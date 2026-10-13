import { sessionMcp } from '../mcp-client.js';
import { readProjectModelEfforts, projectModelEffort } from '../project-model-preferences.js';
import { randomUUID } from 'node:crypto';
import { drainBackgroundJobNotifications } from '../background-jobs.js';
import { cancelActiveCommand } from '../executor.js';
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
  UserInputQuestion,
  UserInputResult,
} from './contracts.js';
import { isUserInputQuestionArray } from './contracts.js';
import {
  createTraceContext,
  gatewayFailureCategory,
  normalizeServerUrl,
  QUOTA_EXCEEDED_CODE,
  readErrorResponse,
  ServerApiError,
  type ServerApiErrorDetails,
  transportFailureDetail,
} from './http.js';
import {
  createTurnRecovery,
  fetchTurnAttempt,
  interruptedStream,
  isRetryableTurnStatus,
  isTurnRecoveryExhausted,
  readTurnChunk,
  type TurnRecovery,
  type TurnRecoveryStatus,
} from './turn-recovery.js';
import { collectClientEnvironment } from '../client-environment.js';
import { collectProjectOrientation } from '../project-orientation.js';
import { describeSessionImageStore } from '../core/session-image-store.js';
import { autoAttachImages } from '../core/image-path-extractor.js';
import { formatTurnFailureMarker } from '../turn-failure-marker.js';
import { browserExtensionSeen, releaseBrowserAfterTurn } from '../browser/session-bridge.js';

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
  id: string;
  event: string;
  data: any;
}

function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  let id = '';
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('id:')) { id = line.slice(3).trim(); continue; }
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
    return { id, event, data: JSON.parse(text) };
  } catch {
    throw new Error('Server emitted invalid event JSON.');
  }
}






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

    if (!entry || entry.role !== 'user' || entry.kind === 'userInterjection') continue;
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








type TurnPhase =
  | 'opening the turn'
  | 'reading the turn stream'
  | 'posting a tool result'
  | 'posting your answer'
  | 'posting a message into the turn';

function tagTurnPhase<T>(phase: TurnPhase, run: () => Promise<T>): Promise<T> {
  return run().catch((error) => {
    if (error && typeof error === 'object' && !(error as any).thegitaiPhase) {
      (error as any).thegitaiPhase = phase;
    }
    throw error;
  });
}

function turnPhaseOf(error: unknown): TurnPhase | null {
  const phase = (error as any)?.thegitaiPhase;
  return typeof phase === 'string' ? (phase as TurnPhase) : null;
}

function preserveCancelledTurnToolResult(
  session: SessionState,
  input: string,
  event: ChatToolCallEvent,
  result: unknown,
): void {
  const callId = String(event.call.id ?? '').trim();
  if (!callId) return;
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


interface TurnInterjection {
  messageId: string;
  text: string;
  hasImages: boolean;
  delivered: boolean;
}




const turnInterjections = new Map<string, TurnInterjection[]>();

function preserveTurnInterjection(
  session: SessionState,
  input: string,
  sent: TurnInterjection,
): void {
  sent.delivered = true;
  preserveCancelledTurnInput(session, input);
  session.history.push({
    role: 'user',
    parts: [{ text: sent.text }],
    kind: 'userInterjection',
    userInput: sent.text,
  });
}

function preserveTurnAnswer(
  session: SessionState,
  input: string,
  requestId: string,
  questions: UserInputQuestion[],
  result: UserInputResult,
): void {
  preserveCancelledTurnInput(session, input);
  session.history.push({ role: 'model', parts: [{ userInputRequest: { requestId, questions } }] });
  session.history.push({ role: 'user', parts: [{ userInputResult: { requestId, result } }] });
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

type TurnRequester = (
  operation: TurnPhase,
  url: string,
  init: RequestInit,
) => Promise<Response>;






function createTurnRequester({
  fetchImpl,
  recovery,
  signal,
  traceId,
}: {
  fetchImpl: typeof fetch;
  recovery: TurnRecovery;
  signal: AbortSignal;
  traceId: string;
}): TurnRequester {
  return (operation, url, init) => {

    const caller = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
    return tagTurnPhase(operation, () =>
      recovery.run(
        operation,
        async () => {
          const response = await fetchTurnAttempt(fetchImpl, url, init, caller, {
            readBody: true,
          });
          if (isRetryableTurnStatus(response.status)) {
            throw await readErrorResponse(response, traceId);
          }
          return response;
        },
        caller,
      ),
    );
  };
}

function turnUrl(config: CliAuthConfig, turnId: string, action: string): string {
  return `${normalizeServerUrl(config.serverUrl)}/v1/chat/turn/${encodeURIComponent(turnId)}/${action}`;
}

async function postToolResult({
  config,
  turnId,
  event,
  result,
  session,
  request,
  traceId,
  delivery,
}: {
  config: CliAuthConfig;
  turnId: string;
  event: ChatToolCallEvent;
  result: unknown;
  session: SessionState;
  request: TurnRequester;
  traceId: string;
  delivery: AbortSignal;
}): Promise<void> {
  const payload: ChatToolResultRequest = {
    executionId: event.executionId,
    toolCallId: event.call.id,
    result,
    toolState: toolStateFromSession(session),
    toolStateSeq: ++toolStateSeqCounter,
  };
  const trace = createTraceContext(traceId);
  const response = await request(
    'posting a tool result',
    turnUrl(config, turnId, 'tool-result'),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...trace.headers,
      },
      body: JSON.stringify(payload),
      signal: delivery,
    },
  );

  if (response.status === 410) return;
  if (!response.ok) {
    throw await readErrorResponse(response, trace.traceId);
  }
}

