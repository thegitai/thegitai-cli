import type {
  UserInputQuestion,
  UserInputResult,
} from '../../api/contracts.js';
import {
  displayWidth,
  line,
  plainLine,
  sliceToWidth,
  span,
  wrapText,
} from './text.js';
import type { TuiLine } from './types.js';

const OTHER_CURSOR = '$other';
const SUBMIT_CURSOR = '$submit';
const ACCENT_COLOR = 'cyan';
const SCROLL_PAGE_ROWS = 4;

type UserInputCursor = string;

export interface UserInputPromptState {
  questions: UserInputQuestion[];
  questionId: string;
  cursorByQuestionId: Record<string, UserInputCursor>;
  selectedOptionIds: Record<string, string[]>;
  customText: Record<string, string>;
  contentScrollAnchor: UserInputCursor | null;
  contentScrollOffset: number;
  noteOpen: boolean;
  noteCursor: number;
  returnStatus: string;
  validationMessage: string;
}

export interface UserInputViewport {
  width: number;
  maxRows: number;
}

export type UserInputPromptEvent =
  | { kind: 'paste'; text: string }
  | {
      kind: 'key';
      input: string;
      ctrl: boolean;
      meta: boolean;
      shift: boolean;
      escape: boolean;
      returnKey: boolean;
      tab: boolean;
      backspace: boolean;
      delete: boolean;
      upArrow: boolean;
      downArrow: boolean;
      leftArrow: boolean;
      rightArrow: boolean;
      home: boolean;
      end: boolean;
      pageUp: boolean;
      pageDown: boolean;
    };

export interface UserInputPromptEventResult {
  state: UserInputPromptState;
  result?: UserInputResult;
}

function currentQuestion(state: UserInputPromptState): UserInputQuestion {
  return (
    state.questions.find((question) => question.id === state.questionId) ??
    state.questions[0]!
  );
}

function questionIndex(state: UserInputPromptState): number {
  return Math.max(
    0,
    state.questions.findIndex((question) => question.id === state.questionId),
  );
}

function defaultCursor(question: UserInputQuestion): UserInputCursor {
  return question.options[0]?.id ?? OTHER_CURSOR;
}

function cursorForQuestion(
  state: UserInputPromptState,
  question: UserInputQuestion,
): UserInputCursor {
  return state.cursorByQuestionId[question.id] ?? defaultCursor(question);
}

function cursorRows(
  state: UserInputPromptState,
  question: UserInputQuestion,
): UserInputCursor[] {
  const rows = [...question.options.map((option) => option.id), OTHER_CURSOR];
  if (questionIndex(state) === state.questions.length - 1) {
    rows.push(SUBMIT_CURSOR);
  }
  return rows;
}

function setQuestion(
  state: UserInputPromptState,
  index: number,
): UserInputPromptState {
  const question = state.questions[index];
  if (!question) return state;
  return {
    ...state,
    questionId: question.id,
    contentScrollAnchor: null,
    contentScrollOffset: 0,
    noteOpen: false,
    noteCursor: (state.customText[question.id] ?? '').length,
    validationMessage: '',
  };
}

function setCursor(
  state: UserInputPromptState,
  question: UserInputQuestion,
  cursor: UserInputCursor,
): UserInputPromptState {
  return {
    ...state,
    contentScrollAnchor: cursor,
    cursorByQuestionId: {
      ...state.cursorByQuestionId,
      [question.id]: cursor,
    },
    validationMessage: '',
  };
}

function moveCursor(
  state: UserInputPromptState,
  delta: number,
): UserInputPromptState {
  const question = currentQuestion(state);
  const rows = cursorRows(state, question);
  const current = cursorForQuestion(state, question);
  const index = Math.max(0, rows.indexOf(current));
  const next = Math.max(0, Math.min(index + delta, rows.length - 1));
  return setCursor(state, question, rows[next]!);
}

