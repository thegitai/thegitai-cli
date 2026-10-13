import { fitModelLabel } from './model-label.js';
import { projectModelEffort, type ProjectModelEfforts } from '../../project-model-preferences.js';
import { REASONING_EFFORTS, REASONING_EFFORT_LABELS, REASONING_EFFORT_DESCRIPTIONS, type ReasoningEffort } from '../../reasoning-effort.js';
import {
  agentModeColor,
  agentModeLabelTiers,
  agentModeShortLabel,
} from '../../agent-mode.js';
import type { ServerModelInfo } from '../../api/models.js';
import type { SessionMetadata } from '../../session-store.js';
import { singleLinePreview, truncate } from '../../utils.js';
import { formatClientTokenUsage } from '../repl.js';
import {
  getHiddenSlashCommandCount,
  getSlashCommandSuggestions,
  type SlashCommandOption,
} from '../slash-commands.js';
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
import {
  buildShortcutGroups,
  shortcutsPanelAvailable,
  type ShortcutGroup,
} from './shortcuts.js';
import type { TuiFrame, TuiLine, TuiSection, TuiSpan } from './types.js';
import {
  buildUserInputOverlayLines,
  type UserInputPromptState,
  type UserInputViewport,
} from './user-input.js';
import {
  composerPromptLabel,
  frameContentWidth,
  splitComposerInput,
} from './composer-layout.js';

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

  recoveryStatus?: string;
  activeTurnInput: string;
  activeTurnInputPreformatted?: boolean;
  agentMode: import('../../agent-mode.js').AgentMode;
  approvalCursor: number;
  approvalPrompt: {
    body: string;
    diffPreview?: DiffPreviewModel;
    filePath?: string;

    options?: { label: string }[];
    title: string;
  } | null;

  approvalOpenedAt?: number | null;

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

  jobsPickerReturnStatus?: string | null;
  modelPickerIndex: number;
  modelPickerOpen: boolean;
  modelPickerEfforts?: ProjectModelEfforts;
  reasoningEffort?: ReasoningEffort;

  shortcutsOpen?: boolean;

  transientStatus?: string | null;
  projectRoot: string;
  resumePickerFilter: string;
  resumePickerIndex: number;
  resumePickerOpen: boolean;
  resumePickerSessions: SessionMetadata[];
  sessionId: string;
  showSessionId: boolean;
  thinkingNotes: string[];
  thinkingTitle: string;

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







const APPROVAL_PREVIEW_MAX_ROWS = 20;
const APPROVAL_PREVIEW_MIN_ROWS = 4;




const APPROVAL_OVERLAY_CHROME_ROWS = 11;





const APPROVAL_PADDING_CHROME_ROWS = 4;
const APPROVAL_PADDING_MIN_ROWS = 30;


const APPROVAL_SCROLLBAR_COLUMNS = 2;



const APPROVAL_ACCENT_COLOR = 'cyan';






const SUDO_PASSWORD_ASSURANCE =
  'The model never sees this. Your password goes straight to sudo on this ' +
  'computer, then is discarded — never sent to our servers, saved, or logged.';
const SUDO_ASSURANCE_COLOR = 'ansi256(248)';


const APPROVAL_SCROLL_STATUS_COLOR = 'ansi256(248)';
const APPROVAL_SCROLLBAR_THUMB = '█';
const APPROVAL_SCROLLBAR_TRACK = '░';
const THINKING_NOTE_PREVIEW_ROWS = 3;
const COMPOSER_INPUT_MAX_ROWS = 6;

const FOOTER_HINT_MIN_GAP = 2;


const FOOTER_HELP_HINT = '? for shortcuts';
const FOOTER_CANCEL_HINT = 'esc cancels turn';






const FOOTER_NOTIFICATIONS_ON = 'Notifications ON';
const FOOTER_NOTIFICATIONS_OFF = 'Notifications OFF';


export function footerNotificationHint(status: string | null | undefined): string {
  const text = String(status ?? '').trim();
  if (text === 'Notifications on') return FOOTER_NOTIFICATIONS_ON;
  if (text === 'Notifications off') return FOOTER_NOTIFICATIONS_OFF;
  return '';
}