async function postUserInputResult({
  config,
  turnId,
  requestId,
  result,
  request,
  traceId,
  delivery,
}: {
  config: CliAuthConfig;
  turnId: string;
  requestId: string;
  result: UserInputResult;
  request: TurnRequester;
  traceId: string;
  delivery: AbortSignal;
}): Promise<void> {
  const payload: ChatUserInputResultRequest = {
    requestId,
    result,
  };
  const trace = createTraceContext(traceId);
  const response = await request(
    'posting your answer',
    turnUrl(config, turnId, 'user-input-result'),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...trace.headers,
      },
      body: JSON.stringify(payload),
      signal: delivery,
    },
  );
  if (response.status === 410) return;
  if (!response.ok) {
    throw await readErrorResponse(response, trace.traceId);
  }
}










export type InterjectionOutcome = 'delivered' | 'stale';



const activeTurnRequesters = new Map<string, TurnRequester>();

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


    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
  };
  const trace = createTraceContext(traceId);
  const url = turnUrl(config, turnId, 'interject');
  const init: RequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      ...trace.headers,
    },
    body: JSON.stringify(payload),
  };
  const request = activeTurnRequesters.get(turnId);


  const sent = turnInterjections.get(turnId);
  const record: TurnInterjection = {
    messageId,
    text,
    hasImages: imageAttachments.length > 0,
    delivered: false,
  };
  sent?.push(record);
  const forget = () => {
    const index = sent?.indexOf(record) ?? -1;
    if (index !== -1) sent!.splice(index, 1);
  };
  let response: Response;
  try {
    response = request
      ? await request('posting a message into the turn', url, init)
      : await fetchImpl(url, init);
  } catch (error) {
    forget();
    throw error;
  }
  if (response.status === 410) {
    forget();
    return 'stale';
  }
  if (!response.ok) {
    forget();
    throw await readErrorResponse(response, trace.traceId);
  }
  return 'delivered';
}






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
  request,
  signal,
  delivery,
  executed,
  traceId,
}: {
  config: CliAuthConfig;
  session: SessionState;
  event: ChatToolCallEvent;
  input: string;
  request: TurnRequester;
  signal: AbortSignal;

  delivery: AbortSignal;
  executed: () => void;
  traceId: string;
}): Promise<void> {
  const turnId = String(event?.turnId ?? '').trim();
  if (!turnId || !event?.executionId || !event?.call?.id || !event.call.name) {
    throw new Error('Server emitted an invalid tool-call event.');
  }
  signal.throwIfAborted();
  delivery.throwIfAborted();
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
    executed();
    signal.throwIfAborted();
    if (delivery.aborted) return;
    await postToolResult({
      config,
      turnId,
      event,
      result: rawResult,
      session,
      request,
      traceId,
      delivery,
    });
  } finally {
    if (serverSessionTurnId) {
      exitServerTurnId(session);
    }
  }
}







