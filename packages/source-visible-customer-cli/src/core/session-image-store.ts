import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getClientStateDir } from '../client-state.js';
import {
  MAX_IMAGE_SIZE_BYTES,
  imageExtensionForMime,
  isSupportedImageMimeType,
  sniffImageMimeType,
} from './image-limits.js';
import type { ImageMimeType } from '../types.js';






















const IMAGE_FILE_MODE = 0o600;
const IMAGE_DIR_MODE = 0o700;


export const SESSION_IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredSessionImage {
  cachePath: string;
  mimeType: ImageMimeType;
  base64Data: string;







  index: number;
}







let activeSessionId: string | null = null;

export function setImageStoreSession(sessionId: string | null): void {
  activeSessionId = String(sessionId ?? '').trim() || null;
  contentIndex.clear();
}















const contentIndex = new Map<string, string>();

function imageContentKey(base64Data: string): string {
  return createHash('sha256').update(base64Data).digest('hex');
}

function rememberStoredImage(base64Data: string, cachePath: string): void {
  contentIndex.set(imageContentKey(base64Data), cachePath);
}






export function findStoredImageByContent(
  base64Data: string,
): string | undefined {
  const cachePath = contentIndex.get(imageContentKey(base64Data));
  if (!cachePath) return undefined;
  if (!existsSync(cachePath)) {
    contentIndex.delete(imageContentKey(base64Data));
    return undefined;
  }
  return cachePath;
}

export function getImageStoreSession(): string | null {
  return activeSessionId;
}

function safeSessionDirName(sessionId: string): string {
  const normalized = String(sessionId ?? '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error(`Invalid session id "${sessionId}".`);
  }
  return normalized;
}

export function getSessionImageBaseDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getClientStateDir(env), 'sessions', 'images');
}

export function getSessionImageDir(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getSessionImageBaseDir(env), safeSessionDirName(sessionId));
}












function nextImageNumber(dir: string): number {
  if (!existsSync(dir)) return 1;
  let highest = 0;
  for (const name of readdirSync(dir)) {
    const parsed = Number.parseInt(path.basename(name, path.extname(name)), 10);
    if (Number.isInteger(parsed) && parsed > highest) highest = parsed;
  }
  return highest + 1;
}

function ensureSessionImageDir(sessionId: string, env: NodeJS.ProcessEnv): string {
  const dir = getSessionImageDir(sessionId, env);
  mkdirSync(dir, { recursive: true, mode: IMAGE_DIR_MODE });
  return dir;
}





export function storeSessionImageBytes({
  sessionId,
  base64Data,
  mimeType,
  env = process.env,
}: {
  sessionId: string;
  base64Data: string;
  mimeType: ImageMimeType;
  env?: NodeJS.ProcessEnv;
}): StoredSessionImage {
  const dir = ensureSessionImageDir(sessionId, env);
  const index = nextImageNumber(dir);
  const cachePath = path.join(dir, `${index}${imageExtensionForMime(mimeType)}`);
  writeFileSync(cachePath, Buffer.from(base64Data, 'base64'), {
    mode: IMAGE_FILE_MODE,
  });
  rememberStoredImage(base64Data, cachePath);
  return { cachePath, mimeType, base64Data, index };
}









export function tryCacheAttachmentBytes({
  base64Data,
  mimeType,
  env = process.env,
}: {
  base64Data: string;
  mimeType: ImageMimeType;
  env?: NodeJS.ProcessEnv;
}): { cachePath: string; index: number } | undefined {
  if (!activeSessionId) return undefined;
  try {
    const stored = storeSessionImageBytes({
      sessionId: activeSessionId,
      base64Data,
      mimeType,
      env,
    });
    return { cachePath: stored.cachePath, index: stored.index };
  } catch {
    return undefined;
  }
}









export function isSessionStorePath(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!activeSessionId) return false;
  const dir = getSessionImageDir(activeSessionId, env);
  const resolved = path.resolve(candidate);
  return (
    resolved.startsWith(dir + path.sep) && path.dirname(resolved) === dir
  );
}









