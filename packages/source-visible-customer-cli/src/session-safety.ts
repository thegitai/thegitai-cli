import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ARTIFACT_IGNORE_DIRS,
  normalizeProjectRelativePath,
  shouldIgnoreArtifactPath,
} from './artifact-policy.js';
import {
  hashBytes,
  readFileEditSnapshot,
  storedContentBuffer,
  type StoredContentEncoding,
} from './edit-journal.js';
import {
  deleteProjectFile,
  resolveProjectPath,
  writeProjectFile,
  writeProjectFileBuffer,
} from './patcher.js';

const MAX_CHECKPOINTS = 20;
const MAX_SESSION_EDITS = 500;
const MAX_READ_RECORDS = 200;
const MAX_REDACTION_TOKENS = 500;
const MAX_SNAPSHOT_CONTENT_CHARS = 8_000_000;
const MAX_MUTATION_SCAN_FILES = 2000;
const MAX_BASELINE_CONTENT_BYTES = 50 * 1024 * 1024;

export type SessionEditOperation = 'create' | 'update' | 'delete';

export interface CheckpointFileSnapshot {
  filePath: string;
  exists: boolean;
  hash: string | null;
  content: string | null;
  contentEncoding: StoredContentEncoding;
  skipped?: string;
}

export interface SessionCheckpoint {
  id: string;
  sequence: number;
  label: string;
  turnId: string | null;
  createdAt: string;
  files: CheckpointFileSnapshot[];
}

export interface ReadCoverageRecord {
  filePath: string;
  hash: string | null;
  fullFile: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  createdAt: string;
}

export interface RedactionTokenRecord {
  token: string;
  value: string;
  filePath: string;
  hash: string | null;
  createdAt: string;
}

export interface SessionEditRecord {
  id: string;
  kind: 'tool_edit' | 'command_mutation' | 'restore';
  turnId: string | null;
  toolCallId: string | null;
  toolName: string;
  filePath: string;
  operation: SessionEditOperation;
  beforeHash: string | null;
  afterHash: string | null;
  beforeContent: string | null;
  beforeContentEncoding: StoredContentEncoding;
  createdAt: string;
  checkpointId: string | null;
  revertedAt: string | null;
}

export interface VerificationRecord {
  ok: boolean;
  toolName: string;
  command?: string;
  filePath?: string;
  createdAt: string;
  editId: string | null;
  errorCount?: number;
}

export interface EditFailureRecord {
  filePath: string;
  toolName: string;
  count: number;
  lastError: string;
  updatedAt: string;
}

export interface SessionSafetyState {
  checkpoints: SessionCheckpoint[];
  checkpointCounter: number;
  readCoverage: ReadCoverageRecord[];
  redactionTokens: RedactionTokenRecord[];
  redactionCounter: number;
  sessionEdits: SessionEditRecord[];
  sessionEditCounter: number;
  editFailures: EditFailureRecord[];
  lastVerification: VerificationRecord | null;
}