function createTurnWork() {
  const executions = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();

  const running = new Set<Promise<void>>();
  let lastSerial: Promise<void> = Promise.resolve();
  let hasFailed = false;
  let rejectFailed!: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailed = reject;
  });
  failed.catch(() => {});

  function dispatch(
    key: string,
    parallel: boolean,
    run: (executed: () => void) => Promise<void>,
  ): void {
    if (executions.has(key)) return;
    const prior = parallel ? lastSerial : Promise.all([lastSerial, ...inFlight]);
    let executed!: () => void;
    const local = new Promise<void>((resolve) => {
      executed = resolve;
    });
    running.add(local);
    void local.then(() => running.delete(local));
    const execution = prior.then(() => run(executed));
    execution.then(executed, executed);
    executions.set(key, execution);
    inFlight.add(execution);
    if (!parallel) lastSerial = execution;
    execution.then(
      () => inFlight.delete(execution),
      (error) => {
        inFlight.delete(execution);
        hasFailed = true;
        rejectFailed(error);
      },
    );
  }

  return {
    dispatch,

    failed,
    get hasFailed() {
      return hasFailed;
    },

    async executed(): Promise<void> {
      await Promise.all([...running]);
    },
    async settled(): Promise<void> {
      await Promise.allSettled([...inFlight]);
    },
  };
}

type TurnOutcome =
  | { kind: 'result'; result: ChatResultPayload }
  | { kind: 'failed'; error: Error };

function terminalFailure(event: SseEvent, traceId: string): Error {
  const data = (event.data ?? {}) as {
    message?: unknown;
    code?: unknown;
    category?: unknown;
    retryable?: unknown;
    traceId?: unknown;
    details?: ServerApiErrorDetails;
    snapshot?: ChatResultPayload['snapshot'];
  };
  const message = String(data.message ?? 'The turn failed before completion.');
  const eventTraceId = typeof data.traceId === 'string' ? data.traceId : traceId;
  if (event.event === 'cancelled') {
    return new TurnCancelledError(message);
  }
  if (data.code === QUOTA_EXCEEDED_CODE) {
    return new ServerApiError(message, 429, eventTraceId, QUOTA_EXCEEDED_CODE, data.details ?? {});
  }
  return new ChatTurnFailedError(
    message,
    typeof data.category === 'string' ? data.category : 'unknown_error',
    Boolean(data.retryable),
    eventTraceId,


    data.snapshot,
  );
}

const TURN_EVENT_ACK_INTERVAL_MS = 5_000;
const MAX_TURN_EVENT_BYTES = 64 * 1024 * 1024;






