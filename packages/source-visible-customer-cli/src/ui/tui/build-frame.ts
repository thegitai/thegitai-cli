import { agentModeLabel } from '../../agent-mode.js';
import type { ServerModelInfo } from '../../api/models.js';
import type { SessionMetadata } from '../../session-store.js';
import { singleLinePreview, truncate } from '../../utils.js';
import { formatClientTokenUsage } from '../repl.js';
import {
  renderFormattedBodyLines,
  renderPreformattedBodyLines,
} from './markdown-render.js';
import {
  displayWidth,
  line,
  padToWidth,
  plainLine,
  sliceToWidth,
  span,
  wrapText,
} from './text.js';
import { isDarkTerminalBackground, mutedColor, mutedStyle } from './terminal-theme.js';
import type { TuiFrame, TuiLine, TuiSection, TuiSpan } from './types.js';
import {
  buildUserInputOverlayLines,
  type UserInputPromptState,
  type UserInputViewport,
} from './user-input.js';

export interface DiffPreviewLine {
  content: string;
  kind: 'add' | 'context' | 'hunk' | 'remove';
  lineNumber: number | null;
}

export interface DiffPreviewModel {
  added: number;
  lines: DiffPreviewLine[];
  removed: number;
}

export type TranscriptKind =
  | 'assistant'
  | 'diff'
  | 'error'
  | 'system'
  | 'tool'
  | 'user';

export interface TranscriptEntryDraft {
  body: string;
  diffPreview?: DiffPreviewModel;
  filePath?: string;
  kind: TranscriptKind;
  preformatted?: boolean;
  title: string;
  jobId?: string;
  todoList?: TodoDisplayItem[];
}

export interface TranscriptEntry extends TranscriptEntryDraft {
  id: number;
}

export type TodoDisplayStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoDisplayItem {
  text: string;
  status: TodoDisplayStatus;
}

export interface BackgroundJobDisplay {
  id: string;
  command: string;
  status: 'running' | 'exited' | 'killed' | 'error';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  firstOutputLine: string | null;
  tailLines: string[];
  detailLines?: string[];
}

export interface ShellState {
  activeTurnInput: string;
  activeTurnInputPreformatted?: boolean;
  agentMode: import('../../agent-mode.js').AgentMode;
  approvalCursor: number;
  approvalPrompt: {
    body: string;
    diffPreview?: DiffPreviewModel;
    filePath?: string;
    /** Per-request choices. Absent in older fixtures; the renderer falls back. */
    options?: { label: string }[];
    title: string;
  } | null;
  /** When the current approval prompt appeared, for the in-flight-key guard. */
  approvalOpenedAt?: number | null;
  /** Rows scrolled off the top of the approval preview. 0 is the first row. */
  approvalScrollOffset: number;
  analyzingImages: number;
  generatingImage: boolean;
  autoYes: boolean;
  backgroundJobs: BackgroundJobDisplay[];
  busy: boolean;
  busyPausedAt: number | null;
  busySince: number | null;
  commandCursor: number;
  commandLog: string[];
  currentModelId: number;
  cursor: number;
  exitConfirmUntil: number | null;
  exiting: boolean;
  imageAttachments: Array<{
    index: number;
    mimeType: string;
    base64Data: string;
    source: 'clipboard' | 'file';
  }>;
  input: string;
  pastedChunks: Array<{ placeholder: string; text: string }>;
  jobsPickerExpandedId: string | null;
  jobsPickerIndex: number;
  jobsPickerOpen: boolean;
  modelPickerIndex: number;
  modelPickerOpen: boolean;
  projectRoot: string;
  resumePickerFilter: string;
  resumePickerIndex: number;
  resumePickerOpen: boolean;
  resumePickerSessions: SessionMetadata[];
  sessionId: string;
  showSessionId: boolean;
  thinkingNotes: string[];
  thinkingTitle: string;
  /** Messages sent (or waiting to be sent) into the turn that is running. */
  turnMessages?: TurnMessage[];
  serverModels: ServerModelInfo[];
  status: string;
  sudoPrompt?: {
    command: string;
    passwordLength: number;
    prompt: string;
  } | null;
  userInputPrompt?: UserInputPromptState | null;
  todos: TodoDisplayItem[];
  tokenUsage: string;
  transcript: TranscriptEntry[];
  transcriptScrollOffset: number;
  workingTools: TranscriptEntryDraft[];
  queuedMessage: {
    body: string;
    imageAttachments: Array<{
      index: number;
      mimeType: string;
      base64Data: string;
      source: 'clipboard' | 'file';
    }>;
    pastedChunks: Array<{ placeholder: string; text: string }>;
  } | null;
}

const WORKING_CLOCK_ICON = '◷';
const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴'] as const;
const TODO_PANEL_MAX_ROWS = 12;
const TODO_IN_PROGRESS_COLOR = 'ansi256(214)';
const COMMAND_PREVIEW_LINES = 10;
const WORKING_TOOL_PREVIEW_ROWS = 3;
const TRANSCRIPT_DIFF_PREVIEW_LINES = 24;
// The approval overlay is pinned to the bottom of the frame and the transcript
// takes whatever rows are left (floored at one), so an unbounded preview of a
// long script hides the conversation that explains why the command is being
// run. Worse, once the overlay outgrows the terminal the renderer keeps only a
// section's last rows, which silently drops the *top* of the command — the part
// that says what it does. So the preview is a fixed window you scroll instead:
// the transcript keeps its half of the screen and every row stays reachable.
const APPROVAL_PREVIEW_MAX_ROWS = 20;
const APPROVAL_PREVIEW_MIN_ROWS = 4;
// Title, its trailing blank, the three options, the counter and the blank rows
// framing it, the footer hint and its leading blank, plus the bordered panel's
// own chrome. Budgeting for them is what keeps the *whole* overlay near half
// the screen rather than just its body.
const APPROVAL_OVERLAY_CHROME_ROWS = 11;
// The blank rows that give the title, the counter and the footer hint some air.
// They are the first thing to go on a short frame: four rows of whitespace
// inside the prompt is a bad trade against four rows of the conversation that
// explains why the command is being run. Same threshold as the panel margin, so
// a cramped terminal loses all the decorative rows at once rather than some.
const APPROVAL_PADDING_CHROME_ROWS = 4;
const APPROVAL_PADDING_MIN_ROWS = 30;
// One column of gap plus one of track, reserved on the right of every preview
// row so the scrollbar never collides with the text.
const APPROVAL_SCROLLBAR_COLUMNS = 2;
// The approval accent. Deliberately not OVERLAY_BORDER_COLOR: the border stays
// yellow so this prompt still reads as a sibling of the sudo prompt, while the
// parts you act on are cyan.
const APPROVAL_ACCENT_COLOR = 'cyan';
// Verified against the implementation, not aspirational: the password is held
// in a closure variable (never the shell store, which only tracks its length),
// written straight to the local pty, cleared on submit/cancel, and registered
// as a secret so redactSecrets scrubs it from the command output that does get
// sent onward. The command itself is sent to the model — the password is not,
// which is why this says "this" and not "nothing here".
const SUDO_PASSWORD_ASSURANCE =
  'The model never sees this. Your password goes straight to sudo on this ' +
  'computer, then is discarded — never sent to our servers, saved, or logged.';
const SUDO_ASSURANCE_COLOR = 'ansi256(248)';
// The same light grey the thinking panel uses for secondary text, so the row
// counter sits behind the command rather than competing with it.
const APPROVAL_SCROLL_STATUS_COLOR = 'ansi256(248)';
const APPROVAL_SCROLLBAR_THUMB = '█';
const APPROVAL_SCROLLBAR_TRACK = '░';
const THINKING_NOTE_PREVIEW_ROWS = 3;
const COMPOSER_INPUT_MAX_ROWS = 6;
const AGENT_MODE_LABEL_WIDTH = 16;
const OVERLAY_PANEL_MAX_WIDTH = 86;
const OVERLAY_PANEL_MARGIN_LINES = 2;
// Below this the panel drops its outer margin rather than spending four rows of
// a cramped frame on whitespace.
const OVERLAY_PANEL_MARGIN_MIN_ROWS = 30;
const OVERLAY_BORDER_COLOR = 'yellow';
const USER_INPUT_BORDER_COLOR = 'cyan';
const OVERLAY_WARNING_COLOR = 'ansi256(208)';
const MODEL_PICKER_PANEL_MAX_WIDTH = 144;
const MODEL_PICKER_PANEL_MARGIN_LINES = 2;
const MODEL_PICKER_BORDER_COLOR = 'cyan';
const MODEL_PICKER_ACCENT_COLOR = 'cyan';
const MODEL_PICKER_HIGHLIGHT_BG = 'ansi256(87)';
const MODEL_PICKER_META_INDENT = '     ';

function splitComposerInput(
  input: string,
  cursor: number,
  width: number,
): { cursorCol: number; cursorRow: number; rows: string[] } {
  const safeWidth = Math.max(1, width);
  const normalizedCursor = Math.min(Math.max(cursor, 0), input.length);
  const rows = [''];
  let cursorRow = 0;
  let cursorCol = 0;
  let capturedCursor = false;

  const captureCursor = () => {
    if (capturedCursor) return;
    const current = rows[rows.length - 1] ?? '';
    if (current.length >= safeWidth) {
      rows.push('');
      cursorRow = rows.length - 1;
      cursorCol = 0;
    } else {
      cursorRow = rows.length - 1;
      cursorCol = current.length;
    }
    capturedCursor = true;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    if (
      char !== '\n' &&
      char !== '\r' &&
      (rows[rows.length - 1]?.length ?? 0) >= safeWidth
    ) {
      rows.push('');
    }
    if (index === normalizedCursor) {
      captureCursor();
    }
    if (char === '\r') continue;
    if (char === '\n') {
      rows.push('');
      continue;
    }
    rows[rows.length - 1] = `${rows[rows.length - 1] ?? ''}${char}`;
  }

  if (!capturedCursor) {
    captureCursor();
  }

  return { cursorCol, cursorRow, rows };
}