const FOOTER_CYCLE_HINT = ' (shift+tab to cycle)';
const OVERLAY_PANEL_MAX_WIDTH = 86;







const USER_INPUT_PANEL_MAX_WIDTH = 120;
const OVERLAY_PANEL_MARGIN_LINES = 2;


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





const COMPOSER_MARKER_PATTERN = /\[Image #\d+\]|\[Pasted Text: [^\]\n]*\]/g;









function composerMarkerMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const match of text.matchAll(COMPOSER_MARKER_PATTERN)) {
    const start = match.index ?? 0;
    for (let offset = start; offset < start + match[0].length; offset += 1) {
      mask[offset] = true;
    }
  }
  return mask;
}






function composerRowSpans(
  text: string,
  mask: readonly boolean[],
  cursorCol: number | null,
): TuiSpan[] {
  const spans: TuiSpan[] = [];
  const push = (value: string, marker: boolean, cursor: boolean) => {
    if (!value) return;
    spans.push(
      span(value, {
        ...(marker ? { color: 'cyan' } : {}),
        ...(cursor ? { inverse: true } : {}),
      }),
    );
  };
  let cut = 0;
  const flushTo = (end: number) => {
    while (cut < end) {
      const marker = mask[cut] ?? false;
      let runEnd = cut + 1;
      while (runEnd < end && (mask[runEnd] ?? false) === marker) runEnd += 1;
      push(text.slice(cut, runEnd), marker, false);
      cut = runEnd;
    }
  };
  if (cursorCol === null) {
    flushTo(text.length);
    return spans;
  }
  flushTo(Math.min(cursorCol, text.length));
  push(text[cursorCol] ?? ' ', mask[cursorCol] ?? false, true);
  cut = Math.min(cursorCol + 1, text.length);
  flushTo(text.length);
  return spans;
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




  const rowOffsets: number[] = [];
  let consumed = 0;
  for (const row of rows) {
    rowOffsets.push(consumed);
    consumed += row.length;
  }
  const mask = composerMarkerMask(rows.join(''));

  return rows
    .slice(firstRow, firstRow + COMPOSER_INPUT_MAX_ROWS)
    .map((text, index) => {
      const absoluteRow = firstRow + index;
      const rowStart = rowOffsets[absoluteRow] ?? 0;
      const label =
        index === 0
          ? span(promptLabel, { color: 'cyan' })
          : span(' '.repeat(labelWidth));
      return line(
        label,
        ...composerRowSpans(
          text,
          mask.slice(rowStart, rowStart + text.length),
          absoluteRow === cursorRow ? cursorCol : null,
        ),
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

export { getSlashCommandSuggestions };

function formatModelLabel(modelId: number, serverModels: ServerModelInfo[]): string {
  return serverModels.find((model) => model.id === modelId)?.label ?? 'Unknown model';
}




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








const TODO_IN_PROGRESS_FRAMES = [
  '\u25CB',
  '\u25D4',
  '\u25D1',
  '\u25D5',
  '\u25CF',
] as const;

const TODO_IN_PROGRESS_STATIC_GLYPH = '\u25D1';





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



    isDarkTerminalBackground()
      ? span(text, { color: mutedColor() })
      : span(text),
  );
}










export interface TurnMessage {
  id: number;
  text: string;
  state: 'queued' | 'sending' | 'delivered';

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






  const DECORATION = 6;
  const budget = Math.max(1, width - DECORATION);
  const preferredLabel = Math.max(
    ...Object.values(TURN_MESSAGE_LABEL).map((value) => displayWidth(value)),
  );


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




export function renderTodoListLines(
  items: TodoDisplayItem[],
  width: number,
  { header = false, progressTick = null }: {
    header?: boolean;

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







const transcriptEntryLineCache = new WeakMap<
  TranscriptEntry,
  Map<number, TuiLine[]>
>();



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

    const oldest = byWidth.keys().next().value;
    if (oldest !== undefined) byWidth.delete(oldest);
  }
  byWidth.set(width, lines);
  return lines;
}




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


export const AGENT_MODE_LOCKED_STATUS = 'Mode locked while the agent is working';





function footerTransientStatus(
  status: string | null,
): { color: string; text: string; icon: string } | null {
  const text = String(status ?? '').trim();
  if (!text) return null;
  if (text === AGENT_MODE_LOCKED_STATUS) {
    return { color: 'yellow', text, icon: '!' };
  }
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



  const hint = state.busy ? ' · ctrl+b' : ' · /jobs';
  return [
    span('   ', { color: 'gray', dim: true }),
    span(`● ${runningCount} ${noun} running`, { color: 'green', bold: true }),
    span(hint, { color: 'gray', dim: true }),
  ];
}




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


function composerFooterRightHints(state: ShellState): string[] {


  const cancelHint =
    state.busy && !state.queuedMessage && !state.userInputPrompt
      ? FOOTER_CANCEL_HINT
      : '';


  const helpHint = shortcutsPanelAvailable(state) ? FOOTER_HELP_HINT : '';


  const notifyHint = footerNotificationHint(state.transientStatus);
  const join = (...parts: string[]) => parts.filter(Boolean).join('  ·  ');
  const tiers: string[] = [];
  if (notifyHint) {
    tiers.push(join(cancelHint, notifyHint, helpHint));
    tiers.push(join(notifyHint, helpHint));
    tiers.push(join(cancelHint, notifyHint));
    tiers.push(notifyHint);
  }
  if (cancelHint && helpHint) tiers.push(`${cancelHint}  ·  ${helpHint}`);

  if (cancelHint) tiers.push(cancelHint);
  if (helpHint) tiers.push(helpHint);
  tiers.push('');

  return tiers.filter((tier, index) => tiers.indexOf(tier) === index);
}












export function fitComposerFooterRow({
  modeLabels,
  modeLabelFallback,
  cycleHint,
  rightHints,
  leadWidth,
  tailWidth,
  contentWidth,
}: {
  modeLabels: string[];
  modeLabelFallback: string;
  cycleHint: string;
  rightHints: string[];

  leadWidth: number;

  tailWidth: number;
  contentWidth: number;
}): { modeLabel: string; cycleHint: string; rightHint: string; gap: number } {
  const candidates = rightHints.flatMap((rightHint) =>
    (cycleHint ? [cycleHint, ''] : ['']).flatMap((cycle) =>
      modeLabels.map((modeLabel) => ({ modeLabel, cycleHint: cycle, rightHint })),
    ),
  );


  const hasTail = (rightHint: string) => Boolean(rightHint) || tailWidth > 0;
  const rowWidth = (
    choice: { modeLabel: string; cycleHint: string; rightHint: string },
    gap: number,
  ) =>
    leadWidth +
    displayWidth(choice.modeLabel) +
    displayWidth(choice.cycleHint) +
    (hasTail(choice.rightHint) ? gap : 0) +
    displayWidth(choice.rightHint) +
    tailWidth;
  const chosen =
    candidates.find(
      (choice) => rowWidth(choice, FOOTER_HINT_MIN_GAP) <= contentWidth,
    ) ?? { modeLabel: modeLabelFallback, cycleHint: '', rightHint: '' };



  const gap = hasTail(chosen.rightHint)
    ? Math.max(FOOTER_HINT_MIN_GAP, contentWidth - rowWidth(chosen, 0))
    : 0;
  return { ...chosen, gap };
}

function composerFooterLines(state: ShellState, contentWidth: number): TuiLine[] {
  const visibleSessionId = formatPromptSessionIdLabel(
    state.showSessionId,
    state.sessionId,
  );
  const transientStatus = footerTransientStatus(state.transientStatus ?? null);
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
  const tokenUsageText = state.tokenUsage || formatClientTokenUsage(null);
  lines.push(
    ...composerFooterModeLines(
      state,
      contentWidth,
      formatModelLabel(state.currentModelId, state.serverModels),
      tokenUsageText
        ? displayWidth(tokenUsageText) + FOOTER_USAGE_SEPARATOR.length
        : 0,
      tokenUsageText
        ? [
            span(FOOTER_USAGE_SEPARATOR, mutedStyle()),
            span(tokenUsageText, { color: 'cyan' }),
          ]
        : [],
    ),
  );
  return lines;
}

function composerFooterModeLines(
  state: ShellState,
  contentWidth: number,
  modelLabel: string,
  usageWidth: number,
  usageSpans: TuiSpan[],
): TuiLine[] {
  const effort = REASONING_EFFORT_LABELS[state.reasoningEffort ?? 'default'];
  const effortText = ` · ${effort} effort`;
  const modeLabels = agentModeLabelTiers(state.agentMode).map((label) => `Mode: ${label}`);
  const modeWidth = displayWidth(modeLabels[0]!);
  const separateUsage = usageWidth > 0 && modeWidth + usageWidth > contentWidth;
  const tailWidth = separateUsage ? 0 : usageWidth;
  const canCancel = state.busy && !state.queuedMessage && !state.userInputPrompt;
  const feedbackHints = [canCancel ? FOOTER_CANCEL_HINT : '', footerNotificationHint(state.transientStatus)].filter(Boolean);
  const feedback = feedbackHints.join('  ·  ');
  const feedbackWidth = feedback ? displayWidth(feedback) + FOOTER_HINT_MIN_GAP : 0;
  const combined = displayWidth(modelLabel + effortText) + FOOTER_MODEL_SEPARATOR.length + modeWidth + tailWidth + feedbackWidth <= contentWidth;
  const modelText = combined ? modelLabel : fitModelLabel(modelLabel, contentWidth - displayWidth(effortText));
  const modelSpans = [
    span(modelText, { color: 'cyan' }),
    span(effortText, { bold: true }),
  ];
  const row = fitComposerFooterRow({
    modeLabels,
    modeLabelFallback: `Mode: ${agentModeShortLabel(state.agentMode)}`,
    cycleHint: state.busy ? '' : FOOTER_CYCLE_HINT,
    rightHints: composerFooterRightHints(state),
    leadWidth: combined ? displayWidth(modelLabel + effortText) + FOOTER_MODEL_SEPARATOR.length : 0,
    tailWidth,
    contentWidth,
  });
  const remainingHints = feedbackHints.filter((hint) => !row.rightHint.includes(hint));
  const remainingFeedback = remainingHints.join('  ·  ');
  const feedbackLines = !remainingFeedback ? []
    : displayWidth(remainingFeedback) <= contentWidth ? [remainingFeedback]
      : remainingHints.flatMap((hint) => wrapText(hint, contentWidth));
  const footerMuted = mutedStyle();
  const modeLine = line(
    ...(combined ? [...modelSpans, span(FOOTER_MODEL_SEPARATOR, footerMuted)] : []),
    span(row.modeLabel, {
      color: agentModeColor(state.agentMode),
      bold: state.agentMode === 'auto-accept',
    }),
    ...(row.cycleHint ? [span(row.cycleHint, footerMuted)] : []),
    ...(row.gap ? [span(' '.repeat(row.gap), footerMuted)] : []),
    ...(row.rightHint ? [span(row.rightHint, footerMuted)] : []),
    ...(separateUsage ? [] : usageSpans),
  );
  return [
    ...(combined ? [] : [line(...modelSpans)]),
    modeLine,
    ...feedbackLines.map((text) => plainLine(text, footerMuted)),
    ...(separateUsage ? wrapText(usageSpans.slice(1).map((part) => part.text).join(''), contentWidth).map((text) => plainLine(text, { color: 'cyan' })) : []),
  ];
}


const FOOTER_USAGE_SEPARATOR = '  ';


const FOOTER_MODEL_SEPARATOR = '   ';

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


const JOBS_PICKER_CHROME_ROWS = 2;

const JOBS_PICKER_MIN_ROWS = 8;

function buildJobsPickerLines(
  state: ShellState,
  width: number,
  height: number,
  nowMs: number,
): TuiLine[] {
  const jobs = state.backgroundJobs ?? [];




  const bodyBudget = Math.max(1, height - JOBS_PICKER_CHROME_ROWS);
  const lines: TuiLine[] = [
    plainLine('Background jobs', { color: 'cyan', bold: true }),
  ];
  if (jobs.length === 0) {
    lines.push(plainLine('No background jobs in this session.', { color: 'gray' }));
  }


  let start = 0;
  let visible = jobs;
  if (jobs.length > bodyBudget) {
    start = Math.min(
      Math.max(0, state.jobsPickerIndex - Math.floor(bodyBudget / 2)),
      jobs.length - bodyBudget,
    );
    visible = jobs.slice(start, start + bodyBudget);
    if (start > 0) {
      lines.push(plainLine(`  … ${start} newer`, { color: 'gray', dim: true }));
    }
  }


  const detailBudget = Math.max(0, bodyBudget - visible.length - (start > 0 ? 1 : 0));
  for (const [offset, job] of visible.entries()) {
    const index = start + offset;
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
      const allDetail = (job.detailLines ?? []).length
        ? job.detailLines ?? []
        : backgroundJobPreviewLines(job, 3);
      const detailLines = allDetail.slice(-detailBudget);
      if (detailBudget > 0 && detailLines.length === 0) {
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
  const remaining = jobs.length - (start + visible.length);
  if (remaining > 0) {
    lines.push(plainLine(`  … ${remaining} older`, { color: 'gray', dim: true }));
  }
  lines.push(
    plainLine('↑/↓ move    enter expand/collapse    k kill    esc close', {
      color: 'gray',
    }),
  );
  return lines;
}

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




function buildRecoveryStatusLines(status: string, width: number): TuiLine[] {
  const [label = '', ...rest] = status.split(' · ');
  const detail = rest.join(' · ');
  const labelSpan = span(fitLine(label, Math.max(1, width - 2)), { color: 'yellow', bold: true });
  if (!detail) return [line(span('● ', { color: 'yellow' }), labelSpan)];
  if (displayWidth(`● ${label} · ${detail}`) <= width) {
    return [line(span('● ', { color: 'yellow' }), labelSpan, span(` · ${detail}`))];
  }
  return [
    line(span('● ', { color: 'yellow' }), labelSpan),
    ...wrapText(detail, Math.max(1, width - 2)).map((row) => plainLine(`  ${row}`)),
  ];
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
  if (state.recoveryStatus) {
    lines.push(...buildRecoveryStatusLines(state.recoveryStatus, width));
  }



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






  if (visibleTitle || visibleNotes.length > 0) {
    lines.push(plainLine(''));
    if (todos.length > 0) {


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
  maxWidth = OVERLAY_PANEL_MAX_WIDTH,
): TuiLine[] {
  const panelWidth = Math.max(24, Math.min(width, maxWidth));
  const innerWidth = Math.max(1, panelWidth - 4);



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
  const used = spans.reduce((total, part) => total + displayWidth(part.text), 0);
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
const MODEL_PICKER_MODEL_MIN_WIDTH = 42;
const MODEL_PICKER_MODEL_MAX_WIDTH = 54;
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

function modelPickerModelWidth(innerWidth: number): number {
  return Math.min(MODEL_PICKER_MODEL_MAX_WIDTH, Math.max(
    MODEL_PICKER_MODEL_MIN_WIDTH,
    innerWidth - MODEL_PICKER_COST_WIDTH - MODEL_PICKER_SEPARATOR.length * 2 - 18,
  ));
}

function modelPickerNotesWidth(innerWidth: number): number {
  return Math.max(
    18,
    innerWidth -
      modelPickerModelWidth(innerWidth) -
      MODEL_PICKER_COST_WIDTH -
      MODEL_PICKER_SEPARATOR.length * 2,
  );
}

function modelPickerModelSpans(
  option: ModelPickerOptionRow,
  selected: boolean,
  effort: ReasoningEffort,
  width: number,
  showCurrentTag: boolean,
  labelStyle: Partial<Omit<TuiSpan, 'text'>>,
  selectedStyle: Partial<Omit<TuiSpan, 'text'>>,
): TuiSpan[] {
  const tag = option.current && showCurrentTag ? ' (current)' : '';
  const effortText = ` · ${REASONING_EFFORT_LABELS[effort]}`;
  const nameWidth = Math.max(1, width - displayWidth(tag + effortText) - 2);
  const label = `${selected ? '▶ ' : '  '}${fitModelLabel(option.label, nameWidth)}`;
  const used = displayWidth(label + effortText + tag);
  return [
    span(label, { ...labelStyle, ...selectedStyle }),
    span(effortText, { color: mutedColor(), bold: selected, ...selectedStyle }),
    span(tag, { color: 'gray', ...selectedStyle }),
    span(' '.repeat(Math.max(0, width - used)), selectedStyle),
  ];
}

function modelPickerItemLines(
  option: ModelPickerOptionRow,
  selected: boolean,
  effort: ReasoningEffort,
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
    const costWidth = 3;
    const modelWidth = Math.max(12, innerWidth - costWidth - 2);
    const row = [
      ...modelPickerModelSpans(
        option,
        selected,
        effort,
        modelWidth,
        false,
        labelStyle,
        selectedStyle,
      ),
      span('  ', selectedStyle),
      modelPickerCell(cost, costWidth, selectedStyle),
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
      effort,
      modelPickerModelWidth(innerWidth),
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
    return line(modelPickerCell('Model · effort', Math.max(1, innerWidth), heading));
  }
  return line(
    modelPickerCell('Model · effort', modelPickerModelWidth(innerWidth), heading),
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
  efforts: ProjectModelEfforts = {},
): TuiLine[] {
  const panelWidth = Math.max(28, Math.min(width, MODEL_PICKER_PANEL_MAX_WIDTH));
  const innerWidth = Math.max(1, panelWidth - 4);
  const showEffortDetails = options.length + 10 <= availableHeight;
  const fixedLineCount = showEffortDetails ? 10 : 7;
  const visibleCount = Math.min(options.length, Math.max(1, availableHeight - fixedLineCount));
  const firstVisible = Math.max(0, Math.min(selectedIndex - visibleCount + 1, options.length - visibleCount));
  const visibleOptions = options.slice(firstVisible, firstVisible + visibleCount);
  const compactBodyLineCount = visibleOptions.length + fixedLineCount;
  const spacerLineCount = Math.max(0, visibleOptions.length - 1);
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
  visibleOptions.forEach((option, index) => {
    body.push(...modelPickerItemLines(option, firstVisible + index === selectedIndex, projectModelEffort(efforts, option.publicId), innerWidth));
    if (useRowSpacing && index < visibleOptions.length - 1) {
      body.push(modelPickerPanelSideLine(plainLine(''), innerWidth));
    }
  });
  const selectedEffort = projectModelEffort(efforts, options[selectedIndex]?.publicId ?? 0);
  const effortChoices = REASONING_EFFORTS.map((effort) =>
    effort === selectedEffort ? `[${REASONING_EFFORT_LABELS[effort]}]` : REASONING_EFFORT_LABELS[effort],
  ).join('  ');
  const fullEffort = `Reasoning effort: ${effortChoices}`;
  const effortText = [...fullEffort].length <= innerWidth
    ? fullEffort
    : `Effort: ${REASONING_EFFORT_LABELS[selectedEffort]}  ←/→`;
  const fullHint = '↑/↓ model  •  ←/→ effort  •  Enter select/save  •  Esc cancel';
  const compactHint = '↑↓ · ←→ · Enter · Esc';
  const hint = [...fullHint].length <= innerWidth ? fullHint : compactHint;
  body.push(
    modelPickerDivider(panelWidth),
    modelPickerPanelSideLine(plainLine(fitLine(effortText, innerWidth), { color: 'cyan', bold: true }), innerWidth),
    ...(showEffortDetails ? [
      modelPickerPanelSideLine(plainLine(''), innerWidth),
      modelPickerPanelSideLine(plainLine(fitLine(REASONING_EFFORT_DESCRIPTIONS[selectedEffort], innerWidth), { color: 'gray' }), innerWidth),
      modelPickerPanelSideLine(plainLine(''), innerWidth),
    ] : []),
    modelPickerPanelSideLine(
      plainLine(fitLine(hint, innerWidth), { color: 'gray' }),
      innerWidth,
    ),
    plainLine(`╰${'─'.repeat(panelWidth - 2)}╯`, { color: MODEL_PICKER_BORDER_COLOR }),
  );
  return [...margin, ...body, ...margin];
}

const SHORTCUTS_PANEL_MAX_WIDTH = 96;
const SHORTCUTS_KEY_COLUMN_MIN = 10;

function shortcutsTopBorder(panelWidth: number): TuiLine {
  const fullTitle = ' TheGitAI - Keyboard & mouse ';
  const compactTitle = ' Shortcuts ';
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







export function buildShortcutsPanel(
  groups: ShortcutGroup[],
  width: number,
  availableHeight: number,
): TuiLine[] {
  const panelWidth = Math.max(28, Math.min(width, SHORTCUTS_PANEL_MAX_WIDTH));
  const innerWidth = Math.max(1, panelWidth - 4);
  const keyWidth = Math.max(
    SHORTCUTS_KEY_COLUMN_MIN,
    ...groups.flatMap((group) => group.rows.map((row) => displayWidth(row.keys))),
  );
  const side = (row: TuiLine) =>
    overlayPanelLine(row, innerWidth, MODEL_PICKER_BORDER_COLOR);
  const groupLines = (group: ShortcutGroup, spaced: boolean): TuiLine[] => [
    ...(spaced ? [side(plainLine(''))] : []),
    side(
      plainLine(fitLine(group.title, innerWidth), {
        color: MODEL_PICKER_ACCENT_COLOR,
        bold: true,
      }),
    ),
    ...group.rows.map((row) =>
      side(
        line(
          span(
            `  ${row.keys}${' '.repeat(Math.max(0, keyWidth - displayWidth(row.keys)))}  `,
            { bold: true },
          ),
          span(
            fitLine(row.description, Math.max(1, innerWidth - keyWidth - 4)),
            { color: 'gray' },
          ),
        ),
      ),
    ),
  ];

  const chromeRows = 4;
  const budget = Math.max(1, availableHeight - chromeRows);
  const spacedBody = groups.flatMap((group, index) => groupLines(group, index > 0));
  const plainBody = groups.flatMap((group) => groupLines(group, false));
  let body = spacedBody;
  let hidden = 0;
  if (spacedBody.length > budget) {



    body = plainBody;
    if (plainBody.length > budget) {
      body = [];
      hidden = groups.reduce((total, group) => total + group.rows.length, 0);
      for (const group of groups) {
        const whole = groupLines(group, false);
        if (body.length + whole.length <= budget) {
          body = [...body, ...whole];
          hidden -= group.rows.length;
          continue;
        }

        const room = budget - body.length - 1;
        if (room >= 1) {
          const kept = group.rows.slice(0, room);
          body = [...body, ...groupLines({ ...group, rows: kept }, false)];
          hidden -= kept.length;
        }
        break;
      }
    }
  }
  const hint =
    hidden > 0 ? `esc close  •  ${hidden} more in /help` : 'esc close';
  return [
    shortcutsTopBorder(panelWidth),
    ...body,
    plainLine(`├${'─'.repeat(panelWidth - 2)}┤`, {
      color: MODEL_PICKER_BORDER_COLOR,
    }),
    side(plainLine(fitLine(hint, innerWidth), { color: 'gray' })),
    plainLine(`╰${'─'.repeat(panelWidth - 2)}╯`, {
      color: MODEL_PICKER_BORDER_COLOR,
    }),
  ];
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
  hiddenCount: number,
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



  if (hiddenCount > 0) {
    body.push(
      commandPaletteSeparatorLine(innerWidth),
      modelPickerPanelSideLine(
        plainLine(`  ${hiddenCount} more  •  keep typing to narrow`, {
          color: 'gray',
          dim: true,
        }),
        innerWidth,
      ),
    );
  }
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



export function buildWorkingClockLine(
  state: Pick<ShellState, 'analyzingImages' | 'busyPausedAt'> & {
    generatingImage?: boolean;
  },
  elapsedSeconds: number,
): string {
  const elapsed = formatElapsedClock(elapsedSeconds);



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




export function approvalPanelInnerWidth(width: number): number {
  return Math.max(1, Math.max(24, Math.min(width, OVERLAY_PANEL_MAX_WIDTH)) - 4);
}

export function userInputPanelInnerWidth(width: number): number {
  return Math.max(
    1,
    Math.max(24, Math.min(width, USER_INPUT_PANEL_MAX_WIDTH)) - 4,
  );
}

export function approvalPaddingEnabled(height: number): boolean {
  return height >= APPROVAL_PADDING_MIN_ROWS;
}


export function approvalPreviewBudget(height: number): number {
  const chrome =
    APPROVAL_OVERLAY_CHROME_ROWS +
    (approvalPaddingEnabled(height) ? APPROVAL_PADDING_CHROME_ROWS : 0);
  return Math.max(
    APPROVAL_PREVIEW_MIN_ROWS,
    Math.min(APPROVAL_PREVIEW_MAX_ROWS, Math.floor(height / 2) - chrome),
  );
}




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

  firstVisibleRow: number;
  lastVisibleRow: number;
  lines: TuiLine[];

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
        userInputPanelInnerWidth(width),
        overlayPanelContentBudget(height),
      ),
      width,
      USER_INPUT_BORDER_COLOR,
      height,
      USER_INPUT_PANEL_MAX_WIDTH,
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



    const previewWindow = buildApprovalPreviewWindow(
      prompt,
      innerWidth,
      height,
      state.approvalScrollOffset ?? 0,
    );
    lines.push(...previewWindow.lines);



    if (padded) lines.push(plainLine(''));
    if (previewWindow.totalRows > previewWindow.lines.length) {
      lines.push(
        rightAlignedLine(approvalScrollStatusLine(previewWindow), innerWidth, {
          color: APPROVAL_SCROLL_STATUS_COLOR,
        }),
      );
      if (padded) lines.push(plainLine(''));
    }








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
  if (state.shortcutsOpen) {
    lines.push(...buildShortcutsPanel(buildShortcutGroups(), width, height));
  }
  if (state.modelPickerOpen) {
    const options = buildModelPickerOptions(state.currentModelId, state.serverModels);
    lines.push(
      ...buildModelPickerPanel(
        options,
        state.modelPickerIndex,
        width,
        height,
        state.modelPickerEfforts,
      ),
    );
  }
  if (state.jobsPickerOpen) {
    lines.push(...buildJobsPickerLines(state, width, height, nowMs));
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
      ...buildCommandPalettePanel(
        suggestions,
        state.commandCursor,
        getHiddenSlashCommandCount(state.input),
        width,
      ),
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
  const contentWidth = frameContentWidth(cols);
  const liveRows = buildLiveLines(
    state,
    contentWidth,
    spinnerFrame,
    elapsedSeconds,
    nowMs,
  ).length;
  const overlayHeight = Math.max(
    0,
    rows - liveRows - composerFooterLines(state, contentWidth).length,
  );
  return {
    width: userInputPanelInnerWidth(contentWidth),
    maxRows: overlayPanelContentBudget(overlayHeight),
  };
}













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
  const contentWidth = frameContentWidth(cols);
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








  if (
    !state.resumePickerOpen &&
    !state.modelPickerOpen &&
    !state.jobsPickerOpen &&
    !state.shortcutsOpen &&
    !overlayActive
  ) {
    const composerLines: TuiLine[] = [];



    if (state.busy && state.status === 'Starting a new conversation...') {
      composerLines.push(
        line(span('Starting a new conversation…', { color: 'gray', dim: true })),
      );
    } else if (state.queuedMessage) {




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
      const promptLabel = composerPromptLabel(state);
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
      lines: [...composerLines, plainLine(''), ...composerFooterLines(state, contentWidth)],
    });
  }
  if (state.userInputPrompt) {
    sections.push({
      kind: 'busyFooter',
      lines: composerFooterLines(state, contentWidth),
    });
  }











  const overlayHeight = state.userInputPrompt
    ? Math.max(0, rows - countSectionLines(sections))
    : state.jobsPickerOpen || state.shortcutsOpen || state.modelPickerOpen
      ? Math.max(
          Math.min(rows, JOBS_PICKER_MIN_ROWS),
          rows - countSectionLines(sections),
        )
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



  const composerReserve =
    state.resumePickerOpen ||
    state.approvalPrompt ||
    state.sudoPrompt ||
    state.userInputPrompt
      ? 0
      : 4;
  const transcriptBudget = Math.max(1, rows - reservedLines - composerReserve - 1);
  let transcriptScrollLimit = Math.max(0, transcriptLines.length - transcriptBudget);




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
