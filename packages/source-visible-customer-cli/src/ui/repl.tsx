import { sessionMcp } from '../mcp-client.js';
import { projectModelEffort, readProjectModelEfforts, saveProjectModelEffort, type ProjectModelEfforts } from '../project-model-preferences.js';
import { REASONING_EFFORT_LABELS, type ReasoningEffort } from '../reasoning-effort.js';
import { basename, join as joinPath } from 'node:path';

import { createRatatuiBridge } from './tui/bridge.js';
import {
  bucketActionLabel,
  type PermissionDecision,
  type PermissionOption,
  type PermissionRequest,
} from '../permissions.js';
import {
  AGENT_MODE_LOCKED_STATUS,
  approvalScrollLimit,
  buildTuiFrame,
  formatJobElapsed,
  formatTodoProgress,
  pickThinkingFallbackPhrase,
  renderTranscriptEntryLines,
  THINKING_FALLBACK_PHRASES,
  userInputViewportForFrame,
  type BackgroundJobDisplay,
  type TodoDisplayItem,
  type TurnMessage,
} from './tui/build-frame.js';
import {
  createAttentionController,
  INITIAL_TERMINAL_FOCUS,
} from './tui/attention.js';
import {
  backendFor,
  createNotificationQueue,
} from './tui/desktop-notification.js';
import { readPreferences, writePreferences } from '../preferences.js';
import { createTerminalTitleController } from './tui/terminal-title.js';
import {
  captureTerminalWrites,
  releaseTerminalWrites,
} from './tui/terminal-writes.js';

import {
  getInputCommandToken,
  getSlashCommandSuggestions,
  isSkillSlashCommand,
  setSkillSlashCommands,
  SLASH_COMMANDS,
  slashCommandMatchesToken,
  type SlashCommandOption,
} from './slash-commands.js';
import { buildSkillsPickerItems, SKILLS_ADD_USAGE, type SkillsPickerItem } from '../skills-command.js';
import {
  discoverSkills,
  personalSkillsRoot,
  projectSkillsRoot,
  skillCatalogue,
} from '../skills/discovery.js';
import {
  installPreparedSkill,
  parseSkillSource,
  prepareSkillInstall,
  preparedSkillHasScripts,
} from '../skills/install.js';
import { BUNDLED_SKILLS } from '../skills/types.js';

export {
  getInputCommandToken,
  getSlashCommandSuggestions,
  SLASH_COMMANDS,
  slashCommandMatchesToken,
};
import type { TuiChildMessage } from './tui/types.js';
import { composerInputWidth, frameContentWidth } from './tui/composer-layout.js';
import {
  agentModeLabel,
  nextAgentMode,
  type AgentMode,
} from '../agent-mode.js';
import { chat, models } from '../api/index.js';
import { isTurnCancelledError, isTurnOutcomeKnown } from '../api/chat.js';
import { formatTurnRecoveryStatus } from '../api/turn-recovery.js';
import { createJobWaitTracker } from '../job-follow-up.js';
import {
  getJobBufferedOutput,
  getJobOutputPreview,
  hasRunningBackgroundJobs,
  killAllBackgroundJobs,
  killBackgroundJob,
  listBackgroundJobs,
  setBackgroundJobSession,
  setBackgroundJobUpdateHook,
  type BackgroundJobSnapshot,
} from '../background-jobs.js';
import { clearTodos, listTodos, setTodoSession } from '../todo-list.js';
import { setScratchSession } from '../scratch-dir.js';
import { setImageStoreSession } from '../core/session-image-store.js';
import { cancelActiveCommand } from '../executor.js';
import { isTurnFailureMarker } from '../turn-failure-marker.js';
import {
  clearCliAuthConfig,
  logoutFromServer,
  type CliAuthConfig,
} from '../api/auth.js';
import {
  authenticationErrorMessage,
  isAuthenticationError,
} from '../api/http.js';
import { buildRefusalNotice } from '../quota-notice.js';
import { createUsageNoticeTracker } from '../usage-notice.js';
import type {
  ChatUsageSummary,
  UserInputQuestion,
  UserInputResult,
} from '../api/contracts.js';
import {
  createUserInputPromptState,
  formatUserInputTranscript,
  type UserInputPromptState,
} from './tui/user-input.js';
import type {
  ServerModelInfo,
  ServerModelsResponse,
} from '../api/models.js';
import type { ModelLock } from '../api/contracts.js';
import type { ServerSessionClient } from '../api/sessions.js';
import { setCommandOutputHook, withTuiMode } from '../runtime-mode.js';
import {
  collectBackgroundJobUiKillMutations,
  collectBackgroundJobUiOutputMutations,
} from '../tool-executor.js';
import {
  startNewConversation,
  type SessionState,
} from '../session.js';
import {
  applySessionSnapshot,
  listSessionMetadata,
  loadSessionSnapshot,
  saveSessionState,
  sessionHasUserMessage,
  type SessionMetadata,
} from '../session-store.js';
import type {
  ChatMessage,
  ImageAttachment,
  ToolCall,
} from '../types.js';
import { truncate } from '../utils.js';
import { readClipboardImage, writeClipboardText } from '../core/clipboard.js';
import { openUrl } from '../core/open-url.js';
import { formatAboutCard, formatInteractiveHelpText } from '../help-text.js';
import {
  buildPastePlaceholder,
  expandPastedChunks,
  PastedChunk,
  shouldCollapsePaste,
} from './paste-collapse.js';
import {
  loadPromptHistory,
  MAX_PROMPT_HISTORY_ENTRIES,
} from './prompt-history-store.js';

type TranscriptKind = 'assistant' | 'diff' | 'error' | 'system' | 'tool' | 'user';

const RESPONSE_STREAM_CHUNK_SIZE = 4;
const RESPONSE_STREAM_DELAY_MS = 8;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function* buildResponseStreamBodies(responseText: string): Generator<string> {
  let body = '';
  let emitted = '';
  let count = 0;
  for (const char of responseText) {
    body += char;
    count += 1;
    if (count % RESPONSE_STREAM_CHUNK_SIZE === 0) {
      emitted = body;
      yield body;
    }
  }
  if (body && emitted !== body) {
    yield responseText;
  }
}

interface ToolTranscriptEvent {
  call: ToolCall;
  result: any;
}

interface TranscriptEntry {
  body: string;
  diffPreview?: DiffPreviewModel;
  filePath?: string;
  id: number;
  jobId?: string;
  kind: TranscriptKind;
  preformatted?: boolean;
  title: string;
  todoList?: TodoDisplayItem[];
}

type TranscriptEntryDraft = Omit<TranscriptEntry, 'id'>;

function sameTranscriptDraft(
  a: TranscriptEntryDraft | undefined,
  b: TranscriptEntryDraft,
): boolean {
  return Boolean(
    a &&
      a.kind === b.kind &&
      a.title === b.title &&
      a.body === b.body &&
      a.filePath === b.filePath &&
      a.preformatted === b.preformatted,
  );
}

export function buildSettledTurnTranscriptEntries(
  turnEntries: TranscriptEntryDraft[],
  responseText: string,
): TranscriptEntryDraft[] {
  const responseBody = String(responseText ?? '').trim();
  const responseEntry: TranscriptEntryDraft | null = responseBody
    ? {
      body: responseBody,
      kind: 'assistant',
      title: 'Response',
    }
    : null;
  return [
    ...turnEntries,
    ...(responseEntry !== null && !sameTranscriptDraft(turnEntries.at(-1), responseEntry)
      ? [responseEntry]
      : []),
  ];
}

interface DiffPreviewLine {
  content: string;
  kind: 'add' | 'context' | 'hunk' | 'remove';
  lineNumber: number | null;
}

interface DiffPreviewModel {
  added: number;
  lines: DiffPreviewLine[];
  removed: number;
}

interface ApprovalPromptState {
  body: string;
  diffPreview?: DiffPreviewModel;
  filePath?: string;

  options: PermissionOption[];
  returnStatus: string;
  title: string;
}

interface SudoPromptState {
  command: string;
  passwordLength: number;
  prompt: string;
  returnStatus: string;
}

interface FormattedLine {
  kind:
    | 'blank'
    | 'bullet'
    | 'code'
    | 'conflict-end'
    | 'conflict-sep'
    | 'conflict-start'
    | 'heading'
    | 'numbered'
    | 'paragraph'
    | 'quote'
    | 'table';
  marker?: string;
  table?: MarkdownTableModel;
  text: string;
}

interface MarkdownTableModel {
  columnWidths: number[];
  headers: string[];
  rows: string[][];
}

interface ParsedMarkdownTableBlock {
  nextIndex: number;
  table: MarkdownTableModel;
}

interface InlineSegment {
  kind: 'bold' | 'code' | 'text';
  text: string;
}

interface ModelPickerOption {
  costRating: number;
  current: boolean;
  disabled: boolean;
  group: 'auto' | 'models';
  id: number;
  label: string;
  note: string;
  publicId: number;
}

interface QueuedMessage {
  body: string;
  imageAttachments: ImageAttachment[];
  pastedChunks: PastedChunk[];
}

interface ShellState {
  activeTurnInput: string;
  activeTurnInputPreformatted: boolean;
  agentMode: AgentMode;
  analyzingImages: number;
  generatingImage: boolean;
  approvalCursor: number;
  approvalPrompt: ApprovalPromptState | null;
  approvalScrollOffset: number;
  autoYes: boolean;
  backgroundJobs: BackgroundJobDisplay[];

  notificationsEnabled: boolean;

  terminalFocused: boolean;
  busy: boolean;
  busyPausedAt: number | null;
  busySince: number | null;
  clockNow: number;
  commandCursor: number;
  commandLog: string[];
  contextStatus: string;
  currentModelId: number;
  cursor: number;
  exiting: boolean;
  input: string;
  maxToolSteps: number;
  jobsPickerExpandedId: string | null;
  jobsPickerIndex: number;
  jobsPickerOpen: boolean;

  jobsPickerReturnStatus?: string | null;
  modelPickerIndex: number;
  modelPickerOpen: boolean;
  modelPickerEfforts?: ProjectModelEfforts;
  reasoningEffort: ReasoningEffort;
  shortcutsOpen: boolean;
  skillsPickerIndex: number;
  skillsPickerItems: SkillsPickerItem[];
  skillsPickerOpen: boolean;
  transientStatus: string | null;
  projectRoot: string;
  sessionId: string;
  showSessionId: boolean;
  promptHistory: string[];
  promptHistoryCursor: number | null;
  promptHistoryDraft: string;
  resumePickerFilter: string;
  resumePickerIndex: number;
  resumePickerOpen: boolean;
  resumePickerSessions: SessionMetadata[];
  serverModels: ServerModelInfo[];
  queuedMessage: QueuedMessage | null;
  recoveryStatus?: string;
  usageNotice?: TranscriptEntryDraft | null;
  plan?: 'free' | 'plus' | 'pro';



  turnMessages: TurnMessage[];
  sudoPrompt: SudoPromptState | null;
  status: string;
  exitConfirmUntil: number | null;
  thinkingTitle: string;
  thinkingNotes: string[];
  todos: TodoDisplayItem[];
  tokenUsage: string;
  transcript: TranscriptEntry[];
  transcriptScrollOffset: number;
  turnCounter: number;
  userInputPrompt: UserInputPromptState | null;
  pastedChunks: PastedChunk[];
  imageAttachments: ImageAttachment[];
  workingTools: TranscriptEntryDraft[];
}

interface ShellStore {
  appendEntry: (entry: TranscriptEntryDraft) => number;
  appendEntries: (entries: TranscriptEntryDraft[]) => number[];
  appendWorkingTool: (entry: TranscriptEntryDraft) => void;
  getState: () => ShellState;
  replaceTranscript: (entries: TranscriptEntryDraft[]) => void;
  setState: (nextState: ShellState) => void;
  subscribe: (listener: () => void) => () => void;
  update: (updater: (state: ShellState) => ShellState) => void;
  updateEntry: (id: number, changes: Partial<Omit<TranscriptEntry, 'id'>>) => void;
}

export interface ClientInteractiveOutcome {

  signedOut: boolean;
}

export interface ClientInteractiveOptions {
  authConfig: CliAuthConfig;
  debugUi: {
    showSessionId: boolean;
  };
  plan?: 'free' | 'plus' | 'pro';
  serverModels: ServerModelsResponse;
  serverSessionClient: ServerSessionClient;
  session: SessionState;
  appendPromptHistory: (prompt: string) => void;
  usageText: () => Promise<string>;
  initialPrompt?: string;
}

const TUI_WIDTH_RATIO = 0.95;
const COMMAND_PREVIEW_LINES = 10;
const TRANSCRIPT_DIFF_PREVIEW_LINES = 24;
const WORKING_TOOL_PREVIEW_ITEMS = 4;
const THINKING_NOTE_PREVIEW_ROWS = 3;
const WORKING_TOOL_PREVIEW_ROWS = 3;

export const REPORT_ISSUE_URL = 'https://thegit.ai/report';

export function buildReportTranscriptEntries(
  openedUrl: boolean,
): TranscriptEntryDraft[] {
  return openedUrl
    ? [
        {
          body: `Opening the private bug report form in your browser. If nothing opened, visit:\n\n${REPORT_ISSUE_URL}\n`,
          kind: 'system',
          title: 'Report',
        },
      ]
    : [
        {
          body: `Could not open a browser. Report the bug manually at:\n\n${REPORT_ISSUE_URL}\n`,
          kind: 'error',
          title: 'Report',
        },
      ];
}

export function buildTurnFailureHintEntries(
  cancelled: boolean,
): TranscriptEntryDraft[] {
  if (cancelled) return [];
  return [
    {
      body: 'Something went wrong? Use /report to submit the issue.',
      kind: 'error',
      title: 'Report',
    },
  ];
}
















export function composerAttachmentsAfterCancel(
  queuedAttachments: readonly ImageAttachment[],
  inFlightAttachments: readonly ImageAttachment[],
): ImageAttachment[] {
  const seen = new Set<number>();
  const kept: ImageAttachment[] = [];
  for (const attachment of [...queuedAttachments, ...inFlightAttachments]) {
    if (seen.has(attachment.index)) continue;
    seen.add(attachment.index);
    kept.push(attachment);
  }
  return kept;
}

function getShellWidth(columns: number): number {
  const safeColumns = Math.max(columns, 20);
  const targetWidth = Math.floor(safeColumns * TUI_WIDTH_RATIO);
  return Math.max(20, Math.min(safeColumns - 2, targetWidth));
}

