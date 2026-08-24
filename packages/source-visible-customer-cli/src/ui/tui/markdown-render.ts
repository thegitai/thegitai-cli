import {
  displayWidth,
  line,
  padToWidth,
  plainLine,
  sliceToWidth,
  span,
  wrapText,
  wrapToWidth,
} from './text.js';
import type { TuiLine, TuiSpan } from './types.js';

export type TranscriptKind =
  | 'assistant'
  | 'diff'
  | 'error'
  | 'system'
  | 'tool'
  | 'user';

interface MarkdownTableModel {
  columnWidths: number[];
  headers: string[];
  rows: string[][];
}

interface ParsedMarkdownTableBlock {
  nextIndex: number;
  table: MarkdownTableModel;
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

interface InlineSegment {
  kind: 'bold' | 'code' | 'link' | 'text';
  text: string;
  url?: string;
}

const MIN_TABLE_COLUMN_WIDTH = 3;

// Every rendered row — border or data — is `sum(columnWidths) + 3n + 1` columns
// wide: one leading '│', then per column a leading space, the cell, a trailing
// space and a closing '│'. Border rows join per-column segments with ┬/┼/┴ and
// come out to exactly the same width.
function tableRowOverhead(columnCount: number): number {
  return 3 * columnCount + 1;
}

function parseInlineSegments(text: string): InlineSegment[] {
  const source = String(text ?? '');
  const segments: InlineSegment[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    if (source[cursor] === '[' && source[cursor - 1] !== '!') {
      const labelEnd = source.indexOf('](', cursor + 1);
      const urlEnd = labelEnd === -1 ? -1 : source.indexOf(')', labelEnd + 2);
      if (labelEnd > cursor + 1 && urlEnd > labelEnd + 2) {
        const url = normalizeLinkUrl(source.slice(labelEnd + 2, urlEnd));
        if (url) {
          const label = source.slice(cursor + 1, labelEnd);
          segments.push({ kind: 'link', text: label || url, url });
          cursor = urlEnd + 1;
          continue;
        }
      }
    }
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
    const nextLink = source.indexOf('[', cursor);
    if (nextBold !== -1) nextCursor = Math.min(nextCursor, nextBold);
    if (nextCode !== -1) nextCursor = Math.min(nextCursor, nextCode);
    if (nextLink !== -1) nextCursor = Math.min(nextCursor, nextLink);
    if (nextCursor === cursor) nextCursor += 1;
    segments.push({ kind: 'text', text: source.slice(cursor, nextCursor) });
    cursor = nextCursor;
  }

  return segments.filter((segment) => segment.text.length > 0);
}

function normalizeLinkUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
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
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}

function fitTableColumnWidths(columnWidths: number[], maxWidth: number): number[] {
  const columnCount = columnWidths.length;
  if (columnCount === 0) return [];
  const natural = columnWidths.map((width) => Math.max(1, Math.floor(width)));
  const budget = Math.floor(maxWidth) - tableRowOverhead(columnCount);
  const total = natural.reduce((sum, width) => sum + width, 0);
  if (budget >= total) return natural;

  const floorWidth = Math.max(
    1,
    Math.min(MIN_TABLE_COLUMN_WIDTH, Math.floor(budget / columnCount)),
  );
  const widths = natural.map((width) => Math.min(width, floorWidth));
  let used = widths.reduce((sum, width) => sum + width, 0);
  if (used > budget) {
    // Too narrow even for the floor (many columns in a tiny terminal): give each
    // column an equal slice rather than overflowing the terminal.
    const share = Math.max(1, Math.floor(budget / columnCount));
    for (let index = 0; index < columnCount; index++) widths[index] = share;
    used = share * columnCount;
  }
  let remaining = budget - used;
  while (remaining > 0) {
    let grew = false;
    for (let index = 0; index < columnCount && remaining > 0; index++) {
      if (widths[index]! >= natural[index]!) continue;
      widths[index]!++;
      remaining--;
      grew = true;
    }
    if (!grew) break;
  }
  return widths;
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
  if (headers.length !== separators.length) return null;
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
      MIN_TABLE_COLUMN_WIDTH,
      ...values.map((value) => displayWidth(stripInlineFormattingForWidth(value))),
    );
  });
  return {
    nextIndex,
    table: { columnWidths, headers: normalizedHeaders, rows },
  };
}

function splitFormattedLines(body: string): FormattedLine[] {
  const lines = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const formatted: FormattedLine[] = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index++) {
    const lineText = lines[index] ?? '';
    const trimmed = lineText.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      formatted.push({ kind: 'code', text: lineText });
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
    formatted.push({ kind: 'paragraph', text: lineText });
  }

  return formatted;
}

