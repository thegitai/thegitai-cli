import { execSync } from 'child_process';
import { Dirent, readdirSync, readFileSync, Stats, statSync } from 'fs';
import path from 'path';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import {
  getNodePrimarySignature,
  getStructuralChildren,
  parseRepoSource,
} from './tree-sitter-runtime.js';
import { Chunk } from './types.js';
import {
  ARTIFACT_IGNORE_DIRS,
  ARTIFACT_IGNORE_FILES,
  ARTIFACT_INSPECT_BLOCK_DIRS,
  BINARY_ARTIFACT_EXTENSIONS,
  isSensitiveProjectPath,
  shouldIgnoreArtifactPath,
} from './artifact-policy.js';

const BINARY_EXTENSIONS = BINARY_ARTIFACT_EXTENSIONS;
const ALWAYS_IGNORE_FILES = ARTIFACT_IGNORE_FILES;

export const ALWAYS_IGNORE_DIRS = ARTIFACT_IGNORE_DIRS;

export const BLOCKED_PATH_INSPECT_DIRS = ARTIFACT_INSPECT_BLOCK_DIRS;

export const SCANNER_MAX_SOURCE_FILE_BYTES = 100 * 1024;

const MAX_FILE_SIZE = SCANNER_MAX_SOURCE_FILE_BYTES;
const MAX_CHUNKS = 2000;
const TARGET_CHUNK_CHARS = 1800;
const MAX_CHUNK_CHARS = 2800;
const FALLBACK_OVERLAP_LINES = 10;
const MAX_STRUCTURE_DEPTH = 2;
interface ScanOptions {
  limit?: number;
}

interface SegmentUnit {
  startLine: number;
  endLine: number;
  charCount: number;
  label?: string;
  kind: 'symbol' | 'context';
  node: TreeSitterNode | null;
}

export interface PathIndexMetadata {
  depth: number;
  estimatedChunks: number;
  size: number;
}

function parseGitLsFilesOutput(output: Buffer | string): string[] {
  return String(output)
    .split('\0')
    .filter(Boolean)
    .filter((filePath) => !shouldIgnorePath(filePath));
}