function formatModelLabel(modelId: number, serverModels: ServerModelInfo[]): string {
  return serverModels.find((model) => model.id === modelId)?.label ?? 'Unknown model';
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function filterResumeSessions(
  sessions: SessionMetadata[],
  filter: string,
  serverModels: ServerModelInfo[],
): SessionMetadata[] {
  const q = filter.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((session) => {
    const branch = (session.branch ?? '').toLowerCase();
    const model = formatModelLabel(session.modelId, serverModels).toLowerCase();
    const conversation = session.lastUserMessage.toLowerCase();
    return branch.includes(q) || model.includes(q) || conversation.includes(q);
  });
}

function getEntryColor(kind: TranscriptKind): string {
  switch (kind) {
    case 'assistant':
    case 'diff':
      return 'green';
    case 'error':
      return 'red';
    case 'system':
      return 'yellow';
    case 'tool':
      return 'blue';
    case 'user':
      return 'cyan';
  }
}

function parseInlineSegments(text: string): InlineSegment[] {
  const source = String(text ?? '');
  const segments: InlineSegment[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    if (source.startsWith('**', cursor)) {
      const end = source.indexOf('**', cursor + 2);
      if (end > cursor + 2) {
        segments.push({ kind: 'bold', text: source.slice(cursor + 2, end) });
        cursor = end + 2;
        continue;
      }
    }

    if (source[cursor] === '`') {
      const end = source.indexOf('`', cursor + 1);
      if (end > cursor + 1) {
        segments.push({ kind: 'code', text: source.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }

    let nextCursor = source.length;
    const nextBold = source.indexOf('**', cursor);
    const nextCode = source.indexOf('`', cursor);
    if (nextBold !== -1) nextCursor = Math.min(nextCursor, nextBold);
    if (nextCode !== -1) nextCursor = Math.min(nextCursor, nextCode);
    if (nextCursor === cursor) nextCursor += 1;
    segments.push({ kind: 'text', text: source.slice(cursor, nextCursor) });
    cursor = nextCursor;
  }

  return segments.filter((segment) => segment.text.length > 0);
}

function isEscapedMarkdownPipe(source: string, pipeIndex: number): boolean {
  let slashCount = 0;
  for (let index = pipeIndex - 1; index >= 0 && source[index] === '\\'; index--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = String(line ?? '').trim();
  const withoutLeadingPipe = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const trailingPipeIndex = withoutLeadingPipe.length - 1;
  const hasTrailingBoundaryPipe =
    trailingPipeIndex >= 0 &&
    withoutLeadingPipe[trailingPipeIndex] === '|' &&
    !isEscapedMarkdownPipe(withoutLeadingPipe, trailingPipeIndex);
  const withoutBoundaryPipes = hasTrailingBoundaryPipe
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < withoutBoundaryPipes.length; index++) {
    const char = withoutBoundaryPipes[index] ?? '';
    if (char === '|' && !isEscapedMarkdownPipe(withoutBoundaryPipes, index)) {
      cells.push(cell.trim().replace(/\\\|/g, '|'));
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim().replace(/\\\|/g, '|'));
  return cells;
}

function isMarkdownTableRow(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && String(line ?? '').includes('|');
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function stripInlineFormattingForWidth(text: string): string {
  return String(text ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}

const TRANSCRIPT_BAR_WIDTH = 3;
const TABLE_BORDER_WIDTH = 2;
const TABLE_CELL_OVERHEAD_WIDTH = 3;

function fitTableColumnWidths(columnWidths: number[], maxWidth: number): number[] {
  const widths = columnWidths.map((width) => Math.max(3, Math.floor(width)));
  if (widths.length === 0) return widths;
  const overhead = TABLE_BORDER_WIDTH + widths.length * TABLE_CELL_OVERHEAD_WIDTH;
  const budget = Math.max(widths.length * 3, maxWidth - overhead);
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= budget) return widths;
  let remaining = budget;
  const scaled = widths.map((width) => {
    const next = Math.max(3, Math.floor((width / total) * budget));
    remaining -= next;
    return next;
  });
  while (remaining > 0) {
    let targetIndex = 0;
    for (let index = 1; index < widths.length; index++) {
      if (widths[index] - scaled[index] > widths[targetIndex] - scaled[targetIndex]) {
        targetIndex = index;
      }
    }
    scaled[targetIndex]++;
    remaining--;
  }
  while (remaining < 0) {
    let targetIndex = -1;
    for (let index = 0; index < scaled.length; index++) {
      if (scaled[index] <= 3) continue;
      if (targetIndex === -1 || scaled[index] > scaled[targetIndex]) {
        targetIndex = index;
      }
    }
    if (targetIndex === -1) break;
    scaled[targetIndex]--;
    remaining++;
  }
  return scaled;
}

function normalizeMarkdownTableCells(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? '');
}

function parseMarkdownTableBlock(
  lines: string[],
  startIndex: number,
): ParsedMarkdownTableBlock | null {
  const headerLine = lines[startIndex] ?? '';
  const separatorLine = lines[startIndex + 1] ?? '';
  if (!isMarkdownTableRow(headerLine) || !isMarkdownTableSeparator(separatorLine)) {
    return null;
  }

  const headers = splitMarkdownTableRow(headerLine);
  const separators = splitMarkdownTableRow(separatorLine);
  if (headers.length !== separators.length) {
    return null;
  }

  const columnCount = Math.max(headers.length, separators.length);
  const rows: string[][] = [];
  let nextIndex = startIndex + 2;

  while (nextIndex < lines.length && isMarkdownTableRow(lines[nextIndex] ?? '')) {
    const cells = splitMarkdownTableRow(lines[nextIndex] ?? '');
    if (cells.length !== columnCount) break;
    rows.push(normalizeMarkdownTableCells(cells, columnCount));
    nextIndex++;
  }

  const normalizedHeaders = normalizeMarkdownTableCells(headers, columnCount);
  const columnWidths = normalizedHeaders.map((header, columnIndex) => {
    const values = [header, ...rows.map((row) => row[columnIndex] ?? '')];
    return Math.max(
      3,
      ...values.map((value) => stripInlineFormattingForWidth(value).length),
    );
  });

  return {
    nextIndex,
    table: {
      columnWidths,
      headers: normalizedHeaders,
      rows,
    },
  };
}

function splitFormattedLines(body: string): FormattedLine[] {
  const lines = String(body ?? '').split('\n');
  const formatted: FormattedLine[] = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      formatted.push({ kind: 'code', text: line });
      continue;
    }

    if (!trimmed) {
      formatted.push({ kind: 'blank', text: '' });
      continue;
    }

    if (/^<{3,}/.test(trimmed)) {
      formatted.push({ kind: 'conflict-start', text: trimmed });
      continue;
    }
    if (/^={3,}$/.test(trimmed)) {
      formatted.push({ kind: 'conflict-sep', text: trimmed });
      continue;
    }
    if (/^>{3,}/.test(trimmed)) {
      formatted.push({ kind: 'conflict-end', text: trimmed });
      continue;
    }

    const tableBlock = parseMarkdownTableBlock(lines, index);
    if (tableBlock) {
      formatted.push({ kind: 'table', table: tableBlock.table, text: '' });
      index = tableBlock.nextIndex - 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      formatted.push({ kind: 'heading', text: headingMatch[2] ?? '' });
      continue;
    }

    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numberedMatch) {
      formatted.push({
        kind: 'numbered',
        marker: numberedMatch[1],
        text: numberedMatch[2] ?? '',
      });
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      formatted.push({ kind: 'bullet', text: bulletMatch[1] ?? '' });
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s+(.*)$/);
    if (quoteMatch) {
      formatted.push({ kind: 'quote', text: quoteMatch[1] ?? '' });
      continue;
    }

    formatted.push({ kind: 'paragraph', text: line });
  }

  return formatted;
}
function parseDiffPreview(patchText: string): DiffPreviewModel {
  const lines = String(patchText ?? '').split('\n');
  const previewLines: DiffPreviewLine[] = [];
  let added = 0;
  let removed = 0;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const rawLine of lines) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      previewLines.push({ kind: 'hunk', lineNumber: null, content: rawLine });
      continue;
    }
    if (rawLine.startsWith('@@')) {
      previewLines.push({ kind: 'hunk', lineNumber: null, content: rawLine });
      continue;
    }
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      continue;
    }
    if (rawLine === '\\ No newline at end of file') {
      continue;
    }
    if (rawLine.startsWith('+')) {
      added++;
      previewLines.push({ kind: 'add', lineNumber: newLine, content: rawLine.slice(1) });
      if (newLine !== null) newLine++;
      continue;
    }
    if (rawLine.startsWith('-')) {
      removed++;
      previewLines.push({ kind: 'remove', lineNumber: oldLine, content: rawLine.slice(1) });
      if (oldLine !== null) oldLine++;
      continue;
    }
    const content = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
    previewLines.push({ kind: 'context', lineNumber: newLine ?? oldLine, content });
    if (oldLine !== null) oldLine++;
    if (newLine !== null) newLine++;
  }

  return { added, lines: previewLines, removed };
}

function diffLineColor(kind: DiffPreviewLine['kind']): string {
  switch (kind) {
    case 'add':
      return 'green';
    case 'remove':
      return 'red';
    case 'hunk':
      return 'cyan';
    case 'context':
      return 'gray';
  }
}

function diffLinePrefix(kind: DiffPreviewLine['kind']): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'remove':
      return '-';
    case 'hunk':
    case 'context':
      return ' ';
  }
}

function splitDiffLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return text.endsWith('\n') && lines[lines.length - 1] === ''
    ? lines.slice(0, -1)
    : lines;
}

