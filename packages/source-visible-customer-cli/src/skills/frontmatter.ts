export type FrontmatterValue = string | boolean | string[] | Record<string, string>;

export type FrontmatterResult =
  | { ok: true; data: Record<string, FrontmatterValue>; body: string }
  | { ok: false; error: string };

interface Line {
  text: string;
  indent: number;
}

function indentOf(text: string): number {
  const match = text.match(/^[ \t]*/);
  return match ? match[0].replace(/\t/g, '  ').length : 0;
}

function closingQuoteIndex(value: string): number {
  const quote = value[0];
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && char === '\\') {
      index += 1;
      continue;
    }
    if (char !== quote) continue;
    if (quote === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function stripComment(value: string): string {
  let start = 0;
  if (value.startsWith('"') || value.startsWith("'")) {
    const close = closingQuoteIndex(value);
    if (close < 0) return value;
    start = close + 1;
  }
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function unquote(raw: string): string {
  const value = stripComment(raw.trim()).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\/nrt])/g, (_match, char: string) => {
        if (char === 'n') return '\n';
        if (char === 'r') return '\r';
        if (char === 't') return '\t';
        return char;
      });
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function scalar(raw: string): string | boolean {
  const value = unquote(raw);
  const quoted = /^\s*["']/.test(raw);
  if (!quoted && /^(true|yes|on)$/i.test(value)) return true;
  if (!quoted && /^(false|no|off)$/i.test(value)) return false;
  return value;
}

function blockScalar(lines: Line[], start: number, parentIndent: number, style: string) {
  const collected: string[] = [];
  let index = start;
  let blockIndent = -1;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.text.trim() === '') {
      collected.push('');
      index += 1;
      continue;
    }
    if (line.indent <= parentIndent) break;
    if (blockIndent < 0) blockIndent = line.indent;
    collected.push(line.text.replace(/\t/g, '  ').slice(Math.min(blockIndent, line.indent)));
    index += 1;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  let value: string;
  if (style.startsWith('|')) {
    value = collected.join('\n');
  } else {
    value = collected
      .join('\n')
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n/g, ' '))
      .join('\n');
  }
  return { value, next: index };
}

function nestedBlock(lines: Line[], start: number, parentIndent: number) {
  const items: string[] = [];
  const map: Record<string, string> = {};
  const plain: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      index += 1;
      continue;
    }
    if (line.indent <= parentIndent) break;
    const listItem = trimmed.match(/^-\s*(.*)$/);
    const pair = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (listItem) {
      items.push(unquote(listItem[1] ?? ''));
    } else if (pair) {
      map[pair[1]!] = String(scalar(pair[2] ?? ''));
    } else {
      plain.push(unquote(trimmed));
    }
    index += 1;
  }
  if (items.length) return { value: items as FrontmatterValue, next: index };
  if (Object.keys(map).length) return { value: map as FrontmatterValue, next: index };
  return { value: plain.join(' ') as FrontmatterValue, next: index };
}

export function parseSkillFile(text: string): FrontmatterResult {
  const source = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rows = source.split('\n');
  if (rows[0]?.trim() !== '---') {
    return { ok: false, error: 'SKILL.md must start with a --- frontmatter block.' };
  }
  const end = rows.findIndex((row, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(row));
  if (end < 0) {
    return { ok: false, error: 'SKILL.md frontmatter is missing its closing ---.' };
  }
  const lines: Line[] = rows.slice(1, end).map((row) => ({ text: row, indent: indentOf(row) }));
  const data: Record<string, FrontmatterValue> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.text.trim();
    if (trimmed === '' || trimmed.startsWith('#') || line.indent > 0) {
      index += 1;
      continue;
    }
    const pair = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/);
    if (!pair) {
      return { ok: false, error: `Frontmatter line ${index + 2} is not a "key: value" pair.` };
    }
    const key = pair[1]!;
    const rest = String(pair[2] ?? '').trim();
    if (/^[|>][+-]?\d*$/.test(rest)) {
      const block = blockScalar(lines, index + 1, line.indent, rest);
      data[key] = block.value;
      index = block.next;
      continue;
    }
    if (rest === '') {
      const nested = nestedBlock(lines, index + 1, line.indent);
      data[key] = nested.value;
      index = nested.next;
      continue;
    }
    let value = rest;
    let next = index + 1;
    if (!/^["']/.test(rest)) {
      while (next < lines.length && lines[next]!.indent > line.indent && lines[next]!.text.trim() !== '') {
        value += ` ${lines[next]!.text.trim()}`;
        next += 1;
      }
    } else if (!/^(["']).*\1\s*(#.*)?$/.test(rest)) {
      const quote = rest[0]!;
      while (next < lines.length) {
        value += ` ${lines[next]!.text.trim()}`;
        next += 1;
        if (value.trimEnd().endsWith(quote)) break;
      }
    }
    data[key] = scalar(value);
    index = next;
  }
  return { ok: true, data, body: rows.slice(end + 1).join('\n').trim() };
}