function getFiles(
  rootDir: string,
  { limit = Infinity }: ScanOptions = {},
): string[] {
  try {
    const output = execSync(
      'git ls-files -z --cached --others --exclude-standard',
      { cwd: rootDir, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const files = parseGitLsFilesOutput(output);
    return Number.isFinite(limit) ? files.slice(0, limit) : files;
  } catch {
    return walkProjectFilesFallback(
      rootDir,
      Number.isFinite(limit) ? limit : Infinity,
    );
  }
}

const FALLBACK_LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

function isFallbackIgnoredFile(relPath: string, fileName: string): boolean {
  if (shouldIgnorePath(relPath)) return true;
  if (fileName.endsWith('.lock')) return true;
  return FALLBACK_LOCKFILES.has(fileName);
}

// Local stand-in for the previous glob('**/*', { nodir: true, dot: false,
// ignore: FALLBACK_IGNORE }) call, used only when `git ls-files` fails (e.g. a
// non-git directory). Walks the tree depth-first, skips dotfiles and
// dot-directories (glob's dot: false), prunes ignored artifact dirs, and drops
// lockfiles plus sensitive/ignored paths — reproducing the old fallback without
// the glob dependency.
function walkProjectFilesFallback(rootDir: string, limit: number): string[] {
  const results: string[] = [];
  const visit = (relDir: string): void => {
    if (results.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(rootDir, relDir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const name = entry.name;
      if (name.startsWith('.')) continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        // Only the prefix-based artifact rule is safe to prune a directory by;
        // the sensitive-basename check must stay at the file level so a dir
        // merely named e.g. `secret` doesn't hide non-sensitive files under it.
        if (ALWAYS_IGNORE_DIRS.has(name) || shouldIgnoreArtifactPath(relPath)) {
          continue;
        }
        visit(relPath);
      } else if (entry.isFile() && !isFallbackIgnoredFile(relPath, name)) {
        results.push(relPath);
      }
    }
  };
  visit('');
  return results;
}

function shouldSkipFile(relPath: string, stat: Stats): boolean {
  if (shouldIgnorePath(relPath)) return true;
  const fileName = path.basename(relPath);
  if (ALWAYS_IGNORE_FILES.has(fileName)) return true;
  const ext = path.extname(relPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (
    relPath.endsWith('.min.js') ||
    relPath.endsWith('.min.css') ||
    relPath.endsWith('.chunk.js') ||
    relPath.endsWith('.bundle.js')
  ) {
    return true;
  }

  return stat.size > MAX_FILE_SIZE;
}

function getRangeCharCount(
  lines: string[],
  startLine: number,
  endLine: number,
): number {
  let total = 0;
  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    total += (lines[lineNum - 1] ?? '').length + 1;
  }
  return total;
}

function normalizeLineRange(
  lines: string[],
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } | null {
  let start = Math.max(1, startLine);
  let end = Math.min(endLine, lines.length);
  while (start <= end && !(lines[start - 1] ?? '').trim()) start++;
  while (end >= start && !(lines[end - 1] ?? '').trim()) end--;
  return start <= end ? { startLine: start, endLine: end } : null;
}

function createChunkFromRange(
  relPath: string,
  lines: string[],
  startLine: number,
  endLine: number,
  label?: string,
  kind: 'symbol' | 'context' = 'context',
): Chunk | null {
  const range = normalizeLineRange(lines, startLine, endLine);
  if (!range) return null;
  return {
    filePath: relPath,
    content: lines.slice(range.startLine - 1, range.endLine).join('\n'),
    startLine: range.startLine,
    endLine: range.endLine,
    label,
    kind,
  };
}

function createSegmentUnit(
  lines: string[],
  startLine: number,
  endLine: number,
  label: string | undefined,
  kind: 'symbol' | 'context',
  node: TreeSitterNode | null,
): SegmentUnit | null {
  const range = normalizeLineRange(lines, startLine, endLine);
  if (!range) return null;
  return {
    startLine: range.startLine,
    endLine: range.endLine,
    charCount: getRangeCharCount(lines, range.startLine, range.endLine),
    label,
    kind,
    node,
  };
}

function deriveChunkLabel(units: SegmentUnit[]): string | undefined {
  const labels = [...new Set(units.map((unit) => unit.label).filter(Boolean))];
  return labels.length === 1 ? labels[0] : undefined;
}

function shouldMergeUnits(
  lines: string[],
  currentUnits: SegmentUnit[],
  nextUnit: SegmentUnit,
): boolean {
  if (!currentUnits.length) return true;
  const currentStart = currentUnits[0]!.startLine;
  const currentEnd = currentUnits[currentUnits.length - 1]!.endLine;
  if (nextUnit.startLine - currentEnd > 3) {
    return false;
  }
  const mergedChars = getRangeCharCount(lines, currentStart, nextUnit.endLine);
  if (mergedChars > MAX_CHUNK_CHARS) {
    return false;
  }
  const hasContext =
    currentUnits.some((unit) => unit.kind === 'context') ||
    nextUnit.kind === 'context';
  if (!hasContext) {
    return false;
  }
  if (mergedChars > TARGET_CHUNK_CHARS) {
    return false;
  }
  return (
    !currentUnits.some((unit) => unit.kind === 'symbol') ||
    nextUnit.kind === 'context'
  );
}

function buildSlidingWindowChunks(
  relPath: string,
  lines: string[],
  startLine: number,
  endLine: number,
  label?: string,
  kind: 'symbol' | 'context' = 'context',
): Chunk[] {
  const chunks: Chunk[] = [];
  const range = normalizeLineRange(lines, startLine, endLine);
  if (!range) return chunks;
  let cursor = range.startLine;
  while (cursor <= range.endLine) {
    let chunkEnd = cursor - 1;
    let charCount = 0;
    while (chunkEnd < range.endLine) {
      const nextLineNum = chunkEnd + 1;
      const nextChars = (lines[nextLineNum - 1] ?? '').length + 1;
      if (
        charCount >= TARGET_CHUNK_CHARS &&
        charCount + nextChars > MAX_CHUNK_CHARS
      ) {
        break;
      }
      chunkEnd = nextLineNum;
      charCount += nextChars;
      if (charCount >= TARGET_CHUNK_CHARS) {
        const lineText = (lines[chunkEnd - 1] ?? '').trim();
        if (
          !lineText ||
          /^[}\])]+[;,]?$/.test(lineText) ||
          /^(export |function |class |interface |type |const |let |var |async function |def |async def |pub |impl |trait |enum |struct )/.test(
            lineText,
          )
        ) {
          break;
        }
      }
    }
    if (chunkEnd < cursor) {
      chunkEnd = cursor;
    }
    const chunk = createChunkFromRange(
      relPath,
      lines,
      cursor,
      chunkEnd,
      label,
      kind,
    );
    if (chunk) {
      chunks.push(chunk);
    }
    if (chunkEnd >= range.endLine) {
      break;
    }
    cursor = Math.max(cursor + 1, chunkEnd - FALLBACK_OVERLAP_LINES + 1);
  }
  return chunks;
}