function buildComposerInputLines(
  input: string,
  cursor: number,
  promptLabel: string,
  placeholder: string,
  width: number,
): TuiLine[] {
  if (!input) {
    return [
      line(
        span(promptLabel, { color: 'cyan' }),
        span(' ', { inverse: true }),
        span(placeholder, { color: mutedColor() }),
      ),
    ];
  }

  const labelWidth = promptLabel.length;
  const inputWidth = Math.max(1, width - labelWidth);
  const { cursorCol, cursorRow, rows } = splitComposerInput(
    input,
    cursor,
    inputWidth,
  );
  const firstRow = Math.min(
    Math.max(cursorRow - COMPOSER_INPUT_MAX_ROWS + 1, 0),
    Math.max(rows.length - COMPOSER_INPUT_MAX_ROWS, 0),
  );

  return rows
    .slice(firstRow, firstRow + COMPOSER_INPUT_MAX_ROWS)
    .map((text, index) => {
      const absoluteRow = firstRow + index;
      const label =
        index === 0
          ? span(promptLabel, { color: 'cyan' })
          : span(' '.repeat(labelWidth));
      if (absoluteRow !== cursorRow) {
        return line(label, span(text));
      }
      const before = text.slice(0, cursorCol);
      const cursorChar = text[cursorCol] ?? ' ';
      const after = text.slice(cursorCol + 1);
      return line(
        label,
        span(before),
        span(cursorChar, { inverse: true }),
        span(after),
      );
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

function diffLineColor(kind: 'add' | 'context' | 'hunk' | 'remove'): string {
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

function diffLinePrefix(kind: 'add' | 'context' | 'hunk' | 'remove'): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'remove':
      return '-';
    case 'hunk':
      return '@@';
    case 'context':
      return ' ';
  }
}

// Fit a single line to the available terminal width with a clean ellipsis.
// Unlike the general-purpose truncate(), this never appends a word like
// "(truncated)" or a newline — that wording belongs on tool output, not
// on-screen rows that a panel budgets by physical line count.
// Measured in terminal columns, not UTF-16 units. Truncating by .length let a
// row of CJK or emoji come out wider than the width it was fitted to; the
// terminal then wrapped it, every row below shifted, and the inline viewport
// desynchronised — leaking cursor escapes into the status lines and leaving
// stale characters under shorter ones (the garbled "Thinking" and elapsed timer).
export function fitLine(content: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(content) <= maxWidth) return content;
  if (maxWidth === 1) return '…';
  return `${sliceToWidth(content, maxWidth - 1)}…`;
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

interface SlashCommandOption {
  command: string;
  description: string;
}

const CLIENT_SLASH_COMMANDS: SlashCommandOption[] = [
  { command: '/help', description: 'Show available chat commands' },
  { command: '/usage', description: 'Show account usage percentage and reset times' },
  { command: '/model', description: 'Switch the active model' },
  { command: '/resume', description: 'Open the session picker to resume a previous session' },
  { command: '/jobs', description: 'Background jobs: pick to view output or kill' },
  { command: '/new', description: 'start a new conversation; this session remains saved' },
  { command: '/logout', description: 'Sign out and quit' },
  { command: '/exit', description: 'Quit the current session' },
];

function buildModelPickerOptions(
  currentModelId: number,
  serverModels: ServerModelInfo[],
) {
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

function getInputCommandToken(input: string): string {
  const trimmed = String(input ?? '').trimStart();
  const match = trimmed.match(/^\/[^\s]*/);
  const token = match?.[0] ?? '';
  // A token with a second '/' is a filesystem path (e.g. /home/user/repo),
  // not a slash command — no command contains a slash, so don't treat it as one.
  if (token.indexOf('/', 1) !== -1) return '';
  return token;
}

function scoreSlashCommand(option: SlashCommandOption, token: string): number {
  if (option.command === token) return 0;
  if (option.command.startsWith(token)) return 1;
  if (option.command.includes(token.slice(1))) return 2;
  if (option.description.toLowerCase().includes(token.slice(1))) return 3;
  return 4;
}

export function getSlashCommandSuggestions(input: string): SlashCommandOption[] {
  const token = getInputCommandToken(input).toLowerCase();
  if (!token) return [];
  const ranked = [...CLIENT_SLASH_COMMANDS].sort((a, b) => {
    const scoreDiff = scoreSlashCommand(a, token) - scoreSlashCommand(b, token);
    if (scoreDiff !== 0) return scoreDiff;
    return a.command.localeCompare(b.command);
  });
  const matches = ranked.filter((option) => scoreSlashCommand(option, token) < 4);
  return (matches.length ? matches : ranked).slice(0, 5);
}

function formatModelLabel(modelId: number, serverModels: ServerModelInfo[]): string {
  return serverModels.find((model) => model.id === modelId)?.label ?? 'Unknown model';
}

// "Some Model (Vendor)" → "Some Model": in the resume picker the vendor
// suffix doesn't help pick a session, and the column space is better spent on
// the prompt text.
function pickerModelLabel(modelId: number, serverModels: ServerModelInfo[]): string {
  return formatModelLabel(modelId, serverModels).replace(/\s*\([^)]*\)\s*$/, '');
}

function filterResumeSessions(
  sessions: SessionMetadata[],
  filter: string,
  serverModels: ServerModelInfo[],
): SessionMetadata[] {
  const q = filter.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => {
    const branch = (s.branch ?? '').toLowerCase();
    const model = formatModelLabel(s.modelId, serverModels).toLowerCase();
    const conv = s.lastUserMessage.toLowerCase();
    return branch.includes(q) || model.includes(q) || conv.includes(q);
  });
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// A filling pie for the in-progress to-do, so an item that owns the panel for
// minutes still reads as moving. Driven by whole elapsed seconds rather than
// the 120ms spinner frame: at spinner speed this reads as a flicker instead of
// a fill, and one step per second is slow enough to look deliberate.
//
// `null` renders a fixed mid-fill glyph — the to-do snapshot in the transcript
// is a historical record and must not appear to still be running.
const TODO_IN_PROGRESS_FRAMES = [
  '\u25CB', // ○  empty
  '\u25D4', // ◔  quarter
  '\u25D1', // ◑  half
  '\u25D5', // ◕  three quarters
  '\u25CF', // ●  full
] as const;

const TODO_IN_PROGRESS_STATIC_GLYPH = '\u25D1';

// 1.5s per step. Derived from the wall clock rather than the 120ms spinner
// frame or whole elapsed seconds: the spinner is far too fast to read as a
// fill, and flooring whole seconds into a 1.5s step gives an uneven 1s/2s
// stutter. Millisecond input divides cleanly.
export const TODO_IN_PROGRESS_STEP_MS = 1_500;

export function todoProgressTick(nowMs: number): number {
  return Math.floor(nowMs / TODO_IN_PROGRESS_STEP_MS);
}

function todoInProgressGlyph(progressTick: number | null): string {
  if (progressTick === null) return TODO_IN_PROGRESS_STATIC_GLYPH;
  const index =
    ((progressTick % TODO_IN_PROGRESS_FRAMES.length) +
      TODO_IN_PROGRESS_FRAMES.length) %
    TODO_IN_PROGRESS_FRAMES.length;
  return TODO_IN_PROGRESS_FRAMES[index]!;
}

function todoItemLine(
  item: TodoDisplayItem,
  width: number,
  progressTick: number | null = null,
): TuiLine {
  const text = fitLine(item.text, Math.max(8, width - 5));
  if (item.status === 'completed') {
    return line(
      span('  ✔ ', { color: 'green' }),
      span(text, mutedStyle()),
    );
  }
  if (item.status === 'in_progress') {
    return line(
      span(`  ${todoInProgressGlyph(progressTick)} `, {
        color: TODO_IN_PROGRESS_COLOR,
      }),
      span(text, { color: TODO_IN_PROGRESS_COLOR, bold: true }),
    );
  }
  return line(
    span('  ○ ', { color: mutedColor() }),
    // Pending copy used the default terminal fg (readable on light). On dark
    // terminals some profiles make that default too dim next to the gray ○, so
    // lift only then — do not force gray on light themes.
    isDarkTerminalBackground()
      ? span(text, { color: mutedColor() })
      : span(text),
  );
}

/**
 * A message the user sent, or is about to send, into the turn that is running.
 *
 * `sending` is the state that earns this panel its place on screen. A single
 * model call can run for minutes, and until the agent reaches its next step the
 * message is genuinely in limbo — accepted but unread. Showing nothing during
 * that window is what made the first version of this feature read as "my
 * messages are being swallowed".
 */
export interface TurnMessage {
  id: number;
  text: string;
  state: 'queued' | 'sending' | 'delivered';
  /** Why it went back to `queued`, e.g. the turn ended first. */
  note?: string;
}

const TURN_MESSAGE_PANEL_MAX_ROWS = 6;

const TURN_MESSAGE_LABEL: Record<TurnMessage['state'], string> = {
  queued: 'queued',
  sending: 'Processing . . .',
  delivered: 'delivered',
};

function turnMessageLine(
  message: TurnMessage,
  width: number,
  progressTick: number | null,
): TuiLine {
  // The Rust renderer does not wrap — it counts the lines it is given — so every
  // row here must fit `width` exactly or it corrupts the layout. The glyph costs
  // 4 columns and the gap before the label costs 2, and BOTH columns are
  // allocated from what is actually left after that. Deriving the text column
  // from a fixed label width instead is what produced a 30-column row on a
  // 20-column terminal: neither column may have a floor the row cannot afford.
  const DECORATION = 6;
  const budget = Math.max(1, width - DECORATION);
  const preferredLabel = Math.max(
    ...Object.values(TURN_MESSAGE_LABEL).map((value) => displayWidth(value)),
  );
  // The message is the user's own words, so it keeps at least half the budget
  // when the terminal is too narrow to give both columns what they want.
  const labelWidth = Math.min(
    Math.max(1, Math.floor(budget / 2)),
    Math.max(preferredLabel, displayWidth(message.note ?? '')),
  );
  const label = fitLine(
    message.note ?? TURN_MESSAGE_LABEL[message.state],
    labelWidth,
  );
  const textWidth = Math.max(1, budget - labelWidth);
  const text = padToWidth(fitLine(`"${message.text}"`, textWidth), textWidth);
  if (message.state === 'delivered') {
    return line(
      span('  ● ', { color: 'green' }),
      span(text, { color: 'gray', dim: true }),
      span(`  ${label}`, { color: 'green' }),
    );
  }
  if (message.state === 'sending') {
    return line(
      span(`  ${todoInProgressGlyph(progressTick)} `, {
        color: TODO_IN_PROGRESS_COLOR,
      }),
      span(text, { color: TODO_IN_PROGRESS_COLOR, bold: true }),
      span(`  ${label}`, { color: TODO_IN_PROGRESS_COLOR }),
    );
  }
  return line(
    span('  ○ ', { color: 'cyan' }),
    span(text, { color: 'cyan' }),
    span(`  ${label}`, { color: 'gray' }),
  );
}

export function buildTurnMessageLines(
  messages: readonly TurnMessage[],
  width: number,
  progressTick: number | null = null,
): TuiLine[] {
  if (messages.length === 0) return [];
  const lines: TuiLine[] = [
    line(span('Your messages', { color: 'cyan', bold: true })),
  ];
  // Newest matter most: an older delivered message is a receipt, the one still
  // in flight is what the user is waiting on.
  const visible = messages.slice(-(TURN_MESSAGE_PANEL_MAX_ROWS - 1));
  const hidden = messages.length - visible.length;
  if (hidden > 0) {
    lines.push(
      line(span(`  ● ${hidden} earlier`, { color: 'gray', dim: true })),
    );
  }
  for (const message of visible) {
    lines.push(turnMessageLine(message, width, progressTick));
  }
  return lines;
}

export function formatTodoProgress(items: TodoDisplayItem[]): string {
  const done = items.filter((item) => item.status === 'completed').length;
  return `${done}/${items.length} done`;
}

// Compact to-do panel: execution order, earlier completed items collapse
// first when over budget because the active and upcoming steps are what the
// user needs to see.
export function renderTodoListLines(
  items: TodoDisplayItem[],
  width: number,
  { header = false, progressTick = null }: {
    header?: boolean;
    /** Whole elapsed seconds. `null` freezes the glyph for static snapshots. */
    progressTick?: number | null;
  } = {},
): TuiLine[] {
  if (items.length === 0) return [];
  const lines: TuiLine[] = [];
  if (header) {
    lines.push(
      line(
        span('To-dos', { color: 'cyan', bold: true }),
        span(` · ${formatTodoProgress(items)}`, { color: mutedColor() }),
      ),
    );
  }
  // The header counts against the same row budget, so a header + 12 items
  // never exceeds TODO_PANEL_MAX_ROWS physical rows.
  const itemRowBudget = TODO_PANEL_MAX_ROWS - (header ? 1 : 0);
  let collapsedDone = 0;
  if (items.length > itemRowBudget) {
    const over = items.length - (itemRowBudget - 1);
    let leadingDone = 0;
    while (
      leadingDone < items.length &&
      items[leadingDone]!.status === 'completed'
    ) {
      leadingDone += 1;
    }
    collapsedDone = Math.min(over, leadingDone);
  }
  if (collapsedDone > 0) {
    lines.push(
      line(
        span('  ✔ ', { color: 'green' }),
        span(`${collapsedDone} completed`, mutedStyle()),
      ),
    );
  }
  const remaining = items.slice(collapsedDone);
  const budget = itemRowBudget - (collapsedDone > 0 ? 1 : 0);
  const visible =
    remaining.length > budget ? remaining.slice(0, budget - 1) : remaining;
  for (const item of visible) {
    lines.push(todoItemLine(item, width, progressTick));
  }
  if (remaining.length > visible.length) {
    lines.push(
      plainLine(
        `  … +${remaining.length - visible.length} more`,
        mutedStyle(),
      ),
    );
  }
  return lines;
}

export function renderTranscriptEntryLines(
  entry: TranscriptEntry | TranscriptEntryDraft,
  width: number,
): TuiLine[] {
  const color = getEntryColor(entry.kind);
  const lines: TuiLine[] = [
    line(span('● ', { color }), span(entry.title, { color, bold: true })),
  ];
  lines.push(
    ...(entry.preformatted
      ? renderPreformattedBodyLines(entry.body, width, entry.kind)
      : renderFormattedBodyLines(entry.body, width, entry.kind)),
  );
  if (entry.diffPreview) {
    lines.push(...renderDiffPreviewLines(entry.diffPreview, width));
  }
  if (entry.todoList && entry.todoList.length > 0) {
    lines.push(...renderTodoListLines(entry.todoList, width));
  }
  return lines;
}

// A scrollable transcript is wrapped twice per frame — once at `contentWidth`
// to decide whether it overflows, then again at `contentWidth - 2` to leave
// room for the scrollbar. Without this the whole backlog is re-wrapped on every
// frame, and frames rebuild on every stream chunk. Transcript entries are
// immutable (repl.tsx replaces the object on update), so identity is a sound
// cache key: only the entry currently streaming misses.
const transcriptEntryLineCache = new WeakMap<
  TranscriptEntry,
  Map<number, TuiLine[]>
>();
// Only two widths are ever live at once (full and scrollbar-reserved). Keeping
// the two most recent stops a drag-resize from pinning a wrap of the entire
// backlog at every intermediate width.
const MAX_CACHED_TRANSCRIPT_WIDTHS = 2;

function cachedTranscriptEntryLines(
  entry: TranscriptEntry,
  width: number,
): TuiLine[] {
  let byWidth = transcriptEntryLineCache.get(entry);
  if (!byWidth) {
    byWidth = new Map();
    transcriptEntryLineCache.set(entry, byWidth);
  }
  const cached = byWidth.get(width);
  if (cached) return cached;
  const lines = renderTranscriptEntryLines(entry, width);
  if (byWidth.size >= MAX_CACHED_TRANSCRIPT_WIDTHS) {
    // Map iterates in insertion order, so this drops the least recently added.
    const oldest = byWidth.keys().next().value;
    if (oldest !== undefined) byWidth.delete(oldest);
  }
  byWidth.set(width, lines);
  return lines;
}

// `maxDiffLines` defaults to the transcript's preview cap. The approval pane
// passes the full length instead: it can scroll, so truncating there would hide
// rows the operator is about to approve.
function renderDiffPreviewLines(
  preview: DiffPreviewModel,
  width: number,
  maxDiffLines = TRANSCRIPT_DIFF_PREVIEW_LINES,
): TuiLine[] {
  return [
    plainLine(
      `  Added ${preview.added} line${preview.added === 1 ? '' : 's'}, removed ${preview.removed} line${preview.removed === 1 ? '' : 's'}`,
      { color: 'gray' },
    ),
    ...preview.lines.slice(0, maxDiffLines).map((diffLine) =>
      line(
        span(`${diffLinePrefix(diffLine.kind)} `, {
          color: diffLineColor(diffLine.kind),
        }),
        span(fitLine(diffLine.content || ' ', width - 4), {
          color: diffLineColor(diffLine.kind),
        }),
      ),
    ),
  ];
}

function tokenUsageLines(usage: string): TuiLine[] {
  const match = usage.match(
    /^Session tokens • in ([^•]+) • out ([^•]+)(?: • think ([^•]+))? • cache ([^•]+)(?: • write ([^•]+))?$/,
  );
  if (!match) {
    return [plainLine(usage, { color: 'cyan' })];
  }
  const spans = [
    span('Tokens', { color: 'cyan', bold: true }),
    span(' In ', { color: 'gray' }),
    span(match[1]?.trim() ?? '', { color: 'green' }),
    span(' Out ', { color: 'gray' }),
    span(match[2]?.trim() ?? '', { color: 'magenta' }),
  ];
  if (match[3]) {
    spans.push(span(' Think ', { color: 'gray' }), span(match[3].trim(), { color: 'magenta' }));
  }
  spans.push(span(' Cache ', { color: 'gray' }), span(match[4]?.trim() ?? '', { color: 'yellow' }));
  if (match[5]) {
    spans.push(span(' Write ', { color: 'gray' }), span(match[5].trim(), { color: 'yellow' }));
  }
  return [line(...spans)];
}

function footerTransientStatus(
  status: string,
): { color: string; text: string; icon: string } | null {
  const text = String(status ?? '').trim();
  if (!text) return null;
  if (text === 'Copied selection' || text === 'Copied link') {
    return { color: 'green', text, icon: '✓' };
  }
  if (text === 'Opened link') {
    return { color: 'cyan', text, icon: '↗' };
  }
  if (text === 'Could not open link' || text === 'Clipboard has no text to paste') {
    return { color: 'yellow', text, icon: '!' };
  }
  return null;
}

function backgroundJobIndicatorSpans(state: ShellState): TuiSpan[] {
  const runningCount = (state.backgroundJobs ?? []).filter(
    (job) => job.status === 'running',
  ).length;
  if (runningCount === 0) return [];
  const noun = runningCount === 1 ? 'shell' : 'shells';
  return [
    span('   ', { color: 'gray', dim: true }),
    span(`● ${runningCount} ${noun} running`, { color: 'green', bold: true }),
    span(' · /jobs', { color: 'gray', dim: true }),
  ];
}

// Slim idle-time progress indicator (display only — the list is agent-driven
// and has no user command surface); while busy the live Working panel already
// shows the full list.
function todoIndicatorSpans(state: ShellState): TuiSpan[] {
  if (state.busy) return [];
  const items = state.todos ?? [];
  if (items.length === 0) return [];
  const done = items.filter((item) => item.status === 'completed').length;
  if (done >= items.length) return [];
  return [
    span('   ', { color: 'gray', dim: true }),
    span(`◐ ${done}/${items.length} to-dos`, {
      color: TODO_IN_PROGRESS_COLOR,
      bold: true,
    }),
  ];
}

function composerFooterLines(state: ShellState): TuiLine[] {
  const visibleSessionId = formatPromptSessionIdLabel(
    state.showSessionId,
    state.sessionId,
  );
  const transientStatus = footerTransientStatus(state.status);
  const lines: TuiLine[] = [
    line(
      span('TheGitAI', { color: 'cyan', bold: true }),
      span(' • ', { color: 'gray', dim: true }),
      span(formatPromptDirectoryLabel(state.projectRoot), { color: 'cyan' }),
      ...(transientStatus
        ? [
            span('   ', { color: 'gray', dim: true }),
            span(transientStatus.text, {
              color: transientStatus.color,
              bold: true,
            }),
            span(` ${transientStatus.icon}`, {
              color: transientStatus.color,
              bold: true,
            }),
          ]
        : []),
      ...(visibleSessionId
        ? [span(`   ${visibleSessionId}`, { color: 'gray', dim: true })]
        : []),
      ...backgroundJobIndicatorSpans(state),
      ...todoIndicatorSpans(state),
    ),
    plainLine(''),
    plainLine(formatModelLabel(state.currentModelId, state.serverModels), {
      color: 'cyan',
      dim: true,
    }),
    plainLine(''),
  ];
  if (state.exitConfirmUntil != null) {
    lines.push(
      plainLine(state.status || 'Press Ctrl+C again to quit.', {
        color: 'red',
        bold: true,
      }),
    );
    return lines;
  }
  // With a message queued the composer is locked, so Enter has exactly one
  // meaning and the hint never has to describe a mode.
  const busyHelperText = state.queuedMessage
    ? 'Enter sends it to the agent • ↑ edit • Esc / Ctrl+C discard'
    : state.input
      ? 'Enter queues • Esc cancels turn • Ctrl+C clears draft'
      : 'Enter queues • Esc / Ctrl+C cancel turn';
  const helperText = state.userInputPrompt
    ? 'Answering agent questions • Ctrl+C cancels turn'
    : state.busy
      ? busyHelperText
      : process.platform === 'win32'
        ? 'Enter sends • Shift+Tab mode • Alt+V image • Esc cancel turn • Ctrl+C clears / quits'
        : process.platform === 'darwin'
          ? 'Enter sends • Shift+Tab mode • Ctrl+V image • Esc cancel turn • Ctrl+C clears / quits'
          : 'Enter sends • Shift+Tab mode • Ctrl+V image • Esc cancel turn • Ctrl+C clears / quits';
  const agentLabel = agentModeLabel(state.agentMode).padEnd(AGENT_MODE_LABEL_WIDTH);
  const tokenUsageText = state.tokenUsage || formatClientTokenUsage(null);
  const footerMuted = mutedStyle();
  const footerSpans: TuiSpan[] = [
    span(helperText, footerMuted),
    span(' '.repeat(Math.max(1, 8)), footerMuted),
    span(agentLabel, {
      color: state.agentMode === 'plan' ? 'yellow' : 'cyan',
    }),
    span(tokenUsageText, { color: 'cyan' }),
  ];
  lines.push(line(...footerSpans));
  return lines;
}

export function formatJobElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(totalSeconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function backgroundJobPreviewLines(
  job: BackgroundJobDisplay,
  maxTailLines: number,
): string[] {
  const lines: string[] = [];
  const first = String(job.firstOutputLine ?? '').trim();
  if (first) {
    lines.push(first);
  }
  for (const outputLine of (job.tailLines ?? []).slice(-maxTailLines)) {
    const trimmed = String(outputLine ?? '').trim();
    if (!trimmed) continue;
    if (lines.length === 1 && trimmed === first) continue;
    lines.push(trimmed);
  }
  return lines;
}

function jobStatusDescriptor(
  job: BackgroundJobDisplay,
  nowMs: number,
): { glyph: string; color: string; text: string } {
  const ran = formatJobElapsed((job.endedAt ?? (nowMs > 0 ? nowMs : Date.now())) - job.startedAt);
  if (job.status === 'running') {
    return { glyph: '●', color: 'green', text: `running · ${ran}` };
  }
  if (job.status === 'killed') {
    return { glyph: '■', color: 'gray', text: `killed · ran ${ran}` };
  }
  if (job.status === 'error') {
    return { glyph: '✖', color: 'red', text: 'failed to start' };
  }
  return job.exitCode === 0
    ? { glyph: '✓', color: 'green', text: `exited (0) · ran ${ran}` }
    : { glyph: '✖', color: 'red', text: `exited (${job.exitCode ?? 1}) · ran ${ran}` };
}

function buildJobsPickerLines(
  state: ShellState,
  width: number,
  nowMs: number,
): TuiLine[] {
  const jobs = state.backgroundJobs ?? [];
  const lines: TuiLine[] = [
    plainLine('Background jobs', { color: 'cyan', bold: true }),
  ];
  if (jobs.length === 0) {
    lines.push(plainLine('No background jobs in this session.', { color: 'gray' }));
  }
  for (const [index, job] of jobs.entries()) {
    const selected = index === state.jobsPickerIndex;
    const expanded = state.jobsPickerExpandedId === job.id;
    const { glyph, color, text } = jobStatusDescriptor(job, nowMs);
    lines.push(
      line(
        span(selected ? '› ' : '  ', { color: selected ? 'cyan' : 'gray' }),
        span(`${glyph} `, { color }),
        span(job.id.padEnd(6), { color: selected ? 'cyan' : undefined, bold: selected }),
        span(` ${truncate(job.command, Math.max(12, width - 34)).padEnd(Math.max(12, Math.min(40, width - 34)))}`, {
          color: selected ? 'cyan' : undefined,
          bold: selected,
        }),
        span(` ${text}`, { color: 'gray' }),
      ),
    );
    if (expanded) {
      const detailLines = (job.detailLines ?? []).length
        ? job.detailLines ?? []
        : backgroundJobPreviewLines(job, 3);
      if (detailLines.length === 0) {
        lines.push(plainLine('    (no output captured)', { color: 'gray' }));
      } else {
        for (const outputLine of detailLines) {
          lines.push(
            line(
              span('    │ ', { color: 'gray', dim: true }),
              span(truncate(outputLine, Math.max(8, width - 8)), {
                color: 'gray',
                dim: true,
              }),
            ),
          );
        }
      }
    }
  }
  lines.push(
    plainLine('↑/↓ move    enter expand/collapse    k kill    esc close', {
      color: 'gray',
    }),
  );
  return lines;
}

// Seeded into the panel at turn start and used whenever there is nothing
// specific to say, so the thinking row is present for the whole turn instead of
// blinking in and out as statuses arrive and get filtered.
//
// This array ships to customers inside the source-visible CLI, so treat it as
// public copy: it is readable by anyone who opens their node_modules. It has to
// live client-side because the seed is drawn at turn start, before any server
// round-trip exists to supply one. Kept in step with
// PUBLIC_REASONING_PROGRESS_STATUSES in providers/reasoning-status.ts, which
// fills the same role for server-sent statuses.
export const THINKING_FALLBACK_PHRASES = [
  'Working out where to start...',
  'Deciding what comes first...',
  'Lining up the pieces...',
  'Untangling the details...',
  'Deciding what not to touch...',
  'Checking what this would break...',
  'Choosing the smaller change...',
  'Picking the least clever option...',
  'Resisting the obvious answer...',
  'Trying the boring explanation first...',
  'Checking whether the assumption holds...',
  'Asking what would have to be true...',
  'Reading it the way the machine would...',
  'Testing the story against the code...',
  'Working out what actually changed...',
  'Finding the smallest thing that explains it...',
  'Looking for the part that is not settled yet...',
  'Making sure this is the simple version...',
] as const;

export function pickThinkingFallbackPhrase(): string {
  const index = Math.floor(Math.random() * THINKING_FALLBACK_PHRASES.length);
  return THINKING_FALLBACK_PHRASES[index]!;
}

// A bare caption ("Restructuring content for logical flow") reads as a finished
// statement and makes an active turn look stalled. A trailing ellipsis is what
// signals the work is still running.
function withProgressEllipsis(title: string): string {
  const text = title.trim();
  if (!text) return text;
  return /(?:\.\.\.|…)$/.test(text) ? text : `${text}...`;
}

function thinkingHeaderLine(
  spinnerFrame: number,
  title: string,
  width: number,
): TuiLine {
  const spinner = `${BRAILLE_SPINNER_FRAMES[spinnerFrame % BRAILLE_SPINNER_FRAMES.length]!} `;
  const decorated = withProgressEllipsis(title);
  const fittedTitle = decorated
    ? fitLine(decorated, Math.max(8, width - spinner.length - 'Thinking'.length - 3))
    : '';
  return line(
    span(spinner, { color: 'green' }),
    span('Thinking', { color: 'green', bold: true }),
    ...(fittedTitle ? [span(` · ${fittedTitle}`, { color: 'ansi256(248)' })] : []),
  );
}

function thinkingNoteLine(note: string, width: number): TuiLine {
  return line(
    span('│  ', { color: 'green' }),
    span(fitLine(note, Math.max(8, width - 3)), { color: 'ansi256(248)' }),
  );
}

function buildLiveLines(
  state: ShellState,
  width: number,
  spinnerFrame: number,
  elapsedSeconds: number,
  nowMs: number,
): TuiLine[] {
  if (!state.busy) return [];
  const lines: TuiLine[] = [plainLine('')];
  if (state.activeTurnInput) {
    lines.push(...renderTranscriptEntryLines(
      {
        body: state.activeTurnInput,
        kind: 'user',
        preformatted: state.activeTurnInputPreformatted,
        title: 'You',
      },
      width,
    ));
    lines.push(plainLine(''));
  }
  // Tool rows and raw output are the parts most likely to run long, so they
  // render first: on a short terminal they're what scrolls out of view, not
  // the status content below (Working, To-dos, Thinking).
  const toolEntries = state.workingTools.slice(-WORKING_TOOL_PREVIEW_ROWS);
  if (toolEntries.length > 0) {
    for (const entry of toolEntries) {
      const color = getEntryColor(entry.kind);
      const body = entry.body.split('\n')[0]?.trim();
      lines.push(
        line(
          span('● ', { color }),
          span(entry.title, { color, bold: true }),
          ...(body ? [span(` ${truncate(body, 140)}`, { color })] : []),
        ),
      );
    }
    lines.push(plainLine(''));
  }
  const logLines = state.commandLog.slice(-COMMAND_PREVIEW_LINES);
  if (logLines.length > 0) {
    lines.push(plainLine('⋮ output', { color: 'gray', dim: true }));
    for (const outputLine of logLines) {
      lines.push(plainLine(outputLine, { color: 'gray', dim: true }));
    }
    lines.push(plainLine(''));
  }
  lines.push(plainLine(buildWorkingClockLine(state, elapsedSeconds), { color: 'yellow' }));
  // Directly under the clock, and above the to-dos: this is status-class
  // content, so a short terminal scrolls the tool rows away before it. The
  // clock is the "how long have I been waiting" context these rows answer.
  const turnMessages = state.turnMessages ?? [];
  if (turnMessages.length > 0) {
    lines.push(plainLine(''));
    lines.push(
      ...buildTurnMessageLines(turnMessages, width, todoProgressTick(nowMs)),
    );
  }
  const todos = state.todos ?? [];
  if (todos.length > 0) {
    lines.push(plainLine(''));
    lines.push(
      ...renderTodoListLines(todos, width, {
        header: true,
        progressTick: todoProgressTick(nowMs),
      }),
    );
  }
  const visibleTitle = state.thinkingTitle.trim();
  const visibleNotes = state.thinkingNotes.filter(Boolean);
  // Hidden until the model has actually said something, then shown for the
  // rest of the turn. The original peek-a-boo came from tool statuses blanking
  // the title mid-turn, which holdOrPickFallback now prevents — once a thought
  // lands the title is never empty again, so this condition latches on rather
  // than flickering. Before that it stays hidden: announcing "Thinking" while
  // nothing has come back yet is inventing activity.
  if (visibleTitle || visibleNotes.length > 0) {
    lines.push(plainLine(''));
    if (todos.length > 0) {
      // A to-do panel is already carrying the "what's happening" job, so
      // thinking only needs a single minimal line here, not the full block.
      const minimalText =
        visibleTitle && visibleTitle !== 'Thinking'
          ? visibleTitle
          : (visibleNotes[visibleNotes.length - 1] ?? '');
      lines.push(
        thinkingHeaderLine(
          spinnerFrame,
          minimalText || THINKING_FALLBACK_PHRASES[0],
          width,
        ),
      );
    } else {
      // A status whose lead line was too long to be a title arrives with the
      // literal title "Thinking", which would render as "Thinking · Thinking".
      // Treat it as absent and let the fallback phrase carry the row.
      const headerTitle =
        visibleTitle && visibleTitle !== 'Thinking' ? visibleTitle : '';
      lines.push(
        thinkingHeaderLine(
          spinnerFrame,
          headerTitle || THINKING_FALLBACK_PHRASES[0],
          width,
        ),
      );
      for (const note of visibleNotes.slice(0, THINKING_NOTE_PREVIEW_ROWS)) {
        lines.push(thinkingNoteLine(note, width));
      }
    }
  }
  lines.push(plainLine(''));
  return lines;
}

function lineCharCount(row: TuiLine): number {
  // Code-point count is not column count: padding a bordered panel by it leaves
  // a row of emoji or CJK sticking out past its own border.
  return row.spans.reduce((total, item) => total + displayWidth(item.text), 0);
}

function overlayPanelLine(row: TuiLine, width: number, color: string): TuiLine {
  const padding = Math.max(0, width - lineCharCount(row));
  return line(
    span('│ ', { color }),
    ...row.spans,
    span(' '.repeat(padding)),
    span(' │', { color }),
  );
}

function overlayPanelMarginLineCount(height: number): number {
  return height < OVERLAY_PANEL_MARGIN_MIN_ROWS
    ? 0
    : OVERLAY_PANEL_MARGIN_LINES;
}

function overlayPanelContentBudget(height: number): number {
  if (!Number.isFinite(height)) {
    return Number.POSITIVE_INFINITY;
  }
  const margins = overlayPanelMarginLineCount(height) * 2;
  return Math.max(1, Math.floor(height) - margins - 2);
}

function buildOverlayPanel(
  rows: TuiLine[],
  width: number,
  color: string,
  height = Number.POSITIVE_INFINITY,
): TuiLine[] {
  const panelWidth = Math.max(24, Math.min(width, OVERLAY_PANEL_MAX_WIDTH));
  const innerWidth = Math.max(1, panelWidth - 4);
  // Four blank rows of breathing space are worth it on a normal terminal and
  // not on a short one, where they come straight out of the transcript the
  // prompt is asking you to read.
  const margin = Array.from(
    {
      length: overlayPanelMarginLineCount(height),
    },
    () => plainLine(''),
  );
  return [
    ...margin,
    plainLine(`╭${'─'.repeat(panelWidth - 2)}╮`, { color }),
    ...rows.map((row) => overlayPanelLine(row, innerWidth, color)),
    plainLine(`╰${'─'.repeat(panelWidth - 2)}╯`, { color }),
    ...margin,
  ];
}

interface ModelPickerOptionRow {
  costRating: number;
  current: boolean;
  disabled: boolean;
  id: number;
  label: string;
  note: string;
  publicId: number;
}

function padSpansToInnerWidth(
  spans: TuiSpan[],
  innerWidth: number,
  fill: Partial<Omit<TuiSpan, 'text'>>,
): TuiSpan[] {
  const used = spans.reduce((total, part) => total + [...part.text].length, 0);
  const pad = Math.max(0, innerWidth - used);
  if (pad === 0) return spans;
  return [...spans, span(' '.repeat(pad), fill)];
}

function modelPickerPanelSideLine(
  content: TuiLine,
  innerWidth: number,
): TuiLine {
  return overlayPanelLine(content, innerWidth, MODEL_PICKER_BORDER_COLOR);
}

const MODEL_PICKER_COST_WIDTH = 6;
const MODEL_PICKER_MODEL_WIDTH = 42;
const MODEL_PICKER_SEPARATOR = ' │ ';
const MODEL_PICKER_WIDE_MIN_WIDTH = 78;

function modelPickerTopBorder(panelWidth: number): TuiLine {
  const fullTitle = ' TheGitAI - Model Selection ';
  const compactTitle = ' Model Selection ';
  const title = panelWidth >= fullTitle.length + 4 ? fullTitle : compactTitle;
  const available = Math.max(0, panelWidth - 2 - [...title].length);
  const left = Math.floor(available / 2);
  const right = available - left;
  return line(
    span(`╭${'─'.repeat(left)}`, { color: MODEL_PICKER_BORDER_COLOR }),
    span(title, { color: MODEL_PICKER_ACCENT_COLOR, bold: true }),
    span(`${'─'.repeat(right)}╮`, { color: MODEL_PICKER_BORDER_COLOR }),
  );
}

function modelPickerDivider(panelWidth: number): TuiLine {
  return plainLine(`├${'─'.repeat(panelWidth - 2)}┤`, {
    color: MODEL_PICKER_BORDER_COLOR,
  });
}

function modelPickerCell(
  text: string,
  width: number,
  style: Partial<Omit<TuiSpan, 'text'>> = {},
): TuiSpan {
  const fitted = fitLine(text, width);
  return span(`${fitted}${' '.repeat(Math.max(0, width - [...fitted].length))}`, style);
}

function modelPickerCostText(rating: number): string {
  const steps = Math.max(1, Math.min(3, Math.round(rating)));
  return '$'.repeat(steps);
}

function modelPickerNotesWidth(innerWidth: number): number {
  return Math.max(
    18,
    innerWidth -
      MODEL_PICKER_MODEL_WIDTH -
      MODEL_PICKER_COST_WIDTH -
      MODEL_PICKER_SEPARATOR.length * 2,
  );
}

function modelPickerModelSpans(
  option: ModelPickerOptionRow,
  selected: boolean,
  width: number,
  showCurrentTag: boolean,
  labelStyle: Partial<Omit<TuiSpan, 'text'>>,
  selectedStyle: Partial<Omit<TuiSpan, 'text'>>,
): TuiSpan[] {
  const tag = option.current && showCurrentTag ? ' (current)' : '';
  const labelWidth = Math.max(1, width - [...tag].length);
  const label = fitLine(`${selected ? '▶ ' : '  '}${option.label}`, labelWidth);
  const used = [...label].length + [...tag].length;
  return [
    span(label, { ...labelStyle, ...selectedStyle }),
    span(tag, { color: 'gray', ...selectedStyle }),
    span(' '.repeat(Math.max(0, width - used)), selectedStyle),
  ];
}

function modelPickerItemLines(
  option: ModelPickerOptionRow,
  selected: boolean,
  innerWidth: number,
): TuiLine[] {
  const selectedStyle = selected ? { bgColor: MODEL_PICKER_HIGHLIGHT_BG } : {};
  const labelStyle = option.disabled
    ? { color: 'gray' }
    : selected
      ? { color: 'cyan', bold: true }
      : {};
  const cost = modelPickerCostText(option.costRating);

  if (innerWidth < MODEL_PICKER_WIDE_MIN_WIDTH) {
    const modelWidth = Math.max(
      12,
      innerWidth - MODEL_PICKER_COST_WIDTH - 2,
    );
    const row = [
      ...modelPickerModelSpans(
        option,
        selected,
        modelWidth,
        false,
        labelStyle,
        selectedStyle,
      ),
      span('  ', selectedStyle),
      modelPickerCell(cost, MODEL_PICKER_COST_WIDTH, selectedStyle),
    ];
    return [
      modelPickerPanelSideLine(
        line(...padSpansToInnerWidth(row, innerWidth, selectedStyle)),
        innerWidth,
      ),
    ];
  }

  const row = [
    ...modelPickerModelSpans(
      option,
      selected,
      MODEL_PICKER_MODEL_WIDTH,
      true,
      labelStyle,
      selectedStyle,
    ),
    span(MODEL_PICKER_SEPARATOR, { color: 'gray', ...selectedStyle }),
    modelPickerCell(cost, MODEL_PICKER_COST_WIDTH, selectedStyle),
    span(MODEL_PICKER_SEPARATOR, { color: 'gray', ...selectedStyle }),
    modelPickerCell(option.note, modelPickerNotesWidth(innerWidth), {
      color: 'gray',
      ...selectedStyle,
    }),
  ];
  return [
    modelPickerPanelSideLine(
      line(...padSpansToInnerWidth(row, innerWidth, selectedStyle)),
      innerWidth,
    ),
  ];
}

function modelPickerHeaderLine(innerWidth: number): TuiLine {
  const heading = { color: MODEL_PICKER_ACCENT_COLOR, bold: true };
  if (innerWidth < MODEL_PICKER_WIDE_MIN_WIDTH) {
    return line(modelPickerCell('Model', Math.max(1, innerWidth), heading));
  }
  return line(
    modelPickerCell('Model', MODEL_PICKER_MODEL_WIDTH, heading),
    span(MODEL_PICKER_SEPARATOR, { color: 'gray' }),
    modelPickerCell('Cost', MODEL_PICKER_COST_WIDTH, heading),
    span(MODEL_PICKER_SEPARATOR, { color: 'gray' }),
    modelPickerCell('Notes', modelPickerNotesWidth(innerWidth), heading),
  );
}

function buildModelPickerPanel(
  options: ModelPickerOptionRow[],
  selectedIndex: number,
  width: number,
  availableHeight: number,
): TuiLine[] {
  const panelWidth = Math.max(28, Math.min(width, MODEL_PICKER_PANEL_MAX_WIDTH));
  const innerWidth = Math.max(1, panelWidth - 4);
  const compactBodyLineCount = options.length + 6;
  const spacerLineCount = Math.max(0, options.length - 1);
  const useRowSpacing = compactBodyLineCount + spacerLineCount <= availableHeight;
  const bodyLineCount = compactBodyLineCount + (useRowSpacing ? spacerLineCount : 0);
  const marginLineCount = Math.max(
    0,
    Math.min(
      MODEL_PICKER_PANEL_MARGIN_LINES,
      Math.floor((availableHeight - bodyLineCount) / 2),
    ),
  );
  const margin = Array.from(
    { length: marginLineCount },
    () => plainLine(''),
  );
  const body: TuiLine[] = [
    modelPickerTopBorder(panelWidth),
    modelPickerPanelSideLine(modelPickerHeaderLine(innerWidth), innerWidth),
    modelPickerDivider(panelWidth),
  ];
  options.forEach((option, index) => {
    body.push(...modelPickerItemLines(option, index === selectedIndex, innerWidth));
    if (useRowSpacing && index < options.length - 1) {
      body.push(modelPickerPanelSideLine(plainLine(''), innerWidth));
    }
  });
  const fullHint = '↑/↓ navigate  •  Enter select  •  Esc cancel';
  const compactHint = '↑/↓  •  enter  •  esc';
  const hint = [...fullHint].length <= innerWidth ? fullHint : compactHint;
  body.push(
    modelPickerDivider(panelWidth),
    modelPickerPanelSideLine(
      plainLine(fitLine(hint, innerWidth), { color: 'gray' }),
      innerWidth,
    ),
    plainLine(`╰${'─'.repeat(panelWidth - 2)}╯`, { color: MODEL_PICKER_BORDER_COLOR }),
  );
  return [...margin, ...body, ...margin];
}

function commandPaletteTopBorder(panelWidth: number): TuiLine {
  const prefix = '╭─ Commands ';
  const suffix = '╮';
  const dashCount = Math.max(0, panelWidth - prefix.length - suffix.length);
  return line(
    span('╭─ ', { color: MODEL_PICKER_BORDER_COLOR }),
    span('Commands', { color: MODEL_PICKER_ACCENT_COLOR, bold: true }),
    span(` ${'─'.repeat(dashCount)}╮`, { color: MODEL_PICKER_BORDER_COLOR }),
  );
}

function commandPaletteSeparatorLine(innerWidth: number): TuiLine {
  return modelPickerPanelSideLine(
    line(span('┈'.repeat(Math.max(1, innerWidth)), { color: 'gray', dim: true })),
    innerWidth,
  );
}

function commandPaletteItemLines(
  option: SlashCommandOption,
  selected: boolean,
  innerWidth: number,
): TuiLine[] {
  const highlight = { bgColor: MODEL_PICKER_HIGHLIGHT_BG };
  if (selected) {
    const titleSpans = padSpansToInnerWidth(
      [
        span('▌', {
          color: MODEL_PICKER_ACCENT_COLOR,
          bold: true,
          ...highlight,
        }),
        span('▶ ', {
          color: MODEL_PICKER_ACCENT_COLOR,
          bold: true,
          ...highlight,
        }),
        span(option.command, {
          color: MODEL_PICKER_ACCENT_COLOR,
          bold: true,
          ...highlight,
        }),
      ],
      innerWidth,
      highlight,
    );
    const metaSpans = padSpansToInnerWidth(
      [
        span(`${MODEL_PICKER_META_INDENT}${option.description}`, {
          color: 'gray',
          ...highlight,
        }),
      ],
      innerWidth,
      highlight,
    );
    return [
      modelPickerPanelSideLine(line(...titleSpans), innerWidth),
      modelPickerPanelSideLine(line(...metaSpans), innerWidth),
    ];
  }
  return [
    modelPickerPanelSideLine(
      line(
        span('  ', { color: 'gray' }),
        span(option.command, { color: MODEL_PICKER_ACCENT_COLOR }),
      ),
      innerWidth,
    ),
    modelPickerPanelSideLine(
      line(span(`${MODEL_PICKER_META_INDENT}${option.description}`, { color: 'gray' })),
      innerWidth,
    ),
  ];
}

function buildCommandPalettePanel(
  suggestions: SlashCommandOption[],
  selectedIndex: number,
  width: number,
): TuiLine[] {
  const panelWidth = Math.max(28, Math.min(width, MODEL_PICKER_PANEL_MAX_WIDTH));
  const innerWidth = Math.max(1, panelWidth - 4);
  const margin = Array.from(
    { length: MODEL_PICKER_PANEL_MARGIN_LINES },
    () => plainLine(''),
  );
  const body: TuiLine[] = [
    plainLine('TheGitAI - Commands', {
      color: MODEL_PICKER_ACCENT_COLOR,
      bold: true,
    }),
    plainLine(''),
    commandPaletteTopBorder(panelWidth),
    modelPickerPanelSideLine(plainLine(''), innerWidth),
  ];
  suggestions.forEach((suggestion, index) => {
    body.push(
      ...commandPaletteItemLines(suggestion, index === selectedIndex, innerWidth),
    );
    if (index < suggestions.length - 1) {
      body.push(commandPaletteSeparatorLine(innerWidth));
    }
  });
  body.push(
    modelPickerPanelSideLine(plainLine(''), innerWidth),
    modelPickerPanelSideLine(
      line(span('─'.repeat(innerWidth), { color: MODEL_PICKER_BORDER_COLOR })),
      innerWidth,
    ),
    modelPickerPanelSideLine(
      plainLine('↑/↓ choose  •  Tab or Enter accept  •  Esc cancel', { color: 'gray' }),
      innerWidth,
    ),
    plainLine(`╰${'─'.repeat(panelWidth - 2)}╯`, { color: MODEL_PICKER_BORDER_COLOR }),
  );
  return [...margin, ...body, ...margin];
}

export function formatElapsedClock(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  return `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, '0')}s`;
}

// While a prompt is waiting the clock is frozen on purpose, so the label says
// so — a still "Working · 42s" reads as a hung turn.
export function buildWorkingClockLine(
  state: Pick<ShellState, 'analyzingImages' | 'busyPausedAt'> & {
    generatingImage?: boolean;
  },
  elapsedSeconds: number,
): string {
  const elapsed = formatElapsedClock(elapsedSeconds);
  // Nullish, not strict: a state object that never set the field is not paused.
  // Strict equality made an unset field read as frozen and every turn render
  // "Paused" forever.
  if (state.busyPausedAt != null) {
    return `${WORKING_CLOCK_ICON} Paused · ${elapsed} · waiting for your response`;
  }
  const label =
    state.generatingImage
      ? 'Generating image'
      : state.analyzingImages > 0
        ? state.analyzingImages > 1
          ? 'Analyzing images'
          : 'Analyzing image'
        : 'Working';
  return `${WORKING_CLOCK_ICON} ${label} · ${elapsed}`;
}

// The overlay is a bordered panel here, so the preview is measured against the
// panel's inner width rather than the frame's. Shared with the input layer so
// the scroll limit is computed against the same rows that get rendered.
export function approvalPanelInnerWidth(width: number): number {
  return Math.max(1, Math.max(24, Math.min(width, OVERLAY_PANEL_MAX_WIDTH)) - 4);
}

export function approvalPaddingEnabled(height: number): boolean {
  return height >= APPROVAL_PADDING_MIN_ROWS;
}

// Half the terminal, so the transcript always keeps the other half.
export function approvalPreviewBudget(height: number): number {
  const chrome =
    APPROVAL_OVERLAY_CHROME_ROWS +
    (approvalPaddingEnabled(height) ? APPROVAL_PADDING_CHROME_ROWS : 0);
  return Math.max(
    APPROVAL_PREVIEW_MIN_ROWS,
    Math.min(APPROVAL_PREVIEW_MAX_ROWS, Math.floor(height / 2) - chrome),
  );
}

// Every row of the thing being approved, in render order. A command wraps; a
// patch renders its whole diff rather than the transcript's 24-line preview,
// because approving half a patch you cannot scroll is the bug this replaces.
export function approvalPreviewRows(
  prompt: NonNullable<ShellState['approvalPrompt']>,
  innerWidth: number,
): TuiLine[] {
  const previewWidth = Math.max(8, innerWidth - APPROVAL_SCROLLBAR_COLUMNS);
  if (prompt.diffPreview) {
    return renderDiffPreviewLines(
      prompt.diffPreview,
      previewWidth,
      prompt.diffPreview.lines.length,
    );
  }
  return wrapText(prompt.body, previewWidth).map((text) =>
    plainLine(text, { color: OVERLAY_BORDER_COLOR }),
  );
}

export function approvalScrollLimit(
  prompt: ShellState['approvalPrompt'],
  width: number,
  height: number,
): number {
  if (!prompt) return 0;
  return Math.max(
    0,
    approvalPreviewRows(prompt, approvalPanelInnerWidth(width)).length -
      approvalPreviewBudget(height),
  );
}

// A proportional thumb over a dotted track: the size says how much of the
// command fits on screen and the position says where you are in it, which the
// row counter alone does not convey at a glance.
function approvalScrollbarGlyphs(
  totalRows: number,
  visibleRows: number,
  offset: number,
): string[] {
  const thumbRows = Math.max(
    1,
    Math.min(visibleRows, Math.round((visibleRows * visibleRows) / totalRows)),
  );
  const maxOffset = totalRows - visibleRows;
  const thumbTop =
    maxOffset <= 0
      ? 0
      : Math.round((offset / maxOffset) * (visibleRows - thumbRows));
  return Array.from({ length: visibleRows }, (_, index) =>
    index >= thumbTop && index < thumbTop + thumbRows
      ? APPROVAL_SCROLLBAR_THUMB
      : APPROVAL_SCROLLBAR_TRACK,
  );
}

function withScrollbarGlyph(target: TuiLine, glyph: string, column: number): TuiLine {
  const padding = Math.max(1, column - lineCharCount(target));
  return {
    spans: [
      ...target.spans,
      span(' '.repeat(padding)),
      span(glyph, {
        color: 'gray',
        dim: glyph === APPROVAL_SCROLLBAR_TRACK,
      }),
    ],
  };
}

export interface ApprovalPreviewWindow {
  /** 1-based, for display. Both are 0 when there is nothing to show. */
  firstVisibleRow: number;
  lastVisibleRow: number;
  lines: TuiLine[];
  /** The requested offset clamped into range. */
  offset: number;
  totalRows: number;
}

export function buildApprovalPreviewWindow(
  prompt: NonNullable<ShellState['approvalPrompt']>,
  innerWidth: number,
  height: number,
  requestedOffset: number,
): ApprovalPreviewWindow {
  const rows = approvalPreviewRows(prompt, innerWidth);
  const budget = approvalPreviewBudget(height);
  if (rows.length <= budget) {
    return {
      firstVisibleRow: rows.length === 0 ? 0 : 1,
      lastVisibleRow: rows.length,
      lines: rows,
      offset: 0,
      totalRows: rows.length,
    };
  }
  const offset = Math.max(0, Math.min(requestedOffset, rows.length - budget));
  const visible = rows.slice(offset, offset + budget);
  const glyphs = approvalScrollbarGlyphs(rows.length, budget, offset);
  return {
    firstVisibleRow: offset + 1,
    lastVisibleRow: offset + visible.length,
    lines: visible.map((target, index) =>
      withScrollbarGlyph(target, glyphs[index]!, innerWidth - 1),
    ),
    offset,
    totalRows: rows.length,
  };
}

export function approvalScrollStatusLine(window: ApprovalPreviewWindow): string {
  return `lines ${window.firstVisibleRow}–${window.lastVisibleRow} of ${window.totalRows} · PgUp/PgDn scrolls`;
}

// Right-aligned so the counter lines up under the scrollbar it describes. A
// counter too long for the panel stays left-aligned rather than being clipped.
export function rightAlignedLine(
  text: string,
  width: number,
  style: Parameters<typeof plainLine>[1] = {},
): TuiLine {
  return plainLine(`${' '.repeat(Math.max(0, width - displayWidth(text)))}${text}`, style);
}

function buildOverlayLines(
  state: ShellState,
  width: number,
  height: number,
  nowMs: number,
): TuiLine[] {
  const lines: TuiLine[] = [];
  const panelWidth = Math.max(24, Math.min(width, OVERLAY_PANEL_MAX_WIDTH));
  const innerWidth = approvalPanelInnerWidth(width);
  if (state.sudoPrompt) {
    const prompt = state.sudoPrompt;
    const passwordWidth = Math.max(0, innerWidth - 11);
    lines.push(
      plainLine('Sudo Authentication Required', {
        color: OVERLAY_BORDER_COLOR,
        bold: true,
      }),
    );
    lines.push(
      ...wrapText(
        'Agents can make mistakes. This command may change your system. Proceed at your own risk.',
        innerWidth,
      ).map((text) => plainLine(text, { color: OVERLAY_WARNING_COLOR })),
    );
    lines.push(plainLine(''));
    const commandLines = wrapText(prompt.command, Math.max(1, innerWidth - 9));
    commandLines.forEach((text, index) => {
      lines.push(
        index === 0
          ? line(
              span('Command: ', {
                color: OVERLAY_BORDER_COLOR,
                bold: true,
              }),
              span(text, { color: OVERLAY_BORDER_COLOR }),
            )
          : line(
              span('         '),
              span(text, { color: OVERLAY_BORDER_COLOR }),
            ),
      );
    });
    lines.push(plainLine(''));
    // Deliberately not `prompt.prompt`: sudo's own prompt is suppressed because
    // our Password: row already asks the same thing, and a raw PAM string next
    // to a security assurance reads as debris exactly where trust matters.
    // The reassurance leads with the fear it answers — people assume anything
    // typed at an agent is sent to the model. It is grey, not orange: this is a
    // statement of fact, not a second warning.
    lines.push(
      ...wrapText(SUDO_PASSWORD_ASSURANCE, innerWidth).map((text) =>
        plainLine(text, { color: SUDO_ASSURANCE_COLOR }),
      ),
    );
    lines.push(plainLine(''));
    lines.push(
      line(
        span('Password: ', { color: 'cyan', bold: true }),
        span('•'.repeat(Math.min(prompt.passwordLength, passwordWidth)), {
          color: 'cyan',
        }),
        span(' ', { inverse: true }),
      ),
    );
    lines.push(
      plainLine('Press Enter to submit, Escape to cancel', { color: 'gray' }),
    );
    return buildOverlayPanel(lines, width, OVERLAY_BORDER_COLOR, height);
  }
  if (state.userInputPrompt) {
    if (height < 3) {
      return [];
    }
    return buildOverlayPanel(
      buildUserInputOverlayLines(
        state.userInputPrompt,
        innerWidth,
        overlayPanelContentBudget(height),
      ),
      width,
      USER_INPUT_BORDER_COLOR,
      height,
    );
  }
  if (state.approvalPrompt) {
    const prompt = state.approvalPrompt;
    const padded = approvalPaddingEnabled(height);
    lines.push(plainLine(prompt.title, {
      color: APPROVAL_ACCENT_COLOR,
      bold: true,
    }));
    if (padded) lines.push(plainLine(''));
    if (prompt.diffPreview && prompt.filePath) {
      lines.push(
        line(
          span('● ', { color: 'green' }),
          span('Update(', { bold: true }),
          span(prompt.filePath, { color: 'cyan', bold: true }),
          span(')', { bold: true }),
        ),
      );
    }
    // Commands and patches share one scrollable pane: both can outgrow the
    // screen, and both are being approved sight-unseen if part of them is
    // unreachable.
    const previewWindow = buildApprovalPreviewWindow(
      prompt,
      innerWidth,
      height,
      state.approvalScrollOffset ?? 0,
    );
    lines.push(...previewWindow.lines);
    // The blank always separates the command from the options. When the counter
    // is there it lands between the two, which is what gives it air on both
    // sides without spending a row when there is nothing to scroll.
    if (padded) lines.push(plainLine(''));
    if (previewWindow.totalRows > previewWindow.lines.length) {
      lines.push(
        rightAlignedLine(approvalScrollStatusLine(previewWindow), innerWidth, {
          color: APPROVAL_SCROLL_STATUS_COLOR,
        }),
      );
      if (padded) lines.push(plainLine(''));
    }
    // Labels only. These used to be prefixed with their `y`/`a`/`n` value,
    // which read as a shortcut key — and pressing one really did answer the
    // prompt, so typing a word while a prompt appeared could approve or deny
    // something. The keys are gone, so advertising them is worse than useless:
    // it invites the exact keystroke that now does nothing.
    //
    // The list is per-request: a command whose prefix can be remembered gets a
    // fourth row, everything else gets three.
    const options = (prompt.options ?? []).map((option) => option.label);
    options.forEach((label, index) => {
      const selected = index === state.approvalCursor;
      lines.push(
        line(
          span(selected ? '› ' : '  ', {
            color: selected ? APPROVAL_ACCENT_COLOR : 'gray',
          }),
          span(label, {
            color: selected ? APPROVAL_ACCENT_COLOR : undefined,
            bold: selected,
          }),
        ),
      );
    });
    if (padded) lines.push(plainLine(''));
    lines.push(
      plainLine('↑/↓ moves • Enter confirms • Esc denies', {
        color: 'gray',
      }),
    );
    return buildOverlayPanel(lines, width, OVERLAY_BORDER_COLOR, height);
  }
  if (state.modelPickerOpen) {
    const options = buildModelPickerOptions(state.currentModelId, state.serverModels);
    lines.push(
      ...buildModelPickerPanel(
        options,
        state.modelPickerIndex,
        width,
        height,
      ),
    );
  }
  if (state.jobsPickerOpen) {
    lines.push(...buildJobsPickerLines(state, width, nowMs));
  }
  if (state.resumePickerOpen) {
    const filtered = filterResumeSessions(
      state.resumePickerSessions,
      state.resumePickerFilter,
      state.serverModels,
    );
    const pickerWidth = Math.max(20, width - 2);
    const divider = () =>
      plainLine('─'.repeat(pickerWidth), { color: 'gray', dim: true });
    lines.push(
      plainLine('Resume a previous session', { color: 'cyan', bold: true }),
    );
    lines.push(
      line(
        span('Search: ', { color: 'gray' }),
        span(state.resumePickerFilter, {}),
        span('█', { color: 'gray' }),
      ),
    );
    lines.push(divider());
    // Each card takes three rows (prompt, metadata, separator), so on short
    // terminals only a window around the selection renders, with dim "…"
    // markers standing in for the rest.
    const maxCards = Math.max(
      2,
      Math.min(filtered.length, Math.floor((height - 10) / 3)),
    );
    let start = 0;
    if (filtered.length > maxCards) {
      start = Math.min(
        Math.max(0, state.resumePickerIndex - Math.floor(maxCards / 2)),
        filtered.length - maxCards,
      );
    }
    const visible = filtered.slice(start, start + maxCards);
    if (start > 0) {
      lines.push(
        plainLine(`  … ${start} newer`, { color: 'gray', dim: true }),
      );
    }
    for (const [offset, session] of visible.entries()) {
      const index = start + offset;
      const selected = index === state.resumePickerIndex;
      // Server-listed rows carry no prompt text (the customer DB stays
      // metadata-only), so fall back to a real identifier rather than
      // leaving the primary line empty.
      const prompt =
        singleLinePreview(session.lastUserMessage, pickerWidth) ||
        session.name ||
        `Session ${session.id}`;
      lines.push(
        line(
          span(selected ? '› ' : '  ', { color: 'cyan' }),
          span(
            fitLine(prompt, Math.max(10, pickerWidth - 2)),
            selected
              ? { color: 'cyan', bold: true }
              : session.lastUserMessage
                ? {}
                : { color: 'gray', dim: true },
          ),
        ),
      );
      const meta = [
        formatRelativeTime(session.updatedAt),
        pickerModelLabel(session.modelId, state.serverModels),
        session.branch ?? null,
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        line(
          span('    '),
          span(fitLine(meta, Math.max(10, pickerWidth - 4)), {
            color: selected ? 'cyan' : 'gray',
            dim: !selected,
          }),
        ),
      );
      if (offset < visible.length - 1) lines.push(plainLine(''));
    }
    const remaining = filtered.length - (start + visible.length);
    if (remaining > 0) {
      lines.push(
        plainLine(`  … ${remaining} older`, { color: 'gray', dim: true }),
      );
    }
    if (filtered.length === 0) {
      lines.push(plainLine('No sessions match.', { color: 'gray' }));
    }
    lines.push(divider());
    lines.push(
      plainLine('↑/↓ move · enter resume · esc start new · ctrl+c quit', {
        color: 'gray',
      }),
    );
  }
  const suggestions = getSlashCommandSuggestions(state.input);
  if (
    !state.busy &&
    !state.exiting &&
    !state.modelPickerOpen &&
    !state.resumePickerOpen &&
    state.input.trimStart().startsWith('/') &&
    !state.input.includes(' ') &&
    suggestions.length > 0
  ) {
    lines.push(
      ...buildCommandPalettePanel(suggestions, state.commandCursor, width),
    );
  }
  return lines;
}

function countSectionLines(sections: TuiSection[]): number {
  return sections.reduce((sum, section) => sum + section.lines.length, 0);
}

export function userInputViewportForFrame(
  state: ShellState,
  cols: number,
  rows: number,
  spinnerFrame: number,
  elapsedSeconds: number,
  nowMs = 0,
): UserInputViewport {
  const contentWidth = Math.max(20, Math.floor(cols * 0.95) - 2);
  const liveRows = buildLiveLines(
    state,
    contentWidth,
    spinnerFrame,
    elapsedSeconds,
    nowMs,
  ).length;
  const overlayHeight = Math.max(
    0,
    rows - liveRows - composerFooterLines(state).length,
  );
  return {
    width: approvalPanelInnerWidth(contentWidth),
    maxRows: overlayPanelContentBudget(overlayHeight),
  };
}

/**
 * Window of transcript lines for the current scroll position.
 *
 * The first line returned is always at index `transcriptScrollLimit -
 * transcriptScrollOffset` of `lines`, because the limit is `lines.length -
 * maxLines` and the window starts `offset` lines above the end. The TUI relies
 * on that identity to turn a screen row back into a transcript line index, so a
 * mouse selection stays on the text it was made on while the viewport scrolls
 * instead of on fixed screen rows. Changing the slice arithmetic here without
 * changing `TranscriptScroll::first_line` in the TUI renderer would drift every
 * selection, so the two are covered by one test.
 */
function sliceTranscriptLines(
  lines: TuiLine[],
  maxLines: number,
  scrollOffset: number,
): TuiLine[] {
  if (maxLines <= 0 || lines.length <= maxLines) {
    return lines;
  }
  const maxOffset = Math.max(0, lines.length - maxLines);
  const offset = Math.min(Math.max(scrollOffset, 0), maxOffset);
  const start = Math.max(0, lines.length - maxLines - offset);
  return lines.slice(start, start + maxLines);
}

export function buildTuiFrame(
  state: ShellState,
  cols: number,
  rows: number,
  spinnerFrame: number,
  elapsedSeconds: number,
  nowMs = 0,
): TuiFrame {
  const contentWidth = Math.max(20, Math.floor(cols * 0.95) - 2);
  const gutter = Math.max(Math.floor((cols - contentWidth) / 2), 0);
  const buildTranscriptLines = (wrapWidth: number): TuiLine[] => {
    const blocks = state.transcript.map((entry) =>
      cachedTranscriptEntryLines(entry, wrapWidth),
    );
    const lines: TuiLine[] = [];
    blocks.forEach((block, index) => {
      if (index > 0) {
        lines.push(plainLine(''));
      }
      lines.push(...block);
    });
    return lines;
  };
  let transcriptLines = buildTranscriptLines(contentWidth);
  const sections: TuiSection[] = [];
  const liveLines = buildLiveLines(
    state,
    contentWidth,
    spinnerFrame,
    elapsedSeconds,
    nowMs,
  );
  if (liveLines.length > 0) {
    sections.push({ kind: 'live', lines: liveLines });
  }
  const overlayActive = Boolean(
    state.approvalPrompt || state.sudoPrompt || state.userInputPrompt,
  );
  // Composer stays visible while busy unless a blocking overlay is active.
  //
  // It used to be REPLACED by the queued-message chip. Keystrokes still went to
  // state.input, so a user typing a second message while one was queued had no
  // input box on screen and no idea their text existed — and the send gesture
  // keyed off whether that invisible box was empty. Measured live: many "stop"s
  // typed, exactly one delivered, each silently overwriting the last. Whatever
  // else changes here, the composer must never vanish while it accepts input.
  if (!state.resumePickerOpen && !state.modelPickerOpen && !state.jobsPickerOpen && !overlayActive) {
    const composerLines: TuiLine[] = [];
    // Must match the status text repl.tsx sets at the start of the /new
    // handler. The session save it waits on can take a few seconds; without
    // this the composer looks like an ordinary idle prompt during that gap.
    if (state.busy && state.status === 'Starting a new conversation...') {
      composerLines.push(
        line(span('Starting a new conversation…', { color: 'gray', dim: true })),
      );
    } else if (state.queuedMessage) {
      // Deliberately locked rather than hidden: the message is already written,
      // so the only useful actions are send / discard / edit. Saying so out loud
      // is what makes the second Enter unambiguous — there is nothing else it
      // could mean in this state.
      const imageCount = state.queuedMessage.imageAttachments.length;
      composerLines.push(
        line(
          span('Queued', { color: 'cyan', bold: true }),
          span('  Enter', { color: 'cyan', bold: true }),
          span(
            imageCount > 0
              ? ' sends it with the next prompt'
              : ' sends it to the agent now',
            { color: 'gray' },
          ),
          span('  ·  ↑', { color: 'cyan', bold: true }),
          span(' edit', { color: 'gray' }),
          span('  ·  Esc', { color: 'cyan', bold: true }),
          span(' discard', { color: 'gray' }),
        ),
      );
    } else {
      const promptLabel = state.busy ? 'queue> ' : '❯ ';
      const placeholder = state.busy
        ? 'Type to queue the next message'
        : 'Type a request or /help';
      composerLines.push(
        ...buildComposerInputLines(
          state.input,
          state.cursor,
          promptLabel,
          placeholder,
          contentWidth,
        ),
      );
    }
    sections.push({
      kind: 'composer',
      lines: [...composerLines, plainLine(''), ...composerFooterLines(state)],
    });
  }
  if (state.userInputPrompt) {
    sections.push({
      kind: 'busyFooter',
      lines: composerFooterLines(state),
    });
  }
  const overlayHeight = state.userInputPrompt
    ? Math.max(0, rows - countSectionLines(sections))
    : rows;
  const overlayLines = buildOverlayLines(
    state,
    contentWidth,
    overlayHeight,
    nowMs,
  );
  if (overlayLines.length > 0) {
    sections.push({ kind: 'overlay', lines: overlayLines });
  }

  const reservedLines = countSectionLines(
    sections.filter((section) => section.kind !== 'transcript'),
  );
  // The reserve is headroom for the composer growing as you type. An approval
  // or sudo prompt swallows every key, so the composer cannot grow while one is
  // open and the cushion is four rows the transcript should have instead.
  const composerReserve =
    state.resumePickerOpen ||
    state.approvalPrompt ||
    state.sudoPrompt ||
    state.userInputPrompt
      ? 0
      : 4;
  const transcriptBudget = Math.max(1, rows - reservedLines - composerReserve - 1);
  let transcriptScrollLimit = Math.max(0, transcriptLines.length - transcriptBudget);
  // When the transcript overflows, the ratatui renderer reserves two columns:
  // a blank gap, then the scrollbar thumb. Rewrap to that narrower width so
  // content never jumps under the bar (narrower wrap can only add lines, so
  // overflow stays true).
  if (transcriptScrollLimit > 0 && contentWidth > 2) {
    transcriptLines = buildTranscriptLines(contentWidth - 2);
    transcriptScrollLimit = Math.max(0, transcriptLines.length - transcriptBudget);
  }
  const transcriptScrollOffset = Math.min(
    Math.max(state.transcriptScrollOffset, 0),
    transcriptScrollLimit,
  );
  sections.unshift({
    kind: 'transcript',
    lines: sliceTranscriptLines(
      transcriptLines,
      transcriptBudget,
      transcriptScrollOffset,
    ),
  });

  return {
    cols,
    rows,
    gutter,
    contentWidth,
    spinnerFrame,
    transcriptScrollLimit,
    transcriptScrollOffset,
    sections,
  };
}