function createEventAcknowledger(send: (eventId: string) => Promise<void>) {
  let latest = '';
  let confirmed = '';
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer || stopped) return;
    timer = setTimeout(flush, TURN_EVENT_ACK_INTERVAL_MS);
    timer.unref?.();
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || inFlight || !latest || latest === confirmed) return;
    const eventId = latest;
    inFlight = true;
    send(eventId)
      .then(
        () => {
          confirmed = eventId;
        },
        () => {},
      )
      .finally(() => {
        inFlight = false;
        if (latest !== confirmed) schedule();
      });
  };
  return {
    note(eventId: string): void {
      latest = eventId;
      schedule();
    },
    flush,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

async function runTurnStream({
  openStream,
  config,
  session,
  input,
  request,
  recovery,
  signal,
  traceId,
  acknowledge,
  stopLocalWork,
  interjections,
  onTurnStart,
  onInterjectionDelivered,
}: {
  openStream: (lastEventId: string) => Promise<Response>;
  config: CliAuthConfig;
  session: SessionState;
  input: string;
  request: TurnRequester;
  recovery: TurnRecovery;
  signal: AbortSignal;
  traceId: string;
  acknowledge: ReturnType<typeof createEventAcknowledger>;
  stopLocalWork: () => void;
  interjections: TurnInterjection[];
  onTurnStart?: (turnId: string) => void;
  onInterjectionDelivered?: (event: ChatInterjectionDeliveredEvent) => void;
}): Promise<TurnOutcome> {
  const seen = new Set<string>();
  const work = createTurnWork();

  const deliveries = new AbortController();
  const delivery = AbortSignal.any([signal, deliveries.signal]);
  const streamToken = {};
  let lastEventId = '';
  let registeredTurnId = '';

  function handleEvent(event: SseEvent): TurnOutcome | null {
    if (!event.id) {
      throw new Error('The server sent a turn event without an id.');
    }
    if (seen.has(event.id)) return null;
    seen.add(event.id);
    lastEventId = event.id;
    const data = event.data;
    switch (event.event) {
      case 'turn-start': {


        const turnId = String(data?.turnId ?? '').trim();
        if (!turnId) throw new Error('The server sent a turn without an id.');
        registeredTurnId = turnId;
        activeTurnRequesters.set(turnId, request);
        turnInterjections.set(turnId, interjections);
        onTurnStart?.(turnId);
        break;
      }
      case 'interjection-delivered': {


        const delivered = data as ChatInterjectionDeliveredEvent;
        for (const messageId of delivered?.messageIds ?? []) {
          const sent = interjections.find((item) => item.messageId === messageId);
          if (sent && !sent.delivered) preserveTurnInterjection(session, input, sent);
        }
        onInterjectionDelivered?.(delivered);
        break;
      }
      case 'status': {
        const status = (data ?? {}) as Partial<ChatStatusEvent>;
        if (status.phase === 'analyzing_image') {
          session.onImageAnalysis?.(Math.max(1, Number(status.imageCount ?? 1) || 1));
          session.onImageGeneration?.(false);
        } else if (status.phase === 'generating_image') {
          session.onImageGeneration?.(true);
          session.onImageAnalysis?.(0);
        } else if (status.phase) {
          session.onImageAnalysis?.(0);
          session.onImageGeneration?.(false);
        }
        const message = publicStatusMessage(data);
        if (message) session.onStatus(message);
        break;
      }
      case 'tool-call': {
        const toolCall = data as ChatToolCallEvent;
        if (!toolCall?.executionId || !toolCall.call?.name) {
          throw new Error('Server emitted an invalid tool-call event.');
        }
        work.dispatch(`tool:${toolCall.executionId}`, toolCall.parallelSafe === true, (executed) =>
          executeAndPostToolResult({
            config,
            session,
            event: toolCall,
            input,
            request,
            signal,
            delivery,
            executed,
            traceId,
          }),
        );
        break;
      }
      case 'tool-result': {
        const toolResult = data as ChatToolResultEvent;
        if (toolResult?.call?.name) {
          session.onToolEvent?.({ call: toolResult.call, result: toolResult.result });
        }
        break;
      }
      case 'user-input-request': {
        const question = data as ChatUserInputRequestEvent;
        const turnId = String(question?.turnId ?? '').trim();
        const requestId = String(question?.requestId ?? '').trim();
        if (!turnId || !requestId || !isUserInputQuestionArray(question?.questions)) {
          throw new Error('Server emitted an invalid user-input request.');
        }
        work.dispatch(`question:${requestId}`, false, async (executed) => {
          if (!session.requestUserInput) {
            throw new Error('Interactive user input is unavailable in this client.');
          }
          const result = await session.requestUserInput(
            { questions: question.questions },
            signal,
          );
          executed();
          signal.throwIfAborted();
          preserveTurnAnswer(session, input, requestId, question.questions, result);
          if (delivery.aborted) return;
          await postUserInputResult({
            config,
            turnId,
            requestId,
            result,
            request,
            traceId,
            delivery,
          });
        });
        break;
      }
      case 'result':
        if (!data?.snapshot) throw new Error('Server returned an invalid chat result.');
        return { kind: 'result', result: data as ChatResultPayload };
      case 'error':
      case 'cancelled':
        return { kind: 'failed', error: terminalFailure(event, traceId) };
      default:
        break;
    }
    acknowledge.note(event.id);
    return null;
  }

  async function readUntilOutcome(response: Response): Promise<TurnOutcome> {
    if (!response.body) throw interruptedStream('The server returned an empty turn stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const read = await Promise.race([readTurnChunk(reader, signal), work.failed]);
        if (read.done) throw interruptedStream();
        buffer += decoder.decode(read.value, { stream: true });
        for (let match = /\r?\n\r?\n/.exec(buffer); match; match = /\r?\n\r?\n/.exec(buffer)) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          signal.throwIfAborted();
          const event = parseSseBlock(block);


          if (!event) continue;
          recovery.restored(streamToken);
          const outcome = handleEvent(event);
          if (outcome) return outcome;
        }
        if (buffer.length > MAX_TURN_EVENT_BYTES) {
          throw new Error('The server sent a turn event larger than the protocol allows.');
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  try {
    for (;;) {
      let outcome: TurnOutcome;
      try {
        signal.throwIfAborted();
        const response = await openStream(lastEventId);
        recovery.reconnected(streamToken);
        outcome = await readUntilOutcome(response);
      } catch (error) {

        signal.throwIfAborted();

        if (work.hasFailed) throw error;
        await recovery.retryAfter(
          streamToken,
          lastEventId ? 'reading the turn stream' : 'opening the turn',
          error,
        );
        continue;
      }
      acknowledge.note(lastEventId);
      acknowledge.flush();
      if (outcome.kind === 'result') {


        deliveries.abort(new Error('The turn already finished.'));
        await work.executed();
        signal.throwIfAborted();
      } else {
        stopLocalWork();
        await work.settled();
      }
      return outcome;
    }
  } catch (error) {
    const outcome = signal.aborted ? signal.reason : error;


    stopLocalWork();
    await work.settled();
    throw outcome;
  } finally {
    if (registeredTurnId) {
      activeTurnRequesters.delete(registeredTurnId);
      turnInterjections.delete(registeredTurnId);
    }
  }
}

export async function sendServerUserMessage({
  config,
  session,
  input,
  jobFollowUp = false,
  imageAttachments = [],
  fetchImpl = globalThis.fetch,
  signal,
  onTurnStart,
  onInterjectionDelivered,
  recoverySleep,
}: {
  config: CliAuthConfig;
  session: SessionState;
  input: string;
  jobFollowUp?: boolean;
  imageAttachments?: ChatTurnRequest['imageAttachments'];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;


  onTurnStart?: (turnId: string) => void;

  onInterjectionDelivered?: (event: ChatInterjectionDeliveredEvent) => void;
  recoverySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<{
  text: string;
  waitingForJobs?: string[];
  waitingForApproval?: boolean;
  toolBudgetReached?: boolean;
  usageSummary?: ChatResultPayload['usageSummary'];
}> {
  const autoAttach = autoAttachImages(input, session.rootDir, imageAttachments);
  const requestImageAttachments =
    autoAttach.attachments.length > 0
      ? [...imageAttachments, ...autoAttach.attachments]
      : imageAttachments;






  const requestInputBase =
    autoAttach.attachments.length > 0 ? autoAttach.sanitizedInput : input;
  const backgroundJobUpdate = drainBackgroundJobNotifications({
    sessionId: session.sessionId,
  });
  for (const err of autoAttach.errors) {
    session.onStatus(`Image: ${err}`);
  }
  const request: ChatTurnRequest = {


    clientTurnId: randomUUID(),
    mcpTools: await sessionMcp(session).discover(signal),
    modelId: session.modelId,
    reasoningEffort: projectModelEffort(
      readProjectModelEfforts(session.rootDir, config.serverUrl, session.env),
      session.modelId,
    ),
    session: snapshotForServer(session),
    input: requestInputBase,
    backgroundJobUpdate: backgroundJobUpdate || undefined,
    supportsJobFollowUp: true,
    ...(jobFollowUp ? { jobFollowUp: true } : {}),
    clientEnvironment: collectClientEnvironment({ env: session.env }),
    projectOrientation:
      collectProjectOrientation(session.rootDir) ?? undefined,



    sessionImageStore: describeSessionImageStore(session.env) ?? undefined,
    imageAttachments: imageAttachmentsForServer(requestImageAttachments),
    ...(session.maxToolStepsWasExplicit || !browserExtensionSeen(session.env)
      ? { maxToolSteps: session.maxToolSteps }
      : {}),
    autoYes: session.autoYes,
    agentMode: session.agentMode,
  };
  const trace = createTraceContext();
  let completed = false;
  let turnEnded = false;
  const reportRecovery = (status: TurnRecoveryStatus) => {

    if (!turnEnded) session.onRecovery?.(status);
  };
  const startAttempt = (
    turnRequest: ChatTurnRequest,
    onStart: ((turnId: string) => void) | undefined,
  ) =>
    startTurnAttempt({
      config,
      session,
      turnRequest,
      input: requestInputBase,
      trace,
      fetchImpl,
      recoverySleep,
      reportRecovery,
      onTurnStart: onStart,
      onInterjectionDelivered,
    });
  let attempt = startAttempt(request, onTurnStart);

  const cancelTurn = () => attempt.cancel();
  const preTurnHistoryLength = session.history.length;
  const preserveOnAbort = () => preserveCancelledTurnInput(session, requestInputBase);
  if (signal?.aborted) {
    preserveOnAbort();
    cancelTurn();
  } else {
    signal?.addEventListener('abort', preserveOnAbort, { once: true });
    signal?.addEventListener('abort', cancelTurn, { once: true });
  }
  try {
    let outcome: TurnOutcome;
    try {
      outcome = await attempt.run();
    } catch (error) {
      const sent = attempt.interjections;


      if (!isTurnLostByServer(error) || sent.some((item) => item.hasImages)) throw error;



      attempt.close(false);
      if (signal?.aborted) throw new TurnCancelledError();
      const carried = sent.filter((item) => !item.delivered);
      for (const item of carried) preserveTurnInterjection(session, requestInputBase, item);
      reportRecovery({ phase: 'continuing' });
      attempt = startAttempt(
        {
          ...request,
          clientTurnId: randomUUID(),
          session: snapshotForServer(session),
          continuation: {
            clientTurnId: request.clientTurnId,
            historyIndex: preTurnHistoryLength,
          },
        },
        (turnId) => {
          reportRecovery({ phase: 'continued' });
          onTurnStart?.(turnId);
          if (carried.length > 0) {
            onInterjectionDelivered?.({
              turnId,
              step: 0,
              deliveredAt: 'tool_round_boundary',
              messageIds: carried.map((item) => item.messageId),
            });
          }
        },
      );
      outcome = await attempt.run();
    }
    if (outcome.kind === 'failed') throw outcome.error;
    applySessionSnapshot(session, outcome.result.snapshot, { preserveAgentMode: true });
    completed = true;
    return {
      text: outcome.result.text,
      waitingForJobs: outcome.result.waitingForJobs,
      waitingForApproval: outcome.result.waitingForApproval,
      toolBudgetReached: outcome.result.toolBudgetReached,
      usageSummary: outcome.result.usageSummary,
    };
  } catch (error) {
    if (isTurnCancelledError(error)) {
      preserveCancelledTurnInput(session, requestInputBase);
      throw error instanceof TurnCancelledError
        ? error
        : new TurnCancelledError();
    }



    const exhausted = isTurnRecoveryExhausted(error);
    const carriesTrace =
      error instanceof ChatTurnFailedError || error instanceof ServerApiError;
    const transportDetail =
      carriesTrace || exhausted ? null : transportFailureDetail(error);
    if (transportDetail && error instanceof Error) {
      const phase = turnPhaseOf(error) ?? 'reaching the server';
      error.message = `connection lost while ${phase}: ${transportDetail} [trace ${trace.traceId}]`;
    } else if (!carriesTrace && error instanceof Error) {
      error.message = `${error.message} [trace ${trace.traceId}]`;
    }
    const category =
      error instanceof ChatTurnFailedError
        ? error.category
        : exhausted
          ? 'connection_error'
          :


            (gatewayFailureCategory(error) ?? 'unknown_error');
    const partial =
      error instanceof ChatTurnFailedError ? error.partialSnapshot : undefined;
    if (partial) {



      applySessionSnapshot(session, partial, { preserveAgentMode: true });
    } else if (session.history.length === preTurnHistoryLength) {
      preserveFailedTurnInput(session, requestInputBase, category);
    } else {



      appendTurnFailureMarker(session, category);
    }
    try {
      saveSessionState(session, session.env);
    } catch {}
    throw error;
  } finally {
    turnEnded = true;
    signal?.removeEventListener('abort', preserveOnAbort);
    signal?.removeEventListener('abort', cancelTurn);
    attempt.close(completed);


    releaseBrowserAfterTurn();
  }
}


function isTurnLostByServer(error: unknown): boolean {
  return error instanceof ServerApiError && error.code === 'RECOVERY_UNAVAILABLE';
}

interface TurnAttempt {

  readonly interjections: TurnInterjection[];

  cancel(): void;
  run(): Promise<TurnOutcome>;

  close(completed: boolean): void;
}


function startTurnAttempt({
  config,
  session,
  turnRequest,
  input,
  trace,
  fetchImpl,
  recoverySleep,
  reportRecovery,
  onTurnStart,
  onInterjectionDelivered,
}: {
  config: CliAuthConfig;
  session: SessionState;
  turnRequest: ChatTurnRequest;
  input: string;
  trace: ReturnType<typeof createTraceContext>;
  fetchImpl: typeof fetch;
  recoverySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  reportRecovery: (status: TurnRecoveryStatus) => void;
  onTurnStart?: (turnId: string) => void;
  onInterjectionDelivered?: (event: ChatInterjectionDeliveredEvent) => void;
}): TurnAttempt {
  const requestBody = JSON.stringify(turnRequest);
  const interjections: TurnInterjection[] = [];
  const turnController = new AbortController();
  const turnSignal = turnController.signal;
  session.turnAbortSignal = turnSignal;
  let serverSettled = false;
  let cancellationSent = false;
  const sendCancellation = () => {
    if (cancellationSent) return;
    cancellationSent = true;
    const cancelController = new AbortController();
    void fetchTurnAttempt(
      fetchImpl,
      turnUrl(config, turnRequest.clientTurnId, 'cancel'),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          ...trace.headers,
        },
        body: JSON.stringify({ sessionId: turnRequest.session.id }),
      },
      cancelController.signal,
      { readBody: true },
    ).catch(() => {});
  };
  const stopLocalWork = () => {
    turnController.abort(new TurnCancelledError());
    cancelActiveCommand();
  };
  const recovery = createTurnRecovery({
    signal: turnSignal,
    sleep: recoverySleep,
    onStatus: reportRecovery,
  });
  const requester = createTurnRequester({
    fetchImpl,
    recovery,
    signal: turnSignal,
    traceId: trace.traceId,
  });


  const acknowledge = createEventAcknowledger(async (eventId) => {
    const response = await fetchTurnAttempt(
      fetchImpl,
      turnUrl(config, turnRequest.clientTurnId, 'ack'),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          ...trace.headers,
        },
        body: JSON.stringify({ eventId }),
      },
      new AbortController().signal,
      { readBody: true },
    );
    if (!response.ok) throw await readErrorResponse(response, trace.traceId);
  });
  const openStream = async (lastEventId: string): Promise<Response> => {
    const response = await fetchTurnAttempt(
      fetchImpl,
      `${normalizeServerUrl(config.serverUrl)}/v1/chat/turn`,
      {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          ...trace.headers,
          ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        },
        body: requestBody,
      },
      turnSignal,
    );
    if (!response.ok) {
      throw await readErrorResponse(response, trace.traceId);
    }
    return response;
  };
  return {
    interjections,
    cancel() {
      stopLocalWork();
      sendCancellation();
    },
    async run() {
      const outcome = await runTurnStream({
        openStream,
        config,
        session,
        input,
        request: requester,
        recovery,
        signal: turnSignal,
        traceId: trace.traceId,
        acknowledge,
        stopLocalWork,
        interjections,
        onTurnStart,
        onInterjectionDelivered,
      });
      serverSettled = true;
      return outcome;
    },
    close(completed) {
      acknowledge.stop();
      if (!serverSettled) sendCancellation();


      if (!completed) turnController.abort(new TurnCancelledError());
      if (session.turnAbortSignal === turnSignal) session.turnAbortSignal = undefined;
    },
  };
}






export function isTurnOutcomeKnown(error: unknown): boolean {
  return error instanceof ChatTurnFailedError;
}
