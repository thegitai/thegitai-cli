import { drainBackgroundJobNotifications } from '../background-jobs.js';
import type { SessionState } from '../session.js';
import {
  createPromptCheckpoint,
  sanitizeSessionSafetyForServer,
} from '../session-safety.js';
import type { ChatMessage, ImageAttachment } from '../types.js';
import {
  applySessionSnapshot,
  saveSessionState,
  snapshotFromSession,
} from '../session-store.js';
import { executeLocalToolCall } from '../tool-executor.js';
import { saveGeneratedImage } from '../tools/save-generated-image.js';
import type { CliAuthConfig } from './auth.js';
import type {
  ChatInterjectionDeliveredEvent,
  ChatInterjectionRequest,
  ChatResultPayload,
  ChatStatusEvent,
  ChatToolCallEvent,
  ChatToolResultEvent,
  ChatToolResultRequest,
  ChatTurnRequest,
  ChatUserInputRequestEvent,
  ChatUserInputResultRequest,
  UserInputResult,
} from './contracts.js';
import { isUserInputQuestionArray } from './contracts.js';
import {
  createTraceContext,
  gatewayFailureCategory,
  normalizeServerUrl,
  readErrorResponse,
} from './http.js';
import { collectClientEnvironment } from '../client-environment.js';
import { collectProjectOrientation } from '../project-orientation.js';
import { autoAttachImages } from '../core/image-path-extractor.js';
import { formatTurnFailureMarker } from '../turn-failure-marker.js';

export class TurnCancelledError extends Error {
  readonly name = 'TurnCancelledError';

  constructor(message = 'Turn cancelled.') {
    super(message);
  }
}

export class ChatTurnFailedError extends Error {
  readonly name = 'ChatTurnFailedError';
  readonly category: string;
  readonly retryable: boolean;
  readonly traceId: string;
  readonly partialSnapshot?: ChatResultPayload['snapshot'];

  constructor(
    message: string,
    category = 'unknown_error',
    retryable = false,
    traceId = '',
    partialSnapshot?: ChatResultPayload['snapshot'],
  ) {
    super(traceId ? `${message}\nTrace ID: ${traceId}` : message);
    this.category = category;
    this.retryable = retryable;
    this.traceId = traceId;
    this.partialSnapshot = partialSnapshot;
  }
}

export function isTurnCancelledError(error: unknown): boolean {
  return (
    error instanceof TurnCancelledError ||
    (error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TurnCancelledError'))
  );
}

interface SseEvent {
  event: string;
  data: any;
}

function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim() || event;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (!dataLines.length) return null;
  const text = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

// Stamped onto every tool-state snapshot so the server can discard one that
// lost the race to a newer sibling. Strictly increasing and read synchronously
// with the snapshot itself, so the ordering matches the order the snapshots
// were taken in. The server only compares within a single turn, so a plain
// process-wide counter is enough.
let toolStateSeqCounter = 0;

function toolStateFromSession(session: SessionState) {
  return {
    autoYes: session.autoYes,
    agentMode: session.agentMode,
    editCounter: session.clientState.editCounter,
    editJournal: session.clientState.editJournal,
    stickyFilePaths: Array.from(session.clientState.stickyFilePaths),
    safety: sanitizeSessionSafetyForServer(session.clientState.safety),
  };
}

function snapshotForServer(session: SessionState) {
  const snapshot = snapshotFromSession(session);
  snapshot.clientState.safety = sanitizeSessionSafetyForServer(
    snapshot.clientState.safety,
  );
  return snapshot;
}

function imageAttachmentsForServer(
  attachments: ChatTurnRequest['imageAttachments'],
): ImageAttachment[] {
  // Keep the local path on file-sourced attachments: this session's file/shell
  // tools execute on THIS machine, so the model needs the real path to act on
  // the file (the prompt text was already rewritten to [Image #N]). The server
  // treats the path as inert metadata for the prompt — it never resolves it.
  // Clipboard pastes have no meaningful path; drop the field there.
  return (attachments ?? []).map(({ filePath, ...attachment }) =>
    attachment.source === 'file' && filePath
      ? { ...attachment, filePath }
      : attachment,
  );
}

function userHistoryText(entry: ChatMessage): string {
  return (entry.parts ?? [])
    .map((part: { text?: string }) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function preserveCancelledTurnInput(
  session: SessionState,
  input: string,
): void {
  const text = input.trim();
  if (!text) return;
  for (let i = session.history.length - 1; i >= 0; i--) {
    const entry = session.history[i];
    if (!entry || entry.role !== 'user') continue;
    const prior = userHistoryText(entry);
    if (!prior) continue;
    if (prior === text || prior.includes(text)) return;
    break;
  }
  session.history.push({
    role: 'user',
    parts: [{ text }],
    kind: 'turnStart',
    userInput: text,
  });
}

function appendTurnFailureMarker(
  session: SessionState,
  category: string,
): void {
  session.history.push({
    role: 'model',
    parts: [{ text: formatTurnFailureMarker(category) }],
  });
}

function preserveFailedTurnInput(
  session: SessionState,
  input: string,
  category: string,
): void {
  const text = input.trim();
  if (!text) return;
  session.history.push({
    role: 'user',
    parts: [{ text }],
    kind: 'turnStart',
    userInput: text,
  });
  appendTurnFailureMarker(session, category);
}

function historyHasToolCall(session: SessionState, callId: string): boolean {
  return session.history.some((entry) =>
    (entry.parts ?? []).some(
      (part: any) => String(part?.functionCall?.id ?? '') === callId,
    ),
  );
}

function preserveCancelledTurnToolResult(
  session: SessionState,
  input: string,
  event: ChatToolCallEvent,
  result: unknown,
): void {
  const callId = String(event.call.id ?? '').trim();
  if (!callId || historyHasToolCall(session, callId)) return;
  preserveCancelledTurnInput(session, input);
  session.history.push({
    role: 'model',
    parts: [{ functionCall: event.call }],
  });
  session.history.push({
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: callId,
          name: event.call.name,
          response: result,
        },
      },
    ],
  });
}

function publicStatusMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const event = data as Partial<ChatStatusEvent>;
  if (
    typeof event.publicText === 'string' &&
    event.publicText.trim() &&
    event.publicText.length <= 400
  ) {
    return event.publicText.trim();
  }
  const toolName =
    typeof event.toolName === 'string' && /^[a-z0-9_:-]+$/i.test(event.toolName)
      ? event.toolName
      : 'tool';
  // The TUI already prefixes every title with its own green "Thinking" label,
  // so a literal "Thinking..." title rendered as "Thinking · Thinking...".
  if (event.phase === 'thinking') return 'Exploring options...';
  if (event.phase === 'analyzing_image') {
    return (event.imageCount ?? 1) > 1 ? 'Analyzing images...' : 'Analyzing image...';
  }
  if (event.phase === 'generating_image') {
    return 'Generating image...';
  }
  if (event.phase === 'running_tool') return `Running ${toolName}...`;
  if (event.phase === 'waiting_for_tool') return `Running ${toolName} locally...`;
  if (event.phase === 'waiting_for_user_input') return 'Waiting for your input...';
  return null;
}

function normalizeShellJobToolCall(call: ChatToolCallEvent['call']): ChatToolCallEvent['call'] {
  if (call.name !== 'shell_job_output' && call.name !== 'shell_job_kill') {
    return call;
  }
  const args =
    call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? { ...call.args }
      : {};
  let changed = false;
  if (args.job_id === undefined) {
    const alias = args.jobId ?? args.id;
    if (alias !== undefined) {
      args.job_id = alias;
      delete args.jobId;
      delete args.id;
      changed = true;
    }
  }
  if (call.name === 'shell_job_output' && args.wait_ms === undefined) {
    const alias = args.waitMs ?? args.wait ?? args.wait_millis;
    if (alias !== undefined) {
      args.wait_ms = alias;
      delete args.waitMs;
      delete args.wait;
      delete args.wait_millis;
      changed = true;
    }
  }
  return changed ? { ...call, args } : call;
}

async function postToolResult({
  config,
  turnId,
  event,
  result,
  session,
  fetchImpl,
  traceId,
}: {
  config: CliAuthConfig;
  turnId: string;
  event: ChatToolCallEvent;
  result: unknown;
  session: SessionState;
  fetchImpl: typeof fetch;
  traceId: string;
}): Promise<void> {
  const payload: ChatToolResultRequest = {
    toolCallId: event.call.id,
    result,
    toolState: toolStateFromSession(session),
    toolStateSeq: ++toolStateSeqCounter,
  };
  const trace = createTraceContext(traceId);
  const response = await fetchImpl(
    `${normalizeServerUrl(config.serverUrl)}/v1/chat/turn/${encodeURIComponent(turnId)}/tool-result`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...trace.headers,
      },
      body: JSON.stringify(payload),
    },
  );
  if (response.status === 410) {
    return;
  }
  if (!response.ok) {
    throw await readErrorResponse(response, trace.traceId);
  }
}