export function createSessionSafetyState(): SessionSafetyState {
  return {
    checkpoints: [],
    checkpointCounter: 0,
    readCoverage: [],
    redactionTokens: [],
    redactionCounter: 0,
    sessionEdits: [],
    sessionEditCounter: 0,
    editFailures: [],
    lastVerification: null,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeEditOperation(value: unknown): SessionEditOperation | null {
  const text = String(value ?? '');
  return text === 'create' || text === 'update' || text === 'delete'
    ? text
    : null;
}

function normalizeStoredContentEncoding(value: unknown): StoredContentEncoding {
  return value === 'base64' ? 'base64' : 'utf8';
}

function writeStoredProjectFile(
  rootDir: string,
  filePath: string,
  content: string,
  encoding: StoredContentEncoding,
): { absPath: string; changed: boolean } {
  return encoding === 'base64'
    ? writeProjectFileBuffer(rootDir, filePath, storedContentBuffer(content, encoding))
    : writeProjectFile(rootDir, filePath, content);
}

export function normalizeSessionSafetyState(value: unknown): SessionSafetyState {
  const raw = value && typeof value === 'object' ? (value as any) : {};
  const safety = createSessionSafetyState();
  safety.checkpointCounter = Math.max(
    0,
    Number.parseInt(String(raw.checkpointCounter ?? 0), 10) || 0,
  );
  safety.redactionCounter = Math.max(
    0,
    Number.parseInt(String(raw.redactionCounter ?? 0), 10) || 0,
  );
  safety.sessionEditCounter = Math.max(
    0,
    Number.parseInt(String(raw.sessionEditCounter ?? 0), 10) || 0,
  );
  if (Array.isArray(raw.checkpoints)) {
    safety.checkpoints = raw.checkpoints
      .map((item: any): SessionCheckpoint | null => {
        const id = String(item?.id ?? '').trim();
        if (!id) return null;
        const files = Array.isArray(item.files)
          ? item.files
              .map((file: any): CheckpointFileSnapshot | null => {
                const filePath = String(file?.filePath ?? '').trim();
                if (!filePath) return null;
                return {
                  filePath,
                  exists: file.exists === true,
                  hash: typeof file.hash === 'string' ? file.hash : null,
                  content: typeof file.content === 'string' ? file.content : null,
                  contentEncoding: normalizeStoredContentEncoding(
                    file.contentEncoding,
                  ),
                  skipped:
                    typeof file.skipped === 'string' && file.skipped.trim()
                      ? file.skipped.trim()
                      : undefined,
                };
              })
              .filter(Boolean) as CheckpointFileSnapshot[]
          : [];
        return {
          id,
          sequence: Math.max(0, Number.parseInt(String(item.sequence ?? 0), 10) || 0),
          label: String(item.label ?? ''),
          turnId: typeof item.turnId === 'string' && item.turnId ? item.turnId : null,
          createdAt:
            typeof item.createdAt === 'string' && item.createdAt
              ? item.createdAt
              : new Date().toISOString(),
          files,
        };
      })
      .filter(Boolean)
      .slice(-MAX_CHECKPOINTS) as SessionCheckpoint[];
  }
  if (Array.isArray(raw.readCoverage)) {
    safety.readCoverage = raw.readCoverage
      .map((item: any): ReadCoverageRecord | null => {
        const filePath = String(item?.filePath ?? '').trim();
        if (!filePath) return null;
        return {
          filePath,
          hash: typeof item.hash === 'string' ? item.hash : null,
          fullFile: item.fullFile === true,
          startLine: Math.max(1, Number.parseInt(String(item.startLine ?? 1), 10) || 1),
          endLine: Math.max(1, Number.parseInt(String(item.endLine ?? 1), 10) || 1),
          totalLines: Math.max(1, Number.parseInt(String(item.totalLines ?? 1), 10) || 1),
          createdAt:
            typeof item.createdAt === 'string' && item.createdAt
              ? item.createdAt
              : new Date().toISOString(),
        };
      })
      .filter(Boolean)
      .slice(-MAX_READ_RECORDS) as ReadCoverageRecord[];
  }
  if (Array.isArray(raw.redactionTokens)) {
    safety.redactionTokens = raw.redactionTokens
      .map((item: any): RedactionTokenRecord | null => {
        const token = String(item?.token ?? '').trim();
        const filePath = String(item?.filePath ?? '').trim();
        if (!token || !filePath || typeof item.value !== 'string') return null;
        return {
          token,
          value: item.value,
          filePath,
          hash: typeof item.hash === 'string' ? item.hash : null,
          createdAt:
            typeof item.createdAt === 'string' && item.createdAt
              ? item.createdAt
              : new Date().toISOString(),
        };
      })
      .filter(Boolean)
      .slice(-MAX_REDACTION_TOKENS) as RedactionTokenRecord[];
  }
  if (Array.isArray(raw.sessionEdits)) {
    safety.sessionEdits = raw.sessionEdits
      .map((item: any): SessionEditRecord | null => {
        const id = String(item?.id ?? '').trim();
        const operation = normalizeEditOperation(item?.operation);
        const filePath = String(item?.filePath ?? '').trim();
        if (!id || !operation || !filePath) return null;
        const kind = String(item.kind ?? '');
        return {
          id,
          kind:
            kind === 'command_mutation' || kind === 'restore'
              ? kind
              : 'tool_edit',
          turnId:
            typeof item.turnId === 'string' && item.turnId ? item.turnId : null,
          toolCallId:
            typeof item.toolCallId === 'string' && item.toolCallId
              ? item.toolCallId
              : null,
          toolName: String(item.toolName ?? ''),
          filePath,
          operation,
          beforeHash: typeof item.beforeHash === 'string' ? item.beforeHash : null,
          afterHash: typeof item.afterHash === 'string' ? item.afterHash : null,
          beforeContent:
            typeof item.beforeContent === 'string' ? item.beforeContent : null,
          beforeContentEncoding: normalizeStoredContentEncoding(
            item.beforeContentEncoding,
          ),
          createdAt:
            typeof item.createdAt === 'string' && item.createdAt
              ? item.createdAt
              : new Date().toISOString(),
          checkpointId:
            typeof item.checkpointId === 'string' && item.checkpointId
              ? item.checkpointId
              : null,
          revertedAt:
            typeof item.revertedAt === 'string' && item.revertedAt
              ? item.revertedAt
              : null,
        };
      })
      .filter(Boolean)
      .slice(-MAX_SESSION_EDITS) as SessionEditRecord[];
  }
  if (Array.isArray(raw.editFailures)) {
    safety.editFailures = raw.editFailures
      .map((item: any): EditFailureRecord | null => {
        const filePath = String(item?.filePath ?? '').trim();
        if (!filePath) return null;
        return {
          filePath,
          toolName: String(item.toolName ?? ''),
          count: Math.max(1, Number.parseInt(String(item.count ?? 1), 10) || 1),
          lastError: String(item.lastError ?? '').slice(0, 1000),
          updatedAt:
            typeof item.updatedAt === 'string' && item.updatedAt
              ? item.updatedAt
              : new Date().toISOString(),
        };
      })
      .filter(Boolean) as EditFailureRecord[];
  }
  const verification = raw.lastVerification;
  if (verification && typeof verification === 'object') {
    safety.lastVerification = {
      ok: verification.ok === true,
      toolName: String(verification.toolName ?? ''),
      command:
        typeof verification.command === 'string' && verification.command
          ? verification.command
          : undefined,
      filePath:
        typeof verification.filePath === 'string' && verification.filePath
          ? verification.filePath
          : undefined,
      createdAt:
        typeof verification.createdAt === 'string' && verification.createdAt
          ? verification.createdAt
          : new Date().toISOString(),
      editId:
        typeof verification.editId === 'string' && verification.editId
          ? verification.editId
          : null,
      errorCount:
        typeof verification.errorCount === 'number'
          ? verification.errorCount
          : undefined,
    };
  }
  return safety;
}

export function cloneSessionSafetyState(state: SessionSafetyState): SessionSafetyState {
  return normalizeSessionSafetyState(cloneJson(state));
}

export function sanitizeSessionSafetyForServer(
  state: SessionSafetyState | undefined,
): SessionSafetyState {
  const safety = cloneSessionSafetyState(state ?? createSessionSafetyState());
  safety.checkpoints = safety.checkpoints.map((checkpoint) => ({
    ...checkpoint,
    files: checkpoint.files.map((file) => ({ ...file, content: null })),
  }));
  safety.redactionTokens = safety.redactionTokens.map((token) => ({
    ...token,
    value: '',
  }));
  safety.sessionEdits = safety.sessionEdits.map((edit) => ({
    ...edit,
    beforeContent: null,
  }));
  if (safety.lastVerification?.command) {
    safety.lastVerification = {
      ...safety.lastVerification,
      command: undefined,
    };
  }
  return safety;
}

export function mergeLocalSessionSafetyState(
  local: SessionSafetyState | undefined,
  incoming: SessionSafetyState | undefined,
): SessionSafetyState {
  const localState = cloneSessionSafetyState(local ?? createSessionSafetyState());
  const next = cloneSessionSafetyState(incoming ?? createSessionSafetyState());
  const localRedactionValues = new Map(
    localState.redactionTokens.map((token) => [
      `${token.token}\0${token.filePath}\0${token.hash ?? ''}`,
      token.value,
    ]),
  );
  next.redactionTokens = next.redactionTokens.map((token) => {
    if (token.value) return token;
    const value = localRedactionValues.get(
      `${token.token}\0${token.filePath}\0${token.hash ?? ''}`,
    );
    return value == null ? token : { ...token, value };
  });
  const localCheckpointContent = new Map<
    string,
    { content: string; contentEncoding: StoredContentEncoding }
  >();
  for (const checkpoint of localState.checkpoints) {
    for (const file of checkpoint.files) {
      if (file.content == null) continue;
      localCheckpointContent.set(
        `${checkpoint.id}\0${file.filePath}\0${file.hash ?? ''}`,
        {
          content: file.content,
          contentEncoding: file.contentEncoding,
        },
      );
    }
  }
  next.checkpoints = next.checkpoints.map((checkpoint) => ({
    ...checkpoint,
    files: checkpoint.files.map((file) => {
      if (file.content != null) return file;
      const content = localCheckpointContent.get(
        `${checkpoint.id}\0${file.filePath}\0${file.hash ?? ''}`,
      );
      return content == null
        ? file
        : {
            ...file,
            content: content.content,
            contentEncoding: content.contentEncoding,
          };
    }),
  }));
  const localBeforeContent = new Map<
    string,
    { beforeContent: string; beforeContentEncoding: StoredContentEncoding }
  >(
    localState.sessionEdits
      .filter((edit) => edit.beforeContent != null)
      .map((edit) => [
        edit.id,
        {
          beforeContent: edit.beforeContent as string,
          beforeContentEncoding: edit.beforeContentEncoding,
        },
      ]),
  );
  next.sessionEdits = next.sessionEdits.map((edit) => {
    if (edit.beforeContent != null) return edit;
    const beforeContent = localBeforeContent.get(edit.id);
    return beforeContent == null
      ? edit
      : {
          ...edit,
          beforeContent: beforeContent.beforeContent,
          beforeContentEncoding: beforeContent.beforeContentEncoding,
        };
  });
  return next;
}

function normalizeFilePath(rootDir: string, filePath: string): string | null {
  const relPath = normalizeProjectRelativePath(rootDir, filePath);
  if (!relPath || shouldIgnoreArtifactPath(relPath)) return null;
  return relPath.split(path.sep).join('/');
}

function readCheckpointSnapshot(
  rootDir: string,
  filePath: string,
): CheckpointFileSnapshot {
  const normalized = normalizeFilePath(rootDir, filePath);
  if (!normalized) {
    return {
      filePath,
      exists: false,
      hash: null,
      content: null,
      contentEncoding: 'utf8',
      skipped: `Refusing to checkpoint ignored or out-of-project path: ${filePath}`,
    };
  }
  const snapshot = readFileEditSnapshot(rootDir, normalized);
  if (snapshot.error) {
    return {
      filePath: normalized,
      exists: snapshot.exists,
      hash: snapshot.hash,
      content: null,
      contentEncoding: snapshot.contentEncoding,
      skipped: snapshot.error,
    };
  }
  if (snapshot.content && snapshot.content.length > MAX_SNAPSHOT_CONTENT_CHARS) {
    return {
      filePath: normalized,
      exists: snapshot.exists,
      hash: snapshot.hash,
      content: null,
      contentEncoding: snapshot.contentEncoding,
      skipped: `File is too large to checkpoint (${snapshot.content.length} chars).`,
    };
  }
  return {
    filePath: normalized,
    exists: snapshot.exists,
    hash: snapshot.hash,
    content: snapshot.content,
    contentEncoding: snapshot.contentEncoding,
  };
}

export function createPromptCheckpoint(
  state: SessionSafetyState,
  label: string,
  turnId: string | null,
): SessionCheckpoint {
  const checkpoint: SessionCheckpoint = {
    id: `checkpoint_${++state.checkpointCounter}`,
    sequence: state.checkpointCounter,
    label,
    turnId,
    createdAt: new Date().toISOString(),
    files: [],
  };
  state.checkpoints.push(checkpoint);
  if (state.checkpoints.length > MAX_CHECKPOINTS) {
    state.checkpoints.splice(0, state.checkpoints.length - MAX_CHECKPOINTS);
  }
  return checkpoint;
}

export function ensureActiveCheckpoint(
  state: SessionSafetyState,
  turnId: string | null,
): SessionCheckpoint {
  return (
    state.checkpoints[state.checkpoints.length - 1] ??
    createPromptCheckpoint(state, 'session start', turnId)
  );
}

export function rememberCheckpointFiles(
  state: SessionSafetyState,
  rootDir: string,
  filePaths: readonly string[],
  turnId: string | null,
): SessionCheckpoint {
  const checkpoint = ensureActiveCheckpoint(state, turnId);
  const existing = new Set(checkpoint.files.map((file) => file.filePath));
  for (const rawPath of filePaths) {
    const normalized = normalizeFilePath(rootDir, rawPath);
    if (!normalized || existing.has(normalized)) continue;
    checkpoint.files.push(readCheckpointSnapshot(rootDir, normalized));
    existing.add(normalized);
  }
  return checkpoint;
}

export function recordReadCoverage(
  state: SessionSafetyState,
  record: ReadCoverageRecord,
): void {
  state.readCoverage.push(record);
  if (state.readCoverage.length > MAX_READ_RECORDS) {
    state.readCoverage.splice(0, state.readCoverage.length - MAX_READ_RECORDS);
  }
}

export function hasFreshFullReadCoverage(
  state: SessionSafetyState,
  filePath: string,
  hash: string | null,
): boolean {
  const records = state.readCoverage.filter(
    (record) => record.filePath === filePath && record.hash === hash,
  );
  if (records.some((record) => record.fullFile)) return true;
  const totalLines = records[records.length - 1]?.totalLines ?? 0;
  if (totalLines <= 0) return false;
  const intervals = records
    .map((record) => ({
      start: Math.max(1, record.startLine),
      end: Math.max(record.startLine, record.endLine),
    }))
    .sort((a, b) => a.start - b.start);
  let coveredEnd = 0;
  for (const interval of intervals) {
    if (interval.start > coveredEnd + 1) return false;
    coveredEnd = Math.max(coveredEnd, interval.end);
    if (coveredEnd >= totalLines) return true;
  }
  return false;
}

const SENSITIVE_VALUE_PATTERN =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS(?:[_-]|$)|CREDENTIAL(?:[_-]|$)|PRIVATE[_-]?KEY)[A-Z0-9_]*)\b\s*[:=]\s*(['"]?)([^\s'",;]+)/gi;

const PEM_BLOCK_PATTERN =
  /-----BEGIN [^-]*(?:PRIVATE KEY|SECRET KEY|OPENSSH PRIVATE KEY)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|SECRET KEY|OPENSSH PRIVATE KEY)-----/gi;

function createRedactionToken(
  state: SessionSafetyState,
  value: string,
  filePath: string,
  hash: string | null,
): string {
  const existing = state.redactionTokens.find(
    (entry) =>
      entry.value === value && entry.filePath === filePath && entry.hash === hash,
  );
  if (existing) return existing.token;
  const token = `[REDACTED:${++state.redactionCounter}]`;
  state.redactionTokens.push({
    token,
    value,
    filePath,
    hash,
    createdAt: new Date().toISOString(),
  });
  if (state.redactionTokens.length > MAX_REDACTION_TOKENS) {
    state.redactionTokens.splice(0, state.redactionTokens.length - MAX_REDACTION_TOKENS);
  }
  return token;
}

export function redactContentWithStableTokens(
  state: SessionSafetyState,
  content: string,
  filePath: string,
  hash: string | null,
): {
  content: string;
  tokens: string[];
} {
  const tokens: string[] = [];
  let next = content.replace(PEM_BLOCK_PATTERN, (value) => {
    const token = createRedactionToken(state, value, filePath, hash);
    tokens.push(token);
    return token;
  });
  next = next.replace(
    SENSITIVE_VALUE_PATTERN,
    (_match, key: string, quote: string, value: string) => {
      if (value.startsWith('[REDACTED:')) {
        return `${key}=${quote}${value}${quote}`;
      }
      const token = createRedactionToken(state, value, filePath, hash);
      tokens.push(token);
      return `${key}=${quote}${token}${quote}`;
    },
  );
  return { content: next, tokens };
}

export function resolveRedactionTokens(
  state: SessionSafetyState | undefined,
  text: string,
  filePath: string,
  hash: string | null,
): string {
  if (!state || !text.includes('[REDACTED:')) return text;
  let next = text;
  for (const entry of state.redactionTokens) {
    if (entry.filePath !== filePath) continue;
    if (entry.hash !== hash) continue;
    next = next.split(entry.token).join(entry.value);
  }
  return next;
}

const DOTENV_ASSIGNMENT_PATTERN =
  /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=)(.*)$/;