function segmentStyle(
  segment: InlineSegment,
  bodyColor: string | undefined,
): Partial<Omit<TuiSpan, 'text'>> {
  if (segment.kind === 'bold') {
    return { color: bodyColor, bold: true };
  }
  if (segment.kind === 'code') {
    return { color: 'cyan' };
  }
  if (segment.kind === 'link') {
    return { color: 'cyan', underline: true, linkUrl: segment.url };
  }
  return { color: bodyColor };
}

function styleFromSpan(part: TuiSpan): Partial<Omit<TuiSpan, 'text'>> {
  const { text, ...style } = part;
  void text;
  return style;
}

function wrapInlineToLines(
  text: string,
  width: number,
  bodyColor: string | undefined,
  prefix = '',
): TuiLine[] {
  const safeWidth = Math.max(1, width);
  const indent = prefix ? span(prefix, { color: 'gray' }) : null;
  const indentSpaces = prefix ? span(' '.repeat(prefix.length), { color: 'gray' }) : null;
  const segments = parseInlineSegments(text);
  const rows: TuiSpan[][] = [[]];
  let rowWidth = 0;

  const startRow = () => {
    rows.push([]);
    rowWidth = 0;
  };

  // Widths here are terminal columns, not UTF-16 units: measuring with .length
  // let a paragraph of CJK or emoji emit rows wider than the frame allowed for.
  const appendSpan = (part: TuiSpan) => {
    let current = rows[rows.length - 1]!;
    let remaining = part.text;
    while (remaining.length > 0) {
      const limit =
        safeWidth - (rows.length === 1 && indent ? displayWidth(prefix) : 0);
      const room = limit - rowWidth;
      if (room <= 0) {
        startRow();
        current = rows[rows.length - 1]!;
        continue;
      }
      const width = displayWidth(remaining);
      if (width <= room) {
        current.push(span(remaining, styleFromSpan(part)));
        rowWidth += width;
        remaining = '';
        break;
      }
      // Prefer moving the whole token to the next line instead of slicing a word
      // mid-way through the remaining room on this row.
      if (rowWidth > 0) {
        if (/^\s+$/.test(remaining)) {
          remaining = '';
          break;
        }
        startRow();
        current = rows[rows.length - 1]!;
        continue;
      }
      // Token is wider than the full line — hard-break as a last resort.
      const head = sliceToWidth(remaining, room);
      if (!head || (displayWidth(head) > room && current.length > 0)) {
        startRow();
        current = rows[rows.length - 1]!;
        continue;
      }
      current.push(span(head, styleFromSpan(part)));
      remaining = remaining.slice(head.length);
      startRow();
      current = rows[rows.length - 1]!;
    }
  };

  for (const segment of segments) {
    const style = segmentStyle(segment, bodyColor);
    const tokens = segment.text.split(/(\s+)/).filter((token) => token.length > 0);
    for (const token of tokens) {
      appendSpan(span(token, style));
    }
  }

  return rows.map((spans, index) => {
    const bodySpans = spans.length > 0 ? spans : [span(' ', {})];
    if (indent && index === 0) return line(indent, ...bodySpans);
    if (indentSpaces) return line(indentSpaces, ...bodySpans);
    return line(...bodySpans);
  });
}

