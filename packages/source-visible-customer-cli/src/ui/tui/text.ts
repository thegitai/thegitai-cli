import type { TuiLine, TuiSpan } from './types.js';

// Model reasoning, tool output and command results all reach the screen as span
// text, and any of them can carry ANSI escapes. The TUI paints span text straight
// into the terminal buffer, so an escape that survives to here is executed by the
// terminal — moving the cursor or resetting colours mid-frame — and it also breaks
// every width calculation, since an escape has no display width but plenty of
// characters. Strip control sequences at the one place every span is built.
// CSI sequences (colours, cursor moves), OSC sequences (window title), and any
// other C0 control character. Newline and tab are left alone: the renderer splits
// on newlines before building spans, and a tab is printable.
const CSI_PATTERN = /\u001B\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export function stripControlCharacters(text: string): string {
  return String(text ?? '')
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, '');
}

export function span(
  text: string,
  style: Partial<Omit<TuiSpan, 'text'>> = {},
): TuiSpan {
  return { text: stripControlCharacters(text), ...style };
}

export function line(...spans: TuiSpan[]): TuiLine {
  return { spans };
}

export function plainLine(text: string, style: Partial<Omit<TuiSpan, 'text'>> = {}): TuiLine {
  return line(span(text, style));
}

export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (!text) return [''];
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    let remaining = rawLine;
    // Measured in terminal columns, not UTF-16 units: a line of CJK or emoji is
    // twice as wide as its .length suggests, and emitting a row wider than the
    // frame was budgeted for makes the terminal wrap it, which shifts every row
    // below and desynchronises the inline viewport.
    while (displayWidth(remaining) > safeWidth) {
      const head = sliceToWidth(remaining, safeWidth);
      let breakAt = head.lastIndexOf(' ');
      if (breakAt <= 0) breakAt = head.length;
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

export function joinLines(blocks: TuiLine[][]): TuiLine[] {
  return blocks.flat();
}

// Terminal columns occupied by a code point. JavaScript's `.length` counts UTF-16
// units, which is not what a terminal draws: CJK, Hangul and most emoji take two
// columns, and combining marks take none. Anything that pads text into a fixed
// column — table cells above all — misaligns the moment a ✅ or a CJK character
// appears unless width is measured this way.
function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200d || // zero-width joiner
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacriticals
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  // East Asian Wide/Fullwidth blocks, plus the emoji that terminals draw two
  // columns wide (this range list covers ✅ U+2705 and ❌ U+274C).
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x231a ||
    codePoint === 0x231b ||
    (codePoint >= 0x23e9 && codePoint <= 0x23ec) ||
    codePoint === 0x23f0 ||
    codePoint === 0x23f3 ||
    (codePoint >= 0x25fd && codePoint <= 0x25fe) ||
    (codePoint >= 0x2614 && codePoint <= 0x2615) ||
    (codePoint >= 0x2648 && codePoint <= 0x2653) ||
    codePoint === 0x267f ||
    codePoint === 0x2693 ||
    codePoint === 0x26a1 ||
    (codePoint >= 0x26aa && codePoint <= 0x26ab) ||
    (codePoint >= 0x26bd && codePoint <= 0x26be) ||
    (codePoint >= 0x26c4 && codePoint <= 0x26c5) ||
    codePoint === 0x26ce ||
    codePoint === 0x26d4 ||
    codePoint === 0x26ea ||
    (codePoint >= 0x26f2 && codePoint <= 0x26f3) ||
    codePoint === 0x26f5 ||
    codePoint === 0x26fa ||
    codePoint === 0x26fd ||
    codePoint === 0x2705 ||
    (codePoint >= 0x270a && codePoint <= 0x270b) ||
    codePoint === 0x2728 ||
    codePoint === 0x274c ||
    codePoint === 0x274e ||
    (codePoint >= 0x2753 && codePoint <= 0x2755) ||
    codePoint === 0x2757 ||
    (codePoint >= 0x2795 && codePoint <= 0x2797) ||
    codePoint === 0x27b0 ||
    codePoint === 0x27bf ||
    (codePoint >= 0x2b1b && codePoint <= 0x2b1c) ||
    codePoint === 0x2b50 ||
    codePoint === 0x2b55 ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function displayWidth(text: string): number {
  const chars = [...String(text ?? '')];
  let width = 0;
  for (let index = 0; index < chars.length; index++) {
    const codePoint = chars[index]!.codePointAt(0)!;
    if (isZeroWidthCodePoint(codePoint)) continue;
    const next = chars[index + 1]?.codePointAt(0);
    // U+FE0F asks for emoji presentation (two columns) even on a base character
    // that is otherwise narrow, e.g. ⚠️; U+FE0E asks for text presentation.
    if (next === 0xfe0f) {
      width += 2;
      index++;
      continue;
    }
    if (next === 0xfe0e) {
      width += 1;
      index++;
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function sliceToWidth(text: string, width: number): string {
  const limit = Math.max(1, Math.floor(width));
  const chars = [...String(text ?? '')];
  let out = '';
  let used = 0;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    const next = chars[index + 1];
    // A presentation selector must stay with the character it modifies, and the
    // pair must be measured as a pair. Measuring them separately made ⚠️ count as
    // one column here while displayWidth counted two, so a row sliced to fit came
    // back one column over budget.
    const selector = next === '️' || next === '︎';
    const cluster = selector ? `${char}${next}` : char;
    const clusterWidth = displayWidth(cluster);
    if (used + clusterWidth > limit) break;
    out += cluster;
    used += clusterWidth;
    if (selector) index++;
  }
  // A single character wider than the whole column would otherwise return '',
  // and callers that slice in a loop would never advance.
  if (!out) return chars[0] ?? '';
  return out;
}

export function padToWidth(text: string, width: number): string {
  const current = displayWidth(text);
  if (current >= width) return text;
  return text + ' '.repeat(width - current);
}

// Word-wrap by display width, hard-breaking any single token longer than the
// column so nothing is ever silently dropped.
export function wrapToWidth(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    let current = '';
    const flush = () => {
      out.push(current);
      current = '';
    };
    for (const token of rawLine.split(/\s+/).filter(Boolean)) {
      let rest = token;
      while (displayWidth(rest) > limit) {
        if (current) flush();
        const head = sliceToWidth(rest, limit);
        out.push(head);
        rest = rest.slice(head.length);
      }
      if (!rest) continue;
      const candidate = current ? `${current} ${rest}` : rest;
      if (displayWidth(candidate) > limit) {
        flush();
        current = rest;
      } else {
        current = candidate;
      }
    }
    flush();
  }
  return out.length > 0 ? out : [''];
}
