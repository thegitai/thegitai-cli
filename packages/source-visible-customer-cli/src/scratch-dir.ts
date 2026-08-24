import { chmodSync, lstatSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The agent's sanctioned workspace for throwaway scripts and files, under the
// OS temp directory. Listing the shared OS temp root stays blocked (it can
// contain other users' and processes' files, which must not be vacuumed into
// model context), so the agent gets its own subtree where creating, running,
// and inspecting/listing are all first-class.
const scratchDirs = new Map<string, string>();
let activeSessionId = 'default';

export function setScratchSession(sessionId: string | null): void {
  activeSessionId = String(sessionId ?? '').trim() || 'default';
}

function allocateSessionScratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'thegitai-'));
  scratchDirs.set(activeSessionId, dir);
  return dir;
}

export function sessionScratchDir(): string {
  return scratchDirs.get(activeSessionId) ?? allocateSessionScratchDir();
}

function isOwnedDirectory(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      st.uid !== process.getuid()
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function ensureSessionScratchDir(): string {
  let dir = sessionScratchDir();
  if (!isOwnedDirectory(dir)) {
    dir = allocateSessionScratchDir();
  }
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o700);
  }
  return dir;
}

function hasUnsafeScratchComponent(root: string, relativePath: string): boolean {
  let current = root;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return true;
      if (stat.isDirectory()) continue;
      if (!stat.isFile() || stat.nlink > 1) return true;
    } catch (error: any) {
      return error?.code !== 'ENOENT';
    }
  }
  return false;
}

export function isWithinSessionScratchDir(absPath: string): boolean {
  const root = path.resolve(ensureSessionScratchDir());
  const resolved = path.resolve(absPath);
  const relative = path.relative(root, resolved);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function isInsideTheGitAiScratch(absPath: string): boolean {
  const root = path.resolve(ensureSessionScratchDir());
  const resolved = path.resolve(absPath);
  const relative = path.relative(root, resolved);
  if (!isWithinSessionScratchDir(resolved)) return false;
  return !hasUnsafeScratchComponent(root, relative);
}