function selectedIds(
  state: UserInputPromptState,
  question: UserInputQuestion,
): string[] {
  return state.selectedOptionIds[question.id] ?? [];
}

function selectOption(
  state: UserInputPromptState,
  optionId: string,
): UserInputPromptState {
  const question = currentQuestion(state);
  const current = selectedIds(state, question);
  const nextSelected = question.multiSelect
    ? current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : question.options
          .map((option) => option.id)
          .filter((id) => id === optionId || current.includes(id))
    : [optionId];
  let next: UserInputPromptState = {
    ...setCursor(state, question, optionId),
    selectedOptionIds: {
      ...state.selectedOptionIds,
      [question.id]: nextSelected,
    },
    customText: question.multiSelect
      ? state.customText
      : {
          ...state.customText,
          [question.id]: '',
        },
  };
  if (!question.multiSelect) {
    const index = questionIndex(state);
    next =
      index < state.questions.length - 1
        ? setQuestion(next, index + 1)
        : setCursor(next, question, SUBMIT_CURSOR);
  }
  return next;
}

function normalizeNoteText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
}

function previousCharacterBoundary(value: string, cursor: number): number {
  const previous = Array.from(value.slice(0, cursor)).at(-1);
  return previous ? cursor - previous.length : 0;
}

function nextCharacterBoundary(value: string, cursor: number): number {
  const next = Array.from(value.slice(cursor))[0];
  return next ? cursor + next.length : value.length;
}

function openCustomTextEditor(
  state: UserInputPromptState,
): UserInputPromptState {
  const question = currentQuestion(state);
  return {
    ...setCursor(state, question, OTHER_CURSOR),
    selectedOptionIds: question.multiSelect
      ? state.selectedOptionIds
      : {
          ...state.selectedOptionIds,
          [question.id]: [],
        },
    noteOpen: true,
    noteCursor: (state.customText[question.id] ?? '').length,
  };
}

function insertNote(
  state: UserInputPromptState,
  insertedText: string,
): UserInputPromptState {
  const nextState = openCustomTextEditor(state);
  const question = currentQuestion(nextState);
  const current = nextState.customText[question.id] ?? '';
  const inserted = normalizeNoteText(insertedText);
  if (!inserted) {
    return nextState;
  }
  const noteCursor = Math.max(
    0,
    Math.min(nextState.noteCursor, current.length),
  );
  const nextText = `${current.slice(0, noteCursor)}${inserted}${current.slice(noteCursor)}`;
  return {
    ...nextState,
    customText: {
      ...nextState.customText,
      [question.id]: nextText,
    },
    noteCursor: noteCursor + inserted.length,
  };
}

function editOpenNote(
  state: UserInputPromptState,
  event: Extract<UserInputPromptEvent, { kind: 'key' }>,
): UserInputPromptState {
  const question = currentQuestion(state);
  const current = state.customText[question.id] ?? '';
  const cursor = Math.max(0, Math.min(state.noteCursor, current.length));
  if (event.escape || event.returnKey) {
    return { ...state, noteOpen: false };
  }
  if (event.tab) return state;
  if ((event.upArrow || event.downArrow) && !current.trim()) {
    return moveCursor(
      {
        ...state,
        customText: {
          ...state.customText,
          [question.id]: '',
        },
        noteOpen: false,
        noteCursor: 0,
      },
      event.upArrow ? -1 : 1,
    );
  }
  if (event.leftArrow) {
    return {
      ...state,
      noteCursor: previousCharacterBoundary(current, cursor),
    };
  }
  if (event.rightArrow) {
    return {
      ...state,
      noteCursor: nextCharacterBoundary(current, cursor),
    };
  }
  if (event.home) {
    return { ...state, noteCursor: 0 };
  }
  if (event.end) {
    return { ...state, noteCursor: current.length };
  }
  if (event.backspace && cursor > 0) {
    const previous = previousCharacterBoundary(current, cursor);
    return {
      ...state,
      customText: {
        ...state.customText,
        [question.id]: `${current.slice(0, previous)}${current.slice(cursor)}`,
      },
      noteCursor: previous,
    };
  }
  if (event.delete && cursor < current.length) {
    const next = nextCharacterBoundary(current, cursor);
    return {
      ...state,
      customText: {
        ...state.customText,
        [question.id]: `${current.slice(0, cursor)}${current.slice(next)}`,
      },
    };
  }
  if (!event.ctrl && !event.meta && event.input) {
    return insertNote(state, event.input);
  }
  return state;
}