function buildStrReplaceDiff(oldString: string, newString: string): string {
  const oldLines = splitDiffLines(String(oldString ?? ''));
  const newLines = splitDiffLines(String(newString ?? ''));
  const lines = [`@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  if (oldLines.length > 0) lines.push(oldLines.map((line) => `-${line}`).join('\n'));
  if (newLines.length > 0) lines.push(newLines.map((line) => `+${line}`).join('\n'));
  return lines.join('\n');
}

function buildWriteFileDiff(content: string): string {
  const lines = splitDiffLines(String(content ?? ''));
  if (lines.length === 0) return '';
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
}

const MAX_DELETE_PREVIEW_LINES = 400;








function buildDeleteFileDiff(content: string): { removed: number; text: string } {
  const lines = splitDiffLines(String(content ?? ''));
  if (lines.length === 0) {
    return { removed: 0, text: '' };
  }
  const shown = lines.slice(0, MAX_DELETE_PREVIEW_LINES);
  const rows = [
    `@@ -1,${lines.length} +0,0 @@`,
    ...shown.map((line) => `-${line}`),
  ];
  const omitted = lines.length - shown.length;
  if (omitted > 0) {
    rows.push(`@@ ${omitted} more removed line(s) not shown @@`);
  }
  return { removed: lines.length, text: rows.join('\n') };
}






function deletedFileSummary(
  result: { bytes?: unknown; contentOmitted?: unknown } | null | undefined,
): string {
  const bytes = typeof result?.bytes === 'number' ? result.bytes : null;
  if (bytes === null) {
    return '';
  }
  const reason = result?.contentOmitted === 'binary' ? ', binary' : '';
  return ` (${formatFileSize(bytes)}${reason})`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function isFileChangeTool(name: string): boolean {
  return (
    name === 'patch_file' ||
    name === 'str_replace' ||
    name === 'write_file' ||
    name === 'delete_file' ||
    name === 'undo_edit'
  );
}

function getToolFilePath(call: ToolCall, result: any): string {
  return String(
    call.args?.filePath ??
      call.args?.file_path ??
      result?.filePath ??
      '',
  ).trim();
}



function formatToolResultState(result: any): string {
  return result?.skipped ? 'Skipped' : 'OK';
}

function formatRunCommandResultState(result: any): string {
  if (result?.timedOut) return 'Timed out';
  if (result?.exitCode != null) return `Exit code ${result.exitCode}`;
  return formatToolResultState(result);
}

function formatToolArgs(call: ToolCall, result: any): string {
  const filePath = getToolFilePath(call, result);
  if (filePath) return filePath;
  if (call.name === 'search_code' || call.name === 'grep_code') {
    return truncate(String(call.args?.query ?? call.args?.pattern ?? ''), 120);
  }
  if (call.name === 'thegitai_web_fetch') {
    return truncate(String(call.args?.url ?? ''), 120);
  }
  if (call.name === 'thegitai_web_search') {
    return truncate(String(call.args?.query ?? ''), 120);
  }
  return '';
}

function buildFileChangeEntry(event: ToolTranscriptEvent): TranscriptEntryDraft {
  const { call, result } = event;
  const filePath = getToolFilePath(call, result) || '(unknown file)';
  const ok = result?.ok === true;
  const skipped = result?.skipped === true;
  const error =
    typeof result?.error === 'string' && result.error.trim()
      ? truncate(result.error.trim(), 180)
      : '';

  if (!ok) {
    const verb =
      call.name === 'delete_file'
        ? 'Delete'
        : call.name === 'undo_edit'
          ? 'Undo'
          : 'Edit';
    if (skipped) {
      return {
        body: error || `${call.name} ${filePath}`,
        filePath,
        kind: 'system',
        title: `${verb} skipped: ${filePath}`,
      };
    }


    return { body: '', filePath, kind: 'system', title: `${verb}: ${filePath}` };
  }




  if (result?.scratch === true) {
    const scratchName = truncate(
      filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath,
      72,
    );
    if (call.name === 'delete_file') {
      return {
        body: '',
        filePath,
        kind: 'tool',
        title:
          result?.deleted === true
            ? `Removed scratch file: ${scratchName}`
            : `Scratch delete skipped: ${scratchName}`,
      };
    }
    const content =
      typeof call.args?.content === 'string' ? call.args.content : '';
    const lineSummary =
      call.name === 'write_file' && content
        ? ` (${splitDiffLines(content).length} lines)`
        : '';
    return {
      body: '',
      filePath,
      kind: 'tool',
      title:
        call.name === 'write_file'
          ? `Wrote scratch file: ${scratchName}${lineSummary}`
          : `Edited scratch file: ${scratchName}`,
    };
  }

  if (call.name === 'undo_edit') {
    const dryRun =
      result?.dryRun === true ||
      result?.dry_run === true ||
      call.args?.dryRun === true ||
      call.args?.dry_run === true;
    const records =
      dryRun && Array.isArray(result?.previewed)
        ? result.previewed
        : Array.isArray(result?.reverted)
          ? result.reverted
          : [];
    const files: string[] = records
      .map((record: any) => String(record?.filePath ?? '').trim())
      .filter((file: string) => Boolean(file));
    const uniqueFiles = Array.from(new Set<string>(files));
    const titleFile =
      uniqueFiles.length === 1 ? uniqueFiles[0] : `${uniqueFiles.length} files`;
    return {
      body: '',
      filePath: uniqueFiles[0] ?? filePath,
      kind: 'tool',
      title: dryRun
        ? `Undo preview: ${titleFile}`
        : `Undid assistant edit: ${titleFile}`,
    };
  }

  if (call.name === 'delete_file') {
    if (result?.deleted !== true) {
      return {
        body: '',
        filePath,
        kind: skipped ? 'system' : 'tool',
        title: `Delete skipped: ${filePath}`,
      };
    }
    const content = typeof result?.content === 'string' ? result.content : '';
    const diff = buildDeleteFileDiff(content);
    const preview = diff.text ? parseDiffPreview(diff.text) : undefined;
    const summary = preview
      ? ` (+0 -${diff.removed})`
      : deletedFileSummary(result);
    return {
      body: '',
      diffPreview: preview,
      filePath,
      kind: 'diff',
      title: `Deleted ${filePath}${summary}`,
    };
  }

  if (call.name === 'write_file') {
    const content = typeof call.args?.content === 'string' ? call.args.content : '';
    const diffText = buildWriteFileDiff(content);
    const preview = diffText ? parseDiffPreview(diffText) : undefined;
    const verb = result?.created === true ? 'Created' : 'Wrote';
    const summary = preview ? ` (+${preview.added} -0)` : '';
    return {
      body: '',
      diffPreview: preview,
      filePath,
      kind: 'diff',
      title: `${verb} ${filePath}${summary}`,
    };
  }

  let diffText = '';
  if (call.name === 'patch_file') {
    diffText = typeof call.args?.patch === 'string' ? call.args.patch : '';
  } else if (call.name === 'str_replace') {
    const oldString = typeof call.args?.old_string === 'string'
      ? call.args.old_string
      : typeof call.args?.oldString === 'string'
        ? call.args.oldString
        : '';
    const newString = typeof call.args?.new_string === 'string'
      ? call.args.new_string
      : typeof call.args?.newString === 'string'
        ? call.args.newString
        : '';
    diffText = buildStrReplaceDiff(oldString, newString);
  }

  const preview = diffText ? parseDiffPreview(diffText) : undefined;
  const summary = preview ? ` (+${preview.added} -${preview.removed})` : '';
  return {
    body: '',
    diffPreview: preview,
    filePath,
    kind: 'diff',
    title: `Edited ${filePath}${summary}`,
  };
}

export function buildWorkingToolEntry(event: ToolTranscriptEvent, label = event.call.name): TranscriptEntryDraft {
  const { call, result } = event;


  const failed = result?.ok !== true && result?.skipped !== true;
  const kind = result?.ok === true ? 'tool' : 'system';
  const state = (text: string) => (failed ? '' : text);
  const error =
    !failed && typeof result?.error === 'string' && result.error.trim()
      ? `\n${truncate(result.error.trim(), 180)}`
      : '';

  if (call.name === 'run_command') {
    const command = String(call.args?.command ?? result?.command ?? '').trim();
    if (result?.backgrounded === true && result?.jobId) {
      return {
        body: `$ ${truncate(command, 180)}${state(`\nBackground job ${String(result.jobId)} started.`)}${error}`,
        kind,
        preformatted: true,
        title: 'Shell',
      };
    }
    return {
      body: `$ ${truncate(command, 180)}${state(`\n${formatRunCommandResultState(result)}`)}${error}`,
      kind,
      title: 'Shell',
    };
  }

  if (call.name === 'shell_job_output' || call.name === 'shell_job_kill') {
    const jobId = String(result?.jobId ?? call.args?.job_id ?? '').trim();
    const status = String(result?.status ?? '').trim();
    const exitCode = result?.exitCode;
    const stateText = status
      ? `${status}${exitCode != null ? ` (code ${exitCode})` : ''}`
      : formatToolResultState(result);
    return {
      body: `${jobId || '(unknown job)'}${state(` · ${stateText}`)}${error}`,
      kind,
      title: call.name === 'shell_job_kill' ? 'Kill job' : 'Job output',
    };
  }

  if (call.name === 'use_skill') {
    const name = String(result?.name ?? call.args?.name ?? '').trim().replace(/^\//, '');
    return {
      body: `/${name || 'skill'}${state(result?.alreadyLoaded === true ? ' · already loaded' : ' · loaded')}`,
      kind,
      title: 'Skill',
    };
  }

  if (call.name === 'run_node_script') {
    return {
      body: `node --input-type=module <script via stdin>${state(`\n${formatRunCommandResultState(result)}`)}${error}`,
      kind,
      title: 'Node',
    };
  }

  if (isFileChangeTool(call.name)) {
    return buildFileChangeEntry(event);
  }

  const args = formatToolArgs(call, result);
  return {
    body: `${label}${args ? ` ${args}` : ''}${state(` -> ${formatToolResultState(result)}`)}${error}`,
    kind,
    title: 'Tool',
  };
}

function buildBackgroundJobNoticeEntry(
  snapshot: BackgroundJobSnapshot,
): TranscriptEntryDraft {
  const command = truncate(snapshot.command, 120);
  const ran = formatJobElapsed(
    (snapshot.endedAt ?? Date.now()) - snapshot.startedAt,
  );
  if (snapshot.status === 'error') {
    return {
      body: `✖ ${snapshot.id} (${command}) failed to start`,
      kind: 'error',
      preformatted: true,
      title: 'Background job',
    };
  }
  if (snapshot.status === 'killed') {
    return {
      body: `■ ${snapshot.id} (${command}) killed · ran ${ran}`,
      kind: 'system',
      preformatted: true,
      title: 'Background job',
    };
  }
  return {
    body: `${snapshot.exitCode === 0 ? '✓' : '✖'} ${snapshot.id} (${command}) exited (code ${snapshot.exitCode ?? 1}) · ran ${ran}`,
    kind: snapshot.exitCode === 0 ? 'system' : 'error',
    preformatted: true,
    title: 'Background job',
  };
}

function findPendingToolCallByName(
  pendingCalls: Map<string, ToolCall>,
  name: string,
): ToolCall | null {
  for (const [id, call] of pendingCalls) {
    if (call.name !== name) continue;
    pendingCalls.delete(id);
    return call;
  }
  return null;
}

function textFromHistoryEntry(entry: ChatMessage): string {
  return (entry.parts ?? [])
    .filter((part: any) => typeof part?.text === 'string' && part.text.trim())
    .map((part: any) => part.text.trim())
    .join('\n\n');
}

function displayUserTextFromHistoryEntry(entry: ChatMessage): string {
  const text = textFromHistoryEntry(entry);
  const markers = [
    'Current user request:\n',
    'Current user message:\n',
    'User request:\n',
    'User message:\n',
  ];
  const marker = markers.find((candidate) => text.includes(candidate)) ?? '';
  if (!marker) return text;
  const start = text.indexOf(marker);
  const contentStart = start + marker.length;
  const contentEnd = text.indexOf('\n\n', contentStart);
  return text
    .slice(contentStart, contentEnd === -1 ? text.length : contentEnd)
    .trim();
}

export function buildTranscriptFromSessionHistory(
  history: ChatMessage[],
): TranscriptEntryDraft[] {
  const entries: TranscriptEntryDraft[] = [];
  const pendingCalls = new Map<string, ToolCall>();
  const pendingUserInputRequests = new Map<string, UserInputQuestion[]>();
  for (const entry of history) {
    if (!entry?.parts?.length) continue;
    for (const part of entry.parts) {
      const userInputRequest = part?.userInputRequest;
      if (userInputRequest && typeof userInputRequest === 'object') {
        const requestId = String(userInputRequest.requestId ?? '').trim();
        if (requestId && Array.isArray(userInputRequest.questions)) {
          pendingUserInputRequests.set(
            requestId,
            userInputRequest.questions as UserInputQuestion[],
          );
        }
      }
      const call = part?.functionCall;
      if (!call || typeof call !== 'object') continue;
      const callId = String(call.id ?? '').trim();
      if (!callId || !call.name) continue;
      pendingCalls.set(callId, call as ToolCall);
    }
    for (const part of entry.parts) {
      const userInputResult = part?.userInputResult;
      if (userInputResult && typeof userInputResult === 'object') {
        const requestId = String(userInputResult.requestId ?? '').trim();
        const questions = pendingUserInputRequests.get(requestId);
        const result = userInputResult.result as UserInputResult | undefined;
        if (
          questions &&
          (result?.status === 'submitted' || result?.status === 'cancelled')
        ) {
          pendingUserInputRequests.delete(requestId);
          entries.push({
            body: formatUserInputTranscript(questions, result),
            kind: result.status === 'submitted' ? 'user' : 'system',
            title: result.status === 'submitted' ? 'Your answers' : 'Question',
          });
        }
      }
      const functionResponse = part?.functionResponse;
      if (!functionResponse || typeof functionResponse !== 'object') continue;
      const responseName = String(functionResponse.name ?? '').trim();
      const responseId = String(
        functionResponse.id ?? functionResponse.toolCallId ?? '',
      ).trim();
      let call: ToolCall | null = null;
      if (responseId) {
        call = pendingCalls.get(responseId) ?? null;
        if (call) pendingCalls.delete(responseId);
      }
      if (!call && responseName) {
        call = findPendingToolCallByName(pendingCalls, responseName);
      }
      if (!call || !isFileChangeTool(call.name)) continue;
      const result = (functionResponse.response ?? {}) as { ok?: boolean; skipped?: boolean };

      if (result.ok !== true && result.skipped !== true) continue;
      entries.push(buildFileChangeEntry({ call, result }));
    }
    if (entry.role === 'user' && entry.kind === 'turnStart') {
      const text = displayUserTextFromHistoryEntry(entry);
      if (text) {
        entries.push({ body: text, kind: 'user', title: 'You' });
      }
      continue;
    }
    if (entry.role === 'user' && entry.kind === 'userInterjection') {
      const text = String(entry.userInput ?? '').trim();
      if (text) {
        entries.push({ body: text, kind: 'user', title: 'You · sent mid-turn' });
      }
      continue;
    }
    const text = textFromHistoryEntry(entry);
    if ((entry.role === 'model' || entry.role === 'assistant') && text) {
      if (isTurnFailureMarker(text)) {
        entries.push({
          body: 'This request did not complete.',
          kind: 'system',
          title: 'Previous turn',
        });
        continue;
      }
      entries.push({ body: text, kind: 'assistant', title: 'Response' });
    }
  }
  return entries;
}

function createInitialTranscript(): TranscriptEntryDraft[] {
  return [
    {
      body: 'Interactive mode ready. Type /help for commands.',
      kind: 'system',
      title: 'System',
    },
  ];
}

function createSessionTranscript(session: SessionState): TranscriptEntryDraft[] {
  const transcript = buildTranscriptFromSessionHistory(session.history);
  return transcript.length ? transcript : createInitialTranscript();
}






export function isJobsPickerCommand(input: string): boolean {
  return String(input ?? '').trim() === '/jobs';
}




interface JobsPickerStatusFields {
  jobsPickerOpen: boolean;
  jobsPickerReturnStatus?: string | null;
  status: string;
}

interface ClosedJobsPickerFields {
  jobsPickerExpandedId?: null;
  jobsPickerOpen?: false;
  jobsPickerReturnStatus?: null;
}

export function statusBehindJobsPicker(state: JobsPickerStatusFields): string {
  return state.jobsPickerOpen
    ? (state.jobsPickerReturnStatus ?? 'Ready')
    : state.status;
}





export function closedJobsPickerFields(
  state: JobsPickerStatusFields,
): ClosedJobsPickerFields {
  if (!state.jobsPickerOpen) return {};
  return {
    jobsPickerExpandedId: null,
    jobsPickerOpen: false,
    jobsPickerReturnStatus: null,
  };
}

export function createShellStore(initialState: ShellState): ShellStore {
  let state = initialState;
  let nextEntryId = 1;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setState = (nextState: ShellState) => {
    state = nextState.busy ? nextState : { ...nextState, usageNotice: null };
    notify();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState,
    update: (updater) => setState(updater(state)),
    appendEntry: (entry) => {
      const id = nextEntryId++;
      state = {
        ...state,
        transcript: [...state.transcript, { ...entry, id }],
        transcriptScrollOffset: 0,
      };
      notify();
      return id;
    },
    appendEntries: (entries) => {
      if (entries.length === 0) return [];
      const appended = entries.map((entry) => ({
        ...entry,
        id: nextEntryId++,
      }));
      state = {
        ...state,
        transcript: [...state.transcript, ...appended],
        transcriptScrollOffset: 0,
      };
      notify();
      return appended.map((entry) => entry.id);
    },
    appendWorkingTool: (entry) => {
      const lastEntry = state.workingTools.at(-1);
      const isDuplicate = sameTranscriptDraft(lastEntry, entry);





      if (isDuplicate && state.commandLog.length === 0) {
        return;
      }
      state = {
        ...state,
        commandLog: [],
        workingTools: isDuplicate
          ? state.workingTools
          : [...state.workingTools, entry].slice(-WORKING_TOOL_PREVIEW_ITEMS),
      };
      notify();
    },
    replaceTranscript: (entries) => {
      state = {
        ...state,
        transcript: entries.map((entry) => ({ ...entry, id: nextEntryId++ })),
        transcriptScrollOffset: 0,
        workingTools: [],
      };
      notify();
    },
    updateEntry: (id, changes) => {
      const index = state.transcript.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      const current = state.transcript[index]!;
      const next = { ...current, ...changes };
      if (
        current.body === next.body &&
        current.kind === next.kind &&
        current.title === next.title
      ) {
        return;
      }
      const nextTranscript = [...state.transcript];
      nextTranscript[index] = next;
      state = { ...state, transcript: nextTranscript };
      notify();
    },
  };
}

function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

function createInitialShellState(
  session: SessionState,
  serverModels: ServerModelsResponse,
  debugUi: ClientInteractiveOptions['debugUi'],
  serverUrl: string,
): ShellState {
  return {
    activeTurnInput: '',
    activeTurnInputPreformatted: false,
    agentMode: session.agentMode,
    analyzingImages: 0,
    generatingImage: false,
    approvalCursor: 0,
    approvalPrompt: null,
    approvalScrollOffset: 0,
    autoYes: session.autoYes,
    backgroundJobs: [],
    busy: false,
    busyPausedAt: null,
    busySince: null,
    clockNow: Date.now(),
    commandCursor: 0,
    commandLog: [],
    contextStatus: 'Idle',
    currentModelId: session.modelId,
    reasoningEffort: projectModelEffort(readProjectModelEfforts(session.rootDir, serverUrl, session.env), session.modelId),
    cursor: 0,
    exiting: false,
    input: '',
    maxToolSteps: session.maxToolSteps,
    notificationsEnabled: readPreferences(session.env).notifications,
    terminalFocused: INITIAL_TERMINAL_FOCUS,
    jobsPickerExpandedId: null,
    jobsPickerIndex: 0,
    jobsPickerOpen: false,
    modelPickerIndex: getDefaultModelPickerIndex(session.modelId, serverModels.models),
    modelPickerOpen: false,
    shortcutsOpen: false,
    skillsPickerIndex: 0,
    skillsPickerItems: [],
    skillsPickerOpen: false,
    transientStatus: null,
    projectRoot: session.rootDir,
    sessionId: session.sessionId,
    showSessionId: debugUi.showSessionId,
    promptHistory: loadPromptHistory(session.env),
    promptHistoryCursor: null,
    promptHistoryDraft: '',
    resumePickerFilter: '',
    resumePickerIndex: 0,
    resumePickerOpen: false,
    resumePickerSessions: [],
    transcriptScrollOffset: 0,
    queuedMessage: null,
    turnMessages: [],
    serverModels: serverModels.models,
    sudoPrompt: null,
    status: 'Ready',
    exitConfirmUntil: null,
    thinkingTitle: '',
    thinkingNotes: [],
    todos: listTodos(),
    tokenUsage: formatClientTokenUsage(null),
    transcript: [],
    turnCounter: Math.max(0, session.history.filter((entry) => entry.role === 'user').length),
    userInputPrompt: null,
    pastedChunks: [],
    imageAttachments: [],
    workingTools: [],
  };
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
}

export function formatClientTokenUsage(
  _responseTimeMs: number | null,
  usageSummary: ChatUsageSummary | null = null,
): string {
  if (!usageSummary) return '';
  const inputTokens = usageSummary?.inputTokens ?? 0;
  const outputTokens = usageSummary?.outputTokens ?? 0;
  const reasoningTokens = usageSummary?.reasoningTokens ?? 0;
  const cacheTokens = usageSummary?.cacheTokens ?? 0;
  const cacheWriteTokens = usageSummary?.cacheWriteTokens ?? 0;
  return [
    'Session tokens',
    `in ${formatTokenCount(inputTokens)}`,
    `out ${formatTokenCount(outputTokens)}`,
    ...(reasoningTokens > 0 ? [`think ${formatTokenCount(reasoningTokens)}`] : []),
    `cache ${formatTokenCount(cacheTokens)}`,
    `write ${formatTokenCount(cacheWriteTokens)}`,
  ].join(' • ');
}

export function formatPromptDirectoryLabel(
  projectRoot: string,
  homeDir = process.env.HOME ?? '',
): string {
  const trimmed = String(projectRoot ?? '').trim();
  if (!trimmed) return '.';
  const normalizedHome = String(homeDir ?? '').trim().replace(/\/+$/, '');
  if (normalizedHome && trimmed === normalizedHome) return '~';
  if (normalizedHome && trimmed.startsWith(`${normalizedHome}/`)) {
    return `~/${trimmed.slice(normalizedHome.length + 1)}`;
  }
  return trimmed;
}

export function formatPromptSessionIdLabel(
  showSessionId: boolean,
  sessionId: string,
): string {
  return showSessionId ? String(sessionId ?? '').trim() : '';
}

function thinkingNoteFromStatus(status: string): string | null {
  const text = String(status ?? '').trim();
  if (!text.startsWith('Thinking:')) return null;
  const note = text.slice('Thinking:'.length).trim();
  return note ? note : null;
}






function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1');
}






function splitThinkingLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'Thinking')
    .flatMap((line) =>
      line
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`])/)
        .map((part) => part.trim())
        .filter(Boolean),
    );
}




const LIVE_STATUS_PANEL_MAX_CHARS = 72;




