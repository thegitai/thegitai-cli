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

/**
 * Per-session image store on the USER's machine.
 *
 *   <client state dir>/sessions/images/<sessionId>/<n>.<ext>
 *
 * Every attachment — clipboard paste, screenshot, or a path the user typed —
 * is copied here the moment it is attached, and the copy is what the rest of
 * the session refers to. Three things fall out of that:
 *
 *   1. The model gets a stable local path it can re-read with ordinary file
 *      tools, so an image stays reachable after the bytes leave the prompt.
 *   2. Analysis is no longer "current message only": anything in the store can
 *      be re-examined turns later, including after a resume.
 *   3. The user can move or delete the original without breaking the session.
 *
 * Nothing here ever runs on the server. The VPS holds image bytes in memory for
 * the length of one turn and writes them nowhere; this directory exists only on
 * the machine the user is sitting at.
 */

/** Files are the user's own images: readable by them, nobody else. */
const IMAGE_FILE_MODE = 0o600;
const IMAGE_DIR_MODE = 0o700;

/** Orphan session image directories are swept after this long. */
export const SESSION_IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredSessionImage {
  cachePath: string;
  mimeType: ImageMimeType;
  base64Data: string;
  /**
   * The session-monotonic number this image was filed under, and the number the
   * user sees in its [Image #N] marker. One counter per session means a marker
   * identifies exactly one image for the life of the conversation, and the file
   * that holds it is `<n>.<ext>` — so a marker, a path, and a stored file are
   * three views of the same number rather than three numbering schemes.
   */
  index: number;
}

/**
 * The active session, bound the same way the scratch dir, todo list, and
 * background job registry bind theirs — attach points like the clipboard paste
 * handler sit far from any SessionState and would otherwise have to thread a
 * session id through half the UI.
 */
let activeSessionId: string | null = null;

export function setImageStoreSession(sessionId: string | null): void {
  activeSessionId = String(sessionId ?? '').trim() || null;
  contentIndex.clear();
}

/**
 * Content -> stored copy, for images this process has written or read.
 *
 * The session file wants to hold a reference instead of the pixels, and the
 * obvious way to know which stored file a history part came from is a field
 * next to the bytes. That field cannot survive a server round trip: it is
 * client-owned metadata, so the snapshot boundary strips it in both directions
 * — which left server-backed sessions, the customer topology, persisting full
 * base64 anyway. Identity by CONTENT survives, because the bytes are the one
 * thing the wire is guaranteed to bring back unchanged.
 *
 * Keyed by hash rather than by the base64 itself so the index costs 64 bytes
 * per image instead of pinning every image's payload in memory for the session.
 */
const contentIndex = new Map<string, string>();

function imageContentKey(base64Data: string): string {
  return createHash('sha256').update(base64Data).digest('hex');
}

function rememberStoredImage(base64Data: string, cachePath: string): void {
  contentIndex.set(imageContentKey(base64Data), cachePath);
}

/**
 * The stored copy holding exactly these bytes, if this session has one. Verifies
 * the file is still there, so a swept or hand-deleted image is reported as
 * absent rather than as a reference that would not load back.
 */
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

/**
 * The session's image counter: next free number, derived from the directory.
 *
 * This is the single source of truth for image identity in a session — the
 * stored filename AND the [Image #N] marker the user and model both see. It
 * used to be only the filename, while markers restarted at 1 on every message,
 * so one session could hold several different "[Image #1]"s and the model had
 * no way to tell which description belonged to which picture. Reading the
 * directory rather than counting in memory means the numbering also survives a
 * restart or a resume.
 */
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

/**
 * Write already-decoded bytes (a clipboard paste or a screenshot) into the
 * session store.
 */
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

/**
 * Best-effort cache of an attachment's bytes under the active session. Returns
 * the stored path, or undefined when there is no active session or the write
 * failed. Deliberately non-throwing: the cache copy is what makes an image
 * re-readable later, but an attachment that could not be cached is still a
 * perfectly good attachment for this turn, and a full disk must not cost the
 * user their prompt.
 */
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

/**
 * Whether a path already points at this session's own copy of an image.
 *
 * The prompt hands the model a `Session image path` and invites it to analyze
 * that path, so this is the common case, not an edge one — and copying a file
 * that is already in the store would give one picture a second number and
 * defeat "one number, one image".
 */
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

/**
 * Find an image by the number the user saw in its marker.
 *
 * Markers are session-monotonic and match the stored filename, so `[Image #3]`
 * is `3.<ext>` in this session's directory — which is what lets a later turn
 * reach an image the current message never carried. Client-side only: the store
 * lives on the user's machine, and the server resolves no paths.
 */
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

export class SessionImageError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'TOO_LARGE' | 'UNSUPPORTED',
  ) {
    super(message);
    this.name = 'SessionImageError';
  }
}

/**
 * Copy a file the user (or the model) named into the session store. The mime
 * type comes from the file's magic bytes, not its extension, so an
 * extension-less screenshot still attaches — and a `.png` that is really a
 * text file is rejected instead of being handed to the vision model.
 */
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

/** Read a stored image back — used to rehydrate history without re-uploading. */
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
    // A resumed session rebuilds the index as it reads its images back, so the
    // next save can still write references rather than pixels.
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

/** Drop one session's images. Called when its session file is deleted. */
export function pruneSessionImages(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    rmSync(getSessionImageDir(sessionId, env), { recursive: true, force: true });
  } catch {
    // A store we cannot clean is not a reason to fail the caller's operation.
  }
}

/**
 * Remove image directories older than the cutoff whose session is gone. Runs on
 * startup; a store that outlives every reference to it is pure disk cost.
 */
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
      // Skip anything we cannot stat or remove; the next sweep retries.
    }
  }
  return removed;
}