function questionAnswered(
  state: UserInputPromptState,
  question: UserInputQuestion,
): boolean {
  return (
    selectedIds(state, question).length > 0 ||
    Boolean((state.customText[question.id] ?? '').trim())
  );
}

function submitResult(state: UserInputPromptState): UserInputPromptEventResult {
  const missing = state.questions.find((question) => !questionAnswered(state, question));
  if (missing) {
    const next = setQuestion(state, state.questions.indexOf(missing));
    return {
      state: {
        ...next,
        validationMessage: 'Choose an option or add details before submitting.',
      },
    };
  }
  return {
    state,
    result: {
      status: 'submitted',
      answers: Object.fromEntries(
        state.questions.map((question) => {
          const customText = (state.customText[question.id] ?? '').trim();
          return [
            question.id,
            {
              selectedOptionIds: selectedIds(state, question),
              ...(customText ? { customText } : {}),
            },
          ];
        }),
      ),
    },
  };
}

export function createUserInputPromptState(
  questions: UserInputQuestion[],
  returnStatus: string,
): UserInputPromptState {
  const first = questions[0]!;
  return {
    questions,
    questionId: first.id,
    cursorByQuestionId: Object.fromEntries(
      questions.map((question) => [question.id, defaultCursor(question)]),
    ),
    selectedOptionIds: Object.fromEntries(
      questions.map((question) => [question.id, []]),
    ),
    customText: Object.fromEntries(
      questions.map((question) => [question.id, '']),
    ),
    contentScrollAnchor: null,
    contentScrollOffset: 0,
    noteOpen: false,
    noteCursor: 0,
    returnStatus,
    validationMessage: '',
  };
}

export function handleUserInputPromptEvent(
  state: UserInputPromptState,
  event: UserInputPromptEvent,
  viewport?: UserInputViewport,
): UserInputPromptEventResult {
  const visibleState = viewport
    ? normalizeUserInputScrollState(state, viewport)
    : state;
  if (event.kind === 'paste') {
    return {
      state:
        visibleState.noteOpen ||
        cursorForQuestion(visibleState, currentQuestion(visibleState)) ===
          OTHER_CURSOR
          ? insertNote(visibleState, event.text)
          : visibleState,
    };
  }
  if (event.pageUp || event.pageDown) {
    if (!viewport) {
      return {
        state: {
          ...visibleState,
          contentScrollAnchor: null,
          contentScrollOffset:
            visibleState.contentScrollOffset +
            (event.pageUp ? -SCROLL_PAGE_ROWS : SCROLL_PAGE_ROWS),
        },
      };
    }
    const window = buildUserInputWindow(
      visibleState,
      viewport.width,
      viewport.maxRows,
    );
    return {
      state: {
        ...visibleState,
        contentScrollAnchor: null,
        contentScrollOffset: Math.max(
          0,
          Math.min(
            window.offset +
              (event.pageUp ? -SCROLL_PAGE_ROWS : SCROLL_PAGE_ROWS),
            window.maxOffset,
          ),
        ),
      },
    };
  }
  if (visibleState.noteOpen) {
    return { state: editOpenNote(visibleState, event) };
  }
  if (event.escape) {
    return { state: visibleState, result: { status: 'cancelled' } };
  }
  if (event.upArrow || event.downArrow) {
    return {
      state: moveCursor(visibleState, event.upArrow ? -1 : 1),
    };
  }
  if (event.leftArrow) {
    return {
      state: setQuestion(visibleState, questionIndex(visibleState) - 1),
    };
  }
  if (event.rightArrow) {
    const index = questionIndex(visibleState);
    if (index < visibleState.questions.length - 1) {
      return { state: setQuestion(visibleState, index + 1) };
    }
    return {
      state: setCursor(
        visibleState,
        currentQuestion(visibleState),
        SUBMIT_CURSOR,
      ),
    };
  }
  const question = currentQuestion(visibleState);
  const numberedRow = /^[1-5]$/.test(event.input)
    ? Number(event.input)
    : 0;
  if (numberedRow && !event.ctrl && !event.meta) {
    if (numberedRow === question.options.length + 1) {
      return {
        state: openCustomTextEditor(visibleState),
      };
    }
    const numberedOption = question.options[numberedRow - 1];
    if (numberedOption) {
      return { state: selectOption(visibleState, numberedOption.id) };
    }
  }
  if (event.returnKey) {
    const cursor = cursorForQuestion(visibleState, question);
    if (cursor === OTHER_CURSOR) {
      return {
        state: openCustomTextEditor(visibleState),
      };
    }
    if (cursor === SUBMIT_CURSOR) {
      return submitResult(visibleState);
    }
    return { state: selectOption(visibleState, cursor) };
  }
  if (
    !event.ctrl &&
    !event.meta &&
    event.input &&
    event.input >= ' ' &&
    cursorForQuestion(visibleState, currentQuestion(visibleState)) ===
      OTHER_CURSOR
  ) {
    return { state: insertNote(visibleState, event.input) };
  }
  return { state: visibleState };
}