const DOTENV_COMMENT_PATTERN = /^(\s*#\s*)(\S.*)$/;

/**
 * Redact a dotenv file's values while leaving keys visible. Every assignment's
 * value is replaced with a stable, reversible token so the agent can see the
 * file's structure and edit it (remove or replace lines) without ever seeing a
 * secret value; `resolveRedactionTokens` swaps the real values back on write.
 * Comment bodies are tokenized too, because developers routinely leave
 * commented-out credentials in dotenv files and those must not leak where the
 * opaque preview would have hidden them. Callers must confirm the content is
 * clean dotenv (`looksLikeEditableDotenv`) first so the only non-assignment
 * lines reaching here are blanks and comments.
 */
export function redactDotenvWithStableTokens(
  state: SessionSafetyState,
  content: string,
  filePath: string,
  hash: string | null,
): {
  content: string;
  tokens: string[];
} {
  const tokens: string[] = [];
  const redactedLines = content.split('\n').map((line) => {
    const assignment = DOTENV_ASSIGNMENT_PATTERN.exec(line);
    if (assignment) {
      const [, keyPart, value] = assignment;
      if (value.trim() === '' || value.includes('[REDACTED:')) return line;
      const token = createRedactionToken(state, value, filePath, hash);
      tokens.push(token);
      return `${keyPart}${token}`;
    }
    const comment = DOTENV_COMMENT_PATTERN.exec(line);
    if (comment) {
      const [, prefix, body] = comment;
      if (body.includes('[REDACTED:')) return line;
      const token = createRedactionToken(state, body, filePath, hash);
      tokens.push(token);
      return `${prefix}${token}`;
    }
    return line;
  });
  return { content: redactedLines.join('\n'), tokens };
}

/**
 * The redaction-token registry is capped at `MAX_REDACTION_TOKENS`; a read that
 * emits more tokens than that would evict its own oldest tokens, leaving
 * `[REDACTED:n]` markers in the preview that `write_file`/`str_replace` can no
 * longer resolve (silently writing the literal token back). So a dotenv file
 * with more tokenizable lines than the budget must not use the editable preview
 * — the caller falls back to the opaque blackout instead.
 */
export function dotenvFitsRedactionBudget(content: string): boolean {
  let count = 0;
  for (const line of content.split('\n')) {
    const assignment = DOTENV_ASSIGNMENT_PATTERN.exec(line);
    if (assignment) {
      if (assignment[2].trim() !== '' && !assignment[2].includes('[REDACTED:')) {
        count += 1;
      }
    } else if (DOTENV_COMMENT_PATTERN.test(line)) {
      count += 1;
    }
    if (count > MAX_REDACTION_TOKENS) return false;
  }
  return true;
}

export function recordSessionEdit(
  state: SessionSafetyState,
  edit: Omit<SessionEditRecord, 'id' | 'createdAt' | 'revertedAt'> & {
    createdAt?: string;
    revertedAt?: string | null;
  },
): SessionEditRecord {
  const record: SessionEditRecord = {
    ...edit,
    id: `session_edit_${++state.sessionEditCounter}`,
    createdAt: edit.createdAt ?? new Date().toISOString(),
    revertedAt: edit.revertedAt ?? null,
  };
  state.sessionEdits.push(record);
  if (state.sessionEdits.length > MAX_SESSION_EDITS) {
    state.sessionEdits.splice(0, state.sessionEdits.length - MAX_SESSION_EDITS);
  }
  return record;
}

export function recordEditFailure(
  state: SessionSafetyState | undefined,
  filePath: string,
  toolName: string,
  error: string,
): EditFailureRecord | null {
  if (!state || !filePath) return null;
  const now = new Date().toISOString();
  let record = state.editFailures.find((item) => item.filePath === filePath);
  if (!record) {
    record = { filePath, toolName, count: 0, lastError: '', updatedAt: now };
    state.editFailures.push(record);
  }
  record.toolName = toolName;
  record.count += 1;
  record.lastError = error.slice(0, 1000);
  record.updatedAt = now;
  return record;
}

export function clearEditFailure(
  state: SessionSafetyState | undefined,
  filePath: string,
): void {
  if (!state || !filePath) return;
  state.editFailures = state.editFailures.filter((item) => item.filePath !== filePath);
}

export function recordVerification(
  state: SessionSafetyState | undefined,
  verification: VerificationRecord,
): void {
  if (!state) return;
  state.lastVerification = verification;
}

export function listCheckpointSummaries(state: SessionSafetyState): any[] {
  return state.checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    sequence: checkpoint.sequence,
    label: checkpoint.label,
    turnId: checkpoint.turnId,
    createdAt: checkpoint.createdAt,
    fileCount: checkpoint.files.length,
    files: checkpoint.files.map((file) => ({
      filePath: file.filePath,
      exists: file.exists,
      hash: file.hash,
      restorable: !file.skipped && (file.content !== null || !file.exists),
      skipped: file.skipped,
    })),
  }));
}

