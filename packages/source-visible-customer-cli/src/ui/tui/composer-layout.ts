




export const COMPOSER_PROMPT_LABEL_IDLE = '❯ ';
export const COMPOSER_PROMPT_LABEL_BUSY = 'queue> ';

export function composerPromptLabel(state: { busy: boolean }): string {
  return state.busy ? COMPOSER_PROMPT_LABEL_BUSY : COMPOSER_PROMPT_LABEL_IDLE;
}




export function frameContentWidth(cols: number): number {
  return Math.max(20, Math.floor(cols * 0.95) - 2);
}

export function composerInputWidth(
  cols: number,
  state: { busy: boolean },
): number {
  return Math.max(1, frameContentWidth(cols) - composerPromptLabel(state).length);
}

interface ComposerRow {
  cursorOffsets: number[];
  text: string;
}

interface ComposerLayout {
  cursorCol: number;
  cursorRow: number;
  rows: ComposerRow[];
}

function buildComposerLayout(
  input: string,
  cursor: number,
  width: number,
): ComposerLayout {
  const safeWidth = Math.max(1, width);
  const normalizedCursor = Math.min(Math.max(cursor, 0), input.length);
  const rows: ComposerRow[] = [{ cursorOffsets: [0], text: '' }];
  let cursorRow = 0;
  let cursorCol = 0;
  let capturedCursor = false;

  const currentRow = () => rows[rows.length - 1]!;
  const addRow = (offset: number) => {
    rows.push({ cursorOffsets: [offset], text: '' });
  };
  const captureCursor = () => {
    if (capturedCursor) return;
    if (currentRow().text.length >= safeWidth) {
      addRow(normalizedCursor);
    }
    cursorRow = rows.length - 1;
    cursorCol = currentRow().text.length;
    capturedCursor = true;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    if (
      char !== '\n' &&
      char !== '\r' &&
      currentRow().text.length >= safeWidth
    ) {
      addRow(index);
    }
    if (index === normalizedCursor) {
      captureCursor();
    }
    if (char === '\r') {
      currentRow().cursorOffsets[currentRow().text.length] = index + 1;
      continue;
    }
    if (char === '\n') {


      currentRow().cursorOffsets[currentRow().text.length] =
        input[index - 1] === '\r' ? index - 1 : index;
      addRow(index + 1);
      continue;
    }
    currentRow().text += char;
    currentRow().cursorOffsets.push(index + 1);
  }

  if (!capturedCursor) {
    captureCursor();
  }

  return { cursorCol, cursorRow, rows };
}

export function splitComposerInput(
  input: string,
  cursor: number,
  width: number,
): { cursorCol: number; cursorRow: number; rows: string[] } {
  const layout = buildComposerLayout(input, cursor, width);
  return {
    cursorCol: layout.cursorCol,
    cursorRow: layout.cursorRow,
    rows: layout.rows.map((row) => row.text),
  };
}

export function moveComposerCursorVertically(
  input: string,
  cursor: number,
  width: number,
  direction: -1 | 1,
): number | null {
  const layout = buildComposerLayout(input, cursor, width);
  const targetRow = layout.rows[layout.cursorRow + direction];
  if (!targetRow) return null;
  const targetCol = Math.min(layout.cursorCol, targetRow.text.length);
  return targetRow.cursorOffsets[targetCol] ?? null;
}