function noteInputLine(state: UserInputPromptState, width: number): TuiLine {
  const question = currentQuestion(state);
  const text = state.customText[question.id] ?? '';
  const cursor = Math.max(0, Math.min(state.noteCursor, text.length));
  const characters = Array.from(text);
  const characterCursor = Array.from(text.slice(0, cursor)).length;
  const available = Math.max(8, width - 8);
  const windowStart = Math.max(0, characterCursor - available + 1);
  const visible = characters.slice(windowStart, windowStart + available);
  const visibleCursor = characterCursor - windowStart;
  return line(
    span('    › ', { color: ACCENT_COLOR }),
    span(visible.slice(0, visibleCursor).join('')),
    span(visible[visibleCursor] ?? ' ', { inverse: true }),
    span(visible.slice(visibleCursor + 1).join('')),
  );
}

function sliceWithinWidth(text: string, width: number): string {
  if (width <= 0) return '';
  let result = sliceToWidth(text, width);
  while (result && displayWidth(result) > width) {
    result = Array.from(result).slice(0, -1).join('');
  }
  return result;
}

function fitText(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  if (width === 1) return '…';
  return `${sliceWithinWidth(text, width - 1).trimEnd()}…`;
}

function clipLineToWidth(row: TuiLine, width: number): TuiLine {
  let remaining = Math.max(0, width);
  const spans = [];
  for (const item of row.spans) {
    if (remaining <= 0) break;
    const text = sliceWithinWidth(item.text, remaining);
    if (text) spans.push({ ...item, text });
    remaining -= displayWidth(text);
  }
  return { spans };
}

interface UserInputContent {
  anchorRange: { start: number; end: number } | null;
  lines: TuiLine[];
}

interface UserInputWindow {
  lines: TuiLine[];
  maxOffset: number;
  offset: number;
}