export function listSessionEditSummaries(state: SessionSafetyState): any[] {
  return state.sessionEdits.map((edit) => ({
    id: edit.id,
    kind: edit.kind,
    turnId: edit.turnId,
    toolName: edit.toolName,
    filePath: edit.filePath,
    operation: edit.operation,
    beforeHash: edit.beforeHash,
    afterHash: edit.afterHash,
    createdAt: edit.createdAt,
    checkpointId: edit.checkpointId,
    revertedAt: edit.revertedAt,
  }));
}

function latestTrackedHashAfterCheckpoint(
  state: SessionSafetyState,
  filePath: string,
  checkpoint: SessionCheckpoint,
): string | null | undefined {
  for (let i = state.sessionEdits.length - 1; i >= 0; i--) {
    const edit = state.sessionEdits[i]!;
    if (edit.filePath !== filePath || edit.revertedAt) continue;
    if (edit.createdAt < checkpoint.createdAt) break;
    return edit.afterHash;
  }
  return undefined;
}

function validateRestoreTarget(
  state: SessionSafetyState,
  rootDir: string,
  checkpoint: SessionCheckpoint,
  snapshot: CheckpointFileSnapshot,
): { ok: true } | { ok: false; error: string; currentHash: string | null } {
  if (snapshot.skipped) {
    return {
      ok: false,
      error: `Cannot restore ${snapshot.filePath}: ${snapshot.skipped}`,
      currentHash: null,
    };
  }
  if (snapshot.exists && snapshot.content === null) {
    return {
      ok: false,
      error: `Cannot restore ${snapshot.filePath}: checkpoint has no stored file content.`,
      currentHash: null,
    };
  }
  const current = readFileEditSnapshot(rootDir, snapshot.filePath);
  if (current.error) {
    return {
      ok: false,
      error: `Cannot inspect ${snapshot.filePath} before restore: ${current.error}`,
      currentHash: current.hash,
    };
  }
  const latestTrackedHash = latestTrackedHashAfterCheckpoint(
    state,
    snapshot.filePath,
    checkpoint,
  );
  if (
    current.hash !== snapshot.hash &&
    latestTrackedHash === undefined
  ) {
    return {
      ok: false,
      error:
        `Cannot restore ${snapshot.filePath}: current hash differs from ${checkpoint.id} and no assistant or command edit explains the change.`,
      currentHash: current.hash,
    };
  }
  if (
    current.hash !== snapshot.hash &&
    latestTrackedHash !== undefined &&
    current.hash !== latestTrackedHash
  ) {
    return {
      ok: false,
      error:
        `Cannot restore ${snapshot.filePath}: current hash is not a known assistant or command state after ${checkpoint.id}.`,
      currentHash: current.hash,
    };
  }
  return { ok: true };
}