function buildUnitsFromNode(
  node: TreeSitterNode,
  lines: string[],
  languageId: string,
): SegmentUnit[] {
  const children = getStructuralChildren(node);
  const nodeStartLine = (node?.startPosition?.row ?? 0) + 1;
  const nodeEndLine = (node?.endPosition?.row ?? 0) + 1;
  const signature = getNodePrimarySignature(node, languageId) ?? undefined;
  if (!children.length) {
    const onlyUnit = createSegmentUnit(
      lines,
      nodeStartLine,
      nodeEndLine,
      signature,
      signature ? 'symbol' : 'context',
      node,
    );
    return onlyUnit ? [onlyUnit] : [];
  }
  const units: SegmentUnit[] = [];
  const firstChildStartLine = (children[0]?.startPosition?.row ?? 0) + 1;
  const headerUnit = createSegmentUnit(
    lines,
    nodeStartLine,
    firstChildStartLine - 1,
    signature,
    'context',
    null,
  );
  if (headerUnit) {
    units.push(headerUnit);
  }
  for (const child of children) {
    const label = getNodePrimarySignature(child, languageId) ?? undefined;
    const childUnit = createSegmentUnit(
      lines,
      (child?.startPosition?.row ?? 0) + 1,
      (child?.endPosition?.row ?? 0) + 1,
      label,
      label ? 'symbol' : 'context',
      child,
    );
    if (childUnit) {
      units.push(childUnit);
    }
  }
  const lastChildEndLine =
    (children[children.length - 1]?.endPosition?.row ?? nodeEndLine - 1) + 1;
  const footerUnit = createSegmentUnit(
    lines,
    lastChildEndLine + 1,
    nodeEndLine,
    undefined,
    'context',
    null,
  );
  if (footerUnit) {
    units.push(footerUnit);
  }
  return units;
}

function buildChunksFromUnits(
  relPath: string,
  lines: string[],
  units: SegmentUnit[],
  languageId: string,
  depth: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentUnits: SegmentUnit[] = [];

  function flush(): void {
    if (!currentUnits.length) return;
    const label = deriveChunkLabel(currentUnits);
    const kind =
      currentUnits.every((unit) => unit.kind === 'symbol') && label
        ? 'symbol'
        : 'context';
    const chunk = createChunkFromRange(
      relPath,
      lines,
      currentUnits[0]!.startLine,
      currentUnits[currentUnits.length - 1]!.endLine,
      label,
      kind,
    );
    if (chunk) {
      chunks.push(chunk);
    }
    currentUnits = [];
  }

  for (const unit of units) {
    if (unit.charCount > MAX_CHUNK_CHARS) {
      flush();
      const nestedUnits =
        unit.node && depth < MAX_STRUCTURE_DEPTH
          ? buildUnitsFromNode(unit.node, lines, languageId)
          : [];
      const madeProgress = nestedUnits.some(
        (nested) =>
          nested.startLine > unit.startLine || nested.endLine < unit.endLine,
      );
      if (nestedUnits.length >= 2 && madeProgress) {
        chunks.push(
          ...buildChunksFromUnits(
            relPath,
            lines,
            nestedUnits,
            languageId,
            depth + 1,
          ),
        );
        continue;
      }
      chunks.push(
        ...buildSlidingWindowChunks(
          relPath,
          lines,
          unit.startLine,
          unit.endLine,
          unit.label,
          unit.kind,
        ),
      );
      continue;
    }
    if (shouldMergeUnits(lines, currentUnits, unit)) {
      currentUnits.push(unit);
      continue;
    }
    flush();
    currentUnits.push(unit);
  }

  flush();
  return chunks;
}

async function chunkFileContent(
  relPath: string,
  content: string,
): Promise<Chunk[]> {
  const lines = content.split('\n');
  const parsed = await parseRepoSource(relPath, content);
  if (parsed) {
    const units = buildUnitsFromNode(parsed.tree.rootNode, lines, parsed.languageId);
    const chunks = buildChunksFromUnits(
      relPath,
      lines,
      units,
      parsed.languageId,
      0,
    );
    if (chunks.length > 0) {
      return chunks;
    }
  }
  return buildSlidingWindowChunks(relPath, lines, 1, lines.length);
}