function buildUserInputContent(
  state: UserInputPromptState,
  width: number,
): UserInputContent {
  const question = currentQuestion(state);
  const index = questionIndex(state);
  const cursor = cursorForQuestion(state, question);
  const selected = new Set(selectedIds(state, question));
  let anchorRange: UserInputContent['anchorRange'] = null;
  const progress = `Question ${index + 1} of ${state.questions.length}`;
  const headerPrefix = ' · ';
  const headerBudget = Math.max(
    0,
    width - displayWidth(progress) - displayWidth(headerPrefix),
  );
  const lines: TuiLine[] = [
    line(
      span(progress, {
        color: ACCENT_COLOR,
        bold: true,
      }),
      ...(headerBudget > 0
        ? [
            span(
              `${headerPrefix}${fitText(question.header, headerBudget)}`,
              { color: 'gray' },
            ),
          ]
        : []),
    ),
    plainLine(''),
    ...wrapText(question.question, width).map((text) =>
      plainLine(text, { bold: true }),
    ),
    plainLine(''),
  ];
  question.options.forEach((option, optionIndex) => {
    const focused = cursor === option.id;
    const checked = selected.has(option.id);
    const marker = question.multiSelect
      ? checked
        ? '[x]'
        : '[ ]'
      : checked
        ? '●'
        : '○';
    const blockStart = lines.length;
    const optionPrefix = `${optionIndex + 1}. ${marker} `;
    const recommendation =
      option.id === question.recommendedOptionId ? '  Recommended' : '';
    const labelBudget = Math.max(
      1,
      width -
        displayWidth('› ') -
        displayWidth(optionPrefix) -
        displayWidth(recommendation),
    );
    lines.push(
      line(
        span(focused ? '› ' : '  ', {
          color: focused ? ACCENT_COLOR : 'gray',
        }),
        span(`${optionPrefix}${fitText(option.label, labelBudget)}`, {
          color: focused ? ACCENT_COLOR : undefined,
          bold: focused,
        }),
        ...(recommendation
          ? [span(recommendation, { color: 'green' })]
          : []),
      ),
    );
    for (const description of wrapText(
      option.description,
      Math.max(8, width - 5),
    )) {
      lines.push(plainLine(`     ${description}`, { color: 'gray' }));
    }
    if (state.contentScrollAnchor === option.id) {
      anchorRange = { start: blockStart, end: lines.length - 1 };
    }
  });
  const customText = (state.customText[question.id] ?? '').trim();
  const otherFocused = cursor === OTHER_CURSOR;
  const otherAnswered = Boolean(customText);
  const otherMarker = question.multiSelect
    ? otherAnswered
      ? '[x]'
      : '[ ]'
    : otherAnswered
      ? '●'
      : '○';
  const otherNumber = question.options.length + 1;
  const otherStart = lines.length;
  lines.push(plainLine(''));
  lines.push(
    line(
      span(otherFocused ? '› ' : '  ', {
        color: otherFocused ? ACCENT_COLOR : 'gray',
      }),
      span(`${otherNumber}. ${otherMarker} Something else / add details`, {
        color: otherFocused ? ACCENT_COLOR : undefined,
        bold: otherFocused,
      }),
      ...(customText && !state.noteOpen
        ? [
            span(
              ` · ${Array.from(customText)
                .slice(0, Math.max(8, width - 28))
                .join('')}`,
              { color: 'gray' },
            ),
          ]
        : otherFocused && !state.noteOpen
          ? [span(' · Type details…', { color: 'gray', dim: true })]
          : []),
    ),
  );
  if (state.noteOpen) {
    lines.push(noteInputLine(state, width));
  }
  lines.push(plainLine(''));
  if (state.contentScrollAnchor === OTHER_CURSOR) {
    anchorRange = { start: otherStart, end: lines.length - 1 };
  }
  if (index === state.questions.length - 1) {
    const submitStart = lines.length - 1;
    lines.push(
      line(
        span(cursor === SUBMIT_CURSOR ? '› ' : '  ', {
          color: cursor === SUBMIT_CURSOR ? ACCENT_COLOR : 'gray',
        }),
        span('Submit answers', {
          color: cursor === SUBMIT_CURSOR ? ACCENT_COLOR : undefined,
          bold: cursor === SUBMIT_CURSOR,
        }),
      ),
    );
    lines.push(plainLine(''));
    if (state.contentScrollAnchor === SUBMIT_CURSOR) {
      anchorRange = { start: submitStart, end: lines.length - 1 };
    }
  }
  if (state.validationMessage) {
    lines.push(plainLine(state.validationMessage, { color: 'yellow' }));
  }
  lines.push(
    plainLine(
      state.noteOpen
        ? 'Type a single-line note • ↑/↓ moves when empty • Enter saves • Esc closes • PgUp/PgDn scroll'
        : question.multiSelect
          ? `↑/↓ move • 1–${otherNumber} choose • Enter toggles/edits • ←/→ questions • PgUp/PgDn scroll • Esc cancels`
          : `↑/↓ move • 1–${otherNumber} choose • Enter selects/edits • ←/→ questions • PgUp/PgDn scroll • Esc cancels`,
      { color: 'gray' },
    ),
  );
  return {
    anchorRange,
    lines: lines.map((row) => clipLineToWidth(row, width)),
  };
}