export async function restoreCheckpointFiles(args: {
  state: SessionSafetyState;
  rootDir: string;
  checkpointId: string;
  filePaths?: string[];
  currentTurnId: string | null;
  currentToolCallId: string | null;
}): Promise<{
  ok: boolean;
  checkpointId: string;
  changed: boolean;
  restored: any[];
  error?: string;
  failures?: any[];
  rolledBack?: any[];
  rollbackFailures?: any[];
}> {
  const checkpoint = args.state.checkpoints.find(
    (item) => item.id === args.checkpointId,
  );
  if (!checkpoint) {
    return {
      ok: false,
      checkpointId: args.checkpointId,
      changed: false,
      restored: [],
      error: `Checkpoint not found: ${args.checkpointId}`,
    };
  }
  const requested = new Set(
    (args.filePaths ?? [])
      .map((filePath) => normalizeFilePath(args.rootDir, filePath))
      .filter(Boolean) as string[],
  );
  const targets = requested.size
    ? checkpoint.files.filter((file) => requested.has(file.filePath))
    : checkpoint.files;
  const missing = [...requested].filter(
    (filePath) => !checkpoint.files.some((file) => file.filePath === filePath),
  );
  if (missing.length) {
    return {
      ok: false,
      checkpointId: checkpoint.id,
      changed: false,
      restored: [],
      error: `Checkpoint ${checkpoint.id} has no snapshot for: ${missing.join(', ')}`,
    };
  }
  const failures: any[] = [];
  for (const snapshot of targets) {
    const validation = validateRestoreTarget(
      args.state,
      args.rootDir,
      checkpoint,
      snapshot,
    );
    if (!validation.ok) {
      failures.push({
        filePath: snapshot.filePath,
        error: validation.error,
        expectedHash: snapshot.hash,
        currentHash: validation.currentHash,
      });
    }
  }
  if (failures.length) {
    return {
      ok: false,
      checkpointId: checkpoint.id,
      changed: false,
      restored: [],
      error: 'Checkpoint restore refused because one or more files are unsafe to restore.',
      failures,
    };
  }
  const restored: any[] = [];
  const applied: {
    snapshot: CheckpointFileSnapshot;
    before: ReturnType<typeof readFileEditSnapshot>;
    after: ReturnType<typeof readFileEditSnapshot>;
  }[] = [];
  let changed = false;
  for (const snapshot of targets) {
    const before = readFileEditSnapshot(args.rootDir, snapshot.filePath);
    try {
      if (snapshot.exists) {
        const result = writeStoredProjectFile(
          args.rootDir,
          snapshot.filePath,
          snapshot.content ?? '',
          snapshot.contentEncoding,
        );
        if (result.changed) changed = true;
      } else {
        const result = deleteProjectFile(args.rootDir, snapshot.filePath);
        if (result.deleted) changed = true;
      }
      const after = readFileEditSnapshot(args.rootDir, snapshot.filePath);
      applied.push({ snapshot, before, after });
    } catch (err: any) {
      const rolledBack: any[] = [];
      const rollbackFailures: any[] = [];
      const rollbackTargets = [
        { snapshot, before },
        ...applied.map((item) => ({
          snapshot: item.snapshot,
          before: item.before,
        })).reverse(),
      ];
      for (const item of rollbackTargets) {
        try {
          if (item.before.exists) {
            if (item.before.content == null) {
              throw new Error('previous file content is unavailable');
            }
            writeStoredProjectFile(
              args.rootDir,
              item.snapshot.filePath,
              item.before.content,
              item.before.contentEncoding,
            );
          } else {
            deleteProjectFile(args.rootDir, item.snapshot.filePath);
          }
          rolledBack.push({ filePath: item.snapshot.filePath });
        } catch (rollbackErr: any) {
          rollbackFailures.push({
            filePath: item.snapshot.filePath,
            error: rollbackErr?.message ? String(rollbackErr.message) : String(rollbackErr),
          });
        }
      }
      return {
        ok: false,
        checkpointId: checkpoint.id,
        changed: applied.length > 0,
        restored: applied.map((item) => ({
          filePath: item.snapshot.filePath,
          restoredHash: item.after.hash,
          checkpointHash: item.snapshot.hash,
        })),
        error: `Checkpoint restore failed while restoring ${snapshot.filePath}.`,
        failures: [
          {
            filePath: snapshot.filePath,
            error: err?.message ? String(err.message) : String(err),
          },
        ],
        rolledBack,
        rollbackFailures,
      };
    }
  }
  for (const item of applied) {
    recordSessionEdit(args.state, {
      kind: 'restore',
      turnId: args.currentTurnId,
      toolCallId: args.currentToolCallId,
      toolName: 'restore_to_checkpoint',
      filePath: item.snapshot.filePath,
      operation: item.snapshot.exists
        ? item.before.exists
          ? 'update'
          : 'create'
        : 'delete',
      beforeHash: item.before.hash,
      afterHash: item.after.hash,
      beforeContent: item.before.content,
      beforeContentEncoding: item.before.contentEncoding,
      checkpointId: checkpoint.id,
    });
    restored.push({
      filePath: item.snapshot.filePath,
      restoredHash: item.after.hash,
      checkpointHash: item.snapshot.hash,
    });
  }
  return {
    ok: true,
    checkpointId: checkpoint.id,
    changed,
    restored,
  };
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trimEnd();
  } catch {
    return null;
  }
}