const TOOL_PROGRESS_STATUS_PATTERN = /^(?:Tool:\s|Running\s\S+(?:\slocally)?\.\.\.$)/i;

export function isToolProgressStatus(status: string): boolean {
  return TOOL_PROGRESS_STATUS_PATTERN.test(String(status ?? '').trim());
}




function holdOrPickFallback(currentTitle: string): string {
  return (THINKING_FALLBACK_PHRASES as readonly string[]).includes(
    currentTitle.trim(),
  )
    ? currentTitle
    : pickThinkingFallbackPhrase();
}

function liveStatusPanelTitle(status: string): string {
  const text = String(status ?? '').trim();
  if (!text || text.includes('\n')) return '';
  if (isToolProgressStatus(text)) return '';
  return text.length <= LIVE_STATUS_PANEL_MAX_CHARS ? text : '';
}

function thinkingPanelFromStatus(
  status: string,
): { title: string; notes: string[] } | null {
  const rawText = thinkingNoteFromStatus(status);
  if (!rawText) return null;
  const text = stripMarkdownEmphasis(rawText);
  const rawLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length === 0) return null;
  if (rawLines.length === 1 && rawLines[0].length <= 72) {
    return {
      title: rawLines[0],
      notes: [],
    };
  }
  const title =
    rawLines.length > 1 && rawLines[0].length <= 72
      ? rawLines[0]
      : 'Thinking';
  const bodyLines =
    rawLines.length > 1 && rawLines[0].length <= 72 ? rawLines.slice(1) : rawLines;
  return {
    title,




    notes: splitThinkingLines(bodyLines.join('\n')).slice(0, 3),
  };
}

export const EXIT_CTRL_C_CONFIRM_MESSAGE = 'Press Ctrl+C again to quit.';
export const EXIT_CTRL_C_CONFIRM_MS = 3000;

export function isExitConfirmActive(
  exitConfirmUntil: number | null,
  now = Date.now(),
): boolean {
  return exitConfirmUntil != null && now < exitConfirmUntil;
}

interface CommandPaletteState {
  busy: boolean;
  exiting: boolean;
  input: string;
  modelPickerOpen: boolean;
  resumePickerOpen: boolean;
}

function shouldShowCommandPalette(state: CommandPaletteState): boolean {
  const trimmed = String(state.input ?? '').trim();
  return (
    !state.busy &&
    !state.exiting &&
    !state.modelPickerOpen &&
    !state.resumePickerOpen &&
    trimmed.startsWith('/') &&



    !String(state.input ?? '').includes(' ') &&



    getInputCommandToken(trimmed) !== '' &&


    getSlashCommandSuggestions(trimmed).length > 0
  );
}

export function shouldRemountLiveFrameForComposerInputChange(
  current: {
    busy: boolean;
    exiting: boolean;
    input: string;
    modelPickerOpen: boolean;
    resumePickerOpen: boolean;
  },
  nextInput: string,
): boolean {
  const currentShowsCommands = shouldShowCommandPalette(current);
  const nextShowsCommands = shouldShowCommandPalette({
    ...current,
    input: nextInput,
  });
  return currentShowsCommands !== nextShowsCommands;
}

export function applySlashCommandSuggestion(
  currentInput: string,
  suggestion: SlashCommandOption,
): Pick<ShellState, 'cursor' | 'input'> {
  const token = getInputCommandToken(currentInput);
  const command = isSkillSlashCommand(suggestion) ? `${suggestion.command} ` : suggestion.command;
  if (!token) {
    return { cursor: command.length, input: command };
  }
  const tokenStart = currentInput.indexOf(token);
  const before = currentInput.slice(0, tokenStart);
  const after = currentInput.slice(tokenStart + token.length);
  const inserted = after.startsWith(' ') ? suggestion.command : command;
  return {
    cursor: before.length + inserted.length,
    input: `${before}${inserted}${after}`,
  };
}

export function insertAtCursor(
  state: ShellState,
  text: string,
): Pick<ShellState, 'cursor' | 'input'> {
  const before = state.input.slice(0, state.cursor);
  const after = state.input.slice(state.cursor);
  return {
    cursor: state.cursor + text.length,
    input: `${before}${text}${after}`,
  };
}

export function deleteBeforeCursor(
  state: ShellState,
): Pick<ShellState, 'cursor' | 'input'> | null {
  if (state.cursor <= 0) return null;
  return {
    cursor: state.cursor - 1,
    input: `${state.input.slice(0, state.cursor - 1)}${state.input.slice(state.cursor)}`,
  };
}

export function deleteAtCursor(
  state: ShellState,
): Pick<ShellState, 'cursor' | 'input'> | null {
  if (state.cursor >= state.input.length) return null;
  return {
    cursor: state.cursor,
    input: `${state.input.slice(0, state.cursor)}${state.input.slice(state.cursor + 1)}`,
  };
}

function appendPromptToHistory(history: string[], prompt: string): string[] {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.startsWith('/')) return history;
  const last = history[history.length - 1];
  if (last === trimmed) return history;
  const next = [...history.filter((entry) => entry !== trimmed), trimmed];
  if (next.length > MAX_PROMPT_HISTORY_ENTRIES) {
    next.splice(0, next.length - MAX_PROMPT_HISTORY_ENTRIES);
  }
  return next;
}

export function navigatePromptHistory(
  state: ShellState,
  direction: 'next' | 'previous',
): ShellState {
  if (state.promptHistory.length === 0) return state;
  if (direction === 'previous') {
    const nextCursor =
      state.promptHistoryCursor === null
        ? state.promptHistory.length - 1
        : Math.max(state.promptHistoryCursor - 1, 0);
    const draft =
      state.promptHistoryCursor === null ? state.input : state.promptHistoryDraft;
    const nextInput = state.promptHistory[nextCursor] ?? '';
    return {
      ...state,
      commandCursor: 0,
      cursor: nextInput.length,
      input: nextInput,
      promptHistoryCursor: nextCursor,
      promptHistoryDraft: draft,
    };
  }
  if (state.promptHistoryCursor === null) return state;
  const nextCursor = state.promptHistoryCursor + 1;
  if (nextCursor >= state.promptHistory.length) {
    const restored = state.promptHistoryDraft;
    return {
      ...state,
      commandCursor: 0,
      cursor: restored.length,
      input: restored,
      promptHistoryCursor: null,
      promptHistoryDraft: '',
    };
  }
  const nextInput = state.promptHistory[nextCursor] ?? '';
  return {
    ...state,
    commandCursor: 0,
    cursor: nextInput.length,
    input: nextInput,
    promptHistoryCursor: nextCursor,
  };
}

export function getDefaultApprovalCursor(optionCount: number): number {


  return Math.max(0, optionCount - 1);
}

export function getNextApprovalCursor(
  currentIndex: number,
  direction: -1 | 1,
  optionCount: number,
): number {
  if (optionCount <= 0) return 0;
  return (currentIndex + direction + optionCount) % optionCount;
}

export interface BusyClock {
  busyPausedAt: number | null;
  busySince: number | null;
}








export function pauseBusyClock<T extends BusyClock>(state: T, nowMs: number): T {
  if (state.busySince === null || state.busyPausedAt !== null) return state;
  return { ...state, busyPausedAt: nowMs };
}

export function resumeBusyClock<T extends BusyClock>(state: T, nowMs: number): T {
  if (state.busyPausedAt === null) return state;
  return {
    ...state,
    busyPausedAt: null,
    busySince:
      state.busySince === null
        ? null
        : state.busySince + Math.max(0, nowMs - state.busyPausedAt),
  };
}

export function busyElapsedMs(state: BusyClock, nowMs: number): number | null {
  if (state.busySince === null) return null;
  return Math.max(0, (state.busyPausedAt ?? nowMs) - state.busySince);
}

export function busyElapsedSeconds(state: BusyClock, nowMs: number): number {
  return Math.floor((busyElapsedMs(state, nowMs) ?? 0) / 1000);
}

export function buildModelPickerOptions(
  currentModelId: number,
  serverModels: ServerModelInfo[],
): ModelPickerOption[] {
  const listed = serverModels.filter((model) => model.locked !== 'auto-only');
  return [
    ...listed.filter((model) => model.auto),
    ...listed.filter((model) => !model.auto),
  ].map((model) => ({
    id: model.id,
    label: model.auto ? autoOptionLabel(model.label) : model.label,
    publicId: model.id,
    costRating: model.costRating,
    current: model.id === currentModelId,
    disabled: Boolean(model.locked),
    group: model.auto ? 'auto' : 'models',
    note: model.locked ? MODEL_LOCK_NOTES[model.locked] : model.description,
  }));
}

export function pausedModelCount(serverModels: ServerModelInfo[]): number {
  return serverModels.filter((model) => model.locked === 'auto-only').length;
}

export async function modelsForSwitch(
  requestedModelId: number,
  cached: ServerModelsResponse,
  refresh: () => Promise<ServerModelsResponse>,
): Promise<ServerModelsResponse> {
  try {
    return await refresh();
  } catch (error) {
    if (cached.models.some((model) => model.id === requestedModelId)) return cached;
    throw error;
  }
}

export const PAUSED_MODELS_NOTE = 'Named models return when your plan renews.';

function autoOptionLabel(label: string): string {
  return /^Auto \((.+)\)$/.exec(label)?.[1] ?? label;
}

const MODEL_LOCK_NOTES: Record<ModelLock, string> = {
  plan: 'Needs a Plus or Pro plan',
  'auto-only': 'Auto options only until your plan renews',
};

export function modelLockMessage(model: Pick<ServerModelInfo, 'label' | 'locked'>): string {
  if (model.locked === 'auto-only') {
    return `Only Auto options run until your plan renews. Pick one of them instead of ${pickerLabel(model.label)}.`;
  }
  return `${pickerLabel(model.label)} needs a Plus or Pro plan.`;
}

function pickerLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '');
}

function getDefaultModelPickerIndex(
  currentModelId: number,
  serverModels: ServerModelInfo[],
): number {
  const options = buildModelPickerOptions(currentModelId, serverModels);
  const currentIndex = options.findIndex((option) => option.id === currentModelId);
  return currentIndex === -1 ? 0 : currentIndex;
}

export function getNextModelPickerIndex(
  options: ModelPickerOption[],
  currentIndex: number,
  direction: -1 | 1,
): number {
  if (!options.length) return 0;
  return (currentIndex + direction + options.length) % options.length;
}

export const TranscriptEntryCard = {
  render: renderTranscriptEntryLines,
  memoized: true,
};

function appendCommandLog(state: ShellState, text: string): ShellState {
  const parts = text.replace(/\r\n?/g, '\n').split('\n');
  const complete = parts.filter((line) => line.trim().length > 0);
  if (complete.length === 0) return state;
  return {
    ...state,
    commandLog: [...state.commandLog, ...complete].slice(-COMMAND_PREVIEW_LINES),
  };
}

async function saveSessionBoth({
  serverSessionClient,
  session,
}: {
  serverSessionClient: ServerSessionClient;
  session: SessionState;
}): Promise<void> {
  if (!sessionHasUserMessage(session)) return;
  saveSessionState(session);
  await serverSessionClient.save(session);
}

