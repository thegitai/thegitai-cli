import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  isSensitiveProjectPath,
  shouldIgnoreArtifactPath,
} from '../artifact-policy.js';





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





function foldPunctuation(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ');
}




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






function isProtectedRepairTarget(rootDir: string, candidate: string): boolean {
  const rel = path.relative(rootDir, resolveAgainst(rootDir, candidate));
  const projectPath = rel && !rel.startsWith('..') ? rel : candidate;
  return (
    isSensitiveProjectPath(projectPath) ||
    (rel !== '' && !rel.startsWith('..') && shouldIgnoreArtifactPath(rel))
  );
}





export const PATH_REPAIRING_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'str_replace',
  'patch_file',
  'replace_document_text',
]);











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
  if (matches.length !== 1) return raw;
  const matchedAbs = path.join(directory, matches[0]!);
  const matchedRel = path.relative(rootDir, matchedAbs);
  const matched =
    path.isAbsolute(dequoted) ? matchedAbs : matchedRel || matchedAbs;


  if (isProtectedRepairTarget(rootDir, matched)) return raw;
  return matched;
}