export function shouldIgnorePath(relPath: string): boolean {
  return shouldIgnoreArtifactPath(relPath) || isSensitiveProjectPath(relPath);
}

export function listProjectFiles(
  rootDir: string,
  opts: ScanOptions = {},
): string[] {
  return getFiles(rootDir, opts);
}

export async function scanFiles(
  rootDir: string,
  relPaths: string[],
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for (const relPath of relPaths) {
    const absPath = path.join(rootDir, relPath);
    let stat: Stats;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || shouldSkipFile(relPath, stat)) continue;
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    if (isBinary(content)) continue;
    chunks.push(...(await chunkFileContent(relPath, content)));
  }
  return chunks;
}

export async function scanProject(rootDir: string): Promise<Chunk[]> {
  const files = getFiles(rootDir);
  const chunks = await scanFiles(rootDir, files);
  if (chunks.length > MAX_CHUNKS) {
    return chunks.slice(0, MAX_CHUNKS);
  }
  return chunks;
}

export function estimateChunkUpperBoundForPath(
  rootDir: string,
  relPath: string,
): number {
  return getPathIndexMetadata(rootDir, relPath).estimatedChunks;
}

function getPathIndexMetadata(
  rootDir: string,
  relPath: string,
): PathIndexMetadata {
  const depth = relPath.split(/[/\\]+/).filter(Boolean).length;
  try {
    const absPath = path.join(rootDir, relPath);
    const stat = statSync(absPath);
    if (!stat.isFile() || shouldSkipFile(relPath, stat)) {
      return { depth, estimatedChunks: 0, size: stat.size };
    }
    const capped = Math.min(stat.size, MAX_FILE_SIZE);
    return {
      depth,
      estimatedChunks: Math.max(1, Math.ceil(capped / TARGET_CHUNK_CHARS)),
      size: stat.size,
    };
  } catch {
    return { depth, estimatedChunks: 0, size: Number.MAX_SAFE_INTEGER };
  }
}

export function buildPathIndexMetadata(
  rootDir: string,
  relPaths: string[],
): Map<string, PathIndexMetadata> {
  const metadata = new Map<string, PathIndexMetadata>();
  for (const relPath of relPaths) {
    metadata.set(relPath, getPathIndexMetadata(rootDir, relPath));
  }
  return metadata;
}

export function estimateChunkCountUpperBoundForFiles(
  rootDir: string,
  relPaths: string[],
): number {
  let n = 0;
  const metadata = buildPathIndexMetadata(rootDir, relPaths);
  for (const relPath of relPaths) {
    n += metadata.get(relPath)?.estimatedChunks ?? 0;
  }
  return n;
}

export function sortPathsForIndexedCoverage(
  rootDir: string,
  relPaths: string[],
  metadata = buildPathIndexMetadata(rootDir, relPaths),
): string[] {
  return [...relPaths].sort((a, b) => {
    const ma = metadata.get(a) ?? getPathIndexMetadata(rootDir, a);
    const mb = metadata.get(b) ?? getPathIndexMetadata(rootDir, b);
    if (ma.depth !== mb.depth) return ma.depth - mb.depth;
    if (ma.size !== mb.size) return ma.size - mb.size;
    return a.localeCompare(b);
  });
}

export function takePathsForChunkBudget(
  rootDir: string,
  orderedPaths: string[],
  maxChunks: number,
  metadata = buildPathIndexMetadata(rootDir, orderedPaths),
): { selected: string[]; rest: string[] } {
  if (maxChunks <= 0) {
    return { selected: [], rest: [...orderedPaths] };
  }
  if (!Number.isFinite(maxChunks)) {
    return { selected: [...orderedPaths], rest: [] };
  }
  const selected: string[] = [];
  let used = 0;
  for (const p of orderedPaths) {
    const add =
      metadata.get(p)?.estimatedChunks ??
      getPathIndexMetadata(rootDir, p).estimatedChunks;
    if (add <= 0) continue;
    if (used + add > maxChunks && selected.length > 0) break;
    selected.push(p);
    used += add;
    if (used >= maxChunks) break;
  }
  const sel = new Set(selected);
  return { selected, rest: orderedPaths.filter((p) => !sel.has(p)) };
}

function isBinary(content: string): boolean {
  const sample = content.slice(0, 8192);
  return sample.includes('\0');
}
