import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from '../client-state.js';

const HISTORY_FILE = 'prompt-history.json';
const LEGACY_HISTORY_FILE = 'prompt-history.txt';
export const MAX_PROMPT_HISTORY_ENTRIES = 20;
const ENTRY_SEPARATOR = '\x1e';

function getHistoryFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getClientStateDir(env), HISTORY_FILE);
}

function getLegacyHistoryFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getClientStateDir(env), LEGACY_HISTORY_FILE);
}

function sanitizeEntry(value: string): string {
  return value.replace(new RegExp(ENTRY_SEPARATOR, 'g'), '').trim();
}

function normalizePromptHistoryEntries(entries: string[]): string[] {
  const uniqueLatest = new Map<string, string>();
  for (const entry of entries) {
    const sanitized = sanitizeEntry(entry);
    if (!sanitized || sanitized.startsWith('/')) continue;
    uniqueLatest.delete(sanitized);
    uniqueLatest.set(sanitized, sanitized);
  }
  const normalized = [...uniqueLatest.values()];
  return normalized.slice(
    Math.max(0, normalized.length - MAX_PROMPT_HISTORY_ENTRIES),
  );
}

function parseJsonPromptHistory(content: string): string[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  if (!parsed || typeof parsed !== 'object') return [];
  const prompts = (parsed as { prompts?: unknown }).prompts;
  return Array.isArray(prompts) ? prompts.map((entry) => String(entry)) : [];
}

function parseLegacyPromptHistory(content: string): string[] {
  return content.replace(new RegExp(ENTRY_SEPARATOR, 'g'), '\n').split(/\r?\n/);
}

function serializePromptHistory(entries: string[]): string {
  return `${JSON.stringify({ version: 1, prompts: entries }, null, 2)}\n`;
}

function writePromptHistoryFile(
  filePath: string,
  entries: string[],
): void {
  writeFileSync(filePath, serializePromptHistory(entries), {
    encoding: 'utf8',
    mode: existsSync(filePath) ? undefined : 0o600,
  });
}

export function loadPromptHistory(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const filePath = getHistoryFilePath(env);
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf8');
      if (!content) return [];
      return normalizePromptHistoryEntries(parseJsonPromptHistory(content));
    } catch {
      return [];
    }
  }

  const legacyFilePath = getLegacyHistoryFilePath(env);
  if (!existsSync(legacyFilePath)) return [];
  try {
    const content = readFileSync(legacyFilePath, 'utf8');
    if (!content) return [];
    const entries = normalizePromptHistoryEntries(
      parseLegacyPromptHistory(content),
    );
    mkdirSync(getClientStateDir(env), { recursive: true });
    writePromptHistoryFile(filePath, entries);
    return entries;
  } catch {
    return [];
  }
}

export function appendPromptToFile(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sanitized = sanitizeEntry(String(prompt ?? ''));
  if (!sanitized || sanitized.startsWith('/')) return;
  try {
    const dir = getClientStateDir(env);
    mkdirSync(dir, { recursive: true });
    const filePath = getHistoryFilePath(env);
    const entries = normalizePromptHistoryEntries([
      ...loadPromptHistory(env),
      sanitized,
    ]);
    writePromptHistoryFile(filePath, entries);
  } catch {
    return;
  }
}
