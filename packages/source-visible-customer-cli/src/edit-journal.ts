import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BINARY_ARTIFACT_EXTENSIONS } from './artifact-policy.js';
import { resolveProjectPath } from './patcher.js';

export type EditToolName =
  | 'write_file'
  | 'patch_file'
  | 'str_replace'
  | 'delete_file'
  | 'replace_document_text';

export type AssistantEditOperation = 'create' | 'update' | 'delete';

export type StoredContentEncoding = 'utf8' | 'base64';

export interface FileEditSnapshot {
  exists: boolean;
  content: string | null;
  contentEncoding: StoredContentEncoding;
  hash: string | null;
  error?: string;
}

export interface AssistantEditRecord {
  id: string;
  turnId: string | null;
  toolCallId: string;
  toolName: EditToolName;
  filePath: string;
  operation: AssistantEditOperation;
  beforeHash: string | null;
  afterHash: string | null;
  beforeContent: string | null;
  beforeContentEncoding: StoredContentEncoding;
  createdAt: string;
  revertedAt: string | null;
  revertedByToolCallId: string | null;
  gitWorkTree: boolean;
}

export const MAX_EDIT_JOURNAL_RECORDS = 50;

const MAX_STORED_CONTENT_CHARS = 8_000_000;

export function hashBytes(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function hashContent(content: string): string {
  return hashBytes(Buffer.from(content, 'utf8'));
}

export function hashStoredContent(
  content: string,
  encoding: StoredContentEncoding = 'utf8',
): string {
  return encoding === 'base64'
    ? hashBytes(Buffer.from(content, 'base64'))
    : hashContent(content);
}

export function storedContentBuffer(
  content: string,
  encoding: StoredContentEncoding = 'utf8',
): Buffer {
  return encoding === 'base64'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf8');
}

function snapshotEncoding(filePath: string, content: Buffer): StoredContentEncoding {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_ARTIFACT_EXTENSIONS.has(ext)) return 'base64';
  if (content.includes(0)) return 'base64';
  return 'utf8';
}

export function readFileEditSnapshot(
  rootDir: string,
  filePath: string,
): FileEditSnapshot {
  try {
    const absPath = resolveProjectPath(rootDir, filePath);
    if (!existsSync(absPath)) {
      return { exists: false, content: null, contentEncoding: 'utf8', hash: null };
    }
    if (lstatSync(absPath).isSymbolicLink()) {
      return {
        exists: true,
        content: null,
        contentEncoding: 'utf8',
        hash: null,
        error: `Refusing to snapshot symbolic link: ${filePath}`,
      };
    }
    const content = readFileSync(absPath);
    const encoding = snapshotEncoding(filePath, content);
    return {
      exists: true,
      content:
        encoding === 'base64' ? content.toString('base64') : content.toString('utf8'),
      contentEncoding: encoding,
      hash: hashBytes(content),
    };
  } catch (err: any) {
    return {
      exists: false,
      content: null,
      contentEncoding: 'utf8',
      hash: null,
      error: err?.message ? String(err.message) : String(err),
    };
  }
}

export function isGitWorkTree(rootDir: string): boolean {
  try {
    const output = execFileSync(
      'git',
      ['-C', rootDir, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output.trim() === 'true';
  } catch {
    return false;
  }
}

export function isEditToolName(toolName: string): toolName is EditToolName {
  return (
    toolName === 'write_file' ||
    toolName === 'patch_file' ||
    toolName === 'str_replace' ||
    toolName === 'delete_file' ||
    toolName === 'replace_document_text'
  );
}

export function operationFromSnapshots(
  before: FileEditSnapshot,
  after: FileEditSnapshot,
): AssistantEditOperation | null {
  if (before.hash === after.hash) return null;
  if (!before.exists && after.exists) return 'create';
  if (before.exists && !after.exists) return 'delete';
  if (before.exists && after.exists) return 'update';
  return null;
}

export function canStoreEditSnapshot(snapshot: FileEditSnapshot): boolean {
  return (
    snapshot.error === undefined &&
    (snapshot.content === null ||
      snapshot.content.length <= MAX_STORED_CONTENT_CHARS)
  );
}

export function normalizeAssistantEditJournal(
  value: unknown,
): AssistantEditRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw): AssistantEditRecord | null => {
      if (!raw || typeof raw !== 'object') return null;
      const entry = raw as Record<string, unknown>;
      const toolName = String(entry.toolName ?? '');
      const operation = String(entry.operation ?? '');
      if (!isEditToolName(toolName)) return null;
      if (
        operation !== 'create' &&
        operation !== 'update' &&
        operation !== 'delete'
      ) {
        return null;
      }
      const id = String(entry.id ?? '').trim();
      const filePath = String(entry.filePath ?? '').trim();
      const toolCallId = String(entry.toolCallId ?? '').trim();
      if (!id || !filePath || !toolCallId) return null;
      return {
        id,
        turnId:
          typeof entry.turnId === 'string' && entry.turnId.trim()
            ? entry.turnId.trim()
            : null,
        toolCallId,
        toolName,
        filePath,
        operation,
        beforeHash:
          typeof entry.beforeHash === 'string' && entry.beforeHash
            ? entry.beforeHash
            : null,
        afterHash:
          typeof entry.afterHash === 'string' && entry.afterHash
            ? entry.afterHash
            : null,
        beforeContent:
          typeof entry.beforeContent === 'string' ? entry.beforeContent : null,
        beforeContentEncoding:
          entry.beforeContentEncoding === 'base64' ? 'base64' : 'utf8',
        createdAt:
          typeof entry.createdAt === 'string' && entry.createdAt
            ? entry.createdAt
            : new Date().toISOString(),
        revertedAt:
          typeof entry.revertedAt === 'string' && entry.revertedAt
            ? entry.revertedAt
            : null,
        revertedByToolCallId:
          typeof entry.revertedByToolCallId === 'string' &&
          entry.revertedByToolCallId
            ? entry.revertedByToolCallId
            : null,
        gitWorkTree: entry.gitWorkTree === true,
      };
    })
    .filter(Boolean)
    .slice(-MAX_EDIT_JOURNAL_RECORDS) as AssistantEditRecord[];
}

export function formatRecentAssistantEdits(
  records: AssistantEditRecord[],
  maxItems: number = 8,
): string {
  const active = records.filter((record) => !record.revertedAt);
  if (!active.length) return '';
  return active
    .slice(-maxItems)
    .reverse()
    .map((record) => {
      const turn = record.turnId ? `, ${record.turnId}` : '';
      return `- ${record.id}: ${record.operation} ${record.filePath} via ${record.toolName}${turn}`;
    })
    .join('\n');
}
