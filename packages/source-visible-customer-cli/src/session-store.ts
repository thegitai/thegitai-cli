import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from './client-state.js';
import {
  findStoredImageByContent,
  pruneSessionImages,
  readSessionImage,
  sweepOrphanSessionImages,
} from './core/session-image-store.js';
import { sweepGeneratedImages } from './tools/save-generated-image.js';
import { normalizeAssistantEditJournal } from './edit-journal.js';
import { createSessionGrants } from './permissions.js';
import {
  cloneSessionSafetyState,
  createSessionSafetyState,
  mergeLocalSessionSafetyState,
  normalizeSessionSafetyState,
} from './session-safety.js';
import type { SessionState } from './session.js';
import type {
  ClientSessionSnapshot,
  ClientSessionStateSnapshot,
  SessionMetadata,
} from './api/contracts.js';
import type { ChatMessage } from './types.js';
import { singleLinePreview } from './utils.js';

const SESSION_STORE_VERSION = 1;
export const MAX_RECENT_SESSIONS = 10;

export type { ClientSessionSnapshot, SessionMetadata };

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeIsoDate(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function normalizeSessionName(name: unknown): string | null {
  const text = String(name ?? '').trim();
  if (!text) return null;
  if (text.length > 120) {
    throw new Error('Session name must be 120 characters or fewer.');
  }
  if (/[\r\n\t]/.test(text)) {
    throw new Error('Session name cannot contain control whitespace.');
  }
  return text;
}

function sanitizeOpaqueState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return cloneJson(value as Record<string, unknown>);
}

function sanitizeClientState(value: unknown): ClientSessionStateSnapshot {
  const raw = value && typeof value === 'object' ? (value as any) : {};
  return {
    editCounter: Math.max(
      0,
      Number.parseInt(String(raw.editCounter ?? 0), 10) || 0,
    ),
    editJournal: normalizeAssistantEditJournal(raw.editJournal),
    stickyFilePaths: Array.isArray(raw.stickyFilePaths)
      ? raw.stickyFilePaths.map((item: unknown) => String(item ?? '')).filter(Boolean)
      : [],
    safety: normalizeSessionSafetyState(raw.safety),
  };
}

function safeSessionFileName(id: string): string {
  const normalized = String(id ?? '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error(`Invalid session id "${id}".`);
  }
  return `${normalized}.json`;
}

function getSessionBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return getClientStateDir(env);
}

export function getSessionProjectKey(rootDir: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const projectName =
    path.basename(resolvedRoot).replace(/[^a-zA-Z0-9._-]/g, '_') || 'project';
  const hash = createHash('sha256')
    .update(resolvedRoot)
    .digest('hex')
    .slice(0, 16);
  return `${projectName}-${hash}`;
}

function getSessionProjectDir(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    getSessionBaseDir(env),
    'sessions',
    'projects',
    getSessionProjectKey(rootDir),
  );
}

function getSessionPath(
  rootDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getSessionProjectDir(rootDir, env), safeSessionFileName(sessionId));
}

function listSessionFiles(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dir = getSessionProjectDir(rootDir, env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name));
}