export async function runClientInteractive({
  appendPromptHistory,
  authConfig,
  debugUi,
  plan,
  serverModels,
  serverSessionClient,
  session,
  usageText,
  initialPrompt,
}: ClientInteractiveOptions): Promise<ClientInteractiveOutcome> {
  if (process.stdin.isTTY !== true) {
    throw new Error('stdin is not a terminal');
  }
  if (process.stdout.isTTY !== true) {
    throw new Error('stdout is not a terminal');
  }

  let fatalError: Error | null = null;
  let signedOut = false;
  await withTuiMode(async () => {
    setBackgroundJobSession(session.sessionId);
    setScratchSession(session.sessionId);
    setImageStoreSession(session.sessionId);
    setTodoSession(session.sessionId);
    const store = createShellStore({
      ...createInitialShellState(session, serverModels, debugUi, authConfig.serverUrl),
      plan,
    });
    store.replaceTranscript(createSessionTranscript(session));
    let currentServerModels = serverModels;
    let sessionAutoYes = session.autoYes;
    let resolveDone: (() => void) | null = null;
    let resolvePermissionDecision:
      | ((decision: PermissionDecision) => void)
      | null = null;
    let resolveSudoPassword: ((password: string | null) => void) | null = null;
    let pendingUserInput:
      | {
          questions: UserInputQuestion[];
          resolve: (result: UserInputResult) => void;
          reject: (error: Error) => void;
          signal?: AbortSignal;
          onAbort: () => void;
        }
      | null = null;
    let cleanupSudoPasswordPrompt: (() => void) | null = null;
    let sudoPasswordBuffer = '';
    const bridge = createRatatuiBridge();


    captureTerminalWrites();
    const { handleShellKeyEvent } = await import('./tui/shell-input.js');
    let terminalCols = 80;
    let terminalRows = 24;
    let exiting = false;
    let remountPromise: Promise<void> | null = null;
    let liveFrameRemountTimer: ReturnType<typeof setTimeout> | null = null;
    let spinnerFrame = 0;
    let tuiReady = false;
    let lastTurnStartedAt: number | null = null;
    let latestUsageSummary: ChatUsageSummary | null = null;
    const usageNotice = createUsageNoticeTracker();
    let pendingTurnEntries: TranscriptEntryDraft[] = [];
    let activeTurnAbort: AbortController | null = null;






    let activeTurnImageAttachments: ImageAttachment[] = [];




    let activeServerTurnId: string | null = null;








    let unacknowledged = new Map<string, { row: number; queued: QueuedMessage }>();



    const blockedRows = new WeakMap<QueuedMessage, number>();



    let newConversationInFlight = false;


    let todosTouchedThisTurn = false;
    const syncTodosState = () => {
      store.update((current) => ({ ...current, todos: listTodos() }));
    };
    let activeTurnGeneration = 0;
    let exitCtrlCArmed = false;
    let exitCtrlCTimer: ReturnType<typeof setTimeout> | null = null;
    let transientStatusTimer: ReturnType<typeof setTimeout> | null = null;







    const THINKING_MIN_DWELL_MS = 3_000;
    let thinkingAppliedAt = 0;
    let pendingThinking: { title: string; notes: string[] } | null = null;

    const applyThinking = (next: { title: string; notes: string[] }): void => {
      thinkingAppliedAt = Date.now();
      pendingThinking = null;
      store.update((current) => ({
        ...current,
        thinkingTitle: next.title || holdOrPickFallback(current.thinkingTitle),
        thinkingNotes: next.notes,
      }));
    };

    const queueThinkingUpdate = (next: {
      title: string;
      notes: string[];
    }): void => {
      if (Date.now() - thinkingAppliedAt >= THINKING_MIN_DWELL_MS) {
        applyThinking(next);
        return;
      }
      pendingThinking = next;
    };

    const flushPendingThinking = (): void => {
      if (!pendingThinking) return;
      if (Date.now() - thinkingAppliedAt < THINKING_MIN_DWELL_MS) return;
      applyThinking(pendingThinking);
    };

    const resetThinkingPacer = (): void => {
      thinkingAppliedAt = 0;
      pendingThinking = null;
    };

    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const scheduleLiveFrameRemount = () => {
      if (exiting || liveFrameRemountTimer) return;
      liveFrameRemountTimer = setTimeout(() => {
        liveFrameRemountTimer = null;
        if (exiting) return;
        void remountTui();
      }, 0);
    };


    const showTransientStatus = (transientStatus: string): void => {
      if (transientStatusTimer) {
        clearTimeout(transientStatusTimer);
        transientStatusTimer = null;
      }
      store.update((current) => ({ ...current, transientStatus }));
      transientStatusTimer = setTimeout(() => {
        transientStatusTimer = null;
        store.update((current) =>
          current.transientStatus === transientStatus
            ? { ...current, transientStatus: null }
            : current,
        );
      }, 2500);
    };



    const terminalTitle = createTerminalTitleController({
      write: (title) => bridge.setTitle(title),
    });
    const syncTerminalTitle = () => {
      const state = store.getState();
      terminalTitle.sync({
        awaitingReview: Boolean(state.approvalPrompt || state.sudoPrompt),
        busy: state.busy,
      });
    };



    const notifier = backendFor();
    let notificationHandle: string | null = null;
    const projectLabel = basename(session.rootDir) || 'TheGitAI';





    const notifications = createNotificationQueue();
    const attention = createAttentionController({
      notify: (kind) => {
        notifications.run(async () => {
          notificationHandle = await notifier.post(
            {
              title: projectLabel,
              body:
                kind === 'blocked'
                  ? 'Waiting for your answer'
                  : 'Finished - your turn',
            },
            notificationHandle,
          );
        });
      },
      withdraw: () => {
        notifications.run(async () => {
          notifier.withdraw(notificationHandle);
          notificationHandle = null;
        });
      },
    });
    const syncAttention = () => {
      const state = store.getState();
      attention.sync(
        {
          awaitingAnswer: Boolean(
            state.approvalPrompt || state.sudoPrompt || state.userInputPrompt,
          ),
          busy: state.busy,
          focused: state.terminalFocused,
        },
        state.notificationsEnabled,
      );
    };

    const renderCurrentFrame = () => {
      if (!tuiReady) return;
      const state = store.getState();
      syncTerminalTitle();
      syncAttention();
      const elapsedSeconds = busyElapsedSeconds(state, Date.now());
      bridge.render(
        buildTuiFrame(
          state,
          terminalCols,
          terminalRows,
          spinnerFrame,
          elapsedSeconds,
          Date.now(),
        ),
      );
    };

    const remountTui = async (): Promise<void> => {
      if (remountPromise) {
        await remountPromise;
        return;
      }
      remountPromise = (async () => {
        if (exiting) return;
        bridge.clear();
        renderCurrentFrame();
      })();
      try {
        await remountPromise;
      } finally {
        remountPromise = null;
      }
    };

    const appendStaticEntries = (entries: TranscriptEntryDraft[]): number[] =>
      store.appendEntries(entries);

    const appendStaticEntry = (entry: TranscriptEntryDraft): number => {
      const ids = appendStaticEntries([entry]);
      return ids[0] ?? -1;
    };

    const queueTurnEntry = (entry: TranscriptEntryDraft): void => {
      if (sameTranscriptDraft(pendingTurnEntries.at(-1), entry)) return;
      pendingTurnEntries = [...pendingTurnEntries, entry];
    };

    const appendTurnAwareEntry = (entry: TranscriptEntryDraft): void => {
      if (store.getState().busy) {
        queueTurnEntry(entry);
        return;
      }
      appendStaticEntry(entry);
    };

    const appendSettledTurnEntries = async (
      turnEntries: TranscriptEntryDraft[],
      responseText: string,
      shouldContinue: () => boolean = () => true,
    ): Promise<void> => {
      const entries = buildSettledTurnTranscriptEntries(turnEntries, responseText);
      const responseEntry = entries.at(-1);
      if (
        !responseEntry ||
        responseEntry.kind !== 'assistant' ||
        responseEntry.title !== 'Response' ||
        !responseEntry.body
      ) {
        appendStaticEntries(entries);
        await remountTui();
        return;
      }

      appendStaticEntries(entries.slice(0, -1));
      const responseId = appendStaticEntry({
        ...responseEntry,
        body: '',
      });
      await remountTui();
      let first = true;
      for (const body of buildResponseStreamBodies(responseEntry.body)) {
        if (!first) {
          await wait(RESPONSE_STREAM_DELAY_MS);
        }
        if (exiting) return;
        if (!shouldContinue()) {
          store.updateEntry(responseId, { body: responseEntry.body });
          return;
        }
        store.updateEntry(responseId, { body });
        first = false;
      }
    };

    const takePendingTurnEntries = (): TranscriptEntryDraft[] => {
      const entries = pendingTurnEntries;
      pendingTurnEntries = [];
      return entries;
    };

    const appendError = (message: string) => {
      appendStaticEntry({
        body: message,
        kind: 'error',
        title: 'Error',
      });
    };

    const handleAppSelectionCopy = (text: string): void => {
      try {
        writeClipboardText(text);
        showTransientStatus('Copied selection');
      } catch (error: any) {
        appendError(`Selection copy failed: ${error.message}`);
      }
    };

    const handleLinkCopy = (url: string): void => {
      try {
        writeClipboardText(url);
        showTransientStatus('Copied link');
      } catch (error: any) {
        appendError(`Link copy failed: ${error.message}`);
      }
    };

    const handleLinkOpen = async (url: string): Promise<void> => {
      try {
        const opened = await openUrl(url);
        showTransientStatus(opened ? 'Opened link' : 'Could not open link');
      } catch (error: any) {
        appendError(`Link open failed: ${error.message}`);
      }
    };

    const disarmExitConfirm = () => {
      exitCtrlCArmed = false;
      if (exitCtrlCTimer) {
        clearTimeout(exitCtrlCTimer);
        exitCtrlCTimer = null;
      }
      if (store.getState().exitConfirmUntil != null) {
        store.update((current) => ({
          ...current,
          exitConfirmUntil: null,
          status:
            current.status === EXIT_CTRL_C_CONFIRM_MESSAGE
              ? 'Ready'
              : current.status,
        }));
      }
    };

    const dismissPendingApproval = () => {
      if (!resolvePermissionDecision) return;
      const pendingResolve = resolvePermissionDecision;
      resolvePermissionDecision = null;
      pendingResolve({ kind: 'deny' });
      store.update((current) => ({
        ...resumeBusyClock(current, Date.now()),
        approvalCursor: 0,
        approvalPrompt: null,
        approvalScrollOffset: 0,
      }));
    };

    const dismissPendingSudoPassword = () => {
      if (!resolveSudoPassword) return;
      const pendingResolve = resolveSudoPassword;
      resolveSudoPassword = null;
      cleanupSudoPasswordPrompt?.();
      cleanupSudoPasswordPrompt = null;
      sudoPasswordBuffer = '';
      pendingResolve(null);
      store.update((current) => ({
        ...resumeBusyClock(current, Date.now()),
        sudoPrompt: null,
      }));
    };

    const dismissPendingUserInput = () => {
      const pending = pendingUserInput;
      if (!pending) return;
      pendingUserInput = null;
      pending.signal?.removeEventListener('abort', pending.onAbort);
      const error = new Error('Turn cancelled.');
      error.name = 'AbortError';
      pending.reject(error);
      store.update((current) => ({
        ...resumeBusyClock(current, Date.now()),
        status: current.userInputPrompt?.returnStatus ?? current.status,
        userInputPrompt: null,
      }));
    };

    const cancelActiveTurn = () => {
      if (!store.getState().busy || newConversationInFlight) return;
      disarmExitConfirm();
      dismissPendingApproval();
      dismissPendingSudoPassword();
      dismissPendingUserInput();
      activeTurnGeneration += 1;
      resetThinkingPacer();
      activeTurnAbort?.abort();
      activeTurnAbort = null;
      cancelActiveCommand();



      const queued = store.getState().queuedMessage;





      const restoredAttachments = composerAttachmentsAfterCancel(
        queued ? queued.imageAttachments : [],
        activeTurnImageAttachments,
      );
      activeTurnImageAttachments = [];
      const cancelledEntries = [
        ...takePendingTurnEntries(),
        {
          body: 'Turn cancelled.',
          kind: 'error' as const,
          title: 'Cancelled',
        },
      ];
      store.update((current) => ({
        ...current,
        activeTurnInput: '',
        activeTurnInputPreformatted: false,
        busy: false,
        busyPausedAt: null,
        busySince: null,
        commandLog: [],
        cursor: queued ? queued.body.length : current.cursor,
        imageAttachments: restoredAttachments,
        input: queued ? queued.body : current.input,
        pastedChunks: queued ? queued.pastedChunks : current.pastedChunks,
        promptHistoryCursor: queued ? null : current.promptHistoryCursor,
        promptHistoryDraft: queued ? '' : current.promptHistoryDraft,
        queuedMessage: null,
        recoveryStatus: '',
        status: 'Ready',
        thinkingTitle: '',
        thinkingNotes: [],
        turnMessages: [],
        workingTools: [],
        tokenUsage: formatClientTokenUsage(
          busyElapsedMs(current, Date.now()),
          latestUsageSummary,
        ),
      }));
      appendStaticEntries(cancelledEntries);
      lastTurnStartedAt = null;
      if (queued) scheduleLiveFrameRemount();
      void remountTui();
    };

    const syncShellStateFromSession = () => {
      store.update((current) => ({
        ...current,
        agentMode: session.agentMode,
        autoYes: sessionAutoYes,
        commandCursor: 0,
        currentModelId: session.modelId,
        reasoningEffort: projectModelEffort(readProjectModelEfforts(session.rootDir, authConfig.serverUrl, session.env), session.modelId),
        sessionId: session.sessionId,
        modelPickerIndex: current.modelPickerOpen
          ? getDefaultModelPickerIndex(session.modelId, current.serverModels)
          : current.modelPickerIndex,
        tokenUsage: formatClientTokenUsage(
          lastTurnStartedAt == null ? null : Date.now() - lastTurnStartedAt,
          latestUsageSummary,
        ),
        turnCounter: Math.max(
          current.turnCounter,
          session.history.filter((entry) => entry.role === 'user').length,
        ),
      }));
    };

    const setAgentMode = (
      mode: AgentMode,
      status = `Mode: ${agentModeLabel(mode)}`,
    ): void => {
      session.agentMode = mode;
      session.autoYes = mode === 'auto-accept';
      sessionAutoYes = session.autoYes;
      store.update((current) => ({
        ...current,
        agentMode: mode,
        autoYes: sessionAutoYes,
        status,
      }));
    };

    const cycleAgentMode = (): void => {
      setAgentMode(nextAgentMode(session.agentMode));
      scheduleLiveFrameRemount();
    };


    const reportAgentModeLocked = (): void => {
      showTransientStatus(AGENT_MODE_LOCKED_STATUS);
    };

    const clearLiveFrameRemountTimer = () => {
      if (!liveFrameRemountTimer) return;
      clearTimeout(liveFrameRemountTimer);
      liveFrameRemountTimer = null;
    };

    const handleCtrlC = () => {
      if (exiting) return;
      if (store.getState().busy) {
        cancelActiveTurn();
        return;
      }
      if (exitCtrlCArmed) {
        disarmExitConfirm();
        requestExit();
        return;
      }
      exitCtrlCArmed = true;
      const exitConfirmUntil = Date.now() + EXIT_CTRL_C_CONFIRM_MS;
      store.update((current) => ({
        ...current,
        exitConfirmUntil,
        status: EXIT_CTRL_C_CONFIRM_MESSAGE,
      }));
      exitCtrlCTimer = setTimeout(() => {
        exitCtrlCTimer = null;
        exitCtrlCArmed = false;
        store.update((current) => ({
          ...current,
          exitConfirmUntil: null,
          status:
            current.status === EXIT_CTRL_C_CONFIRM_MESSAGE
              ? 'Ready'
              : current.status,
        }));
      }, EXIT_CTRL_C_CONFIRM_MS);
      exitCtrlCTimer.unref?.();
    };

    const requestExit = () => {
      if (exiting) return;
      disarmExitConfirm();
      if (transientStatusTimer) {
        clearTimeout(transientStatusTimer);
        transientStatusTimer = null;
      }
      dismissPendingApproval();
      dismissPendingSudoPassword();
      dismissPendingUserInput();
      exiting = true;
      killAllBackgroundJobs();
      store.update((current) => ({
        ...current,
        exiting: true,
        queuedMessage: null,
        status: 'Exiting...',
      }));
      void bridge.close().then(() => {
        releaseTerminalWrites();
        resolveDone?.();
      });
    };

    const exitForAuthenticationError = (error: unknown): boolean => {
      if (!isAuthenticationError(error)) return false;
      clearCliAuthConfig(session.env);
      if (sessionHasUserMessage(session)) {
        saveSessionState(session);
      }
      fatalError = new Error(authenticationErrorMessage(error));
      requestExit();
      return true;
    };





    const saveActiveSession = async (): Promise<boolean> => {
      try {
        await saveSessionBoth({ serverSessionClient, session });
        return true;
      } catch (error: any) {
        if (exitForAuthenticationError(error)) return false;
        appendError(`Session save failed: ${error.message}`);
        return true;
      }
    };




    const saveActiveSessionOrAbort = async (): Promise<boolean> => {
      try {
        await saveSessionBoth({ serverSessionClient, session });
        return true;
      } catch (error: any) {
        if (exitForAuthenticationError(error)) return false;
        appendError(`Session save failed: ${error.message}`);
        return false;
      }
    };

    const openSudoPasswordPrompt = (
      command: string,
      prompt: string,
      signal?: AbortSignal,
    ): Promise<string | null> =>
      new Promise((resolve) => {
        if (exiting || signal?.aborted) {
          resolve(null);
          return;
        }
        dismissPendingSudoPassword();
        const abortPrompt = () => dismissPendingSudoPassword();
        sudoPasswordBuffer = '';
        resolveSudoPassword = resolve;
        if (signal) {
          signal.addEventListener('abort', abortPrompt, { once: true });
          cleanupSudoPasswordPrompt = () =>
            signal.removeEventListener('abort', abortPrompt);
        } else {
          cleanupSudoPasswordPrompt = null;
        }
        store.update((current) => ({
          ...pauseBusyClock(current, Date.now()),
          sudoPrompt: {
            command,
            passwordLength: 0,
            prompt,
            returnStatus: current.status,
          },
          status: 'Sudo authentication required',
        }));
      });

    const handleSudoPasswordInput = (
      event:
        | { kind: 'backspace' }
        | { kind: 'cancel' }
        | { kind: 'char'; char: string }
        | { kind: 'submit' },
    ): void => {
      const pendingResolve = resolveSudoPassword;
      if (!pendingResolve) return;
      if (event.kind === 'cancel') {
        resolveSudoPassword = null;
        cleanupSudoPasswordPrompt?.();
        cleanupSudoPasswordPrompt = null;
        sudoPasswordBuffer = '';
        store.update((current) => ({
          ...resumeBusyClock(current, Date.now()),
          sudoPrompt: null,
          status: current.sudoPrompt?.returnStatus ?? current.status,
        }));
        pendingResolve(null);
        return;
      }
      if (event.kind === 'submit') {
        const password = sudoPasswordBuffer;
        resolveSudoPassword = null;
        cleanupSudoPasswordPrompt?.();
        cleanupSudoPasswordPrompt = null;
        sudoPasswordBuffer = '';
        store.update((current) => ({
          ...resumeBusyClock(current, Date.now()),
          sudoPrompt: null,
          status: current.sudoPrompt?.returnStatus ?? current.status,
        }));
        pendingResolve(password);
        return;
      }
      if (event.kind === 'backspace') {
        sudoPasswordBuffer = sudoPasswordBuffer.slice(0, -1);
      } else {
        sudoPasswordBuffer += event.char;
      }
      store.update((current) => ({
        ...current,
        sudoPrompt: current.sudoPrompt
          ? { ...current.sudoPrompt, passwordLength: sudoPasswordBuffer.length }
          : null,
      }));
    };

    const openUserInputPrompt = (
      questions: UserInputQuestion[],
      signal?: AbortSignal,
    ): Promise<UserInputResult> =>
      new Promise((resolve, reject) => {
        if (exiting || signal?.aborted) {
          const error = new Error('Turn cancelled.');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        const onAbort = () => dismissPendingUserInput();
        pendingUserInput = {
          questions,
          resolve,
          reject,
          signal,
          onAbort,
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        store.update((current) => ({
          ...pauseBusyClock(current, Date.now()),
          ...closedJobsPickerFields(current),
          status: 'Waiting for your input',
          userInputPrompt: createUserInputPromptState(
            questions,
            statusBehindJobsPicker(current),
          ),
        }));
        scheduleLiveFrameRemount();
      });

    const handleInlineUserInput = async (
      result: UserInputResult,
    ): Promise<void> => {
      const pending = pendingUserInput;
      const prompt = store.getState().userInputPrompt;
      if (!pending || !prompt) return;
      pendingUserInput = null;
      pending.signal?.removeEventListener('abort', pending.onAbort);
      store.update((current) => ({
        ...resumeBusyClock(current, Date.now()),
        status: prompt.returnStatus,
        userInputPrompt: null,
      }));
      appendTurnAwareEntry({
        body: formatUserInputTranscript(pending.questions, result),
        kind: result.status === 'submitted' ? 'user' : 'system',
        title: result.status === 'submitted' ? 'Your answers' : 'Question',
      });
      pending.resolve(result);
      scheduleLiveFrameRemount();
    };

    const openApprovalPrompt = (
      request: PermissionRequest & { options: PermissionOption[] },
      signal?: AbortSignal,
    ): Promise<PermissionDecision> =>
      new Promise((resolve) => {
        const deny: PermissionDecision = { kind: 'deny' };
        if (exiting || signal?.aborted) {
          resolve(deny);
          return;
        }

        const onAbort = () => dismissPendingApproval();
        signal?.addEventListener('abort', onAbort, { once: true });
        resolvePermissionDecision = (decision) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(decision);
        };
        store.update((current) => ({
          ...pauseBusyClock(current, Date.now()),
          ...closedJobsPickerFields(current),
          approvalCursor: getDefaultApprovalCursor(request.options.length),
          approvalOpenedAt: Date.now(),



          approvalScrollOffset: 0,
          approvalPrompt: {
            title: request.title,
            body: request.body,
            diffPreview:
              request.diff && request.filePath
                ? parseDiffPreview(request.diff)
                : undefined,
            filePath: request.filePath,
            options: request.options,
            returnStatus: statusBehindJobsPicker(current),
          },
          status: request.title,
        }));
      });






    const handleInlineApprovalChoice = async (index: number): Promise<void> => {
      const current = store.getState();
      const options = current.approvalPrompt?.options ?? [];
      const chosen = options[index]?.decision ?? { kind: 'deny' as const };
      const pendingResolve = resolvePermissionDecision;
      resolvePermissionDecision = null;
      store.update((next) => ({
        ...resumeBusyClock(next, Date.now()),
        approvalCursor: getDefaultApprovalCursor(options.length),
        approvalPrompt: null,
        approvalScrollOffset: 0,
        status: current.approvalPrompt?.returnStatus ?? next.status,
      }));
      pendingResolve?.(chosen);
    };

    const refreshServerModels = async (): Promise<ServerModelsResponse> => {
      currentServerModels = await models.fetchServerModels({ config: authConfig });
      store.update((current) => ({
        ...current,
        serverModels: currentServerModels.models,
      }));
      return currentServerModels;
    };

    const openModelPicker = async () => {
      const fresh = await refreshServerModels();
      store.update((current) => ({
        ...current,
        commandCursor: 0,
        cursor: 0,
        input: '',
        modelPickerIndex: getDefaultModelPickerIndex(
          current.currentModelId,
          fresh.models,
        ),
        modelPickerOpen: true,
        modelPickerEfforts: readProjectModelEfforts(session.rootDir, authConfig.serverUrl, session.env),
        status: 'Select a model',
      }));
    };

    const switchToModel = async (modelId: string | number, effort?: ReasoningEffort): Promise<void> => {
      const fresh = await modelsForSwitch(Number(modelId), currentServerModels, refreshServerModels);
      const selected = models.validateServerModel(modelId, fresh);
      const lockedModel = fresh.models.find((model) => model.id === selected && model.locked);
      if (lockedModel) throw new Error(modelLockMessage(lockedModel));
      if (effort !== undefined) {
        saveProjectModelEffort(session.rootDir, selected, effort, authConfig.serverUrl, session.env);
      }
      session.modelId = selected;
      models.updateSelectedModelCache({
        config: authConfig,
        selectedModelId: selected,
        serverModels: fresh,
      });
      if (!(await saveActiveSession())) return;
      syncShellStateFromSession();
      appendStaticEntry({
        body: fresh.models.some((model) => model.id === selected && model.auto)
          ? formatModelLabel(selected, fresh.models)
          : `${formatModelLabel(selected, fresh.models)} · ${REASONING_EFFORT_LABELS[store.getState().reasoningEffort]} effort${effort === undefined ? '' : '\nSaved for this model in this project.'}`,
        kind: 'system',
        title: 'Model',
      });
    };

    const toggleNotifications = () => {
      const enabled = !store.getState().notificationsEnabled;
      store.update((current) => ({ ...current, notificationsEnabled: enabled }));
      try {
        writePreferences(
          { ...readPreferences(session.env), notifications: enabled },
          session.env,
        );
      } catch {


      }
      showTransientStatus(enabled ? 'Notifications on' : 'Notifications off');
    };

    const openJobsPicker = () => {
      if (store.getState().jobsPickerOpen) return;
      syncBackgroundJobsState();




      store.update((current) => ({
        ...current,
        commandCursor: 0,
        jobsPickerExpandedId: null,
        jobsPickerIndex: 0,
        jobsPickerOpen: true,
        jobsPickerReturnStatus: current.status,
        status: 'Background jobs',
      }));


      scheduleLiveFrameRemount();
    };

    const appendJobOutputEntry = async (jobId: string): Promise<void> => {
      const id = jobId.trim();
      await collectBackgroundJobUiOutputMutations({
        session,
        jobId: id,
      });
      const job = listBackgroundJobs().find((candidate) => candidate.id === id);
      const buffered = getJobBufferedOutput(id);
      if (!job || !buffered) {
        appendError(`Unknown background job id: ${id}`);
        return;
      }
      const dropped =
        buffered.droppedChars > 0
          ? `... (${buffered.droppedChars} chars of older output dropped) ...\n`
          : '';
      appendStaticEntry({
        body: `${dropped}${buffered.output || '(no output captured)'}`,
        kind: 'system',
        preformatted: true,
        title: `${job.id} output - ${truncate(job.command, 80)}`,
      });
    };

    const selectedJobsPickerId = (): string | null => {
      const current = store.getState();
      if (!current.backgroundJobs.length) return null;
      const index = Math.min(
        Math.max(current.jobsPickerIndex, 0),
        current.backgroundJobs.length - 1,
      );
      return current.backgroundJobs[index]?.id ?? null;
    };













    const deferredJobMutationIds = new Set<string>();

    const drainDeferredJobMutations = async (): Promise<void> => {
      if (deferredJobMutationIds.size === 0) return;
      const pending = [...deferredJobMutationIds];
      deferredJobMutationIds.clear();
      for (const jobId of pending) {


        await collectBackgroundJobUiOutputMutations({ session, jobId });
      }
      syncBackgroundJobsState();
    };

    const handleJobsPickerOutput = async (): Promise<void> => {
      const jobId = selectedJobsPickerId();
      if (!jobId) return;
      if (store.getState().busy) {
        deferredJobMutationIds.add(jobId);
      } else {
        await collectBackgroundJobUiOutputMutations({
          session,
          jobId,
        });
      }



      store.update((current) => ({
        ...current,
        jobsPickerExpandedId:
          current.jobsPickerExpandedId === jobId ? null : jobId,
      }));
      syncBackgroundJobsState();
    };

    const handleJobsPickerKill = async (): Promise<void> => {
      const jobId = selectedJobsPickerId();
      if (!jobId) return;
      const killed = await killBackgroundJob(jobId);


      if (store.getState().busy) {
        deferredJobMutationIds.add(jobId);
      } else {
        await collectBackgroundJobUiKillMutations({
          session,
          jobId,
          result: killed,
        });
      }
      syncBackgroundJobsState();
      if (!killed.ok) {
        appendError(killed.error ?? 'Background job kill failed.');
      } else if (killed.alreadyFinished) {
        appendStaticEntry({
          body: `${jobId} had already finished.`,
          kind: 'system',
          title: 'Background jobs',
        });
      }

    };

    const handleInlineModelSelection = async (): Promise<void> => {
      const current = store.getState();
      const options = buildModelPickerOptions(current.currentModelId, current.serverModels);
      const selectedIndex = Math.min(
        current.modelPickerIndex,
        Math.max(options.length - 1, 0),
      );
      const selected = options[selectedIndex];
      const lockedModel = selected?.disabled
        ? current.serverModels.find((model) => model.id === selected.id)
        : undefined;
      if (lockedModel) {
        showTransientStatus(modelLockMessage(lockedModel));
        return;
      }
      store.update((next) => ({
        ...next,
        modelPickerOpen: false,
        status: 'Ready',
      }));
      if (!selected) {
        appendStaticEntry({
          body: 'Model selection cancelled.',
          kind: 'system',
          title: 'Model',
        });
        return;
      }
      try {
        await switchToModel(selected.id, projectModelEffort(current.modelPickerEfforts ?? {}, selected.id));
      } catch (error: any) {
        if (exitForAuthenticationError(error)) return;
        appendError(error.message);
      }
    };

    const loadInteractiveSessionList = async (): Promise<SessionMetadata[]> => {
      const local = listSessionMetadata(session.rootDir, session.env);
      if (local.length > 0) return local;
      return serverSessionClient.list(session.rootDir);
    };

    const loadInteractiveSession = async (identifier: string) => {
      const local = loadSessionSnapshot(session.rootDir, identifier, session.env);
      if (local) return local;
      return serverSessionClient.load(session.rootDir, identifier);
    };

    const openResumePicker = async () => {
      const sessionList = await loadInteractiveSessionList();
      store.update((current) => ({
        ...current,
        commandCursor: 0,
        cursor: 0,
        input: '',
        resumePickerFilter: '',
        resumePickerIndex: 0,
        resumePickerOpen: true,
        resumePickerSessions: sessionList,
        status: 'Select a session to resume',
      }));
    };

    const handleInlineResumeSelection = async (): Promise<void> => {
      const current = store.getState();
      const filtered = filterResumeSessions(
        current.resumePickerSessions,
        current.resumePickerFilter,
        current.serverModels,
      );
      const selectedIndex = Math.min(
        current.resumePickerIndex,
        Math.max(filtered.length - 1, 0),
      );
      const selected = filtered[selectedIndex];
      if (!selected) {
        store.update((next) => ({
          ...next,
          resumePickerFilter: '',
          resumePickerIndex: 0,
          resumePickerOpen: false,
          resumePickerSessions: [],
          status: 'Ready',
        }));
        return;
      }
      const resumeStartedAt = Date.now();
      store.update((next) => ({
        ...next,
        busy: true,
        busyPausedAt: null,
        busySince: resumeStartedAt,
        clockNow: resumeStartedAt,
        status: 'Loading session...',
      }));
      try {
        const snapshot = await loadInteractiveSession(selected.id);



        const requestedModelId = Number(snapshot.modelId);
        const knownModels = currentServerModels.models.some(
          (model) => model.id === requestedModelId,
        )
          ? currentServerModels
          : await refreshServerModels();
        const { modelId: resolvedModelId, fellBack } = models.resolveResumedSessionModel(
          requestedModelId,
          knownModels,
        );
        applySessionSnapshot(session, snapshot, {
          modelOverride: fellBack ? resolvedModelId : undefined,
        });
        setBackgroundJobSession(session.sessionId);
        setScratchSession(session.sessionId);
        setImageStoreSession(session.sessionId);
        syncBackgroundJobsState();
        setTodoSession(session.sessionId);
        syncTodosState();
        syncShellStateFromSession();
        store.update((next) => ({
          ...next,
          busy: false,
          busyPausedAt: null,
          busySince: null,
          resumePickerFilter: '',
          resumePickerIndex: 0,
          resumePickerOpen: false,
          resumePickerSessions: [],
          status: 'Ready',
        }));
        store.replaceTranscript([
          {
            body: `Resumed session${session.sessionName ? ` "${session.sessionName}"` : ''} (${session.sessionId})`,
            kind: 'system',
            title: 'Session',
          },
          ...(fellBack
            ? [
                {
                  body: `This session's model is no longer available - switched to ${formatModelLabel(resolvedModelId, knownModels.models)}. Conversation history preserved.`,
                  kind: 'system' as const,
                  title: 'Model',
                },
              ]
            : []),
          ...buildTranscriptFromSessionHistory(session.history),
        ]);
        await remountTui();
      } catch (error: any) {
        if (exitForAuthenticationError(error)) return;
        store.update((next) => ({
          ...next,
          busy: false,
          busyPausedAt: null,
          busySince: null,
          resumePickerFilter: '',
          resumePickerIndex: 0,
          resumePickerOpen: false,
          resumePickerSessions: [],
          status: 'Ready',
        }));
        appendError(`Failed to resume session: ${error.message}`);
      }
    };

    const flushQueuedMessage = async (): Promise<void> => {
      const queued = store.getState().queuedMessage;
      if (!queued || store.getState().busy || exiting) {
        return;
      }


      store.update((current) => ({
        ...current,
        imageAttachments: queued.imageAttachments,
        pastedChunks: queued.pastedChunks,
        queuedMessage: null,
      }));
      await handleSubmit(queued.body);
    };



    let turnMessageCounter = 0;
    const upsertTurnMessage = (
      id: number,
      patch: Partial<TurnMessage>,
    ): void => {
      store.update((current) => ({
        ...current,
        turnMessages: current.turnMessages.map((message) =>
          message.id === id ? { ...message, ...patch } : message,
        ),
      }));
    };







    const recoverUnacknowledgedMessages = (autoSubmits = true): void => {
      if (unacknowledged.size === 0) return;
      const stranded = [...unacknowledged.values()];
      unacknowledged = new Map();
      for (const { row } of stranded) {
        upsertTurnMessage(row, {
          state: 'queued',


          note: autoSubmits
            ? 'not read - sending as the next prompt'
            : 'not read - left in the composer',
        });
      }





      const existing = store.getState().queuedMessage;
      const combined = [
        ...stranded.map((entry) => entry.queued),
        ...(existing ? [existing] : []),
      ];
      const body = combined
        .map((entry) => entry.body)
        .filter((entry) => entry.trim())
        .join('\n\n');
      if (!body.trim()) return;
      scheduleLiveFrameRemount();
      store.update((current) => ({
        ...current,
        queuedMessage: {
          body,
          imageAttachments: combined.flatMap((entry) => entry.imageAttachments),
          pastedChunks: combined.flatMap((entry) => entry.pastedChunks),
        },
      }));
    };

    const fireQueuedMessage = async (): Promise<void> => {
      const state = store.getState();
      const queued = state.queuedMessage;
      if (!queued || !state.busy || exiting) return;
      const text = (
        queued.pastedChunks.length
          ? expandPastedChunks(queued.body, queued.pastedChunks)
          : queued.body
      ).trim();


      const images = queued.imageAttachments.filter((attachment) =>
        queued.body.includes(`[Image #${attachment.index}]`),
      );
      if (!text && images.length === 0) return;



      const turnId = activeServerTurnId;
      const blockedReason = !turnId ? 'waiting for the turn to end' : null;




      const existingRow = blockedRows.get(queued);
      if (existingRow !== undefined) {
        upsertTurnMessage(existingRow, {
          state: 'queued',
          ...(blockedReason ? { note: blockedReason } : {}),
        });
        if (blockedReason || !turnId) return;
      }
      const id = existingRow ?? ++turnMessageCounter;
      const messageId = `m${id}_${Date.now().toString(36)}`;
      if (existingRow === undefined) {
        scheduleLiveFrameRemount();
        store.update((current) => ({
          ...current,
          turnMessages: [
            ...current.turnMessages,
            {
              id,
              text,
              state: blockedReason ? 'queued' : 'sending',
              ...(blockedReason ? { note: blockedReason } : {}),
            },
          ],
        }));
      }
      if (blockedReason || !turnId) {
        blockedRows.set(queued, id);
        return;
      }
      blockedRows.delete(queued);














      unacknowledged.set(messageId, { row: id, queued });
      scheduleLiveFrameRemount();
      store.update((current) =>
        current.queuedMessage === queued
          ? { ...current, queuedMessage: null }
          : current,
      );



      queueTurnEntry({
        body: text,
        kind: 'user',
        preformatted: queued.pastedChunks.length > 0,
        title: 'You · sent mid-turn',
      });




      const rollback = (note: string): void => {







        if (!unacknowledged.delete(messageId)) return;
        upsertTurnMessage(id, { state: 'queued', note });
        scheduleLiveFrameRemount();
        store.update((current) =>
          current.queuedMessage ? current : { ...current, queuedMessage: queued },
        );
      };

      let outcome: chat.InterjectionOutcome;
      try {
        outcome = await chat.postInterjection({
          config: authConfig,
          turnId,
          text,
          messageId,
          imageAttachments: images,
        });
      } catch (error: any) {
        rollback(`not sent - ${error?.message ?? 'request failed'}`);
        return;
      }
      if (outcome === 'stale') {

        rollback('turn ended - sending as the next prompt');
      }
    };






    const jobWait = createJobWaitTracker(() => session.sessionId);

    const refreshSkillCommands = () => {
      try {
        const local = skillCatalogue(discoverSkills(session.rootDir, session.env));
        const names = new Set(local.map((skill) => skill.name));
        setSkillSlashCommands([
          ...local,
          ...BUNDLED_SKILLS.filter((skill) => !names.has(skill.name)),
        ]);
      } catch {
        setSkillSlashCommands([]);
      }
    };

    const runSkillsCommand = async (args: string): Promise<void> => {
      const builtinCommands = SLASH_COMMANDS.flatMap((option) => [
        option.command,
        ...(option.aliases ?? []),
      ]);
      if (!args || args === 'list') {
        refreshSkillCommands();
        store.update((current) => ({
          ...current,
          commandCursor: 0,
          skillsPickerIndex: 0,
          skillsPickerItems: buildSkillsPickerItems(session.rootDir, session.env, builtinCommands),
          skillsPickerOpen: true,
        }));
        scheduleLiveFrameRemount();
        return;
      }
      const addMatch = args.match(/^add(?:\s+([\s\S]*))?$/);
      const project = /(^|\s)--project(\s|$)/.test(args);
      const sourceText = String(addMatch?.[1] ?? '')
        .replace(/(^|\s)--project(?=\s|$)/g, ' ')
        .trim();
      const source = addMatch && sourceText ? parseSkillSource(sourceText, session.rootDir) : null;
      if (!source) {
        appendStaticEntry({
          body: `Usage: /skills to list skills, or ${SKILLS_ADD_USAGE}`,
          kind: 'system',
          title: 'Skills',
        });
        return;
      }
      const controller = new AbortController();
      activeTurnAbort = controller;
      store.update((current) => ({
        ...current,
        busy: true,
        status: 'Fetching skill...',
        activeTurnInput: `/skills add ${sourceText}`,
      }));
      try {
        const prepared = await prepareSkillInstall(source, session.env, globalThis.fetch, controller.signal);
        if (!prepared.ok) {
          appendStaticEntry({
            body: controller.signal.aborted ? 'Skill install cancelled.' : prepared.error,
            kind: 'system',
            title: 'Skills',
          });
          return;
        }
        const skill = prepared.skill;
        const targetRoot = project
          ? projectSkillsRoot(session.rootDir)
          : personalSkillsRoot(session.env);
        const destination = joinPath(targetRoot, skill.name);
        const files = skill.files.map((file) => file.relPath);
        const shownFiles = files.slice(0, 12).join(', ') + (files.length > 12 ? `, and ${files.length - 12} more` : '');
        const decision = await openApprovalPrompt(
          {
            bucket: 'create',
            title: `Install skill /${skill.name}?`,
            body: [
              skill.description,
              '',
              `From: ${skill.origin}`,
              `To: ${destination}`,
              `Files (${files.length}): ${shownFiles}`,
              ...(preparedSkillHasScripts(skill)
                ? ['', 'It includes scripts. Nothing runs now, and the agent still asks before running any command.']
                : []),
            ].join('\n'),
            options: [
              { label: 'Install', decision: { kind: 'once' } },
              { label: 'Cancel', decision: { kind: 'deny' } },
            ],
          },
          controller.signal,
        );
        if (decision.kind === 'deny') {
          appendStaticEntry({ body: 'Skill not installed.', kind: 'system', title: 'Skills' });
          return;
        }
        const installed = installPreparedSkill(skill, targetRoot);
        if (!installed.ok) {
          appendStaticEntry({ body: installed.error, kind: 'system', title: 'Skills' });
          return;
        }
        refreshSkillCommands();
        appendStaticEntry({
          body: `Installed /${skill.name} in ${installed.dir}.\nThe agent can use it from your next message, or run it yourself with /${skill.name}.`,
          kind: 'system',
          title: 'Skills',
        });
      } finally {
        if (activeTurnAbort === controller) activeTurnAbort = null;
        store.update((current) => ({ ...current, busy: false, activeTurnInput: '', status: '' }));
        await remountTui();
        await flushQueuedMessage();
      }
    };

    const handleSubmit = async (
      rawInput: string,
      { jobFollowUp = false }: { jobFollowUp?: boolean } = {},
    ): Promise<void> => {
      const chunks = jobFollowUp ? [] : store.getState().pastedChunks;
      const expanded = chunks.length
        ? expandPastedChunks(String(rawInput ?? ''), chunks)
        : String(rawInput ?? '');
      const input = expanded.trim();
      const preformatted = chunks.length > 0;
      refreshSkillCommands();
      if (store.getState().busy) {
        if (!input || exiting) return;
        if (input.startsWith('/')) {





          if (isJobsPickerCommand(input)) {
            store.update((current) => ({
              ...current,
              cursor: 0,
              input: '',
              pastedChunks: [],
            }));
            openJobsPicker();
            return;
          }




          if (input === '/notify') {
            store.update((current) => ({
              ...current,
              cursor: 0,
              input: '',
              pastedChunks: [],
            }));
            toggleNotifications();
            return;
          }
          appendTurnAwareEntry({
            body:
              "Slash commands can't be queued while a turn is running. " +
              'Ctrl+B opens background jobs, Ctrl+G toggles notifications.',
            kind: 'system',
            title: 'Queued',
          });
          return;
        }



        const pending = store.getState();
        const body = String(rawInput ?? '');
        const snapshot: QueuedMessage = {
          body,







          imageAttachments: pending.imageAttachments.filter((attachment) =>
            body.includes(`[Image #${attachment.index}]`),
          ),
          pastedChunks: pending.pastedChunks,
        };
        scheduleLiveFrameRemount();
        store.update((current) => ({
          ...current,
          cursor: 0,
          imageAttachments: [],
          input: '',
          pastedChunks: [],
          queuedMessage: snapshot,
          transcriptScrollOffset: 0,
        }));
        return;
      }




      const imageAttachments = store
        .getState()
        .imageAttachments.filter((attachment) =>
          input.includes(`[Image #${attachment.index}]`),
        );

      if (!jobFollowUp) {
        scheduleLiveFrameRemount();
        store.update((current) => ({
          ...current,
          cursor: 0,
          imageAttachments: [],
          input: '',
          pastedChunks: [],
          promptHistory: appendPromptToHistory(current.promptHistory, input),
          promptHistoryCursor: null,
          promptHistoryDraft: '',
        }));
        appendPromptHistory(input);
      }

      if ((!input && !jobFollowUp) || exiting) {
        store.update((current) => ({ ...current, imageAttachments: [] }));
        return;
      }

      if (input === '/exit' || input === '/quit') {
        requestExit();
        return;
      }

      if (input === '/logout') {
        store.update((current) => ({
          ...current,
          busy: true,
          status: 'Signing out...',
        }));



        try {
          await logoutFromServer({ config: authConfig });
        } catch {

        }
        clearCliAuthConfig(session.env);
        signedOut = true;
        requestExit();
        return;
      }

      if (input === '/skills' || input.startsWith('/skills ')) {
        await runSkillsCommand(input.slice('/skills'.length).trim());
        return;
      }

      if (input === '/mcp') {
        const connections = sessionMcp(session);
        const controller = new AbortController();
        activeTurnAbort = controller;
        store.update((current) => ({ ...current, busy: true, status: 'Checking MCP servers...', activeTurnInput: '/mcp' }));
        try {
          await connections.discover(controller.signal, { force: true });
          appendStaticEntry({ body: connections.status(), kind: 'system', title: 'MCP servers' });
        } catch (error) {
          appendStaticEntry({ body: controller.signal.aborted ? 'MCP discovery cancelled.' : String((error as Error).message), kind: 'system', title: 'MCP servers' });
        } finally {
          if (activeTurnAbort === controller) activeTurnAbort = null;
          store.update((current) => ({ ...current, busy: false, activeTurnInput: '', status: '' }));
          await remountTui();
        }
        await flushQueuedMessage();
        return;
      }

      if (input === '/help') {
        appendStaticEntry({
          body: formatInteractiveHelpText(),
          kind: 'system',
          title: 'Help',
        });
        return;
      }

      if (input === '/about') {
        appendStaticEntry({
          body: formatAboutCard(),
          kind: 'system',
          title: 'About',
        });
        return;
      }

      if (input === '/report') {
        const opened = await openUrl(REPORT_ISSUE_URL);
        appendStaticEntries(buildReportTranscriptEntries(opened));
        return;
      }

      if (input === '/notify') {
        toggleNotifications();
        return;
      }

      if (input === '/jobs' || input.startsWith('/jobs ')) {
        const jobsArgs = input.slice('/jobs'.length).trim();
        if (!jobsArgs) {
          openJobsPicker();
          return;
        }
        const killMatch = jobsArgs.match(/^kill\s+(\S+)$/);
        if (killMatch) {
          const jobId = killMatch[1]!;
          const killed = await killBackgroundJob(jobId);
          await collectBackgroundJobUiKillMutations({
            session,
            jobId,
            result: killed,
          });
          if (!killed.ok) {
            appendError(killed.error ?? 'Background job kill failed.');
          } else if (killed.alreadyFinished) {
            appendStaticEntry({
              body: `${jobId} had already finished.`,
              kind: 'system',
              title: 'Background jobs',
            });
          }

          return;
        }
        const outputMatch = jobsArgs.match(/^output\s+(\S+)$/);
        if (outputMatch) {
          await appendJobOutputEntry(outputMatch[1]!);
          return;
        }
        appendStaticEntry({
          body: 'Usage: /jobs - open the jobs picker · /jobs output <id> - full output · /jobs kill <id> - kill one',
          kind: 'system',
          title: 'Background jobs',
        });
        return;
      }

      if (input === '/usage') {
        store.update((current) => ({
          ...current,
          busy: true,
          status: 'Loading usage...',
        }));
        try {
          appendStaticEntry({
            body: await usageText(),
            kind: 'system',
            title: 'Usage',
          });
        } catch (error: any) {
          if (exitForAuthenticationError(error)) return;
          appendError(error.message);
        } finally {
          if (!exiting) {
            store.update((current) => ({
              ...current,
              busy: false,
              status: 'Ready',
            }));
          }
        }
        return;
      }

      if (input === '/resume') {
        store.update((current) => ({
          ...current,
          busy: true,
          status: 'Loading sessions...',
        }));
        try {
          await openResumePicker();
        } catch (error: any) {
          if (exitForAuthenticationError(error)) return;
          appendError(error.message);
        } finally {
          if (!exiting) {
            store.update((current) => ({
              ...current,
              busy: false,
              status: current.resumePickerOpen ? 'Select a session to resume' : 'Ready',
            }));
          }
        }
        return;
      }

      if (input === '/model' || input.startsWith('/model ')) {
        const inlineSelection = input.slice('/model'.length).trim();
        store.update((current) => ({
          ...current,
          busy: true,
          status: inlineSelection ? 'Switching model...' : 'Loading models...',
        }));
        try {
          if (!inlineSelection || inlineSelection === 'list') {
            await openModelPicker();
          } else {
            await switchToModel(inlineSelection);
          }
        } catch (error: any) {
          if (exitForAuthenticationError(error)) return;
          appendError(error.message);
        } finally {
          if (!exiting) {
            store.update((current) => ({
              ...current,
              busy: false,
              status: current.modelPickerOpen ? 'Select a model' : 'Ready',
            }));
          }
        }
        return;
      }

      if (input === '/new') {








        newConversationInFlight = true;
        store.update((current) => ({
          ...current,
          busy: true,
          busyPausedAt: null,
          busySince: Date.now(),






          imageAttachments: [],
          queuedMessage: null,
          status: 'Starting a new conversation...',
        }));
        if (!(await saveActiveSessionOrAbort())) {
          newConversationInFlight = false;
          store.update((current) => ({
            ...current,
            busy: false,
            busyPausedAt: null,
            busySince: null,
            status: 'Ready',
          }));





          await flushQueuedMessage();
          return;
        }
        startNewConversation(session);
        setBackgroundJobSession(session.sessionId);
        setScratchSession(session.sessionId);
        setImageStoreSession(session.sessionId);
        setTodoSession(session.sessionId);
        clearTodos();
        syncBackgroundJobsState();
        syncTodosState();
        latestUsageSummary = null;



        store.replaceTranscript([
          {
            body: 'Started a new conversation. The previous session remains saved.',
            kind: 'system',
            title: 'Session',
          },
        ]);





        await saveActiveSession();
        syncShellStateFromSession();
        newConversationInFlight = false;
        store.update((current) => ({
          ...current,
          busy: false,
          busyPausedAt: null,
          busySince: null,
          status: 'Ready',
        }));
        await remountTui();


        await flushQueuedMessage();
        return;
      }

      jobWait.turnStarted(jobFollowUp);
      latestUsageSummary = null;
      disarmExitConfirm();
      unacknowledged = new Map();
      const turnStartedAt = Date.now();
      const turnGeneration = ++activeTurnGeneration;
      const turnAbort = new AbortController();
      activeTurnAbort = turnAbort;
      lastTurnStartedAt = turnStartedAt;
      todosTouchedThisTurn = false;






      if (!jobFollowUp) clearTodos();
      syncTodosState();
      const userEntry: TranscriptEntryDraft = {
        body: input,
        kind: 'user',
        preformatted,
        title: 'You',
      };
      pendingTurnEntries = [];
      if (!jobFollowUp) queueTurnEntry(userEntry);


      resetThinkingPacer();
      activeTurnImageAttachments = imageAttachments;
      store.update((current) => ({
        ...current,
        activeTurnInput: input,
        activeTurnInputPreformatted: preformatted,
        analyzingImages: 0,
        generatingImage: false,
        busy: true,
        busyPausedAt: null,
        busySince: turnStartedAt,
        clockNow: turnStartedAt,
        recoveryStatus: '',
        status: 'Running turn...',
        usageNotice: null,




        thinkingTitle: '',
        thinkingNotes: [],
        transcriptScrollOffset: 0,
        tokenUsage: formatClientTokenUsage(0, latestUsageSummary),
        turnCounter: current.turnCounter + 1,

        turnMessages: [],
        workingTools: [],
      }));

      try {
        const result = await chat.sendServerUserMessage({
          config: authConfig,
          session,
          input,
          jobFollowUp,
          imageAttachments,
          signal: turnAbort.signal,
          onTurnStart: (serverTurnId) => {


            if (turnGeneration !== activeTurnGeneration) return;
            activeServerTurnId = serverTurnId;
          },
          onInterjectionDelivered: (event) => {
            if (turnGeneration !== activeTurnGeneration) return;



            for (const messageId of event.messageIds ?? []) {
              const pending = unacknowledged.get(messageId);
              if (!pending) continue;
              unacknowledged.delete(messageId);
              upsertTurnMessage(pending.row, {
                state: 'delivered',
                note: undefined,
              });
            }
          },
        });
        if (turnGeneration !== activeTurnGeneration) return;
        latestUsageSummary = result.usageSummary ?? null;
        const turnEntries = takePendingTurnEntries();
        if (!(await saveActiveSession())) return;
        syncShellStateFromSession();
        activeTurnImageAttachments = [];
        store.update((current) => ({
          ...current,
          activeTurnInput: '',
          activeTurnInputPreformatted: false,
          busy: true,
          commandLog: [],
          imageAttachments: [],
          status: result.waitingForApproval ? 'Awaiting approval' : 'Finishing response...',
          usageNotice: null,
          thinkingTitle: '',
          thinkingNotes: [],
          tokenUsage: formatClientTokenUsage(
            Date.now() - turnStartedAt,
            latestUsageSummary,
          ),
          workingTools: [],
        }));
        await appendSettledTurnEntries(
          turnEntries,
          result.text ?? '',
          () => turnGeneration === activeTurnGeneration && !turnAbort.signal.aborted,
        );
        if (turnGeneration !== activeTurnGeneration) return;
        if (todosTouchedThisTurn) {
          todosTouchedThisTurn = false;
          const todoItems = listTodos();
          if (todoItems.length > 0) {
            appendStaticEntry({
              body: '',
              kind: 'system',
              title: `To-dos · ${formatTodoProgress(todoItems)}`,
              todoList: todoItems,
            });





            if (todoItems.every((item) => item.status === 'completed')) {
              clearTodos();
              syncTodosState();
            }
          }
        }
        store.update((current) => ({
          ...current,
          busy: false,
          busyPausedAt: null,
          busySince: null,
          recoveryStatus: '',
          status: result.waitingForApproval ? 'Awaiting approval' : 'Ready',
          tokenUsage: formatClientTokenUsage(
            Date.now() - turnStartedAt,
            latestUsageSummary,
          ),
        }));
        jobWait.turnEnded(result.waitingForJobs);


        recoverUnacknowledgedMessages();
        await flushQueuedMessage();
      } catch (error: any) {
        if (turnGeneration !== activeTurnGeneration) {
          if (isTurnCancelledError(error)) {
            await saveActiveSession();
          }
          return;
        }
        const cancelled = isTurnCancelledError(error);
        if (exitForAuthenticationError(error)) return;
        dismissPendingApproval();
        dismissPendingSudoPassword();
        dismissPendingUserInput();




        const failedTurnAttachments = activeTurnImageAttachments;
        activeTurnImageAttachments = [];

        const quotaNotice = cancelled ? null : buildRefusalNotice(error);
        const restoresPrompt =
          quotaNotice !== null && !jobFollowUp && !store.getState().input && !store.getState().queuedMessage;
        store.update((current) => ({
          ...current,
          ...(restoresPrompt
            ? { cursor: String(rawInput ?? '').length, input: String(rawInput ?? ''), pastedChunks: chunks }
            : {}),
          activeTurnInput: '',
          activeTurnInputPreformatted: false,
          busy: false,
          busyPausedAt: null,
          busySince: null,
          commandLog: [],
          imageAttachments: failedTurnAttachments,
          recoveryStatus: '',
          status: cancelled
            ? 'Ready'
            : quotaNotice
              ? quotaNotice.title
              : 'Turn failed',
          thinkingTitle: '',
          thinkingNotes: [],
          tokenUsage: formatClientTokenUsage(
            Date.now() - turnStartedAt,
            latestUsageSummary,
          ),
          workingTools: [],
        }));
        const turnEntries = takePendingTurnEntries();
        if (cancelled) {
          appendStaticEntries([
            ...turnEntries,
            {
              body: 'Turn cancelled.',
              kind: 'system',
              title: 'System',
            },
          ]);
          if (!(await saveActiveSession())) return;
        } else if (quotaNotice) {
          appendStaticEntries([
            ...turnEntries,
            {
              body: quotaNotice.body,
              kind: 'system',
              title: quotaNotice.title,
            },
          ]);
        } else {
          appendStaticEntries(turnEntries);
          appendError(error.message);
          appendStaticEntries(buildTurnFailureHintEntries(cancelled));
        }
        await remountTui();



        const autoSubmits = !cancelled && isTurnOutcomeKnown(error);
        recoverUnacknowledgedMessages(autoSubmits);
        if (autoSubmits && turnGeneration === activeTurnGeneration) {
          await flushQueuedMessage();
        }
      } finally {
        if (activeTurnAbort === turnAbort) {
          activeTurnAbort = null;
        }
        if (turnGeneration === activeTurnGeneration) {
          lastTurnStartedAt = null;

          activeServerTurnId = null;
        }



        recoverUnacknowledgedMessages();



        await drainDeferredJobMutations();

        if (turnGeneration === activeTurnGeneration) scheduleJobFollowUp();
      }
    };

    session.onAccountUsage = (usage) => {
      if (usage?.plan && usage.plan !== store.getState().plan) {
        store.update((current) => ({ ...current, plan: usage.plan }));
      }
      const notice = usageNotice(usage);
      if (!notice) return;
      const entry: TranscriptEntryDraft = { ...notice, kind: 'system' };
      appendTurnAwareEntry(entry);
      if (store.getState().busy) {
        store.update((current) => ({ ...current, usageNotice: entry }));
      }
    };
    session.onImageAnalysis = (activeImageCount) => {
      store.update((current) => ({
        ...current,
        analyzingImages: Math.max(0, activeImageCount),
        generatingImage: activeImageCount > 0 ? false : current.generatingImage,
      }));
    };
    session.onRecovery = (status) => {
      if (status.phase === 'restored' || status.phase === 'continued') {
        store.update((current) => ({ ...current, recoveryStatus: '' }));
        appendTurnAwareEntry(
          status.phase === 'restored'
            ? { body: 'Continued the same turn.', kind: 'system', title: 'Connection restored' }
            : {
                body: 'Continued from the steps that had finished.',
                kind: 'system',
                title: 'Server restarted',
              },
        );
        return;
      }
      store.update((current) => ({
        ...current,

        recoveryStatus:
          status.phase === 'reconnected' ? '' : formatTurnRecoveryStatus(status),
      }));
    };
    session.onImageGeneration = (active) => {
      store.update((current) => ({
        ...current,
        generatingImage: Boolean(active),
        analyzingImages: active ? 0 : current.analyzingImages,
      }));
    };
    session.onStatus = (message) => {
      const panel = thinkingPanelFromStatus(message);
      store.update((current) => ({
        ...current,
        status: message,
        tokenUsage: formatClientTokenUsage(
          busyElapsedMs(current, Date.now()),
          latestUsageSummary,
        ),
      }));
      queueThinkingUpdate({
        title: panel ? panel.title : liveStatusPanelTitle(message),
        notes: panel ? panel.notes : [],
      });
    };
    session.onContextLog = (message) => {
      store.update((current) => ({
        ...current,
        contextStatus: message,
        tokenUsage: formatClientTokenUsage(
          busyElapsedMs(current, Date.now()),
          latestUsageSummary,
        ),
      }));
    };
    session.onToolEvent = (event) => {
      syncShellStateFromSession();
      if (event.call.name === 'update_todos') {
        syncTodosState();
        if ((event.result as { ok?: boolean } | null)?.ok === true) {



          todosTouchedThisTurn = true;
          return;
        }
      }
      if (isFileChangeTool(event.call.name)) {
        const entry = buildFileChangeEntry(event);
        store.appendWorkingTool(entry);
        const result = event.result as { ok?: boolean; skipped?: boolean } | null;
        if (result?.ok === true || result?.skipped === true) appendTurnAwareEntry(entry);
        return;
      }
      store.appendWorkingTool(buildWorkingToolEntry(event, session.mcp?.label(event.call.name)));
    };
    const syncBackgroundJobsState = () => {





      const expandedId = store.getState().jobsPickerExpandedId;
      const jobsForDisplay: BackgroundJobDisplay[] = listBackgroundJobs().map(
        (job) => {
          const expanded = job.id === expandedId;
          const preview = getJobOutputPreview(job.id, expanded ? 20 : 3);
          const dropped = preview?.droppedChars ?? 0;
          const detailLines = !expanded
            ? []
            : dropped > 0
              ? [
                  `... (${dropped} chars of older output dropped) ...`,
                  ...(preview?.tailLines ?? []),
                ]
              : (preview?.tailLines ?? []);
          return {
            id: job.id,
            command: job.command,
            status: job.status,
            exitCode: job.exitCode,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            firstOutputLine: preview?.firstLine ?? '',


            tailLines: (preview?.tailLines ?? []).slice(-3),
            detailLines,
          };
        },
      );
      store.update((current) => ({
        ...current,
        backgroundJobs: jobsForDisplay,
        jobsPickerExpandedId: jobsForDisplay.some(
          (job) => job.id === current.jobsPickerExpandedId,
        )
          ? current.jobsPickerExpandedId
          : null,
      }));
    };
    const scheduleJobFollowUp = () => {
      if (jobWait.waiting.length === 0) return;
      setTimeout(async () => {
        const state = store.getState();
        if (exiting || state.busy || state.modelPickerOpen || state.resumePickerOpen) return;
        const decision = jobWait.takeDecision();
        if (decision === 'wait') return;
        if (decision === 'stop') {
          appendStaticEntry({
            body: 'A background job finished. Send a message to continue.',
            kind: 'system',
            title: 'Background job',
          });
          return;
        }

        await drainDeferredJobMutations();

        if (exiting || store.getState().busy) return;
        void handleSubmit('', { jobFollowUp: true });
      }, 0);
    };


    setBackgroundJobUpdateHook((snapshot) => {
      syncBackgroundJobsState();
      if (snapshot.status !== 'running') {
        appendTurnAwareEntry(buildBackgroundJobNoticeEntry(snapshot));
        scheduleJobFollowUp();
      }
    });
    refreshSkillCommands();
    session.requestSudoPassword = async ({ command, prompt, signal }) =>
      openSudoPasswordPrompt(command, prompt, signal);
    session.requestUserInput = async (request, signal) =>
      openUserInputPrompt(request.questions, signal);
    session.requestPermission = async (request) => {
      const deny = { kind: 'deny' as const };
      if (exiting) return deny;
      if (sessionAutoYes) return { kind: 'once' as const };
      const decision = await openApprovalPrompt(request, session.turnAbortSignal);


      if (decision.kind === 'always-bucket') {
        appendTurnAwareEntry({
          body: `Allowed for the rest of this session: ${bucketActionLabel(request.bucket)}.`,
          kind: 'system',
          title: 'Approvals',
        });
      } else if (decision.kind === 'always-prefix') {
        appendTurnAwareEntry({
          body: `Allowed for the rest of this session: commands starting with \`${decision.prefix}\`.`,
          kind: 'system',
          title: 'Approvals',
        });
      } else if (decision.kind === 'always-mcp-tool') {
        appendTurnAwareEntry({
          body: `Allowed for the rest of this session: ${request.mcpLabel ?? request.title}.`,
          kind: 'system',
          title: 'Approvals',
        });
      } else if (decision.kind === 'always-origin') {
        appendTurnAwareEntry({
          body: `Allowed for the rest of this session: browser actions on ${decision.origin}.`,
          kind: 'system',
          title: 'Approvals',
        });
      }
      return decision;
    };

    const shellInputHandlers = {
      getApprovalScrollLimit: () => {
        const contentWidth = frameContentWidth(terminalCols);
        return approvalScrollLimit(
          store.getState().approvalPrompt,
          contentWidth,
          terminalRows,
        );
      },
      getComposerInputWidth: () =>
        composerInputWidth(terminalCols, store.getState()),
      getTranscriptScrollLimit: () => {
        const contentWidth = frameContentWidth(terminalCols);
        const blocks = store.getState().transcript.map((entry) =>
          renderTranscriptEntryLines(entry, contentWidth),
        );
        return blocks.reduce(
          (total, block, index) => total + block.length + (index > 0 ? 1 : 0),
          0,
        );
      },
      getUserInputViewport: () => {
        const nowMs = Date.now();
        const state = store.getState();
        return userInputViewportForFrame(
          state,
          terminalCols,
          terminalRows,
          spinnerFrame,
          busyElapsedSeconds(state, nowMs),
          nowMs,
        );
      },
      onCancelTurn: cancelActiveTurn,
      onCycleAgentMode: cycleAgentMode,
      onAgentModeChangeBlocked: reportAgentModeLocked,
      onCtrlC: handleCtrlC,
      onLinkCopy: handleLinkCopy,
      onLinkOpen: handleLinkOpen,
      onLiveFrameShapeChange: scheduleLiveFrameRemount,
      onRequestExit: requestExit,
      onResolveApproval: handleInlineApprovalChoice,
      onResolveUserInput: handleInlineUserInput,
      onResumeSession: handleInlineResumeSelection,
      onSelectionCopy: handleAppSelectionCopy,
      onSelectModel: handleInlineModelSelection,
      onOpenJobsPicker: openJobsPicker,
      onToggleNotifications: toggleNotifications,
      onJobsPickerOutput: handleJobsPickerOutput,
      onJobsPickerKill: handleJobsPickerKill,
      onSudoPasswordInput: handleSudoPasswordInput,
      onSubmit: handleSubmit,
      onFireQueuedMessage: fireQueuedMessage,
    };

    const unsubscribe = store.subscribe(() => {
      renderCurrentFrame();

      if (jobWait.waiting.length > 0 && !store.getState().busy) scheduleJobFollowUp();
    });
    const spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % 6;
      if (store.getState().busy) {
        flushPendingThinking();
        renderCurrentFrame();
      }
    }, 120);
    const clockTimer = setInterval(() => {


      if (hasRunningBackgroundJobs()) {
        syncBackgroundJobsState();
      }
      if (store.getState().busy || hasRunningBackgroundJobs()) {
        renderCurrentFrame();
      }
    }, 1000);

    let initialPromptDelivered = false;
    bridge.onEvent((message: TuiChildMessage) => {
      if (message.op === 'ready') {
        tuiReady = true;
        terminalCols = message.cols;
        terminalRows = message.rows;
        bridge.clear();
        renderCurrentFrame();
        if (!initialPromptDelivered && initialPrompt) {
          initialPromptDelivered = true;
          void handleSubmit(initialPrompt);
        }
        return;
      }
      if (message.op === 'closed') {
        resolveDone?.();
        return;
      }
      if (message.op === 'event') {
        if (message.kind === 'focus') {
          store.update((current) =>
            current.terminalFocused === message.focused
              ? current
              : { ...current, terminalFocused: message.focused },
          );
          renderCurrentFrame();
          return;
        }
        if (message.kind === 'resize') {
          terminalCols = message.cols;
          terminalRows = message.rows;
          void remountTui();
          return;
        }
        handleShellKeyEvent(store, shellInputHandlers, message);
        renderCurrentFrame();
      }
    });

    setCommandOutputHook((text) => {
      store.update((current) => appendCommandLog(current, text));
    });

    try {
      await done;
    } finally {
      clearInterval(spinnerTimer);
      clearInterval(clockTimer);
      unsubscribe();
      clearLiveFrameRemountTimer();
      terminalTitle.dispose();
      killAllBackgroundJobs();
      setBackgroundJobSession(null);
      setScratchSession(null);
      setImageStoreSession(null);
      setTodoSession(null);
      setBackgroundJobUpdateHook(null);
      await bridge.close();
      releaseTerminalWrites();
      setCommandOutputHook(null);
    }
  });
  if (fatalError) throw fatalError;
  return { signedOut };
}