async function postUserInputResult({
  config,
  turnId,
  requestId,
  result,
  fetchImpl,
  traceId,
}: {
  config: CliAuthConfig;
  turnId: string;
  requestId: string;
  result: UserInputResult;
  fetchImpl: typeof fetch;
  traceId: string;
}): Promise<void> {
  const payload: ChatUserInputResultRequest = {
    requestId,
    result,
  };
  const trace = createTraceContext(traceId);
  const response = await fetchImpl(
    `${normalizeServerUrl(config.serverUrl)}/v1/chat/turn/${encodeURIComponent(turnId)}/user-input-result`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...trace.headers,
      },
      body: JSON.stringify(payload),
    },
  );
  if (response.status === 410) {
    return;
  }
  if (!response.ok) {
    throw await readErrorResponse(response, trace.traceId);
  }
}

/**
 * Result of firing a message into a turn that is already running.
 *
 * `stale` is the race this feature has to survive: the user hits Enter while the
 * turn is visibly working, but it finishes before the request lands. The server
 * answers 410 rather than accepting text nothing will read, and the caller falls
 * back to submitting the message as its own turn — so the message is never lost,
 * it just arrives as the next prompt instead of mid-turn.
 */
export type InterjectionOutcome = 'delivered' | 'stale';

export async function postInterjection({
  config,
  turnId,
  text,
  messageId,
  imageAttachments = [],
  fetchImpl = globalThis.fetch,
  traceId,
}: {
  config: CliAuthConfig;
  turnId: string;
  text: string;
  messageId: string;
  imageAttachments?: ImageAttachment[];
  fetchImpl?: typeof fetch;
  traceId?: string;
}): Promise<InterjectionOutcome> {
  const payload: ChatInterjectionRequest = {
    text,
    messageId,
    // Only sent when there is something to send: an empty array would be a
    // pointless field on the overwhelmingly common text-only interjection.
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
  };
  const trace = createTraceContext(traceId);
  const response = await fetchImpl(
    `${normalizeServerUrl(config.serverUrl)}/v1/chat/turn/${encodeURIComponent(turnId)}/interject`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...trace.headers,
      },
      body: JSON.stringify(payload),
    },
  );
  if (response.status === 410) {
    return 'stale';
  }
  if (!response.ok) {
    throw await readErrorResponse(response, trace.traceId);
  }
  return 'delivered';
}

// Parallel-safe tool calls from one server batch execute concurrently on this
// session, all under the same server turn id. Overriding turnState.id with a
// plain save/restore per call would race (the first call to finish would
// restore the local id while others still run), so the override is refcounted:
// first entry saves the local id, last exit restores it.
const turnIdOverrides = new WeakMap<
  SessionState,
  { previousTurnId: string | null; depth: number }
>();

function enterServerTurnId(
  session: SessionState,
  serverSessionTurnId: string,
): void {
  const active = turnIdOverrides.get(session);
  if (active) {
    active.depth += 1;
    return;
  }
  turnIdOverrides.set(session, {
    previousTurnId: session.turnState.id,
    depth: 1,
  });
  session.turnState.id = serverSessionTurnId;
}

function exitServerTurnId(session: SessionState): void {
  const active = turnIdOverrides.get(session);
  if (!active) return;
  active.depth -= 1;
  if (active.depth === 0) {
    session.turnState.id = active.previousTurnId;
    turnIdOverrides.delete(session);
  }
}