function renderTableLines(table: MarkdownTableModel, width: number): TuiLine[] {
  const columnWidths = fitTableColumnWidths(table.columnWidths, width);
  const border = (left: string, joint: string, right: string): TuiLine =>
    line(
      span(
        left +
          columnWidths.map((colWidth) => '─'.repeat(colWidth + 2)).join(joint) +
          right,
        { color: 'cyan', dim: true },
      ),
    );
  // Cells wrap within their column instead of being sliced to fit, so a long cell
  // grows the row downwards rather than losing its tail. The row is as tall as its
  // tallest cell; shorter cells pad with blanks. Data rows carry the same interior
  // '│' dividers as the borders, so both come out to the same width.
  const renderRow = (cells: string[], bold: boolean): TuiLine[] => {
    const wrapped = columnWidths.map((colWidth, index) =>
      wrapToWidth(stripInlineFormattingForWidth(cells[index] ?? ''), colWidth),
    );
    const height = Math.max(1, ...wrapped.map((cellLines) => cellLines.length));
    const rows: TuiLine[] = [];
    for (let row = 0; row < height; row++) {
      const spans: TuiSpan[] = [span('│', { color: 'cyan' })];
      for (let column = 0; column < columnWidths.length; column++) {
        const text = wrapped[column]?.[row] ?? '';
        spans.push(
          span(` ${padToWidth(text, columnWidths[column]!)} `, {
            color: 'cyan',
            bold,
          }),
        );
        spans.push(span('│', { color: 'cyan' }));
      }
      rows.push(line(...spans));
    }
    return rows;
  };
  return [
    border('┌', '┬', '┐'),
    ...renderRow(table.headers, true),
    border('├', '┼', '┤'),
    ...table.rows.flatMap((row) => renderRow(row, false)),
    border('└', '┴', '┘'),
  ];
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

export function renderFormattedBodyLines(
  body: string,
  width: number,
  kind: TranscriptKind,
): TuiLine[] {
  const formatted = splitFormattedLines(body);
  const headingColor = kind === 'system' ? 'cyan' : getEntryColor(kind);
  const bodyColor = kind === 'error' ? 'red' : undefined;
  const bodyWidth = Math.max(1, width - 2);
  const output: TuiLine[] = [];

  for (let index = 0; index < formatted.length; index++) {
    const formattedLine = formatted[index]!;
    if (formattedLine.kind === 'blank') {
      output.push(plainLine(''));
      continue;
    }
    if (formattedLine.kind === 'heading') {
      for (const wrapped of wrapText(formattedLine.text, bodyWidth)) {
        output.push(
          plainLine(`  ${wrapped}`, { color: headingColor, bold: true }),
        );
      }
      continue;
    }
    if (formattedLine.kind === 'bullet') {
      output.push(...wrapInlineToLines(formattedLine.text, bodyWidth, bodyColor, '• '));
      continue;
    }
    if (formattedLine.kind === 'numbered') {
      const marker = `${formattedLine.marker}. `;
      output.push(...wrapInlineToLines(formattedLine.text, bodyWidth, bodyColor, marker));
      continue;
    }
    if (formattedLine.kind === 'quote') {
      output.push(...wrapInlineToLines(formattedLine.text, bodyWidth, bodyColor, '│ '));
      continue;
    }
    if (formattedLine.kind === 'code') {
      const prev = formatted[index - 1];
      if (prev && prev.kind !== 'code' && prev.kind !== 'blank') {
        output.push(plainLine(''));
      }
      for (const wrapped of wrapText(formattedLine.text || ' ', bodyWidth)) {
        output.push(plainLine(`    ${wrapped}`, { color: 'cyan' }));
      }
      const next = formatted[index + 1];
      if (next && next.kind !== 'code' && next.kind !== 'blank') {
        output.push(plainLine(''));
      }
      continue;
    }
    if (formattedLine.kind === 'table' && formattedLine.table) {
      output.push(
        ...renderTableLines(formattedLine.table, bodyWidth).map((tableLine) => {
          // Indent the row once, not once per span. A row is many spans — border
          // glyphs, dividers, cells — and prefixing every one of them pushed each
          // row two columns wider per span than the widths it was laid out for.
          const spans = tableLine.spans.map((part, index) =>
            index === 0 ? { ...part, text: `  ${part.text}` } : part,
          );
          return { spans };
        }),
      );
      continue;
    }
    if (formattedLine.kind === 'conflict-start') {
      output.push(plainLine('  ━━ before ━━━━━━━━━━━━━━━', { color: 'red', dim: true }));
      continue;
    }
    if (formattedLine.kind === 'conflict-sep') {
      output.push(plainLine('  ━━━━━━━━━━━━━━━━━━━━━━━━━', { color: 'gray', dim: true }));
      continue;
    }
    if (formattedLine.kind === 'conflict-end') {
      output.push(plainLine('  ━━ after ━━━━━━━━━━━━━━━━', { color: 'green', dim: true }));
      continue;
    }
    output.push(...wrapInlineToLines(formattedLine.text, bodyWidth, bodyColor, '  '));
  }

  return output;
}

export function renderPreformattedBodyLines(
  body: string,
  width: number,
  kind: TranscriptKind,
): TuiLine[] {
  const bodyColor = kind === 'error' ? 'red' : undefined;
  const bodyWidth = Math.max(1, width - 8);
  const output: TuiLine[] = [];
  const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (const rawLine of normalizedBody.split('\n')) {
    if (rawLine === '') {
      output.push(plainLine(''));
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > bodyWidth) {
      output.push(plainLine(`  ${remaining.slice(0, bodyWidth)}`, { color: bodyColor }));
      remaining = remaining.slice(bodyWidth);
    }
    output.push(plainLine(`  ${remaining}`, { color: bodyColor }));
  }

  return output;
}
