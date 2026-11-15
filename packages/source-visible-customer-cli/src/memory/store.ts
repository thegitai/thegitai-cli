import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { MemoryScope, MemoryTopic, MemoryTopicType } from '../api/contracts.js';
import { getClientStateDir } from '../client-state.js';
import { localTimestamp } from '../local-clock.js';
import { getSessionProjectKey } from '../project-key.js';

export const MEMORY_ENTRY_MAX_CHARS = 1_000;
export const MEMORY_TOPIC_MAX_CHARS = 12_000;
export const MEMORY_MAX_TOPICS_PER_SCOPE = 100;
const DESCRIPTION_MAX_CHARS = 200;
const REQUEST_BODY_BUDGET_CHARS = 60_000;
const INDEX_FILE = 'INDEX.md';
const LEGACY_FILE = 'memories.json';
const TYPES: readonly MemoryTopicType[] = ['preference', 'correction', 'fact', 'decision'];
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 15;
const LOCK_BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

export type MemorySaveResult =
  | { ok: true; topic: MemoryTopic; entry: { at: string; text: string }; created: boolean }
  | { ok: false; error: string };

export function memoryFolder(
  scope: MemoryScope,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = getClientStateDir(env);
  return scope === 'personal'
    ? path.join(base, 'memory')
    : path.join(base, 'projects', getSessionProjectKey(rootDir), 'memory');
}

export function memoryFolders(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<MemoryScope, string> {
  return { personal: memoryFolder('personal', rootDir, env), project: memoryFolder('project', rootDir, env) };
}

function settingsFile(env: NodeJS.ProcessEnv): string {
  return path.join(getClientStateDir(env), 'memory', 'settings.json');
}

function withMemoryLock<T>(env: NodeJS.ProcessEnv, mutate: () => T): T {
  const lockPath = path.join(getClientStateDir(env), 'memory', '.lock');
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      break;
    } catch (error: any) {
      if (!LOCK_BUSY_CODES.has(error?.code)) throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch {
      }
      if (Date.now() > deadline) throw new Error('Memory is busy. Try again in a moment.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    return mutate();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function writeText(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, text, { mode: 0o600 });
  renameSync(tempPath, filePath);
}

function oneLine(value: unknown, max = DESCRIPTION_MAX_CHARS): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validTime(value: string | undefined): string {
  return value && !Number.isNaN(Date.parse(value)) ? value : '';
}

function entryStamp(timestamp: string): string {
  return timestamp.slice(0, 16).replace('T', ' ');
}

const TRAILING_FILLER = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with']);

function nameFromSentence(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  while (words.length > 1 && TRAILING_FILLER.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

export function memoryBodyVersion(body: unknown): string {
  return createHash('sha256').update(String(body ?? '').trim()).digest('hex').slice(0, 16);
}

function entryText(block: string): string {
  return block.trim().replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}: /, '');
}

export function topicNameFrom(value: unknown): string {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!slug) return 'note';
  return slug === 'index' ? 'index-topic' : slug;
}

function parseTopic(name: string, scope: MemoryScope, content: string, modified: Date): MemoryTopic {
  const header: Record<string, string> = {};
  let body = content;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) header[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    body = content.slice(match[0].length);
  }
  body = body.trim();
  const fallback = localTimestamp(modified);
  const created = validTime(header.created) || fallback;
  return {
    name,
    scope,
    description: oneLine(header.description) || oneLine(body.split('\n')[0]) || name,
    type: TYPES.includes(header.type as MemoryTopicType) ? (header.type as MemoryTopicType) : 'fact',
    created,
    updated: validTime(header.updated) || created,
    body,
  };
}

function renderTopic(topic: MemoryTopic): string {
  return [
    '---',
    `name: ${topic.name}`,
    `description: ${topic.description}`,
    `type: ${topic.type}`,
    `created: ${topic.created}`,
    `updated: ${topic.updated}`,
    '---',
    '',
    topic.body ?? '',
    '',
  ].join('\n');
}

function topicFile(folder: string, name: string): string {
  return path.join(folder, `${name}.md`);
}

function readScope(scope: MemoryScope, rootDir: string, env: NodeJS.ProcessEnv): MemoryTopic[] {
  const folder = memoryFolder(scope, rootDir, env);
  let files: string[];
  try {
    files = readdirSync(folder);
  } catch {
    return [];
  }
  const topics: MemoryTopic[] = [];
  for (const file of files) {
    if (!file.endsWith('.md') || file === INDEX_FILE) continue;
    const filePath = path.join(folder, file);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      topics.push(parseTopic(file.slice(0, -3), scope, readFileSync(filePath, 'utf8'), stat.mtime));
    } catch {
    }
  }
  return topics;
}

function byNewest(a: MemoryTopic, b: MemoryTopic): number {
  return (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0);
}

