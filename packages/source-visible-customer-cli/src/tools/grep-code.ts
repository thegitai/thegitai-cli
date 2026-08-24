import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ARTIFACT_IGNORE_FILES,
  BINARY_ARTIFACT_EXTENSIONS,
} from '../artifact-policy.js';
import {
  ALWAYS_IGNORE_DIRS,
  listProjectFiles,
  shouldIgnorePath,
} from '../scanner.js';
import { clampInteger } from '../utils.js';
import {
  getRipgrepPathCandidates,
  isRipgrepExecutionUnavailable,
} from './ripgrep.js';
import {
  getCommandErrorText,
  getCommandExitCode,
} from './exec-utils.js';
import { ToolResponse } from './types.js';

const MAX_RESULTS = 200;
const MAX_OUTPUT_CHARS = 8000;
const MAX_FALLBACK_FILE_BYTES = 512 * 1024;
const MAX_FALLBACK_FILES_TO_SCAN = 5000;

function buildRgIgnoreArgs(): string[] {
  const args: string[] = [];
  for (const dir of ALWAYS_IGNORE_DIRS) {
    args.push('--glob', `!${dir}`);
    args.push('--glob', `!**/${dir}/**`);
  }
  args.push('--glob', '!*.min.js');
  args.push('--glob', '!*.min.css');
  args.push('--glob', '!*.map');
  args.push('--glob', '!package-lock.json');
  args.push('--glob', '!yarn.lock');
  args.push('--glob', '!pnpm-lock.yaml');
  return args;
}

function isRegexParseFailure(error: any): boolean {
  if (getCommandExitCode(error) !== 2) return false;
  return /regex parse error|repetition quantifier|unclosed group|invalid regex/i.test(
    getCommandErrorText(error),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !unique.includes(trimmed)) {
      unique.push(trimmed);
    }
  }
  return unique;
}

function literalPatternCandidates(pattern: string): string[] {
  const trimmed = pattern.trim();
  const candidates = [trimmed];
  if (trimmed.startsWith('(?:')) {
    const inner = trimmed.slice(3).trim();
    candidates.push(inner.endsWith(')') ? inner.slice(0, -1).trim() : inner);
  } else if (trimmed.startsWith('(')) {
    const inner = trimmed.slice(1).trim();
    candidates.push(inner.endsWith(')') ? inner.slice(0, -1).trim() : inner);
  }
  return uniqueNonEmptyStrings(candidates);
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let pattern = '^';
  for (let index = 0; index < normalized.length; ) {
    const char = normalized[index] ?? '';
    const next = normalized[index + 1] ?? '';
    const afterNext = normalized[index + 2] ?? '';
    if (char === '*' && next === '*' && afterNext === '/') {
      pattern += '(?:.*/)?';
      index += 3;
    } else if (char === '*' && next === '*') {
      pattern += '.*';
      index += 2;
    } else if (char === '*') {
      pattern += '[^/]*';
      index += 1;
    } else if (char === '?') {
      pattern += '[^/]';
      index += 1;
    } else {
      pattern += escapeRegExp(char);
      index += 1;
    }
  }
  return RegExp(`${pattern}$`);
}

function matchesFilePattern(filePath: string, filePattern: string): boolean {
  if (!filePattern) return true;
  const normalized = filePath.replace(/\\/g, '/');
  const pattern = filePattern.replace(/\\/g, '/');
  const negated = pattern.startsWith('!');
  const effectivePattern = negated ? pattern.slice(1) : pattern;
  const regex = globToRegExp(effectivePattern);
  const matches =
    regex.test(normalized) ||
    (!effectivePattern.includes('/') && regex.test(path.basename(normalized)));
  return negated ? !matches : matches;
}

function isBinaryText(content: string): boolean {
  return content.slice(0, 8192).includes('\0');
}

function shouldSkipFallbackFile(rootDir: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (shouldIgnorePath(normalized)) return true;
  if (ARTIFACT_IGNORE_FILES.has(path.basename(normalized))) return true;
  if (
    normalized.endsWith('.min.js') ||
    normalized.endsWith('.min.css') ||
    normalized.endsWith('.map')
  ) {
    return true;
  }
  if (BINARY_ARTIFACT_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    return true;
  }
  try {
    const stat = statSync(path.join(rootDir, normalized));
    return !stat.isFile() || stat.size > MAX_FALLBACK_FILE_BYTES;
  } catch {
    return true;
  }
}

function normalizeMatches(raw: string, limit: number): {
  matchCount: number;
  matches: string;
} {
  const limitedLines = raw.split('\n').filter(Boolean).slice(0, limit);
  const limited = limitedLines.join('\n');
  const matchCount = limitedLines.length;
  const matches =
    limited.length > MAX_OUTPUT_CHARS
      ? `${limited.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated)`
      : limited;
  return { matchCount, matches };
}

