import type { AssistantEditRecord } from '../edit-journal.js';
import type { AgentMode } from '../agent-mode.js';
import type { SessionSafetyState } from '../session-safety.js';
import type { ChatMessage, ImageAttachment, ToolCall } from '../types.js';

export interface AuthCustomer {
  id: string;
  uuid: string;
  email: string;
  customer_type: string;
  scopes: string[];
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  tokenId: string;
  customer: AuthCustomer;
}

export interface WhoAmIResponse {
  customer: AuthCustomer;
  debugUi: {
    showSessionId: boolean;
  };
  usage?: {
    percentLeft: Record<'5-hourly' | 'weekly' | 'monthly', number>;
    resetsAt: Record<'5-hourly' | 'weekly' | 'monthly', string | null>;
  };
}

export interface LogoutResponse {
  ok: true;
}

export interface ServerModelInfo {
  id: number;
  label: string;
  costRating: 1 | 2 | 3;
  description: string;
}

export interface ListModelsResponse {
  models: ServerModelInfo[];
}

export interface ClientSessionStateSnapshot {
  editCounter: number;
  editJournal: AssistantEditRecord[];
  stickyFilePaths: string[];
  safety: SessionSafetyState;
}

export interface ClientSessionSnapshot {
  version: number;
  id: string;
  name: string | null;
  rootDir: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
  modelId: number;
  /** Git branch of rootDir when the session was last saved, if resolvable. */
  branch?: string | null;
  history: ChatMessage[];
  clientState: ClientSessionStateSnapshot;
  serverState: Record<string, unknown>;
}

export interface SessionMetadata {
  id: string;
  name: string | null;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  modelId: number;
  messageCount: number;
  lastUserMessage: string;
  summaryPreview: string;
  branch?: string | null;
}

export interface ListSessionsResponse {
  sessions: SessionMetadata[];
}

export interface LoadSessionResponse {
  session: ClientSessionSnapshot;
}

export interface SaveSessionRequest {
  messageCount: number;
  session: ClientSessionSnapshot;
}

export interface SaveSessionResponse {
  session: SessionMetadata;
}

export interface ChatToolState {
  autoYes: boolean;
  agentMode?: AgentMode;
  editCounter: number;
  editJournal: AssistantEditRecord[];
  stickyFilePaths: string[];
  safety: SessionSafetyState;
}

export interface ClientEnvironmentContext {
  platform: string;
  arch: string;
  release: string;
  shell: string;
  distroId?: string;
  distroName?: string;
  distroVersion?: string;
  packageManagers: string[];
  // Client-machine scratch directory for the agent's throwaway scripts/files
  // (also exported to commands as THEGITAI_SCRATCH_DIR). Inert metadata for
  // the prompt; the server never resolves it.
  scratchDir?: string;
}

export interface ProjectOrientationContext {
  topLevelEntries: string[];
  packageScripts: string[];
  truncated: boolean;
}

export interface ChatTurnRequest {
  modelId: number | null;
  session: ClientSessionSnapshot;
  input: string;
  backgroundJobUpdate?: string;
  clientEnvironment?: ClientEnvironmentContext;
  projectOrientation?: ProjectOrientationContext;
  imageAttachments?: ImageAttachment[];
  maxToolSteps?: number;
  autoYes?: boolean;
  agentMode?: AgentMode;
}

export interface ChatToolResultRequest {
  toolCallId: string;
  result: unknown;
  toolState: ChatToolState;
  // Order in which this snapshot was taken from the live client session.
  // Parallel-safe calls post concurrently, so snapshots can reach the server
  // out of order; each one is a full copy of client-owned state, and applying
  // an older one would drop a sibling call's read coverage or redaction
  // tokens. Client state only grows within a turn, so the highest sequence
  // seen is always the most complete snapshot. Absent on older clients, which
  // post one result at a time and therefore cannot race.
  toolStateSeq?: number;
}

export interface GeneratedImageSavePayload {
  base64Data: string;
  mimeType: string;
  suggestedFilename: string;
}

export interface ChatToolCallEvent {
  turnId: string;
  sessionTurnId?: string | null;
  call: ToolCall;
  // True when the server may have other tool calls of this batch in flight;
  // the client can execute this call without blocking the event stream.
  // Absent on older servers, which only ever send one call at a time.
  parallelSafe?: boolean;
  /**
   * When set, the server already produced image bytes and the client must only
   * write them under the local state directory, then post back the saved path.
   */
  generatedImage?: GeneratedImageSavePayload;
}