function writeIndex(folder: string, topics: MemoryTopic[]): void {
  if (topics.length === 0) {
    rmSync(path.join(folder, INDEX_FILE), { force: true });
    return;
  }
  const lines = [...topics]
    .sort(byNewest)
    .map(
      (topic) =>
        `- [${topic.name}](${encodeURI(`${topic.name}.md`)}) - ${topic.description} (updated ${entryStamp(topic.updated)})`,
    );
  writeText(path.join(folder, INDEX_FILE), ['# Memory', '', ...lines, ''].join('\n'));
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

function migrateLegacyNotes(scope: MemoryScope, rootDir: string, env: NodeJS.ProcessEnv): void {
  const folder = memoryFolder(scope, rootDir, env);
  const legacyPath = path.join(folder, LEGACY_FILE);
  if (!existsSync(legacyPath)) return;
  withMemoryLock(env, () => {
    let notes: unknown;
    try {
      notes = JSON.parse(readFileSync(legacyPath, 'utf8'));
    } catch {
      return;
    }
    const topics = readScope(scope, rootDir, env);
    const taken = new Set(topics.map((topic) => topic.name));
    for (const item of Array.isArray(notes) ? notes : []) {
      const record = (item ?? {}) as Record<string, unknown>;
      const text = oneLine(record.text, MEMORY_ENTRY_MAX_CHARS);
      if (!text) continue;
      const created = validTime(String(record.createdAt ?? '')) || localTimestamp();
      const name = uniqueName(topicNameFrom(nameFromSentence(text)), taken);
      taken.add(name);
      const topic: MemoryTopic = {
        name,
        scope,
        description: oneLine(text.split(/(?<=[.!?])\s/)[0]),
        type: 'fact',
        created,
        updated: validTime(String(record.updatedAt ?? '')) || created,
        body: `${entryStamp(created)}: ${text}`,
      };
      writeText(topicFile(folder, name), renderTopic(topic));
      topics.push(topic);
    }
    writeIndex(folder, topics);
    rmSync(legacyPath, { force: true });
  });
}

export function listMemoryTopics(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryTopic[] {
  const scoped = (scope: MemoryScope) => {
    try {
      migrateLegacyNotes(scope, rootDir, env);
    } catch {
    }
    return readScope(scope, rootDir, env).sort(byNewest);
  };
  return [...scoped('project'), ...scoped('personal')];
}

export function isMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return JSON.parse(readFileSync(settingsFile(env), 'utf8'))?.enabled !== false;
  } catch {
    return true;
  }
}

export function setMemoryEnabled(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  writeText(settingsFile(env), `${JSON.stringify({ enabled }, null, 2)}\n`);
}

