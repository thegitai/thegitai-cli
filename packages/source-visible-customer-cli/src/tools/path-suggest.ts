import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  isSensitiveProjectPath,
  shouldIgnoreArtifactPath,
} from '../artifact-policy.js';

// "File not found" recovery hint: when a model mistypes a filename (most
// often Unicode punctuation — a straight ' for a curly ’ — or a small typo),
// suggest the closest real file from the same directory.

function foldName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ')
    .toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const current = [i, ...new Array(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        prev[j]! + 1,
        current[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = current;
  }
  return prev[cols - 1]!;
}

export function suggestClosestPath(
  rootDir: string,
  missingPath: string,
): string | null {
  const resolved = path.isAbsolute(missingPath)
    ? missingPath
    : path.resolve(rootDir, missingPath);
  const directory = path.dirname(resolved);
  const wantedBase = foldName(path.basename(resolved));
  if (!wantedBase) return null;

  let candidates: string[];
  try {
    candidates = readdirSync(directory);
  } catch {
    return null;
  }

  const threshold = Math.max(2, Math.floor(wantedBase.length * 0.25));
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    // Never suggest a file the caller would refuse to read/write directly:
    // probing a near-miss like `.enx` or `credential.docx` must not leak the
    // existence of `.env`/credentials through the recovery hint.
    const candidateRelative = path.relative(
      rootDir,
      path.join(directory, candidate),
    );
    if (isSensitiveProjectPath(candidateRelative)) continue;
    const distance = levenshtein(wantedBase, foldName(candidate));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (!best || bestDistance > threshold) return null;
  const suggested = path.join(directory, best);
  const relative = path.relative(rootDir, suggested);
  return relative && !relative.startsWith('..') ? relative : suggested;
}

// Fold only the punctuation/whitespace a model routinely alters when it echoes
// a filename — a curly apostrophe ’ flattened to a straight ', smart double
// quotes, and a non-breaking space — WITHOUT touching case, so a path is only
// auto-corrected when nothing but this punctuation differs from a real file.
function foldPunctuation(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ');
}

// Strip ONE matched pair of surrounding quotes. A path pasted from a file
// manager's "Copy as path" or dragged into a terminal arrives wrapped in
// '…' / "…", and that wrapping is captured verbatim as part of the filename.
function stripSurroundingQuotes(p: string): string {
  if (p.length >= 2) {
    const first = p[0];
    const last = p[p.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return p.slice(1, -1);
    }
  }
  return p;
}

// A single backslash is a legal filename byte on POSIX, but models routinely
// double it (it is JSON's escape character) when echoing a name, turning
// `back\slash.js` into `back\\slash.js`. Collapse doubled backslashes to one.
function collapseDoubledBackslashes(p: string): string {
  return p.replace(/\\\\/g, '\\');
}

function resolveAgainst(rootDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(rootDir, p);
}

function existsAgainst(rootDir: string, p: string): boolean {
  try {
    return existsSync(resolveAgainst(rootDir, p));
  } catch {
    return false;
  }
}

// Repair must never resolve a protected file (a secret like `.env`/credentials).
// Repair only runs when the literal path is missing, so without this a quoted or
// curly-flattened secret path — which used to fail as not-found — would be
// silently resolved to the real secret, bypassing the redaction that keys off
// the original tool-call args (e.g. read_document, str_replace, patch_file).
function isProtectedRepairTarget(rootDir: string, candidate: string): boolean {
  const rel = path.relative(rootDir, resolveAgainst(rootDir, candidate));
  const projectPath = rel && !rel.startsWith('..') ? rel : candidate;
  return (
    isSensitiveProjectPath(projectPath) ||
    (rel !== '' && !rel.startsWith('..') && shouldIgnoreArtifactPath(rel))
  );
}

// Edit tools that call repairFilePath on their path argument internally. The
// executor repairs the pre-edit snapshot path only for these, so its snapshot
// targets the same file the tool writes; write_file/delete_file consume the raw
// path, so their snapshot must too.
export const PATH_REPAIRING_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'str_replace',
  'patch_file',
  'replace_document_text',
]);

// Repair a model/user-supplied path to a real on-disk file WITHOUT changing
// intent, for tools that act on a file expected to already exist. Literal
// first: any path that already resolves — including one that legitimately
// contains quotes or backslashes — is returned untouched. Only when the path
// does not resolve do we try safe de-manglings: strip surrounding quotes,
// collapse doubled backslashes, and finally match a directory entry that
// differs only by foldable punctuation (the "model flattened a curly ’ to a
// straight '" case, which no transform of the input can reproduce). Returns the
// input unchanged when nothing better exists, so the caller's normal not-found
// handling (and its recovery hint) still fires.
export function repairFilePath(rootDir: string, raw: string): string {
  if (!raw || existsAgainst(rootDir, raw)) return raw;

  const dequoted = stripSurroundingQuotes(raw);
  for (const candidate of [
    dequoted,
    collapseDoubledBackslashes(raw),
    collapseDoubledBackslashes(dequoted),
  ]) {
    if (
      candidate !== raw &&
      existsAgainst(rootDir, candidate) &&
      !isProtectedRepairTarget(rootDir, candidate)
    ) {
      return candidate;
    }
  }

  const probe = resolveAgainst(rootDir, dequoted);
  const directory = path.dirname(probe);
  const wanted = foldPunctuation(path.basename(probe));
  if (!wanted) return raw;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return raw;
  }
  const matches = entries.filter((entry) => foldPunctuation(entry) === wanted);
  if (matches.length !== 1) return raw; // none, or ambiguous — never guess
  const matchedAbs = path.join(directory, matches[0]!);
  const matchedRel = path.relative(rootDir, matchedAbs);
  const matched =
    path.isAbsolute(dequoted) ? matchedAbs : matchedRel || matchedAbs;
  // Never auto-resolve into a protected file: a fold-match that lands on `.env`
  // would confirm its existence to the model and bypass redaction.
  if (isProtectedRepairTarget(rootDir, matched)) return raw;
  return matched;
}
