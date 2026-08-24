import { createRatatuiBridge } from './tui/bridge.js';
import {
  bucketActionLabel,
  type PermissionDecision,
  type PermissionOption,
  type PermissionRequest,
} from '../permissions.js';
import {
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
import { createTerminalTitleController } from './tui/terminal-title.js';
import {
  captureTerminalWrites,
  releaseTerminalWrites,
} from './tui/terminal-writes.js';

export { getSlashCommandSuggestions } from './tui/build-frame.js';
import type { TuiChildMessage } from './tui/types.js';
import {
  agentModeLabel,
  nextAgentMode,
  type AgentMode,
} from '../agent-mode.js';
import { chat, models } from '../api/index.js';
import { isTurnCancelledError } from '../api/chat.js';
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
  /** Built per request, so a command prompt can offer a prefix grant. */
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

interface SlashCommandOption {
  command: string;
  description: string;
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
  modelPickerIndex: number;
  modelPickerOpen: boolean;
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
  // Everything the user has sent into the running turn, with its delivery
  // state. Rendered live so an accepted-but-not-yet-read message is visibly
  // pending rather than apparently lost.
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
  /** True when the session ended because the user ran `/logout`. */
  signedOut: boolean;
}

export interface ClientInteractiveOptions {
  authConfig: CliAuthConfig;
  debugUi: {
    showSessionId: boolean;
  };
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
const AGENT_MODE_LABEL_WIDTH = 16;

export const SLASH_COMMANDS: SlashCommandOption[] = [
  {
    command: '/help',
    description: 'Show available chat commands',
  },
  {
    command: '/about',
    description: 'Show version and platform info',
  },
  {
    command: '/usage',
    description: 'Show account usage percentage and reset times',
  },
  {
    command: '/model',
    description: 'Switch the active model',
  },
  {
    command: '/resume',
    description: 'Open the session picker',
  },
  {
    command: '/jobs',
    description: 'Background jobs: pick to view output or kill',
  },
  {
    command: '/new',
    description: 'start a new conversation; this session remains saved',
  },
  {
    command: '/logout',
    description: 'Sign out and quit',
  },
  {
    command: '/exit',
    description: 'Quit the current session',
  },
];

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

function buildDeleteFileDiff(content: string): string {
  const lines = splitDiffLines(String(content ?? ''));
  if (lines.length === 0) return '';
  return `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}`;
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
  if (result?.skipped) return 'Skipped';
  if (result?.blocked) return 'Blocked';
  if (result?.ok === true) return 'OK';
  // A remote status is the whole story for a failed fetch — 404 means the page
  // is gone, 403/429 means we were turned away. Everything without one (DNS,
  // timeout, unparseable body) stays a plain "Failed".
  if (Number.isInteger(result?.httpStatus)) return String(result.httpStatus);
  return 'Failed';
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
    return {
      body: error || `${call.name} ${filePath}`,
      filePath,
      kind: skipped ? 'system' : 'error',
      title: skipped ? `${verb} skipped: ${filePath}` : `${verb} failed: ${filePath}`,
    };
  }

  // Scratch-directory files are the agent's throwaway workspace, not project
  // files: render a compact shell-style line instead of a repo-edit diff so
  // the transcript does not read as "file added to your project".
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
    const diffText = buildDeleteFileDiff(content);
    const preview = diffText ? parseDiffPreview(diffText) : undefined;
    const summary = preview ? ` (+0 -${preview.removed})` : '';
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

export function buildWorkingToolEntry(event: ToolTranscriptEvent): TranscriptEntryDraft {
  const { call, result } = event;
  const error =
    typeof result?.error === 'string' && result.error.trim()
      ? `\n${truncate(result.error.trim(), 180)}`
      : '';

  if (call.name === 'run_command') {
    const command = String(call.args?.command ?? result?.command ?? '').trim();
    if (result?.backgrounded === true && result?.jobId) {
      return {
        body: `$ ${truncate(command, 180)}\nBackground job ${String(result.jobId)} started.${error}`,
        kind: result?.ok === true ? 'tool' : 'error',
        preformatted: true,
        title: 'Shell',
      };
    }
    return {
      body: `$ ${truncate(command, 180)}\n${formatRunCommandResultState(result)}${error}`,
      kind: result?.ok === true ? 'tool' : 'error',
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
      body: `${jobId || '(unknown job)'} · ${stateText}${error}`,
      kind: result?.ok === true ? 'tool' : 'error',
      title: call.name === 'shell_job_kill' ? 'Kill job' : 'Job output',
    };
  }

  if (call.name === 'run_node_script') {
    return {
      body: `node --input-type=module <script via stdin>\n${formatRunCommandResultState(result)}${error}`,
      kind: result?.ok === true ? 'tool' : 'error',
      title: 'Node',
    };
  }

  if (isFileChangeTool(call.name)) {
    return buildFileChangeEntry(event);
  }

  const args = formatToolArgs(call, result);
  return {
    body: `${call.name}${args ? ` ${args}` : ''} -> ${formatToolResultState(result)}${error}`,
    kind: result?.ok === true ? 'tool' : 'error',
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
      entries.push(
        buildFileChangeEntry({
          call,
          result: functionResponse.response ?? {},
        }),
      );
    }
    if (entry.role === 'user' && entry.kind === 'turnStart') {
      const text = displayUserTextFromHistoryEntry(entry);
      if (text) {
        entries.push({ body: text, kind: 'user', title: 'You' });
      }
      continue;
    }
    // A message the user sent into a turn that was already running. Rendered
    // from `userInput` rather than the parts, which carry the envelope the
    // model reads; without this branch the entry is skipped as machine context
    // and the user's own words vanish from scrollback on resume.
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

function createShellStore(initialState: ShellState): ShellStore {
  let state = initialState;
  let nextEntryId = 1;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState: (nextState) => {
      state = nextState;
      notify();
    },
    update: (updater) => {
      state = updater(state);
      notify();
    },
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
      // Even a duplicate summary row (the same command run twice in a row)
      // means the tool that just produced it finished, so its leftover raw
      // output must still be cleared here — otherwise a repeated command's
      // stdout tail lingers under whatever runs next, with nothing marking
      // the boundary.
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
    cursor: 0,
    exiting: false,
    input: '',
    maxToolSteps: session.maxToolSteps,
    jobsPickerExpandedId: null,
    jobsPickerIndex: 0,
    jobsPickerOpen: false,
    modelPickerIndex: getDefaultModelPickerIndex(session.modelId, serverModels.models),
    modelPickerOpen: false,
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

// Reasoning models often format their thinking narration with markdown
// emphasis (e.g. "**Executing Audit Script**" as a bolded heading). The
// panel already renders titles/notes with its own bold/color styling, so the
// literal ** or __ markers must be stripped here or they show up doubled
// (bold text that still has asterisks baked into it) in the terminal.
function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1');
}

// No character-count truncation here: the TUI fits each line to the actual
// terminal width at render time (see fitLine in build-frame.ts), so a
// fixed-width cut here would either be redundant or, worse, chop a thought
// mid-sentence with a confusing "(truncated)" marker on a line the renderer
// was going to re-fit anyway.
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

// A live status line is shown in place of the last thought while it is current.
// Internal, operator-facing status text (local runs only) must never take the
// panel over, so only short single-line messages are promoted.
const LIVE_STATUS_PANEL_MAX_CHARS = 72;

// Tool activity already has its own rendered line above the thinking panel, so
// letting these through produced the same fact twice — a "Tool list_files -> OK"
// row with "Thinking · Tool: list_files" directly beneath it.
const TOOL_PROGRESS_STATUS_PATTERN = /^(?:Tool:\s|Running\s\S+(?:\slocally)?\.\.\.$)/i;

export function isToolProgressStatus(status: string): boolean {
  return TOOL_PROGRESS_STATUS_PATTERN.test(String(status ?? '').trim());
}

// Reshuffling the phrase on every filtered status would make the row flicker
// through five different texts a second. Whatever fallback is already showing
// stays put; a new one is drawn only when coming from a real thought.
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
    // First rows, not the last: the payload is now a composed summary whose
    // first line is its opening, so tailing it dropped the beginning. For raw
    // narration the upstream sanitizer already keeps only recent lines, so
    // taking the head there is still current.
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

export function getInputCommandToken(input: string): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed.startsWith('/')) return '';
  const firstSpaceIndex = trimmed.indexOf(' ');
  const token = firstSpaceIndex === -1 ? trimmed : trimmed.slice(0, firstSpaceIndex);
  // A token with a second '/' is a filesystem path (e.g. /home/user/repo),
  // not a slash command — no command contains a slash, so don't treat it as one.
  if (token.indexOf('/', 1) !== -1) return '';
  return token;
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
    !trimmed.includes(' ') &&
    // A '/'-prefixed token with a second '/' is a filesystem path, not a
    // command — getInputCommandToken returns '' for it, so the palette stays
    // closed when a folder path is pasted.
    getInputCommandToken(trimmed) !== ''
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
  if (!token) {
    return { cursor: suggestion.command.length, input: suggestion.command };
  }
  const tokenStart = currentInput.indexOf(token);
  const before = currentInput.slice(0, tokenStart);
  const after = currentInput.slice(tokenStart + token.length);
  return {
    cursor: before.length + suggestion.command.length,
    input: `${before}${suggestion.command}${after}`,
  };
}

export function isExactSlashCommandToken(token: string): boolean {
  return SLASH_COMMANDS.some((command) => command.command === token);
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
  // Deny is always the last option and the prompt opens on it, so a stray Enter
  // lands on the safe answer rather than approving something unread.
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

// The "Working · 42s" clock measures how long the model has been busy, so the
// time an operator spends reading an approval or sudo prompt does not belong in
// it — left running it turns a considered review into what looks like a slow
// turn, and the same number is what the token footer reports as the turn
// duration. Pausing freezes the reading; resuming pushes busySince forward by
// however long the prompt was up, so the clock carries on from where it stopped
// instead of jumping to catch up.
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
  return serverModels.map((model) => ({
    id: model.id,
    label: model.label,
    publicId: model.id,
    costRating: model.costRating,
    current: model.id === currentModelId,
    disabled: false,
    note: model.description,
  }));
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
    const store = createShellStore(
      createInitialShellState(session, serverModels, debugUi),
    );
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
    // From here until the TUI releases the terminal, nothing this process writes
    // may reach the TTY: a stray write splits ratatui's escape sequences.
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
    let pendingTurnEntries: TranscriptEntryDraft[] = [];
    let activeTurnAbort: AbortController | null = null;
    // Server id of the turn currently streaming, learned from its first event.
    // Non-null only while a turn is genuinely live on the server, which is what
    // makes it safe to use as the address for a mid-turn message: it is cleared
    // the moment the turn settles, so a late Enter cannot post into a dead turn.
    let activeServerTurnId: string | null = null;
    // Messages the server has accepted but the agent has not read yet, keyed by
    // the id sent with the request.
    //
    // The payload is held, not discarded, until the agent confirms it read the
    // message. A 200 only means the server parked the text: the turn can still
    // fail, be cancelled, or end through a path that never drains the mailbox,
    // and the composer has already unlocked by then. Anything still unconfirmed
    // when the turn settles is submitted as the next prompt instead of vanishing.
    let unacknowledged = new Map<string, { row: number; queued: QueuedMessage }>();
    // Rows already shown for a message that could not be sent yet, keyed by the
    // queued payload, so repeated Enter presses update one row instead of
    // adding a new one each time.
    const blockedRows = new WeakMap<QueuedMessage, number>();
    // /new's busy state isn't an abortable turn — its awaited saves can't be
    // cancelled mid-flight, so cancelActiveTurn must not reopen input while
    // this is true (see cancelActiveTurn below).
    let newConversationInFlight = false;
    // Set when update_todos ran this turn, so exactly one readable snapshot
    // of the final list lands in the transcript at turn end.
    let todosTouchedThisTurn = false;
    const syncTodosState = () => {
      store.update((current) => ({ ...current, todos: listTodos() }));
    };
    let activeTurnGeneration = 0;
    let exitCtrlCArmed = false;
    let exitCtrlCTimer: ReturnType<typeof setTimeout> | null = null;
    let transientStatusTimer: ReturnType<typeof setTimeout> | null = null;

    // Reasoning arrives far faster than anyone can read it — a thought could be
    // replaced within milliseconds of appearing. Each one now holds the row for
    // a minimum dwell; newer thoughts overwrite the pending slot rather than
    // queueing, so the panel always advances to the freshest thought rather
    // than replaying a backlog. Flushed from the existing spinner tick, so this
    // costs no extra timer.
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

    const showTransientStatus = (status: string): void => {
      if (transientStatusTimer) {
        clearTimeout(transientStatusTimer);
        transientStatusTimer = null;
      }
      store.update((current) => ({ ...current, status }));
      transientStatusTimer = setTimeout(() => {
        transientStatusTimer = null;
        store.update((current) =>
          current.status === status ? { ...current, status: 'Ready' } : current,
        );
      }, 2500);
    };

    // Routed through the TUI process, which owns the terminal. Writing the title
    // escape from here raced its frame flushes and corrupted the status rows.
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

    const renderCurrentFrame = () => {
      if (!tuiReady) return;
      const state = store.getState();
      syncTerminalTitle();
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
      // Ctrl+C with a queued message: recall it into the composer for editing
      // rather than auto-submitting it against the cancelled turn. (Esc with a
      // queued message clears the slot in shell-input without cancelling.)
      const queued = store.getState().queuedMessage;
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
        imageAttachments: queued ? queued.imageAttachments : [],
        input: queued ? queued.body : current.input,
        pastedChunks: queued ? queued.pastedChunks : current.pastedChunks,
        promptHistoryCursor: queued ? null : current.promptHistoryCursor,
        promptHistoryDraft: queued ? '' : current.promptHistoryDraft,
        queuedMessage: null,
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

    // Tolerant: a generic save failure is reported but does not abort the
    // caller. Other call sites (model switch, turn completion) rely on this —
    // a transient save error must not drop an already-completed response or
    // strand the shell in a busy state.
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

    // Strict: used only around the /new session-rotation boundary, where a
    // save failure must abort instead of silently continuing past unsaved
    // conversation data.
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
          status: 'Waiting for your input',
          userInputPrompt: createUserInputPromptState(
            questions,
            current.status,
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
    ): Promise<PermissionDecision> =>
      new Promise((resolve) => {
        const deny: PermissionDecision = { kind: 'deny' };
        if (exiting) {
          resolve(deny);
          return;
        }
        resolvePermissionDecision = resolve;
        store.update((current) => ({
          ...pauseBusyClock(current, Date.now()),
          approvalCursor: getDefaultApprovalCursor(request.options.length),
          approvalOpenedAt: Date.now(),
          // Every prompt opens at its first row: the top of a script is what
          // says what it does, and carrying a previous prompt's scroll position
          // over would open the next one somewhere arbitrary.
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
            returnStatus: current.status,
          },
          status: request.title,
        }));
      });

    /**
     * Resolve the open prompt with the option at `index`. Anything out of range
     * — including the -1 that Esc sends — denies, so an unmapped key can never
     * approve by accident.
     */
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
        status: 'Select a model',
      }));
    };

    const switchToModel = async (modelId: string | number): Promise<void> => {
      const requested = Number(modelId);
      const fresh = currentServerModels.models.some((model) => model.id === requested)
        ? currentServerModels
        : await refreshServerModels();
      const selected = models.validateServerModel(modelId, fresh);
      session.modelId = selected;
      models.updateSelectedModelCache({
        config: authConfig,
        selectedModelId: selected,
        serverModels: fresh,
      });
      if (!(await saveActiveSession())) return;
      syncShellStateFromSession();
      appendStaticEntry({
        body: `Switched to ${formatModelLabel(selected, fresh.models)}. Conversation history preserved.`,
        kind: 'system',
        title: 'Model',
      });
    };

    const openJobsPicker = () => {
      syncBackgroundJobsState();
      store.update((current) => ({
        ...current,
        commandCursor: 0,
        cursor: 0,
        input: '',
        jobsPickerExpandedId: null,
        jobsPickerIndex: 0,
        jobsPickerOpen: true,
        status: 'Background jobs',
      }));
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
        title: `${job.id} output — ${truncate(job.command, 80)}`,
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

    const handleJobsPickerOutput = async (): Promise<void> => {
      const jobId = selectedJobsPickerId();
      if (!jobId) return;
      await collectBackgroundJobUiOutputMutations({
        session,
        jobId,
      });
      syncBackgroundJobsState();
      store.update((current) => ({
        ...current,
        jobsPickerExpandedId:
          current.jobsPickerExpandedId === jobId ? null : jobId,
      }));
    };

    const handleJobsPickerKill = async (): Promise<void> => {
      const jobId = selectedJobsPickerId();
      if (!jobId) return;
      const killed = await killBackgroundJob(jobId);
      await collectBackgroundJobUiKillMutations({
        session,
        jobId,
        result: killed,
      });
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
      // A successful kill is reported by the job's notice row.
    };

    const handleInlineModelSelection = async (): Promise<void> => {
      const current = store.getState();
      const options = buildModelPickerOptions(current.currentModelId, current.serverModels);
      const selectedIndex = Math.min(
        current.modelPickerIndex,
        Math.max(options.length - 1, 0),
      );
      const selected = options[selectedIndex];
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
      if (selected.id === current.currentModelId) {
        appendStaticEntry({
          body: `Already using ${formatModelLabel(selected.id, current.serverModels)}.`,
          kind: 'system',
          title: 'Model',
        });
        return;
      }
      try {
        await switchToModel(selected.id);
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
        applySessionSnapshot(session, snapshot);
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
      // Rehydrate attachments/chunks before submit: handleSubmit expands
      // pastedChunks from the store and the turn picks up imageAttachments.
      store.update((current) => ({
        ...current,
        imageAttachments: queued.imageAttachments,
        pastedChunks: queued.pastedChunks,
        queuedMessage: null,
      }));
      await handleSubmit(queued.body);
    };

    // Every row the user can see in the live "Your messages" panel. Ids are
    // local and monotonic; the server never needs them.
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

    // A message the server accepted but the agent never read — the turn failed,
    // was cancelled, or ended through a path that took no further look at the
    // mailbox. The user was told it was on its way, so it is put back in the
    // composer's queued slot and the ordinary end-of-turn flush submits it as
    // the next prompt. Losing it silently is the one outcome that is not
    // acceptable.
    const recoverUnacknowledgedMessages = (autoSubmits = true): void => {
      if (unacknowledged.size === 0) return;
      const stranded = [...unacknowledged.values()];
      unacknowledged = new Map();
      for (const { row } of stranded) {
        upsertTurnMessage(row, {
          state: 'queued',
          // A cancelled turn deliberately never auto-submits, so promising the
          // next prompt there would be a lie the UI tells about itself.
          note: autoSubmits
            ? 'not read — sending as the next prompt'
            : 'not read — left in the composer',
        });
      }
      // Every stranded message is restored, not just the first. They were all
      // written to this turn, in this order, so they are combined into the one
      // queued slot rather than silently reduced to whichever happened to be
      // sent first. Any message the user had already typed for next time keeps
      // its place at the end.
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

    // Sends the queued message into the turn that is already running, instead of
    // waiting for it to finish. The model receives it at the running turn's next
    // step boundary — which can be over a minute away on a long generation, so
    // the row stays on screen as `sending` until the server says otherwise.
    //
    // Every failure path leaves the message queued rather than dropping it: the
    // turn's own end-of-turn flushQueuedMessage then submits it as the next
    // prompt. "Could not send it early" degrades to "sent it at the end" and
    // never to "lost it" — and the row says which happened.
    const fireQueuedMessage = async (): Promise<void> => {
      const state = store.getState();
      const queued = state.queuedMessage;
      if (!queued || !state.busy || exiting) return;
      const text = (
        queued.pastedChunks.length
          ? expandPastedChunks(queued.body, queued.pastedChunks)
          : queued.body
      ).trim();
      // An image on its own is a complete message ("look at this"), so only an
      // empty message with nothing attached is a no-op.
      const images = queued.imageAttachments.filter((attachment) =>
        queued.body.includes(`[Image #${attachment.index}]`),
      );
      if (!text && images.length === 0) return;
      // The mid-turn channel carries images alongside the text now, so an
      // attached screenshot rides into the running turn instead of being held
      // back to the next prompt. Only a missing turn id still blocks.
      const turnId = activeServerTurnId;
      const blockedReason = !turnId ? 'waiting for the turn to end' : null;

      // A blocked message keeps the composer locked, so Enter lands here again
      // on every press. Without this the panel stacks another identical row
      // each time — three presses, three copies of the same sentence.
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

      // Everything that must be true before the request goes out happens here,
      // synchronously, for two reasons.
      //
      // Single-flight: the queued slot is claimed now, so a second Enter during
      // normal network latency cannot start a second POST carrying the same
      // text — which the server would append and the model would execute twice.
      //
      // Acknowledgement ordering: `interjection-delivered` arrives on the SSE
      // stream, a different connection from this POST, so the agent can consume
      // the message and the event can land BEFORE this request resolves.
      // Registering afterwards would leave the handler nothing to match, the
      // acknowledgement discarded, and recovery re-sending a message the model
      // already acted on.
      unacknowledged.set(messageId, { row: id, queued });
      scheduleLiveFrameRemount();
      store.update((current) =>
        current.queuedMessage === queued
          ? { ...current, queuedMessage: null }
          : current,
      );
      // Record it where it actually happened. Titled apart from a normal prompt
      // so a change of direction halfway down the transcript is readable later
      // as something the user asked for mid-turn, not the model wandering.
      queueTurnEntry({
        body: text,
        kind: 'user',
        preformatted: queued.pastedChunks.length > 0,
        title: 'You · sent mid-turn',
      });

      // Rolled back only on a definitive refusal. A message the server never
      // accepted must go back to being queued; one it did accept stays claimed
      // until the agent acknowledges reading it.
      const rollback = (note: string): void => {
        // The delete IS the ownership test. Two orderings can take this message
        // away before a late response arrives: the turn can settle first, with
        // recovery moving it to the queued slot and the flush submitting it; or
        // the agent can read it and the delivery event settle the row while the
        // POST response is still lost in the network. Re-queueing in either
        // case submits text that has already been sent or already been acted
        // on — the user's words executed twice.
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
        rollback(`not sent — ${error?.message ?? 'request failed'}`);
        return;
      }
      if (outcome === 'stale') {
        // The turn finished between the keystroke and the request landing.
        rollback('turn ended — sending as the next prompt');
      }
    };

    const handleSubmit = async (rawInput: string): Promise<void> => {
      const chunks = store.getState().pastedChunks;
      const expanded = chunks.length
        ? expandPastedChunks(String(rawInput ?? ''), chunks)
        : String(rawInput ?? '');
      const input = expanded.trim();
      const preformatted = chunks.length > 0;
      if (store.getState().busy) {
        if (!input || exiting) return;
        if (input.startsWith('/')) {
          appendTurnAwareEntry({
            body: "Slash commands can't be queued while a turn is running.",
            kind: 'system',
            title: 'Queued',
          });
          return;
        }
        // Snapshot the raw (placeholder) body plus chunks/images so recall and
        // flush round-trip the collapsed paste + attachments. Hold at most one;
        // a second enqueue replaces the slot.
        const pending = store.getState();
        const body = String(rawInput ?? '');
        const snapshot: QueuedMessage = {
          body,
          // Only the images THIS message references. The store still holds the
          // attachments of the turn that is currently running — they are
          // cleared when that turn's request goes out, not when it finishes —
          // so copying the list wholesale used to hand a text-only queued
          // message someone else's image, and the queue then refused to deliver
          // it early ("images go with the next prompt") over an attachment the
          // user never put there.
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
      // Only the images this message actually references, and handed off now
      // rather than when the turn ends: attachments left sitting in composer
      // state for the length of a turn are what a later queued message used to
      // pick up as its own.
      const imageAttachments = store
        .getState()
        .imageAttachments.filter((attachment) =>
          input.includes(`[Image #${attachment.index}]`),
        );
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

      if (!input || exiting) {
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
        // Revoking server-side is best effort: if it fails (offline, already
        // expired) the local credential still has to go, or the user is left
        // holding a token they asked to be rid of.
        try {
          await logoutFromServer({ config: authConfig });
        } catch {
          // Intentionally ignored; clearing locally is the part that matters.
        }
        clearCliAuthConfig(session.env);
        signedOut = true;
        requestExit();
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
          // A successful kill is reported by the job's notice row.
          return;
        }
        const outputMatch = jobsArgs.match(/^output\s+(\S+)$/);
        if (outputMatch) {
          await appendJobOutputEntry(outputMatch[1]!);
          return;
        }
        appendStaticEntry({
          body: 'Usage: /jobs — open the jobs picker · /jobs output <id> — full output · /jobs kill <id> — kill one',
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
        // Mark busy immediately, before the first await: saving can take a
        // few seconds, and handleSubmit only rejects/queues further input
        // while busy is true. Without this, a slow save leaves the shell
        // looking idle and a stray submit (including another /new) can race
        // the rotation below. newConversationInFlight additionally blocks
        // cancelActiveTurn (Ctrl+C/Esc): the awaited saves below can't be
        // cancelled mid-flight, so treating this like a cancellable turn
        // would let input reopen while the rotation is still pending.
        newConversationInFlight = true;
        store.update((current) => ({
          ...current,
          busy: true,
          busyPausedAt: null,
          busySince: Date.now(),
          // A stale queue/attachment from the old conversation shouldn't
          // leak into the new one. Cleared here, at entry, rather than at
          // exit below, so a message the user queues *during* this save
          // (now possible since input queues while busy) survives to be
          // flushed into the new session instead of being wiped alongside
          // the old one.
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
          // /new never rotated, so the current session is still the right
          // target: submit anything the user queued during the failed save
          // instead of leaving it stuck (the queued chip replaces the input
          // box until it is cleared) or flushing unexpectedly after some
          // later, unrelated turn.
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
        // Replace the transcript before the save below: if that save fails,
        // its reported error must survive on top of the fresh transcript,
        // not get wiped by a replaceTranscript call that runs after it.
        store.replaceTranscript([
          {
            body: 'Started a new conversation. The previous session remains saved.',
            kind: 'system',
            title: 'Session',
          },
        ]);
        // The rotation above already happened in memory, so a failure here
        // cannot be "aborted" — the old session is safely saved (the guard
        // above), and this session object is already the new one. Use the
        // tolerant save so the UI still gets updated to match reality; the
        // error is reported, not swallowed.
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
        // Flush anything the user queued while this save was in flight —
        // it belongs to the new session, not the old one.
        await flushQueuedMessage();
        return;
      }

      latestUsageSummary = null;
      disarmExitConfirm();
      unacknowledged = new Map();
      const turnStartedAt = Date.now();
      const turnGeneration = ++activeTurnGeneration;
      const turnAbort = new AbortController();
      activeTurnAbort = turnAbort;
      lastTurnStartedAt = turnStartedAt;
      todosTouchedThisTurn = false;
      // A new prompt is a new task: retire the previous turn's list instead of
      // carrying it into this one. It stays in the transcript as history; what
      // must not happen is the live panel showing a half-done list from an
      // earlier prompt that this turn is not working on — the agent cannot see
      // that list either, so it would sit there stale forever.
      clearTodos();
      syncTodosState();
      const userEntry: TranscriptEntryDraft = {
        body: input,
        kind: 'user',
        preformatted,
        title: 'You',
      };
      pendingTurnEntries = [];
      queueTurnEntry(userEntry);
      // A fresh turn must not inherit the previous turn's dwell clock or a
      // thought that never got flushed before it ended.
      resetThinkingPacer();
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
        status: 'Running turn...',
        // Deliberately blank: the panel stays hidden until the model actually
        // says something. Seeding a phrase here put a "Thinking" row on screen
        // before anything had come back, which announces activity that has not
        // started yet.
        thinkingTitle: '',
        thinkingNotes: [],
        transcriptScrollOffset: 0,
        tokenUsage: formatClientTokenUsage(0, latestUsageSummary),
        turnCounter: current.turnCounter + 1,
        // Belongs to the turn that just ended, not this one.
        turnMessages: [],
        workingTools: [],
      }));

      try {
        const result = await chat.sendServerUserMessage({
          config: authConfig,
          session,
          input,
          imageAttachments,
          signal: turnAbort.signal,
          onTurnStart: (serverTurnId) => {
            // Guard on generation: a stale stream that is still draining after
            // the user started a newer turn must not steal the fire address.
            if (turnGeneration !== activeTurnGeneration) return;
            activeServerTurnId = serverTurnId;
          },
          onInterjectionDelivered: (event) => {
            if (turnGeneration !== activeTurnGeneration) return;
            // Settle every message named in this drain. Several can be accepted
            // before one boundary and handed over together, so acknowledging
            // only one would leave the rest stuck showing as in-flight forever.
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
        store.update((current) => ({
          ...current,
          activeTurnInput: '',
          activeTurnInputPreformatted: false,
          busy: true,
          commandLog: [],
          imageAttachments: [],
          status: result.waitingForApproval ? 'Awaiting approval' : 'Finishing response...',
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
            // A fully-completed list has nothing left to show; clear it here
            // (after the snapshot above preserves it in scrollback) so an
            // unrelated later turn doesn't resurrect the old completed panel
            // in the live Working area before the model calls update_todos
            // again.
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
          status: result.waitingForApproval ? 'Awaiting approval' : 'Ready',
          tokenUsage: formatClientTokenUsage(
            Date.now() - turnStartedAt,
            latestUsageSummary,
          ),
        }));
        // Before the flush, not after: recovery restores anything the agent
        // never read into the queued slot, and the flush is what submits it.
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
        store.update((current) => ({
          ...current,
          activeTurnInput: '',
          activeTurnInputPreformatted: false,
          busy: false,
          busyPausedAt: null,
          busySince: null,
          commandLog: [],
          imageAttachments: [],
          status: cancelled ? 'Ready' : 'Turn failed',
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
        } else {
          appendStaticEntries(turnEntries);
          appendError(error.message);
        }
        await remountTui();
        // A cancelled turn never auto-submits the queue (Ctrl+C recalls it via
        // cancelActiveTurn); only a genuine error flushes a pending message.
        // A cancelled turn keeps its unread messages in the composer rather
        // than auto-submitting them, matching how Ctrl+C recalls a queued one.
        recoverUnacknowledgedMessages(!cancelled);
        if (!cancelled && turnGeneration === activeTurnGeneration) {
          await flushQueuedMessage();
        }
      } finally {
        if (activeTurnAbort === turnAbort) {
          activeTurnAbort = null;
        }
        if (turnGeneration === activeTurnGeneration) {
          lastTurnStartedAt = null;
          // Nothing may be fired into a turn that is no longer running.
          activeServerTurnId = null;
        }
        // Deliberately outside the generation guard: cancelling a turn bumps
        // the generation, and these messages belong to THIS turn regardless of
        // what has started since. Skipping here stranded them permanently.
        recoverUnacknowledgedMessages();
      }
    };

    session.onImageAnalysis = (activeImageCount) => {
      store.update((current) => ({
        ...current,
        analyzingImages: Math.max(0, activeImageCount),
        generatingImage: activeImageCount > 0 ? false : current.generatingImage,
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
        // A status that is not a thought supersedes the last thought rather
        // than sitting beneath it. Keeping the previous one on screen is what
        // made a stalled provider look like active reasoning for minutes.
        //
        // But superseding it with nothing empties the row and the row then
        // vanishes, so an empty title falls through to a fallback phrase.
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
          // The live to-do panel already shows the change; a generic tool
          // row would just duplicate it. Failures still fall through so the
          // user sees them.
          todosTouchedThisTurn = true;
          return;
        }
      }
      if (isFileChangeTool(event.call.name)) {
        const entry = buildFileChangeEntry(event);
        store.appendWorkingTool(entry);
        appendTurnAwareEntry(entry);
        return;
      }
      store.appendWorkingTool(buildWorkingToolEntry(event));
    };
    const jobDetailLines = (jobId: string): string[] => {
      const buffered = getJobBufferedOutput(jobId);
      if (!buffered) return [];
      const lines = buffered.output
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const visible = lines.slice(-20);
      return buffered.droppedChars > 0
        ? [
            `... (${buffered.droppedChars} chars of older output dropped) ...`,
            ...visible,
          ]
        : visible;
    };
    const syncBackgroundJobsState = () => {
      const jobsForDisplay: BackgroundJobDisplay[] = listBackgroundJobs().map(
        (job) => {
          const preview = getJobOutputPreview(job.id, 3);
          return {
            id: job.id,
            command: job.command,
            status: job.status,
            exitCode: job.exitCode,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            firstOutputLine: preview?.firstLine ?? '',
            tailLines: preview?.tailLines ?? [],
            detailLines: jobDetailLines(job.id),
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
    // Lifecycle transitions each fire this hook exactly once; output chunks do
    // not, so idle sessions stay calm.
    setBackgroundJobUpdateHook((snapshot) => {
      syncBackgroundJobsState();
      if (snapshot.status !== 'running') {
        appendTurnAwareEntry(buildBackgroundJobNoticeEntry(snapshot));
      }
    });
    session.requestSudoPassword = async ({ command, prompt, signal }) =>
      openSudoPasswordPrompt(command, prompt, signal);
    session.requestUserInput = async (request, signal) =>
      openUserInputPrompt(request.questions, signal);
    session.requestPermission = async (request) => {
      const deny = { kind: 'deny' as const };
      if (exiting) return deny;
      if (sessionAutoYes) return { kind: 'once' as const };
      const decision = await openApprovalPrompt(request);
      // A grant is invisible once the prompt closes — there is no permissions
      // screen — so say plainly what was just allowed and for how long.
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
      }
      return decision;
    };

    const shellInputHandlers = {
      getApprovalScrollLimit: () => {
        const contentWidth = Math.max(20, Math.floor(terminalCols * 0.95) - 2);
        return approvalScrollLimit(
          store.getState().approvalPrompt,
          contentWidth,
          terminalRows,
        );
      },
      getTranscriptScrollLimit: () => {
        const contentWidth = Math.max(20, Math.floor(terminalCols * 0.95) - 2);
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
      onJobsPickerOutput: handleJobsPickerOutput,
      onJobsPickerKill: handleJobsPickerKill,
      onSudoPasswordInput: handleSudoPasswordInput,
      onSubmit: handleSubmit,
      onFireQueuedMessage: fireQueuedMessage,
    };

    const unsubscribe = store.subscribe(() => {
      renderCurrentFrame();
    });
    const spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % 6;
      if (store.getState().busy) {
        flushPendingThinking();
        renderCurrentFrame();
      }
    }, 120);
    const clockTimer = setInterval(() => {
      // Tick while busy, and while managed background jobs are alive so the
      // compact jobs line keeps a live elapsed time between turns.
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