function normalizeBranch(value: unknown): string | null {
  const text = String(value ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  return text ? text.slice(0, 120) : null;
}

/**
 * Replace inline image bytes with a reference to the session image store before
 * writing a session to disk.
 *
 * These two functions belong to the LOCAL FILE boundary and nowhere else.
 * `snapshotFromSession` and `applySessionSnapshot` look like the natural home
 * for them, but both also serve the client -> server wire: a server-owned turn
 * POSTs its snapshot and the server calls `applySessionSnapshot` on it. Putting
 * rehydration there hands a client the ability to name any path on the VPS and
 * have the server read it into provider history — the arbitrary-read primitive
 * that index-addressed attachments exist to prevent. Rehydrate only when
 * reading a file this machine wrote.
 *
 * A vision model's history holds the full base64 of every image the user ever
 * attached, and the session file is rewritten after every turn — which is how
 * ordinary sessions reached several megabytes of mostly-duplicated pixels. The
 * store already holds those exact bytes at a stable path, so the file only
 * needs to say which one. The text part next to the reference is what a reader
 * that cannot find the file falls back to, so a resumed session degrades to
 * "the image was here" instead of a broken part.
 */
function dehydrateHistoryImages(history: ChatMessage[]): ChatMessage[] {
  return history.map((entry) => ({
    ...entry,
    parts: (entry.parts ?? []).map((part: any) => {
      if (!part?.inlineData?.data) return part;
      // The sibling field is the fast path, for history this process built.
      // History that came back from a server-owned turn has had it stripped at
      // the snapshot boundary — client-owned metadata does not cross — so fall
      // back to identifying the image by its bytes, which do survive intact.
      // Without this, the customer topology persisted full base64 every turn.
      const cachePath =
        part.imageCachePath ?? findStoredImageByContent(part.inlineData.data);
      if (!cachePath) return part;
      return {
        imageRef: { cachePath, mimeType: part.inlineData.mimeType },
        text: '[image stored in this session]',
      };
    }),
  }));
}

/**
 * Restore inline bytes from the session image store when loading a session
 * file this machine wrote. A reference whose file is gone (swept, or deleted by
 * the user) keeps its text placeholder rather than resurrecting as an empty
 * image part. Never call this on anything that arrived over the wire.
 */
function rehydrateHistoryImages(history: ChatMessage[]): ChatMessage[] {
  return history.map((entry) => ({
    ...entry,
    parts: (entry.parts ?? []).map((part: any) => {
      const ref = part?.imageRef;
      if (!ref?.cachePath) return part;
      const stored = readSessionImage(String(ref.cachePath));
      if (!stored) return { text: part.text ?? '[image no longer available]' };
      return {
        inlineData: { mimeType: stored.mimeType, data: stored.base64Data },
        imageCachePath: ref.cachePath,
      };
    }),
  }));
}

function normalizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof (entry as any).role === 'string' &&
      Array.isArray((entry as any).parts),
  ) as ChatMessage[];
}

function normalizeSnapshot(raw: any, rootDir: string): ClientSessionSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Session file is not valid JSON object data.');
  }
  if (raw.version !== SESSION_STORE_VERSION) {
    throw new Error(`Unsupported session file version "${raw.version}".`);
  }
  const id = String(raw.id ?? '').trim();
  safeSessionFileName(id);
  const modelId = Number(raw.modelId);
  if (!Number.isInteger(modelId) || modelId <= 0) {
    throw new Error(`Session "${id}" is missing modelId.`);
  }
  return {
    version: SESSION_STORE_VERSION,
    id,
    name: normalizeSessionName(raw.name ?? null),
    rootDir: path.resolve(rootDir),
    projectKey: getSessionProjectKey(rootDir),
    createdAt: normalizeIsoDate(raw.createdAt),
    updatedAt: normalizeIsoDate(raw.updatedAt),
    modelId,
    branch: normalizeBranch(raw.branch),
    history: cloneJson(normalizeHistory(raw.history)),
    clientState: sanitizeClientState(raw.clientState),
    serverState: sanitizeOpaqueState(raw.serverState),
  };
}

function loadSnapshotFile(filePath: string, rootDir: string): ClientSessionSnapshot {
  return normalizeSnapshot(JSON.parse(readFileSync(filePath, 'utf-8')), rootDir);
}

function loadAllSnapshots(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ClientSessionSnapshot[] {
  const snapshots: ClientSessionSnapshot[] = [];
  for (const filePath of listSessionFiles(rootDir, env)) {
    try {
      snapshots.push(loadSnapshotFile(filePath, rootDir));
    } catch {
      // Skip corrupted snapshots silently — customers have no actionable debug path here.
    }
  }
  return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function writeSnapshot(
  snapshot: ClientSessionSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = getSessionProjectDir(snapshot.rootDir, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = getSessionPath(snapshot.rootDir, snapshot.id, env);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tempPath, filePath);
}

function assertSessionNameAvailable(
  rootDir: string,
  name: string | null,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!name) return;
  const duplicate = loadAllSnapshots(rootDir, env).find(
    (snapshot) => snapshot.name === name && snapshot.id !== sessionId,
  );
  if (duplicate) {
    throw new Error(
      `Session name "${name}" is already used by ${duplicate.id}. Use --session "${name}" to resume it or choose a different name.`,
    );
  }
}

/**
 * Every session id that still has a saved session file, across all projects.
 * Filenames only — no snapshot is parsed, so this stays cheap enough to run on
 * startup.
 */
function listAllSessionIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ids = new Set<string>();
  const projectsDir = path.join(getSessionBaseDir(env), 'sessions', 'projects');
  if (!existsSync(projectsDir)) return ids;
  try {
    for (const project of readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, project);
      try {
        for (const file of readdirSync(dir)) {
          if (file.endsWith('.json')) ids.add(path.basename(file, '.json'));
        }
      } catch {
        // A project directory we cannot read contributes no live ids; the age
        // gate in the sweep keeps that from deleting anything recent.
      }
    }
  } catch {
    return ids;
  }
  return ids;
}