export interface ChatToolResultEvent {
  call: ToolCall;
  result: unknown;
}

export interface UserInputOption {
  id: string;
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  multiSelect: boolean;
  recommendedOptionId?: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const USER_INPUT_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isUserInputQuestionArray(
  value: unknown,
): value is UserInputQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    return false;
  }
  const questionIds = new Set<string>();
  return value.every((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      return false;
    }
    const candidate = question as Record<string, unknown>;
    if (
      !nonEmptyString(candidate.id) ||
      !USER_INPUT_ID_PATTERN.test(candidate.id) ||
      questionIds.has(candidate.id) ||
      !nonEmptyString(candidate.header) ||
      Array.from(candidate.header).length > 12 ||
      !nonEmptyString(candidate.question) ||
      typeof candidate.multiSelect !== 'boolean' ||
      !Array.isArray(candidate.options) ||
      candidate.options.length < 2 ||
      candidate.options.length > 4
    ) {
      return false;
    }
    questionIds.add(candidate.id);
    const optionIds = new Set<string>();
    const optionsValid = candidate.options.every((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        return false;
      }
      const item = option as Record<string, unknown>;
      if (
        !nonEmptyString(item.id) ||
        !USER_INPUT_ID_PATTERN.test(item.id) ||
        optionIds.has(item.id) ||
        !nonEmptyString(item.label) ||
        !nonEmptyString(item.description)
      ) {
        return false;
      }
      optionIds.add(item.id);
      return true;
    });
    if (!optionsValid) {
      return false;
    }
    if (
      candidate.recommendedOptionId !== undefined &&
      (!nonEmptyString(candidate.recommendedOptionId) ||
        candidate.recommendedOptionId !==
          (candidate.options[0] as Record<string, unknown>).id)
    ) {
      return false;
    }
    return true;
  });
}

export interface UserInputAnswer {
  selectedOptionIds: string[];
  customText?: string;
}

export type UserInputResult =
  | {
      status: 'submitted';
      answers: Record<string, UserInputAnswer>;
    }
  | {
      status: 'cancelled';
    };

export interface ChatUserInputRequestEvent {
  turnId: string;
  requestId: string;
  questions: UserInputQuestion[];
}

export interface ChatUserInputResultRequest {
  requestId: string;
  result: UserInputResult;
}

/**
 * A message the user sent into a turn that was already running, instead of
 * waiting for it to finish. The server parks it and the agent loop hands it to
 * the model at its next round boundary.
 */
export interface ChatInterjectionRequest {
  text: string;
  /**
   * Client-chosen identity for this message, echoed back on delivery.
   *
   * Needed because several messages can be accepted before the agent reaches a
   * step boundary and are then handed over together in one drain. A single
   * delivery event would otherwise only be attributable to one of them, leaving
   * the rest displayed as permanently in-flight.
   */
  messageId: string;
  /**
   * Screenshots the user attached to this mid-turn message. Same shape and same
   * caps as a turn's attachments; the running turn adopts them and renumbers
   * their [Image #N] markers against the attachments it already has.
   */
  imageAttachments?: ImageAttachment[];
}

export interface ChatInterjectionResponse {
  ok: true;
  messageId: string;
}

/**
 * Emitted when the agent loop has actually handed a mid-turn message to the
 * model — not when the server accepted it. The gap between the two is the whole
 * point: a single model call can run for well over a minute, and without this
 * the client can only say "sent" and hope.
 *
 * Carries no message text. The client echoes its own copy; this is purely the
 * state transition.
 */
export interface ChatInterjectionDeliveredEvent {
  turnId: string;
  /** Agent step the message was folded into, for support and telemetry. */
  step: number;
  deliveredAt: 'tool_round_boundary' | 'completion_gate';
  /** Every message handed over in this drain, so each row is settled exactly once. */
  messageIds: string[];
}

export type ChatStatusPhase =
  | 'thinking'
  | 'analyzing_image'
  | 'generating_image'
  | 'running_tool'
  | 'waiting_for_tool'
  | 'waiting_for_user_input';

export interface ChatStatusEvent {
  phase: ChatStatusPhase;
  toolName?: string;
  publicText?: string;
  imageCount?: number;
}

export interface ChatUsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  responseTimeMs: number | null;
}

export interface ChatResultPayload {
  text: string;
  waitingForApproval?: boolean;
  toolBudgetReached?: boolean;
  usageSummary?: ChatUsageSummary;
  snapshot: ClientSessionSnapshot;
}