function buildUserInputWindow(
  state: UserInputPromptState,
  width: number,
  maxRows: number,
): UserInputWindow {
  const content = buildUserInputContent(state, width);
  if (!Number.isFinite(maxRows) || content.lines.length <= maxRows) {
    return { lines: content.lines, maxOffset: 0, offset: 0 };
  }
  const rowBudget = Math.max(1, Math.floor(maxRows));
  const visibleRowBudget = rowBudget === 1 ? 1 : rowBudget - 1;
  const maxOffset = Math.max(0, content.lines.length - visibleRowBudget);
  let offset = Math.max(
    0,
    Math.min(state.contentScrollOffset, maxOffset),
  );
  const range = content.anchorRange;
  if (range) {
    const blockRows = range.end - range.start + 1;
    if (blockRows <= visibleRowBudget) {
      if (range.start < offset) {
        offset = range.start;
      } else if (range.end >= offset + visibleRowBudget) {
        offset = range.end - visibleRowBudget + 1;
      }
    } else if (
      range.start < offset ||
      range.start >= offset + visibleRowBudget
    ) {
      offset = range.start;
    }
    offset = Math.max(0, Math.min(offset, maxOffset));
  }
  const visible = content.lines.slice(
    offset,
    offset + visibleRowBudget,
  );
  if (rowBudget === 1) {
    return { lines: visible, maxOffset, offset };
  }
  return {
    lines: [
      ...visible,
      plainLine(
        fitText(
          `Rows ${offset + 1}–${offset + visible.length} of ${content.lines.length} · PgUp/PgDn scroll`,
          width,
        ),
        { color: 'gray' },
      ),
    ],
    maxOffset,
    offset,
  };
}

export function normalizeUserInputScrollState(
  state: UserInputPromptState,
  viewport: UserInputViewport,
): UserInputPromptState {
  const window = buildUserInputWindow(
    state,
    viewport.width,
    viewport.maxRows,
  );
  return window.offset === state.contentScrollOffset
    ? state
    : { ...state, contentScrollOffset: window.offset };
}

export function buildUserInputOverlayLines(
  state: UserInputPromptState,
  width: number,
  maxRows = Number.POSITIVE_INFINITY,
): TuiLine[] {
  return buildUserInputWindow(state, width, maxRows).lines;
}

export function formatUserInputTranscript(
  questions: UserInputQuestion[],
  result: UserInputResult,
): string {
  if (result.status === 'cancelled') {
    return 'Cancelled without answers.';
  }
  return questions
    .map((question) => {
      const answer = result.answers[question.id];
      const selected = question.options
        .filter((option) => answer?.selectedOptionIds.includes(option.id))
        .map((option) => option.label);
      const values = [
        ...selected,
        ...(answer?.customText ? [answer.customText] : []),
      ];
      return `${question.header} · ${question.question}\n  ${values.join(', ')}`;
    })
    .join('\n');
}
