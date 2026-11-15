import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import type { ProjectInstructionFile } from './api/contracts.js';
import type { SessionSafetyState } from './session-safety.js';
import {
  getCurrentFileHash,
  redactContentWithStableTokens,
} from './session-safety.js';

const INSTRUCTION_FILE_NAMES = new Set(['agents.md', 'agent.md', 'claude.md']);
const MAX_FILES = 6;
const MAX_LISTED_FILES = 12;
const MAX_FILE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 64_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_NAME_CHARS = 120;

export function isProjectInstructionFileName(name: string): boolean {
  return INSTRUCTION_FILE_NAMES.has(name.toLowerCase());
}

function clipToLines(
  text: string,
  maxChars: number,
): { content: string; clipped: boolean } {
  if (text.length <= maxChars) return { content: text, clipped: false };
  const cut = maxChars > 0 ? text.lastIndexOf('\n', maxChars - 1) : -1;
  return { content: cut >= 0 ? text.slice(0, cut + 1) : '', clipped: true };
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

export function normalizeProjectInstructionFiles(
  value: unknown,
): ProjectInstructionFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: ProjectInstructionFile[] = [];
  let loaded = 0;
  let total = 0;
  for (const item of value) {
    if (files.length >= MAX_LISTED_FILES) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.content !== 'string') continue;
    const name = record.name
      .replace(/[\u0000-\u001f\u007f/\\]/g, '')
      .trim()
      .slice(0, MAX_NAME_CHARS);
    if (!isProjectInstructionFileName(name)) continue;
    const text = record.content.replace(/\r\n/g, '\n');
    if (!text.trim() && record.truncated !== true) continue;
    const budget =
      loaded < MAX_FILES ? Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total) : 0;
    const { content, clipped } = clipToLines(text, budget);
    if (!content.trim()) {
      files.push({ name, content: '', shownLines: 0, truncated: true });
      continue;
    }
    loaded += 1;
    total += content.length;
    files.push({
      name,
      content,
      shownLines: countLines(content),
      truncated: clipped || record.truncated === true,
    });
  }
  return files.length > 0 ? files : null;
}

function readInstructionFile(
  filePath: string,
  rootReal: string,
): { text: string; partial: boolean } | null {
  let fd: number | null = null;
  try {
    const real = realpathSync(filePath);
    const relative = path.relative(rootReal, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    fd = openSync(real, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(size);
    const read = size > 0 ? readSync(fd, buffer, 0, size, 0) : 0;
    const text = buffer.subarray(0, read).toString('utf8');
    if (text.includes('\u0000')) return null;
    return { text, partial: stat.size > MAX_READ_BYTES };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function collectProjectInstructionFiles(
  rootDir: string,
  safety?: SessionSafetyState,
): ProjectInstructionFile[] | null {
  let rootReal: string;
  let names: string[];
  try {
    rootReal = realpathSync(rootDir);
    names = readdirSync(rootDir)
      .filter(isProjectInstructionFileName)
      .sort();
  } catch {
    return null;
  }
  const files: Array<{ name: string; content: string; truncated: boolean }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    const filePath = path.join(rootDir, name);
    const file = readInstructionFile(filePath, rootReal);
    if (!file || !file.text.trim() || seen.has(file.text)) continue;
    seen.add(file.text);
    const content = safety
      ? redactContentWithStableTokens(
          safety,
          file.text,
          name,
          getCurrentFileHash(rootDir, filePath),
        ).content
      : file.text;
    files.push({ name, content, truncated: file.partial });
  }
  return normalizeProjectInstructionFiles(files);
}