export function pruneSavedSessions(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const snapshots = loadAllSnapshots(rootDir, env);
  const keep = new Set(snapshots.slice(0, MAX_RECENT_SESSIONS).map((snapshot) => snapshot.id));
  for (const snapshot of snapshots.slice(MAX_RECENT_SESSIONS)) {
    if (!keep.has(snapshot.id)) {
      rmSync(getSessionPath(rootDir, snapshot.id, env), { force: true });
      // The session's images go with it. They are only ever referenced from the
      // session that captured them, so keeping them past its deletion is pure
      // disk cost — and images are the largest thing this store holds.
      pruneSessionImages(snapshot.id, env);
    }
  }
  // Images whose session is gone for any other reason (a hand-deleted file, a
  // crash before the snapshot was written) are swept on age alone. The live set
  // spans every project, not just this one: sessions are stored per project but
  // images are stored per session id, so scoping this to the current project
  // would read another project's sessions as orphans.
  sweepOrphanSessionImages({
    activeSessionIds: listAllSessionIds(env),
    env,
  });
  sweepGeneratedImages({ env });
}

// Recorded into the snapshot so the resume picker can show which branch a
// session was working on. Detached HEAD (literal "HEAD") reads as no branch.
export function readGitBranch(rootDir: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const branch = result.status === 0 ? String(result.stdout ?? '').trim() : '';
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

export function snapshotFromSession(session: SessionState): ClientSessionSnapshot {
  const now = new Date().toISOString();
  const createdAt = normalizeIsoDate(session.sessionCreatedAt ?? now);
  session.sessionCreatedAt = createdAt;
  session.sessionUpdatedAt = now;
  return {
    version: SESSION_STORE_VERSION,
    id: session.sessionId,
    name: normalizeSessionName(session.sessionName ?? null),
    rootDir: path.resolve(session.rootDir),
    projectKey: getSessionProjectKey(session.rootDir),
    createdAt,
    updatedAt: now,
    modelId: session.modelId,
    branch: readGitBranch(session.rootDir),
    history: cloneJson(session.history),
    clientState: {
      editCounter: session.clientState.editCounter,
      editJournal: normalizeAssistantEditJournal(session.clientState.editJournal),
      stickyFilePaths: Array.from(session.clientState.stickyFilePaths),
      safety: cloneSessionSafetyState(
        session.clientState.safety ?? createSessionSafetyState(),
      ),
    },
    serverState: sanitizeOpaqueState(session.serverState),
  };
}

export function saveSessionState(
  session: SessionState,
  env: NodeJS.ProcessEnv = process.env,
): ClientSessionSnapshot {
  const snapshot = snapshotFromSession(session);
  assertSessionNameAvailable(snapshot.rootDir, snapshot.name, snapshot.id, env);
  writeSnapshot(snapshot, env);
  pruneSavedSessions(snapshot.rootDir, env);
  return snapshot;
}

export function applySessionSnapshot(
  session: SessionState,
  snapshot: ClientSessionSnapshot,
  options: {
    modelOverride?: number | null;
    preserveAgentMode?: boolean;
  } = {},
): void {
  const currentAgentMode = session.agentMode;
  // This same function syncs server state back into the *live* session after
  // every turn, so grants must key off session identity rather than the call.
  // Clearing unconditionally wiped every grant once per turn.
  const previousSessionId = session.sessionId;
  session.sessionId = snapshot.id;
  session.sessionName = snapshot.name;
  session.sessionCreatedAt = snapshot.createdAt;
  session.sessionUpdatedAt = snapshot.updatedAt;
  session.modelId = Number(options.modelOverride ?? snapshot.modelId);
  session.history = cloneJson(snapshot.history);
  session.serverState = sanitizeOpaqueState(snapshot.serverState);
  session.agentMode = options.preserveAgentMode ? currentAgentMode : 'default';
  session.autoYes = session.agentMode === 'auto-accept';
  if (previousSessionId !== session.sessionId) {
    session.grants = createSessionGrants();
  }
  session.turnState = {
    id: null,
    historyStartIndex: session.history.length,
    retrievedFilePaths: [],
    injectedContext: '',
    userInput: '',
  };
  session.clientState = {
    stickyFilePaths: new Set(snapshot.clientState.stickyFilePaths),
    editJournal: normalizeAssistantEditJournal(snapshot.clientState.editJournal),
    editCounter: Math.max(0, snapshot.clientState.editCounter ?? 0),
    safety: mergeLocalSessionSafetyState(
      session.clientState.safety,
      snapshot.clientState.safety,
    ),
  };
}

// A session the user never prompted in is not worth resuming; callers skip
// saving those so they don't evict real sessions from the recent-session store.
// Runtime notices carry role 'user' but are not user input, so a session that
// only contains those still counts as promptless.
export function sessionHasUserMessage(session: SessionState): boolean {
  return session.history.some((entry) => Boolean(userPromptText(entry)));
}

function extractMarkedSection(text: string, marker: string): string {
  const index = text.indexOf(marker);
  if (index === -1) return '';
  const after = text.slice(index + marker.length).trimStart();
  const end = after.indexOf('\n\n');
  return (end === -1 ? after : after.slice(0, end)).trim();
}

/**
 * Text the user actually typed in a history entry, or '' if the entry is not
 * user input. Only entries the runtime tagged as the start of a user turn
 * qualify: role alone is not enough, because automated turn signals are also
 * appended with role 'user' and must never be shown back to the user as if
 * they had written them.
 */
export function userPromptText(entry: ChatMessage | undefined): string {
  if (!entry || entry.role !== 'user' || entry.kind !== 'turnStart') return '';
  const text = (entry.parts ?? [])
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) return '';
  const request =
    extractMarkedSection(text, 'Current user request:') ||
    extractMarkedSection(text, 'User request:');
  const message =
    extractMarkedSection(text, 'Current user message:') ||
    extractMarkedSection(text, 'User message:');
  return (request || message || text).trim();
}