function grepCodeWithoutRipgrep(
  rootDir: string,
  pattern: string,
  options: {
    limit: number;
    filePattern: string;
    caseSensitive: boolean;
  },
): ToolResponse {
  let regexes: RegExp[];
  let literalMode = false;
  try {
    regexes = [RegExp(pattern, options.caseSensitive ? '' : 'i')];
  } catch {
    literalMode = true;
    regexes = literalPatternCandidates(pattern).map((candidate) =>
      RegExp(escapeRegExp(candidate), options.caseSensitive ? '' : 'i'),
    );
  }
  const allFiles = listProjectFiles(rootDir)
    .filter((filePath) => matchesFilePattern(filePath, options.filePattern))
    .filter((filePath) => !shouldSkipFallbackFile(rootDir, filePath));
  const files = allFiles.slice(0, MAX_FALLBACK_FILES_TO_SCAN);
  const matches: string[] = [];
  for (const filePath of files) {
    if (matches.length >= options.limit) break;
    let content: string;
    try {
      content = readFileSync(path.join(rootDir, filePath), 'utf8');
    } catch {
      continue;
    }
    if (isBinaryText(content)) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (matches.length >= options.limit) break;
      const line = lines[index] ?? '';
      if (regexes.some((regex) => regex.test(line))) {
        matches.push(`${filePath}:${index + 1}:${line}`);
      }
    }
  }
  const normalized = normalizeMatches(matches.join('\n'), options.limit);
  return {
    ok: true,
    pattern,
    matchCount: normalized.matchCount,
    matches: normalized.matches,
    searchEngine: 'node_fallback',
    searchMode: literalMode ? 'literal' : 'regex',
    warning:
      allFiles.length > files.length
        ? `ripgrep is unavailable; searched the first ${files.length} matching files with the built-in fallback.`
        : 'ripgrep is unavailable; searched with the built-in fallback.',
  };
}

function buildRipgrepArgs(options: {
  caseSensitive: boolean;
  filePattern: string;
  fixedStrings: boolean;
  limit: number;
  pattern: string;
}): string[] {
  const rgArgs = [
    '-n',
    '--no-heading',
    '--color',
    'never',
    ...buildRgIgnoreArgs(),
  ];
  if (options.fixedStrings) {
    rgArgs.push('--fixed-strings');
  }
  if (!options.caseSensitive) {
    rgArgs.push('-i');
  }
  if (options.filePattern) {
    rgArgs.push('--glob', options.filePattern);
  }
  rgArgs.push('-m', String(options.limit));
  rgArgs.push('--', options.pattern, '.');
  return rgArgs;
}

function runRipgrep(
  rootDir: string,
  options: {
    caseSensitive: boolean;
    filePattern: string;
    fixedStrings: boolean;
    limit: number;
    pattern: string;
  },
): string {
  const args = buildRipgrepArgs(options);
  let unavailableError: any = null;
  for (const candidate of getRipgrepPathCandidates()) {
    try {
      return execFileSync(candidate, args, {
        cwd: rootDir,
        encoding: 'utf-8',
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (error: any) {
      if (!isRipgrepExecutionUnavailable(error)) {
        throw error;
      }
      unavailableError = error;
    }
  }
  throw unavailableError;
}

function runRipgrepLiteralSearch(
  rootDir: string,
  options: {
    caseSensitive: boolean;
    filePattern: string;
    limit: number;
    pattern: string;
  },
): string | null {
  for (const literalPattern of literalPatternCandidates(options.pattern)) {
    try {
      return runRipgrep(rootDir, {
        ...options,
        fixedStrings: true,
        pattern: literalPattern,
      });
    } catch (literalErr: any) {
      if (getCommandExitCode(literalErr) === 1) {
        continue;
      }
      throw literalErr;
    }
  }
  return null;
}

export function grepCode(
  rootDir: string,
  args: {
    pattern?: string;
    limit?: number;
    filePattern?: string;
    caseSensitive?: boolean;
  },
): ToolResponse {
  const pattern = String(args.pattern ?? '').trim();
  if (!pattern) {
    return { ok: false, error: 'pattern is required' };
  }
  const limit = clampInteger(args.limit, 50, MAX_RESULTS);
  const filePattern = args.filePattern ? String(args.filePattern).trim() : '';
  const caseSensitive = args.caseSensitive !== false;
  try {
    const raw = runRipgrep(rootDir, {
      caseSensitive,
      filePattern,
      fixedStrings: false,
      limit,
      pattern,
    });
    const { matchCount, matches } = normalizeMatches(raw, limit);
    return {
      ok: true,
      pattern,
      matchCount,
      matches,
      searchEngine: 'ripgrep',
      searchMode: 'regex',
    };
  } catch (err: any) {
    if (getCommandExitCode(err) === 1) {
      return {
        ok: true,
        pattern,
        matchCount: 0,
        matches: '',
        searchEngine: 'ripgrep',
        searchMode: 'regex',
      };
    }
    if (isRegexParseFailure(err)) {
      try {
        const raw = runRipgrepLiteralSearch(rootDir, {
          caseSensitive,
          filePattern,
          limit,
          pattern,
        });
        if (raw === null) {
          return {
            ok: true,
            pattern,
            matchCount: 0,
            matches: '',
            searchEngine: 'ripgrep',
            searchMode: 'literal',
          };
        }
        const { matchCount, matches } = normalizeMatches(raw, limit);
        return {
          ok: true,
          pattern,
          matchCount,
          matches,
          searchEngine: 'ripgrep',
          searchMode: 'literal',
        };
      } catch (literalErr: any) {
        if (!isRipgrepExecutionUnavailable(literalErr)) {
          return {
            ok: false,
            error: 'ripgrep literal search failed.',
          };
        }
      }
    }
    if (isRipgrepExecutionUnavailable(err)) {
      return grepCodeWithoutRipgrep(rootDir, pattern, {
        limit,
        filePattern,
        caseSensitive,
      });
    }
    return {
      ok: false,
      error: 'ripgrep search failed.',
    };
  }
}
