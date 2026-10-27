import type { McpToolDefinition } from '../mcp-types.js';
import type { InvokedSkill, SkillCatalogueEntry } from '../skills/types.js';
import type { AssistantEditRecord } from '../edit-journal.js';
import type { AgentMode } from '../agent-mode.js';
import type { SessionSafetyState } from '../session-safety.js';
import type { SessionImageStoreContext } from '../core/session-image-store.js';
import type { EditDiagnosticsPlan } from '../tools/shell-diagnostics.js';
import type { ChatMessage, ImageAttachment, ToolCall } from '../types.js';

export type { SessionImageStoreContext };

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


export interface CliReleaseInfo {
  latestVersion: string;
}

export type AccountPlan = 'free' | 'plus' | 'pro';

export interface AccountUsage {
  percentLeft: Record<'5-hourly' | 'weekly' | 'monthly', number>;
  resetsAt: Record<'5-hourly' | 'weekly' | 'monthly', string | null>;
  plan?: AccountPlan;
  autoOnly?: true;
  autoPercentLeft?: number;
  autoExtraSpent?: true;
}

export interface WhoAmIResponse {
  customer: AuthCustomer;
  debugUi: {
    showSessionId: boolean;
  };
  release?: CliReleaseInfo;
  usage?: AccountUsage;
}

export interface LogoutResponse {
  ok: true;
}

export type ModelLock = 'plan' | 'auto-only';

export interface ServerModelInfo {
  id: number;
  label: string;
  costRating: 1 | 2 | 3;
  description: string;
  locked?: ModelLock;
  auto?: true;
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



  scratchDir?: string;








  browserExtensionSeen?: boolean;
}

export interface ProjectOrientationContext {
  topLevelEntries: string[];
  packageScripts: string[];
  truncated: boolean;
}

export interface ChatTurnRequest {
  mcpTools?: McpToolDefinition[];
  skills?: SkillCatalogueEntry[];
  invokedSkill?: InvokedSkill;
  reasoningEffort?: import('../reasoning-effort.js').ReasoningEffort;
  clientTurnId: string;
  modelId: number | null;
  session: ClientSessionSnapshot;
  input: string;
  backgroundJobUpdate?: string;


  supportsJobFollowUp?: boolean;

  jobFollowUp?: boolean;
  clientEnvironment?: ClientEnvironmentContext;
  projectOrientation?: ProjectOrientationContext;



  sessionImageStore?: SessionImageStoreContext;
  imageAttachments?: ImageAttachment[];
  maxToolSteps?: number;
  autoYes?: boolean;
  agentMode?: AgentMode;



  continuation?: { clientTurnId: string; historyIndex: number };
}

export interface ChatToolResultRequest {
  executionId: string;
  toolCallId: string;
  result: unknown;
  toolState: ChatToolState;







  toolStateSeq?: number;
}

export interface GeneratedImageSavePayload {
  base64Data: string;
  mimeType: string;
  suggestedFilename: string;
}

export interface ChatToolCallEvent {
  executionId: string;
  turnId: string;
  sessionTurnId?: string | null;
  call: ToolCall;



  parallelSafe?: boolean;




  generatedImage?: GeneratedImageSavePayload;
  diagnostics?: EditDiagnosticsPlan;
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

export interface ChatInterjectionRequest {
  text: string;
  messageId: string;
  imageAttachments?: ImageAttachment[];
}

export interface ChatInterjectionResponse {
  ok: true;
  messageId: string;
}

export interface ChatInterjectionDeliveredEvent {
  turnId: string;
  step: number;
  deliveredAt: 'tool_round_boundary' | 'completion_gate';
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

  waitingForJobs?: string[];
  waitingForApproval?: boolean;
  toolBudgetReached?: boolean;
  usageSummary?: ChatUsageSummary;
  snapshot: ClientSessionSnapshot;
}