export function collectMemoryRequest(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { memoryTopics?: MemoryTopic[] } {
  if (!isMemoryEnabled(env)) return {};
  let budget = REQUEST_BODY_BUDGET_CHARS;
  const topics = listMemoryTopics(rootDir, env)
    .sort(byNewest)
    .map((topic) => {
      const body = (topic.body ?? '').slice(0, MEMORY_TOPIC_MAX_CHARS);
      if (body.length > budget) return { ...topic, body: undefined };
      budget -= body.length;
      return { ...topic, body };
    });
  return { memoryTopics: topics };
}

export function addMemoryEntry({
  rootDir,
  env = process.env,
  scope: rawScope,
  topic: rawTopic,
  text: rawText,
  description,
  type,
  body: rewrittenBody,
  basedOn,
}: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  scope?: unknown;
  topic?: unknown;
  text: unknown;
  description?: unknown;
  type?: unknown;
  body?: unknown;
  basedOn?: unknown;
}): MemorySaveResult {
  const text = oneLine(rawText, Number.MAX_SAFE_INTEGER);
  if (!text) return { ok: false, error: 'A memory needs some text.' };
  if (text.length > MEMORY_ENTRY_MAX_CHARS) {
    return { ok: false, error: `One memory entry can be at most ${MEMORY_ENTRY_MAX_CHARS} characters.` };
  }
  const scope: MemoryScope = rawScope === 'personal' ? 'personal' : 'project';
  const folder = memoryFolder(scope, rootDir, env);
  try {
    migrateLegacyNotes(scope, rootDir, env);
    return withMemoryLock(env, (): MemorySaveResult => {
      const topics = readScope(scope, rootDir, env);
      const requested = String(rawTopic ?? '').trim();
      const name = topics.some((topic) => topic.name === requested)
        ? requested
        : topicNameFrom(requested || nameFromSentence(text));
      const existing = topics.find((topic) => topic.name === name);
      if (!existing && topics.length >= MEMORY_MAX_TOPICS_PER_SCOPE) {
        return {
          ok: false,
          error: `Memory is full (${MEMORY_MAX_TOPICS_PER_SCOPE} topics). Add to an existing topic, or ask the user to remove some with /memory.`,
        };
      }
      const now = localTimestamp();
      const entry = { at: entryStamp(now), text };
      const base: MemoryTopic = existing ?? {
        name,
        scope,
        description: oneLine(description) || oneLine(text.split(/(?<=[.!?])\s/)[0]),
        type: TYPES.includes(type as MemoryTopicType) ? (type as MemoryTopicType) : 'fact',
        created: now,
        updated: now,
        body: '',
      };
      const replacement =
        typeof rewrittenBody === 'string' && rewrittenBody.trim() && existing && basedOn === memoryBodyVersion(existing.body)
          ? rewrittenBody.trim()
          : null;
      const before = replacement ?? base.body ?? '';
      const duplicate = before.split(/\n\s*\n/).some((block) => entryText(block) === text);
      if (duplicate && replacement === null) return { ok: true, topic: base, entry, created: false };
      const body = duplicate ? before : before ? `${before}\n\n${entry.at}: ${text}` : `${entry.at}: ${text}`;
      if (body.length > MEMORY_TOPIC_MAX_CHARS) {
        return {
          ok: false,
          error: `The topic ${base.name} is full (${MEMORY_TOPIC_MAX_CHARS} characters). Ask the user to tidy it with /memory.`,
        };
      }
      const topic: MemoryTopic = { ...base, updated: now, body };
      writeText(topicFile(folder, topic.name), renderTopic(topic));
      writeIndex(folder, [...topics.filter((item) => item.name !== topic.name), topic]);
      return { ok: true, topic, entry, created: !existing };
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function findTopic(
  scope: MemoryScope,
  name: string,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): MemoryTopic | undefined {
  return readScope(scope, rootDir, env).find((topic) => topic.name === name);
}

export function readMemoryTopicFile({
  rootDir,
  env = process.env,
  scope,
  name,
}: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  scope: MemoryScope;
  name: string;
}): { path: string; content: string } {
  if (!findTopic(scope, name, rootDir, env)) throw new Error('That memory topic no longer exists.');
  const filePath = topicFile(memoryFolder(scope, rootDir, env), name);
  return { path: filePath, content: readFileSync(filePath, 'utf8') };
}

export function writeMemoryTopicFile({
  rootDir,
  env = process.env,
  scope,
  name,
  content,
}: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  scope: MemoryScope;
  name: string;
  content: string;
}): MemoryTopic {
  return withMemoryLock(env, () => {
    const folder = memoryFolder(scope, rootDir, env);
    const topics = readScope(scope, rootDir, env);
    const existing = topics.find((topic) => topic.name === name);
    if (!existing) throw new Error('That memory topic no longer exists.');
    const parsed = parseTopic(name, scope, String(content), new Date());
    if (!parsed.body) throw new Error('A memory topic needs some text. Delete it instead.');
    if ((parsed.body ?? '').length > MEMORY_TOPIC_MAX_CHARS) {
      throw new Error(`A memory topic can be at most ${MEMORY_TOPIC_MAX_CHARS} characters.`);
    }
    const changed = parsed.body !== existing.body || parsed.description !== existing.description || parsed.type !== existing.type;
    const topic: MemoryTopic = {
      ...parsed,
      created: existing.created,
      updated: changed ? localTimestamp() : existing.updated,
    };
    writeText(topicFile(folder, name), renderTopic(topic));
    writeIndex(folder, [...topics.filter((item) => item.name !== name), topic]);
    return topic;
  });
}

export function deleteMemoryTopic({
  rootDir,
  env = process.env,
  scope,
  name,
}: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  scope: MemoryScope;
  name: string;
}): boolean {
  return withMemoryLock(env, () => {
    const folder = memoryFolder(scope, rootDir, env);
    const topics = readScope(scope, rootDir, env);
    if (!topics.some((topic) => topic.name === name)) return false;
    rmSync(topicFile(folder, name), { force: true });
    writeIndex(folder, topics.filter((topic) => topic.name !== name));
    return true;
  });
}

export function searchMemoryTopics(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  query: string,
  limit = 5,
): MemoryTopic[] {
  const topics = listMemoryTopics(rootDir, env);
  const terms = oneLine(query, 500).toLowerCase().split(' ').filter((term) => term.length > 1);
  if (terms.length === 0) return topics.slice(0, limit);
  return topics
    .map((topic) => {
      const title = `${topic.name} ${topic.description}`.toLowerCase();
      const body = (topic.body ?? '').toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (title.includes(term) ? 2 : 0) + (body.includes(term) ? 1 : 0),
        0,
      );
      return { topic, score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || byNewest(a.topic, b.topic))
    .slice(0, limit)
    .map((match) => match.topic);
}
