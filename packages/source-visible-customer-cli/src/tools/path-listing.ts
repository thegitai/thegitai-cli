import { listProjectFiles } from '../scanner.js';

const LISTING_SCAN_MULTIPLIER = 20;
const LISTING_MIN_SCAN_LIMIT = 1000;
const LISTING_MAX_SCAN_LIMIT = 10000;

export function listFilesystemFiles(
  rootDir: string,
  { pattern = '', limit = 200 } = {},
): string[] {
  return listProjectFiles(rootDir, { limit: scanLimitForListing(limit) })
    .filter((filePath) => matchesPathPattern(filePath, pattern))
    .sort()
    .slice(0, limit);
}

export function listFilesystemDirectories(
  rootDir: string,
  { pattern = '', limit = 200 } = {},
): string[] {
  const directories = new Set<string>();
  for (const filePath of listProjectFiles(rootDir, {
    limit: scanLimitForListing(limit),
  })) {
    const parts = filePath.split(/[\\/]+/).filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join('/'));
    }
    if (directories.size >= limit * LISTING_SCAN_MULTIPLIER) break;
  }
  return [...directories]
    .filter((dirPath) => matchesPathPattern(dirPath, pattern))
    .sort()
    .slice(0, limit);
}

function scanLimitForListing(limit: number): number {
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  return Math.min(
    LISTING_MAX_SCAN_LIMIT,
    Math.max(LISTING_MIN_SCAN_LIMIT, requested * LISTING_SCAN_MULTIPLIER),
  );
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  if (!/[*?{}]/.test(pattern)) {
    return filePath.includes(pattern);
  }
  return globLikePatternToRegExp(pattern).test(filePath);
}

function globLikePatternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        source += '(?:[^/]+/)*';
        i++;
      } else {
        source += '.*';
      }
      continue;
    }
    if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else if (char === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end === -1) {
        source += escapeRegExp(char);
      } else {
        const alternatives = pattern
          .slice(i + 1, end)
          .split(',')
          .map((part) => escapeRegExp(part.trim()));
        source += `(?:${alternatives.join('|')})`;
        i = end;
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
