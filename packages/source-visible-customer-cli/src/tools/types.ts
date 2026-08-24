import type { AssistantEditRecord } from '../edit-journal.js';
import type { SudoPasswordRequester } from '../executor.js';
import type { PermissionRequester, SessionGrants } from '../permissions.js';
import type { SessionSafetyState } from '../session-safety.js';

export interface ToolContext {
  rootDir: string;
  sessionId?: string | null;
  autoYes: boolean;
  /** Session-scoped permission grants. Absent means nothing is pre-approved. */
  grants?: SessionGrants;
  requestPermission: PermissionRequester | null;
  requestSudoPassword: SudoPasswordRequester | null;
  onStatus: (msg: string) => void;
  editJournal?: AssistantEditRecord[];
  safety?: SessionSafetyState;
  currentTurnId?: string | null;
  currentToolCallId?: string;
  markEditReverted?: (editId: string, toolCallId: string) => void;
  env?: NodeJS.ProcessEnv;
}

export type ToolFailureCategory =
  | 'unknown_tool'
  | 'malformed_arguments'
  | 'missing_required_argument'
  | 'invalid_argument'
  | 'permission_denied'
  | 'policy_blocked'
  | 'not_found'
  | 'ambiguous_match'
  | 'command_failed'
  | 'command_not_found'
  | 'diagnostics_failed'
  | 'budget_exceeded'
  | 'conflict'
  | 'user_declined'
  | 'external_service'
  | 'tool_exception';

export interface ToolFailureDetails {
  category: ToolFailureCategory;
  action: string;
  tool?: string;
  missing?: string[];
  invalid?: string[];
  acceptedKeys?: string[];
  unexpectedKeys?: string[];
  exitCode?: number;
}

export interface ToolCallRepair {
  repaired: true;
  changes: string[];
  originalTool: string;
  tool: string;
}

export interface ToolResponse {
  ok: boolean;
  error?: string;
  failureCategory?: ToolFailureCategory;
  failureDetails?: ToolFailureDetails;
  toolCallRepair?: ToolCallRepair;
  [key: string]: any;
}