async function executeAndPostToolResult({
  config,
  session,
  event,
  input,
  fetchImpl,
  signal,
  traceId,
}: {
  config: CliAuthConfig;
  session: SessionState;
  event: ChatToolCallEvent;
  input: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  traceId: string;
}): Promise<void> {
  const turnId = String(event?.turnId ?? '').trim();
  if (!turnId || !event?.call?.id || !event.call.name) {
    throw new Error('Server emitted an invalid tool-call event.');
  }
  if (signal?.aborted) {
    throw new TurnCancelledError();
  }
  const serverSessionTurnId = String(event.sessionTurnId ?? '').trim();
  if (serverSessionTurnId) {
    enterServerTurnId(session, serverSessionTurnId);
    if (
      !session.clientState.safety.checkpoints.some(
        (checkpoint) => checkpoint.turnId === serverSessionTurnId,
      )
    ) {
      createPromptCheckpoint(
        session.clientState.safety,
        'prompt boundary',
        serverSessionTurnId,
      );
    }
  }
  try {
    const call = normalizeShellJobToolCall(event.call);
    const rawResult = event.generatedImage
      ? saveGeneratedImage({
          base64Data: event.generatedImage.base64Data,
          mimeType: event.generatedImage.mimeType,
          suggestedFilename:
            event.generatedImage.suggestedFilename ||
            String(call.args?.filename ?? call.args?.file_name ?? ''),
        })
      : await executeLocalToolCall(session, call);
    preserveCancelledTurnToolResult(session, input, { ...event, call }, rawResult);
    if (signal?.aborted) {
      throw new TurnCancelledError();
    }
    await postToolResult({
      config,
      turnId,
      event,
      result: rawResult,
      session,
      fetchImpl,
      traceId,
    });
  } finally {
    if (serverSessionTurnId) {
      exitServerTurnId(session);
    }
  }
}