function gitBuffer(args: string[], cwd: string): Buffer | null {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

export function findGitRoot(startDir: string): string | null {
  const root = git(['rev-parse', '--show-toplevel'], startDir);
  return root ? path.resolve(root) : null;
}

export function findNestedGitRoots(rootDir: string, limit: number = 12): string[] {
  const roots: string[] = [];
  const root = path.resolve(rootDir);
  const visit = (dir: string, depth: number): void => {
    if (roots.length >= limit || depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('.git')) {
      roots.push(path.relative(root, dir) || '.');
      return;
    }
    for (const entry of entries) {
      if (ARTIFACT_IGNORE_DIRS.has(entry)) continue;
      const abs = path.join(dir, entry);
      try {
        if (lstatSync(abs).isDirectory()) visit(abs, depth + 1);
      } catch {}
    }
  };
  visit(root, 0);
  return roots;
}

export function buildNestedGitHint(rootDir: string, command: string): any | null {
  if (!/\bgit\b/.test(command)) return null;
  if (findGitRoot(rootDir)) return null;
  const nestedRoots = findNestedGitRoots(rootDir);
  if (!nestedRoots.length) return null;
  return {
    currentCwdIsGitWorkTree: false,
    nestedGitRoots: nestedRoots,
    message:
      `This cwd is not a git worktree, but nested git repos exist: ${nestedRoots.join(', ')}. ` +
      'Run git commands from the intended nested repo cwd.',
  };
}

function gitStatusPaths(rootDir: string): string[] {
  const output = git(['status', '--porcelain=v1', '--untracked-files=all'], rootDir);
  if (output == null || !output.trim()) return [];
  const paths = new Set<string>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const filePath = raw.includes(' -> ') ? raw.split(' -> ').pop()! : raw;
    const normalized = normalizeFilePath(rootDir, filePath);
    if (normalized) paths.add(normalized);
  }
  return [...paths].sort();
}