export function readSessionImageByIndex(
  index: number,
  env: NodeJS.ProcessEnv = process.env,
): StoredSessionImage | null {
  if (!activeSessionId || !Number.isInteger(index) || index < 1) return null;
  const dir = getSessionImageDir(activeSessionId, env);
  if (!existsSync(dir)) return null;
  try {
    for (const name of readdirSync(dir)) {
      if (Number.parseInt(path.basename(name, path.extname(name)), 10) === index) {
        return readSessionImage(path.join(dir, name));
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface SessionImageStoreContext {

  dir: string;

  indices: number[];
}


















export function describeSessionImageStore(
  env: NodeJS.ProcessEnv = process.env,
): SessionImageStoreContext | null {
  if (!activeSessionId) return null;
  const dir = getSessionImageDir(activeSessionId, env);
  if (!existsSync(dir)) return null;
  const indices: number[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const parsed = Number.parseInt(
        path.basename(name, path.extname(name)),
        10,
      );
      if (Number.isInteger(parsed) && parsed >= 1) indices.push(parsed);
    }
  } catch {
    return null;
  }
  if (indices.length === 0) return null;
  return { dir, indices: indices.sort((a, b) => a - b) };
}


const MAX_STORE_DIR_CHARS = 512;
const MAX_STORE_INDICES = 200;


const STORE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;











export function normalizeSessionImageStore(
  value: unknown,
): SessionImageStoreContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const dir = String(record.dir ?? '')
    .replace(STORE_CONTROL_CHARS, ' ')
    .trim()
    .slice(0, MAX_STORE_DIR_CHARS);
  if (!dir) return null;
  const seen = new Set<number>();
  for (const raw of Array.isArray(record.indices) ? record.indices : []) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) continue;
    seen.add(parsed);
    if (seen.size >= MAX_STORE_INDICES) break;
  }
  if (seen.size === 0) return null;
  return { dir, indices: [...seen].sort((a, b) => a - b) };
}

export class SessionImageError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'TOO_LARGE' | 'UNSUPPORTED',
  ) {
    super(message);
    this.name = 'SessionImageError';
  }
}







export function storeSessionImageFromPath({
  sessionId,
  sourcePath,
  env = process.env,
}: {
  sessionId: string;
  sourcePath: string;
  env?: NodeJS.ProcessEnv;
}): StoredSessionImage {
  const resolved = path.resolve(sourcePath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new SessionImageError(`Image file not found: ${resolved}`, 'NOT_FOUND');
  }
  const size = statSync(resolved).size;
  if (size > MAX_IMAGE_SIZE_BYTES) {
    throw new SessionImageError(
      `Image file exceeds ${Math.round(MAX_IMAGE_SIZE_BYTES / 1024 / 1024)}MB limit (${(size / 1024 / 1024).toFixed(1)}MB): ${resolved}`,
      'TOO_LARGE',
    );
  }
  const bytes = readFileSync(resolved);
  const sniffed = sniffImageMimeType(bytes);
  if (!sniffed || !isSupportedImageMimeType(sniffed)) {
    throw new SessionImageError(
      `Not a supported image file: ${resolved}. Supported: PNG, JPEG, GIF, WebP.`,
      'UNSUPPORTED',
    );
  }
  const dir = ensureSessionImageDir(sessionId, env);
  const index = nextImageNumber(dir);
  const cachePath = path.join(dir, `${index}${imageExtensionForMime(sniffed)}`);
  writeFileSync(cachePath, bytes, { mode: IMAGE_FILE_MODE });
  const base64Data = bytes.toString('base64');
  rememberStoredImage(base64Data, cachePath);
  return { cachePath, mimeType: sniffed, base64Data, index };
}


export function readSessionImage(cachePath: string): StoredSessionImage | null {
  try {
    if (!existsSync(cachePath)) return null;
    const bytes = readFileSync(cachePath);
    const sniffed = sniffImageMimeType(bytes);
    if (!sniffed) return null;
    const parsed = Number.parseInt(
      path.basename(cachePath, path.extname(cachePath)),
      10,
    );
    const base64Data = bytes.toString('base64');


    rememberStoredImage(base64Data, cachePath);
    return {
      cachePath,
      mimeType: sniffed,
      base64Data,
      index: Number.isInteger(parsed) ? parsed : 0,
    };
  } catch {
    return null;
  }
}


export function pruneSessionImages(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    rmSync(getSessionImageDir(sessionId, env), { recursive: true, force: true });
  } catch {

  }
}





export function sweepOrphanSessionImages({
  activeSessionIds,
  maxAgeMs = SESSION_IMAGE_MAX_AGE_MS,
  env = process.env,
  now = Date.now(),
}: {
  activeSessionIds: ReadonlySet<string>;
  maxAgeMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): number {
  const baseDir = getSessionImageBaseDir(env);
  if (!existsSync(baseDir)) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (activeSessionIds.has(entry)) continue;
    const dir = path.join(baseDir, entry);
    try {
      if (now - statSync(dir).mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {

    }
  }
  return removed;
}
