import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ProjectOrientationContext } from './api/contracts.js';
import { shouldIgnoreArtifactPath } from './artifact-policy.js';

const MAX_TOP_LEVEL_ENTRIES = 80;
const MAX_DECLARED_TASKS = 40;
const MAX_NAME_CHARS = 120;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return normalized || null;
}

function normalizeNames(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = normalizeName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

function readPackageTasks(rootDir: string): string[] {
  const packagePath = path.join(rootDir, 'package.json');
  let fd: number | null = null;
  try {
    const pathStat = lstatSync(packagePath);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.nlink > 1 ||
      pathStat.size > MAX_PACKAGE_JSON_BYTES
    ) {
      return [];
    }
    const noFollow =
      typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    fd = openSync(packagePath, constants.O_RDONLY | noFollow);
    const fileStat = fstatSync(fd);
    if (
      !fileStat.isFile() ||
      fileStat.nlink > 1 ||
      fileStat.size > MAX_PACKAGE_JSON_BYTES ||
      fileStat.dev !== pathStat.dev ||
      fileStat.ino !== pathStat.ino
    ) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(fd, 'utf8'));
    if (!parsed?.scripts || typeof parsed.scripts !== 'object') return [];
    return normalizeNames(Object.keys(parsed.scripts), MAX_DECLARED_TASKS);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function normalizeProjectOrientation(
  value: unknown,
): ProjectOrientationContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const topLevelEntries = normalizeNames(
    record.topLevelEntries,
    MAX_TOP_LEVEL_ENTRIES,
  );
  const packageScripts = normalizeNames(
    record.packageScripts,
    MAX_DECLARED_TASKS,
  );
  if (topLevelEntries.length === 0 && packageScripts.length === 0) return null;
  return {
    topLevelEntries,
    packageScripts,
    truncated: record.truncated === true,
  };
}

export function collectProjectOrientation(
  rootDir: string,
): ProjectOrientationContext | null {
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => !shouldIgnoreArtifactPath(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const topLevelEntries = entries
      .slice(0, MAX_TOP_LEVEL_ENTRIES)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
    return normalizeProjectOrientation({
      topLevelEntries,
      packageScripts: readPackageTasks(rootDir),
      truncated: entries.length > MAX_TOP_LEVEL_ENTRIES,
    });
  } catch {
    return null;
  }
}