export interface FilesystemStat {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function filesystemStatMap(rootDir: string): Map<string, FilesystemStat> {
  const root = path.resolve(rootDir);
  const stats = new Map<string, FilesystemStat>();
  const visit = (dir: string): void => {
    if (stats.size >= MAX_MUTATION_SCAN_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stats.size >= MAX_MUTATION_SCAN_FILES) return;
      if (ARTIFACT_IGNORE_DIRS.has(entry)) continue;
      const abs = path.join(dir, entry);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || shouldIgnoreArtifactPath(rel)) continue;
      try {
        const stat = lstatSync(abs);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          visit(abs);
        } else if (stat.isFile()) {
          stats.set(rel, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          });
        }
      } catch {}
    }
  };
  visit(root);
  return stats;
}

function statsDiffer(a: FilesystemStat, b: FilesystemStat): boolean {
  return (
    a.size !== b.size ||
    a.mtimeMs !== b.mtimeMs ||
    a.ctimeMs !== b.ctimeMs
  );
}

function readGitHeadSnapshot(rootDir: string, filePath: string): CheckpointFileSnapshot | null {
  const gitRoot = findGitRoot(rootDir);
  if (!gitRoot) return null;
  const abs = resolveProjectPath(rootDir, filePath);
  const relToGit = path.relative(gitRoot, abs).split(path.sep).join('/');
  const content = gitBuffer(['show', `HEAD:${relToGit}`], gitRoot);
  if (content == null) return null;
  return {
    filePath,
    exists: true,
    hash: hashBytes(content),
    content: content.toString('base64'),
    contentEncoding: 'base64',
  };
}