// The prompt that opened the session identifies it far better than whatever
// came last, which is often an automated mid-turn signal rather than a
// question. Snapshots too old to carry the turn tag yield '' and fall back to
// name/id in the picker, which is safer than guessing at untagged entries.
function extractFirstUserPrompt(history: ChatMessage[]): string {
  for (const entry of history) {
    const text = userPromptText(entry);
    if (text) return singleLinePreview(text, 120);
  }
  return '';
}

function metadataFromSnapshot(snapshot: ClientSessionSnapshot): SessionMetadata {
  return {
    id: snapshot.id,
    name: snapshot.name,
    rootDir: snapshot.rootDir,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    modelId: snapshot.modelId,
    messageCount: snapshot.history.length,
    // Field name is the persisted wire/DB contract; the value is the session's
    // opening prompt.
    lastUserMessage: extractFirstUserPrompt(snapshot.history),
    summaryPreview: '',
    branch: snapshot.branch ?? null,
  };
}

export function listSessionMetadata(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionMetadata[] {
  return loadAllSnapshots(rootDir, env).map(metadataFromSnapshot);
}

export function loadSessionSnapshot(
  rootDir: string,
  identifier: string,
  env: NodeJS.ProcessEnv = process.env,
): ClientSessionSnapshot | null {
  const target = String(identifier ?? '').trim();
  if (!target) return null;
  const snapshots = loadAllSnapshots(rootDir, env);
  return (
    snapshots.find((snapshot) => snapshot.id === target) ??
    snapshots.find((snapshot) => snapshot.name === target) ??
    null
  );
}
