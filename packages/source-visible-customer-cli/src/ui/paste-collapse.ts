export interface PastedChunk {
  placeholder: string;
  text: string;
}

const PASTE_LINE_THRESHOLD = 5;
const PASTE_CHAR_THRESHOLD = 200;

export function shouldCollapsePaste(text: string): boolean {
  return (
    text.split('\n').length > PASTE_LINE_THRESHOLD ||
    text.length > PASTE_CHAR_THRESHOLD
  );
}

export function buildPastePlaceholder(text: string, id: number): string {
  const lineCount = text.split('\n').length;
  const label =
    lineCount > PASTE_LINE_THRESHOLD
      ? `${lineCount} lines`
      : `${text.length} chars`;
  return id === 1
    ? `[Pasted Text: ${label}]`
    : `[Pasted Text: ${label} #${id}]`;
}

export function expandPastedChunks(
  input: string,
  chunks: readonly PastedChunk[],
): string {
  let result = input;
  for (const chunk of chunks) {
    result = result.replace(chunk.placeholder, () => chunk.text);
  }
  return result;
}