export interface MutationTracker {
  mode: 'git' | 'filesystem';
  beforePaths: string[];
  beforeSnapshots: Map<string, CheckpointFileSnapshot>;
  beforeStats?: Map<string, FilesystemStat>;
  baselineTruncated?: boolean;
}

export function captureMutationBaseline(
  rootDir: string,
  options?: { contentBudgetBytes?: number },
): MutationTracker {
  const mode = findGitRoot(rootDir) ? 'git' : 'filesystem';
  if (mode === 'git') {
    const beforePaths = gitStatusPaths(rootDir);
    const beforeSnapshots = new Map<string, CheckpointFileSnapshot>();
    for (const filePath of beforePaths) {
      beforeSnapshots.set(filePath, readCheckpointSnapshot(rootDir, filePath));
    }
    return { mode, beforePaths, beforeSnapshots };
  }
  const contentBudget = options?.contentBudgetBytes ?? MAX_BASELINE_CONTENT_BYTES;
  const beforeStats = filesystemStatMap(rootDir);
  const beforePaths = [...beforeStats.keys()].sort();
  const beforeSnapshots = new Map<string, CheckpointFileSnapshot>();
  let baselineBytesUsed = 0;
  let baselineTruncated = false;
  for (const filePath of beforePaths) {
    const stat = beforeStats.get(filePath)!;
    if (baselineBytesUsed + stat.size > contentBudget) {
      baselineTruncated = true;
      beforeSnapshots.set(filePath, {
        filePath,
        exists: true,
        hash: null,
        content: null,
        contentEncoding: 'utf8',
        skipped: `Pre-command snapshot skipped: project baseline content budget exceeded (${contentBudget} bytes). Restore for this file is not available.`,
      });
      continue;
    }
    const snapshot = readCheckpointSnapshot(rootDir, filePath);
    beforeSnapshots.set(filePath, snapshot);
    if (snapshot.content) baselineBytesUsed += snapshot.content.length;
  }
  return { mode, beforePaths, beforeSnapshots, beforeStats, baselineTruncated };
}

export function collectCommandMutations(args: {
  state: SessionSafetyState;
  rootDir: string;
  tracker: MutationTracker;
  toolName: string;
  toolCallId: string | null;
  turnId: string | null;
  checkpointId: string | null;
}): SessionEditRecord[] {
  let candidatePaths: Set<string>;
  if (args.tracker.mode === 'git') {
    const afterPaths = gitStatusPaths(args.rootDir);
    candidatePaths = new Set([...args.tracker.beforePaths, ...afterPaths]);
  } else {
    const afterStats = filesystemStatMap(args.rootDir);
    candidatePaths = new Set<string>();
    const beforeStats = args.tracker.beforeStats ?? new Map<string, FilesystemStat>();
    for (const [filePath, stat] of afterStats) {
      const beforeStat = beforeStats.get(filePath);
      if (!beforeStat || statsDiffer(beforeStat, stat)) {
        candidatePaths.add(filePath);
      }
    }
    for (const filePath of beforeStats.keys()) {
      if (!afterStats.has(filePath)) candidatePaths.add(filePath);
    }
  }
  const records: SessionEditRecord[] = [];
  const checkpoint = args.checkpointId
    ? args.state.checkpoints.find((item) => item.id === args.checkpointId)
    : null;
  const checkpointFiles = new Set(
    checkpoint?.files.map((snapshot) => snapshot.filePath) ?? [],
  );
  for (const filePath of candidatePaths) {
    const after = readCheckpointSnapshot(args.rootDir, filePath);
    const before =
      args.tracker.beforeSnapshots.get(filePath) ??
      readGitHeadSnapshot(args.rootDir, filePath) ??
      {
        filePath,
        exists: false,
        hash: null,
        content: null,
        contentEncoding: 'utf8',
      };
    if (before.hash === after.hash && !before.skipped) continue;
    if (checkpoint && !checkpointFiles.has(filePath)) {
      checkpoint.files.push(before);
      checkpointFiles.add(filePath);
    }
    const operation: SessionEditOperation = !before.exists
      ? 'create'
      : !after.exists
        ? 'delete'
        : 'update';
    const record = recordSessionEdit(args.state, {
      kind: 'command_mutation',
      turnId: args.turnId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      filePath,
      operation,
      beforeHash: before.hash,
      afterHash: after.hash,
      beforeContent: before.content,
      beforeContentEncoding: before.contentEncoding,
      checkpointId: args.checkpointId,
    });
    records.push(record);
  }
  return records;
}

export function getCurrentFileHash(rootDir: string, filePath: string): string | null {
  const snapshot = readFileEditSnapshot(rootDir, filePath);
  return snapshot.hash;
}