async function consumeTurnStream({
  response,
  config,
  session,
  input,
  fetchImpl,
  signal,
  traceId,
  onTurnStart,
  onInterjectionDelivered,
}: {
  response: Response;
  config: CliAuthConfig;
  session: SessionState;
  input: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  traceId: string;
  onTurnStart?: (turnId: string) => void;
  onInterjectionDelivered?: (event: ChatInterjectionDeliveredEvent) => void;
}): Promise<ChatResultPayload> {
  if (!response.body) {
    throw new Error('Server returned an empty chat stream.');
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  const finalResult: { current: ChatResultPayload | null } = {
    current: null,
  };

  // Executions dispatched without blocking the stream reader, so the server
  // can keep other calls of the same batch in flight. Each entry resolves to
  // null on success or the failure, never rejects — a bare rejected promise
  // sitting in this list until the next drain would trip Node's
  // unhandled-rejection detection.
  const pendingParallelTools: Promise<unknown>[] = [];

  // Rejects the moment a dispatched tool fails, and otherwise never settles. If
  // posting a parallel tool's result fails, the server is left waiting for that
  // result and will send nothing further — so a stream read would block until
  // the server-side tool-result timeout instead of failing now, the way the
  // serial path does. The reader races this to turn that hang into a prompt
  // error. The trailing catch keeps an unraced rejection from being reported as
  // unhandled.
  let firstParallelFailure: unknown = null;
  let rejectOnParallelFailure: ((error: unknown) => void) | null = null;
  const parallelToolFailure = new Promise<never>((_, reject) => {
    rejectOnParallelFailure = reject;
  });
  parallelToolFailure.catch(() => {});

  function recordParallelFailure(error: unknown): unknown {
    const failure = error ?? new Error('Local tool execution failed.');
    if (firstParallelFailure == null) {
      firstParallelFailure = failure;
      rejectOnParallelFailure?.(failure);
    }
    return failure;
  }

  async function drainParallelTools(): Promise<void> {
    if (!pendingParallelTools.length) return;
    const pending = pendingParallelTools.splice(0);
    const outcomes = await Promise.all(pending);
    for (const outcome of outcomes) {
      if (outcome != null) throw outcome;
    }
  }

  async function handleEvent(event: SseEvent): Promise<void> {
    // First event of every turn. Reporting the id here is what lets the user
    // address the running turn (to send a message into it) before it has made
    // any tool call — a turn that only ever answers in prose emits no other
    // event carrying a turn id.
    if (event.event === 'turn-start') {
      const turnId = String((event.data as { turnId?: unknown })?.turnId ?? '').trim();
      if (turnId) onTurnStart?.(turnId);
      return;
    }
    // The agent has actually taken the message the user sent mid-turn. Distinct
    // from the POST returning 200, which only means the server parked it.
    if (event.event === 'interjection-delivered') {
      onInterjectionDelivered?.(event.data as ChatInterjectionDeliveredEvent);
      return;
    }
    if (event.event === 'status') {
      const data = event.data as Partial<ChatStatusEvent> | null;
      if (data?.phase === 'analyzing_image') {
        session.onImageAnalysis?.(Math.max(1, Number(data.imageCount ?? 1) || 1));
        session.onImageGeneration?.(false);
      } else if (data?.phase === 'generating_image') {
        session.onImageGeneration?.(true);
        session.onImageAnalysis?.(0);
      } else if (data?.phase) {
        session.onImageAnalysis?.(0);
        session.onImageGeneration?.(false);
      }
      const message = publicStatusMessage(event.data);
      if (message) session.onStatus(message);
      return;
    }
    if (event.event === 'context') {
      return;
    }
    if (event.event === 'tool-call') {
      const data = event.data as ChatToolCallEvent;
      if (data?.parallelSafe === true) {
        pendingParallelTools.push(
          executeAndPostToolResult({
            config,
            session,
            event: data,
            input,
            fetchImpl,
            signal,
            traceId,
          }).then(
            () => null,
            (error) => recordParallelFailure(error),
          ),
        );
        return;
      }
      await drainParallelTools();
      await executeAndPostToolResult({
        config,
        session,
        event: data,
        input,
        fetchImpl,
        signal,
        traceId,
      });
      return;
    }
    if (event.event === 'tool-result') {
      const data = event.data as ChatToolResultEvent;
      if (data?.call?.name) {
        session.onToolEvent?.({ call: data.call, result: data.result });
      }
      return;
    }
    if (event.event === 'user-input-request') {
      await drainParallelTools();
      const data = event.data as ChatUserInputRequestEvent;
      const turnId = String(data?.turnId ?? '').trim();
      const requestId = String(data?.requestId ?? '').trim();
      if (
        !turnId ||
        !requestId ||
        !isUserInputQuestionArray(data?.questions)
      ) {
        throw new Error('Server emitted an invalid user-input request.');
      }
      if (!session.requestUserInput) {
        throw new Error('Interactive user input is unavailable in this client.');
      }
      const result = await session.requestUserInput(
        { questions: data.questions },
        signal,
      );
      if (signal?.aborted) {
        throw new TurnCancelledError();
      }
      await postUserInputResult({
        config,
        turnId,
        requestId,
        result,
        fetchImpl,
        traceId,
      });
      return;
    }
    if (event.event === 'result') {
      await drainParallelTools();
      finalResult.current = event.data as ChatResultPayload;
      return;
    }
    if (event.event === 'cancelled' || event.event === 'error') {
      // The server already decided how this turn ends; let in-flight local
      // tools settle but report the server's failure, not theirs.
      await drainParallelTools().catch(() => {});
      const message = String(event.data?.message ?? 'Server chat failed.');
      if (event.event === 'cancelled') {
        throw new TurnCancelledError(message);
      }
      throw new ChatTurnFailedError(
        message,
        typeof event.data?.category === 'string' ? event.data.category : 'unknown_error',
        Boolean(event.data?.retryable),
        typeof event.data?.traceId === 'string' ? event.data.traceId : traceId,
        // The turn often ran real tools before it failed. The server ships its
        // own history for it so that work survives the failure.
        (event.data as { snapshot?: ChatResultPayload['snapshot'] })?.snapshot,
      );
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new TurnCancelledError();
      }
      const read = await Promise.race([reader.read(), parallelToolFailure]);
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const event = parseSseBlock(block);
        if (event) await handleEvent(event);
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
    await drainParallelTools();
  } catch (error) {
    // The server is still streaming (or waiting on a result we cannot deliver);
    // close it out rather than leaving the response body open.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    // On an error path, never leave dispatched executions running past the
    // stream; their failures are superseded by whatever is being thrown.
    await drainParallelTools().catch(() => {});
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const event = parseSseBlock(tail);
    if (event) await handleEvent(event);
  }
  if (!finalResult.current?.snapshot) {
    throw new Error('Server returned an invalid chat result.');
  }
  return finalResult.current;
}

export async function sendServerUserMessage({
  config,
  session,
  input,
  imageAttachments = [],
  fetchImpl = globalThis.fetch,
  signal,
  onTurnStart,
  onInterjectionDelivered,
}: {
  config: CliAuthConfig;
  session: SessionState;
  input: string;
  imageAttachments?: ChatTurnRequest['imageAttachments'];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  // Fires with the server turn id as soon as the stream opens, so the caller can
  // address this turn while it is still running.
  onTurnStart?: (turnId: string) => void;
  // Fires when the agent has actually received a message sent into this turn.
  onInterjectionDelivered?: (event: ChatInterjectionDeliveredEvent) => void;
}): Promise<{
  text: string;
  waitingForApproval?: boolean;
  toolBudgetReached?: boolean;
  usageSummary?: ChatResultPayload['usageSummary'];
}> {
  const autoAttach = autoAttachImages(input, session.rootDir, imageAttachments);
  const requestImageAttachments =
    autoAttach.attachments.length > 0
      ? [...imageAttachments, ...autoAttach.attachments]
      : imageAttachments;
  // requestInput is the server-bound, path-sanitized text ([Image #N] markers in
  // place of local image paths). Every history-preservation path below (abort,
  // cancel, failure, mid-stream tool cancel) must persist THIS, never the raw
  // input — otherwise a cancelled or failed image turn leaks the local
  // filesystem path into session history and the next snapshot ships it to the
  // server, defeating the point of sanitizing before the request crosses over.
  const requestInputBase =
    autoAttach.attachments.length > 0 ? autoAttach.sanitizedInput : input;
  const backgroundJobUpdate = drainBackgroundJobNotifications({
    sessionId: session.sessionId,
  });
  for (const err of autoAttach.errors) {
    session.onStatus(`Image: ${err}`);
  }
  const request: ChatTurnRequest = {
    modelId: session.modelId,
    session: snapshotForServer(session),
    input: requestInputBase,
    backgroundJobUpdate: backgroundJobUpdate || undefined,
    clientEnvironment: collectClientEnvironment({ env: session.env }),
    projectOrientation:
      collectProjectOrientation(session.rootDir) ?? undefined,
    imageAttachments: imageAttachmentsForServer(requestImageAttachments),
    maxToolSteps: session.maxToolSteps,
    autoYes: session.autoYes,
    agentMode: session.agentMode,
  };
  const trace = createTraceContext();
  const preTurnHistoryLength = session.history.length;
  const preserveOnAbort = () => preserveCancelledTurnInput(session, requestInputBase);
  if (signal?.aborted) {
    preserveOnAbort();
  } else {
    signal?.addEventListener('abort', preserveOnAbort, { once: true });
  }
  try {
    const response = await fetchImpl(
      `${normalizeServerUrl(config.serverUrl)}/v1/chat/turn`,
      {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          ...trace.headers,
        },
        body: JSON.stringify(request),
        signal,
      },
    );
    if (!response.ok) {
      throw await readErrorResponse(response, trace.traceId);
    }
    const result = await consumeTurnStream({
      response,
      config,
      session,
      input: requestInputBase,
      fetchImpl,
      signal,
      traceId: trace.traceId,
      onTurnStart,
      onInterjectionDelivered,
    });
    applySessionSnapshot(session, result.snapshot, { preserveAgentMode: true });
    return {
      text: result.text,
      waitingForApproval: result.waitingForApproval,
      toolBudgetReached: result.toolBudgetReached,
      usageSummary: result.usageSummary,
    };
  } catch (error) {
    if (isTurnCancelledError(error)) {
      preserveCancelledTurnInput(session, requestInputBase);
      throw error instanceof TurnCancelledError
        ? error
        : new TurnCancelledError();
    }
    const category =
      error instanceof ChatTurnFailedError
        ? error.category
        : // A turn killed between the CLI and the server is not a mystery, and
          // recording it as one leaves a misleading marker in the history the
          // model replays. Name the transport failure for what it is.
          gatewayFailureCategory(error) ?? 'unknown_error';
    const partial =
      error instanceof ChatTurnFailedError ? error.partialSnapshot : undefined;
    if (partial) {
      // The server's own history for the failed turn. Unlike the local
      // speculative entries below it is already sanitized for provider replay,
      // so the tools this turn ran survive instead of being thrown away.
      applySessionSnapshot(session, partial, { preserveAgentMode: true });
    } else {
      // Non-cancel failures (e.g. upstream connection errors) must not leave
      // speculative cancelled-turn entries in history — otherwise the next
      // request replays a malformed transcript to the server.
      session.history.length = preTurnHistoryLength;
      preserveFailedTurnInput(session, requestInputBase, category);
    }
    try {
      saveSessionState(session, session.env);
    } catch {}
    throw error;
  } finally {
    signal?.removeEventListener('abort', preserveOnAbort);
  }
}
