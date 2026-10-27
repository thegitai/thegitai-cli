import type { McpConnections } from './mcp-client.js';
import path from 'node:path';
import {
  normalizeAgentMode,
  type AgentMode,
} from './agent-mode.js';
import type { TurnRecoveryStatus } from './api/turn-recovery.js';
import type { AssistantEditRecord } from './edit-journal.js';
import type { SudoPasswordRequester } from './executor.js';
import {
  createSessionGrants,
  type PermissionRequester,
  type SessionGrants,
} from './permissions.js';
import {
  createSessionSafetyState,
  type SessionSafetyState,
} from './session-safety.js';
import { closeBrowserBridge } from './browser/session-bridge.js';
import type { ChatMessage, ToolCall } from './types.js';
import { clampInteger } from './utils.js';
import type {
  AccountUsage,
  UserInputQuestion,
  UserInputResult,
} from './api/contracts.js';

const DEFAULT_MAX_TOOL_STEPS = 32;

function defaultStatus(message: string): void {
  if (message.trim()) {
    console.log(message);
  }
}

function defaultContextLog(message: string): void {
  if (message.trim()) {
    console.log(message);
  }
}

function createSessionId(): string {
  return `session_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function cloneOpaqueState(value: Record<string, unknown> | null | undefined) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function preserveProviderSelection(
  serverState: Record<string, unknown> | null | undefined,
) {
  const clone = cloneOpaqueState(serverState);
  const providerSelection =
    clone.providerSelection &&
    typeof clone.providerSelection === 'object' &&
    !Array.isArray(clone.providerSelection)
      ? clone.providerSelection
      : null;
  return providerSelection ? { providerSelection } : {};
}

export interface SessionTurnState {
  id: string | null;
  historyStartIndex: number;
  retrievedFilePaths: string[];
  injectedContext: string;
  userInput: string;
}

export interface SessionClientState {
  stickyFilePaths: Set<string>;
  editJournal: AssistantEditRecord[];
  editCounter: number;
  safety: SessionSafetyState;
}

export interface SessionState {
  mcp?: McpConnections;
  rootDir: string;
  env: NodeJS.ProcessEnv;
  autoYes: boolean;
  agentMode: AgentMode;
  maxToolSteps: number;











  maxToolStepsWasExplicit: boolean;
  onStatus: (message: string) => void;
  onContextLog: (message: string) => void;



  onImageAnalysis?: (activeImageCount: number) => void;
  onImageGeneration?: (active: boolean) => void;
  onRecovery?: (status: TurnRecoveryStatus) => void;
  onAccountUsage?: (usage: AccountUsage) => void;
  onToolEvent: ((event: { call: ToolCall; result: unknown }) => void) | null;


  turnAbortSignal?: AbortSignal;
  grants: SessionGrants;
  requestPermission: PermissionRequester | null;
  requestSudoPassword: SudoPasswordRequester | null;
  requestUserInput:
    | ((
        request: { questions: UserInputQuestion[] },
        signal?: AbortSignal,
      ) => Promise<UserInputResult>)
    | null;
  history: ChatMessage[];
  initialized: boolean;
  sessionId: string;
  sessionName: string | null;
  sessionCreatedAt: string;
  sessionUpdatedAt: string;
  modelId: number;
  turnState: SessionTurnState;
  clientState: SessionClientState;
  serverState: Record<string, unknown>;
}

export interface CreateSessionOptions {
  rootDir: string;
  autoYes?: boolean;
  agentMode?: AgentMode;
  modelId: number;
  maxToolSteps?: number;

  maxToolStepsWasExplicit?: boolean;
  requestPermission?: PermissionRequester | null;
  requestSudoPassword?: SudoPasswordRequester | null;
  requestUserInput?:
    | ((
        request: { questions: UserInputQuestion[] },
        signal?: AbortSignal,
      ) => Promise<UserInputResult>)
    | null;
  onStatus?: ((message: string) => void) | null;
  onContextLog?: ((message: string) => void) | null;
  onToolEvent?: ((event: { call: ToolCall; result: unknown }) => void) | null;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  sessionName?: string | null;
  history?: ChatMessage[];
  serverState?: Record<string, unknown> | null;
  editJournal?: AssistantEditRecord[];
  stickyFilePaths?: string[];
  editCounter?: number;
  safety?: SessionSafetyState;
}

export function createSession({
  rootDir,
  autoYes = false,
  agentMode,
  modelId,
  maxToolSteps = DEFAULT_MAX_TOOL_STEPS,
  maxToolStepsWasExplicit = false,
  requestPermission = null,
  requestSudoPassword = null,
  requestUserInput = null,
  onStatus = null,
  onContextLog = null,
  onToolEvent = null,
  env = process.env,
  sessionId = createSessionId(),
  sessionName = null,
  history = [],
  serverState = null,
  editJournal = [],
  stickyFilePaths = [],
  editCounter = 0,
  safety = createSessionSafetyState(),
}: CreateSessionOptions): SessionState {
  const createdAt = new Date().toISOString();
  const initialAgentMode = normalizeAgentMode(
    agentMode ?? (autoYes ? 'auto-accept' : 'default'),
  );
  return {
    rootDir: path.resolve(rootDir),
    env,
    autoYes: initialAgentMode === 'auto-accept',
    agentMode: initialAgentMode,
    maxToolSteps: clampInteger(maxToolSteps, DEFAULT_MAX_TOOL_STEPS, 128),
    maxToolStepsWasExplicit: maxToolStepsWasExplicit === true,
    onStatus: onStatus ?? defaultStatus,
    onContextLog: onContextLog ?? defaultContextLog,
    onToolEvent,
    grants: createSessionGrants(),
    requestPermission,
    requestSudoPassword,
    requestUserInput,
    history: JSON.parse(JSON.stringify(history)),
    initialized: true,
    sessionId,
    sessionName,
    sessionCreatedAt: createdAt,
    sessionUpdatedAt: createdAt,
    modelId: Number(modelId),
    turnState: {
      id: null,
      historyStartIndex: history.length,
      retrievedFilePaths: [],
      injectedContext: '',
      userInput: '',
    },
    clientState: {
      stickyFilePaths: new Set(stickyFilePaths),
      editJournal: [...editJournal],
      editCounter: Math.max(0, editCounter),
      safety,
    },
    serverState: cloneOpaqueState(serverState),
  };
}

export function startNewConversation(session: SessionState): void {
  clearConversation(session);
  const createdAt = new Date().toISOString();
  session.sessionId = createSessionId();
  session.sessionName = null;
  session.sessionCreatedAt = createdAt;
  session.sessionUpdatedAt = createdAt;
}

export function clearConversation(session: SessionState): void {
  session.history = [];

  session.grants = createSessionGrants();
  session.serverState = preserveProviderSelection(session.serverState);
  session.turnState = {
    id: null,
    historyStartIndex: 0,
    retrievedFilePaths: [],
    injectedContext: '',
    userInput: '',
  };
  session.clientState = {
    stickyFilePaths: new Set(),
    editJournal: [],
    editCounter: 0,
    safety: createSessionSafetyState(),
  };
}

export async function disposeSession(session: SessionState): Promise<void> {



  closeBrowserBridge();
  await session.mcp?.close();
}

export function switchModel(session: SessionState, modelId: number): { id: number } {
  session.modelId = Number(modelId);
  return { id: session.modelId };
}
