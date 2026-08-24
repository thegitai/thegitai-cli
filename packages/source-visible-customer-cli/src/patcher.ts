import chalk from './colors.js';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { runCommand } from './executor.js';
import {
  ensureSessionScratchDir,
  isInsideTheGitAiScratch,
  isWithinSessionScratchDir,
} from './scratch-dir.js';
import { isTuiMode } from './runtime-mode.js';
import { truncate } from './utils.js';

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function parseUnifiedDiff(patchText: string): Hunk[] {
  const lines = patchText.split('\n');
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (
      line.startsWith('diff ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      i++;
      continue;
    }
    break;
  }
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) {
      i++;
      continue;
    }
    const oldStart = parseInt(hunkMatch[1] || '0', 10);
    const oldCount =
      hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
    const newStart = parseInt(hunkMatch[3] || '0', 10);
    const newCount =
      hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
    i++;
    const hunkLines: string[] = [];
    while (i < lines.length) {
      const nextLine = lines[i];
      if (nextLine === undefined || nextLine.startsWith('@@')) break;
      hunkLines.push(nextLine);
      i++;
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
  }
  return hunks;
}

function formatActualFileSnippet(lines: string[], lineIndex: number): string {
  const before = Math.max(0, lineIndex - 3);
  const after = Math.min(lines.length, lineIndex + 4);
  const width = String(after).length;
  const rows: string[] = [];
  for (let i = before; i < after; i++) {
    const marker = i === lineIndex ? '→' : ' ';
    const line = i < lines.length ? lines[i]! : '';
    rows.push(`${marker} ${String(i + 1).padStart(width)}: ${line}`);
  }
  return rows.join('\n');
}

export function applyUnifiedPatch(
  originalContent: string,
  patchText: string,
): string {
  const hunks = parseUnifiedDiff(patchText);
  if (!hunks.length) {
    throw new Error(
      'No valid hunks found in patch. Ensure the patch uses standard unified diff format with @@ hunk headers.',
    );
  }
  const endsWithNewline = originalContent.endsWith('\n');
  const originalLines = endsWithNewline
    ? originalContent.slice(0, -1).split('\n')
    : originalContent.split('\n');
  const result = [...originalLines];
  let offset = 0;
  for (const hunk of hunks) {
    const startIdx = hunk.oldStart - 1 + offset;
    let oldIdx = startIdx;
    const newChunk: string[] = [];
    if (hunk.oldCount === 0 && startIdx > result.length) {
      throw new Error(
        `Patch hunk claims insertion at line ${hunk.oldStart} but the file only has ${result.length} line(s). ` +
          'Re-read the file to get current line numbers before patching.',
      );
    }
    for (const line of hunk.lines) {
      if (line.length === 0) continue;
      if (line === '\\ No newline at end of file') continue;
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === ' ') {
        if (result[oldIdx] !== content) {
          throw new Error(
            `Patch context mismatch at line ${oldIdx + 1}:\n` +
              `  Expected: ${JSON.stringify(content)}\n` +
              `  Got:      ${JSON.stringify(result[oldIdx])}\n\n` +
              `Actual file around line ${oldIdx + 1}:\n${formatActualFileSnippet(result, oldIdx)}\n\n` +
              `Re-read the file to get the current lines and rebuild the hunk before retrying.`,
          );
        }
        newChunk.push(content);
        oldIdx++;
      } else if (prefix === '-') {
        if (result[oldIdx] !== content) {
          throw new Error(
            `Patch removal mismatch at line ${oldIdx + 1}:\n` +
              `  Expected: ${JSON.stringify(content)}\n` +
              `  Got:      ${JSON.stringify(result[oldIdx])}\n\n` +
              `Actual file around line ${oldIdx + 1}:\n${formatActualFileSnippet(result, oldIdx)}\n\n` +
              `Re-read the file to get the current lines and rebuild the hunk before retrying.`,
          );
        }
        oldIdx++;
      } else if (prefix === '+') {
        newChunk.push(content);
      }
    }
    const removedCount = oldIdx - startIdx;
    result.splice(startIdx, removedCount, ...newChunk);
    offset += newChunk.length - removedCount;
  }
  const joined = result.join('\n');
  return endsWithNewline ? `${joined}\n` : joined;
}

export function renderDiffPreview(filePath: string, patchText: string): void {
  if (isTuiMode()) return;
  console.log(chalk.bold(`\n  📋 Patch preview for ${filePath}:`));
  for (const line of patchText.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      console.log(chalk.bold(line));
    } else if (line.startsWith('@@')) {
      console.log(chalk.cyan(line));
    } else if (line.startsWith('+')) {
      console.log(chalk.green(line));
    } else if (line.startsWith('-')) {
      console.log(chalk.red(line));
    } else {
      console.log(chalk.dim(line));
    }
  }
  console.log();
}

function normalizeRoot(rootDir: string): string {
  return path.resolve(rootDir);
}

function expandScratchPath(filePath: string): string {
  const match = filePath.match(
    /^(?:\$THEGITAI_SCRATCH_DIR|\$\{THEGITAI_SCRATCH_DIR\})(?:[\\/](.*))?$/,
  );
  if (!match) return filePath;
  const root = ensureSessionScratchDir();
  return match[1] ? path.join(root, match[1]) : root;
}

// Where a tool-supplied path lands: inside the project root, inside the
// session scratch subtree (the sanctioned temp workspace the prompt
// advertises), or outside both. Only 'outside' is refused — the scratch dir
// must accept the same file tools whose guidance points the model at it.
export type ProjectPathKind = 'project' | 'scratch' | 'outside';

export function classifyProjectPath(
  rootDir: string,
  filePath: string,
): ProjectPathKind {
  const absRoot = normalizeRoot(rootDir);
  const absPath = path.resolve(absRoot, expandScratchPath(filePath));
  if (isWithinSessionScratchDir(absPath)) {
    return absPath !== path.resolve(ensureSessionScratchDir()) &&
      isInsideTheGitAiScratch(absPath)
      ? 'scratch'
      : 'outside';
  }
  const relative = path.relative(absRoot, absPath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return 'project';
  }
  return 'outside';
}

export function resolveProjectPath(rootDir: string, filePath: string): string {
  const absRoot = normalizeRoot(rootDir);
  const absPath = path.resolve(absRoot, expandScratchPath(filePath));
  if (classifyProjectPath(rootDir, filePath) === 'outside') {
    throw new Error(
      `Refusing to access path outside the project root: ${filePath}. Allowed locations are the project root and the session scratch directory ($THEGITAI_SCRATCH_DIR).`,
    );
  }
  return absPath;
}

// Parent directories minted inside the scratch subtree are created 0700 like
// the session scratch root itself — a write must not recreate a missing
// thegitai-* root with looser permissions than ensureSessionScratchDir uses.
function mkdirForWrite(absPath: string, scratchPath: boolean): void {
  const parent = path.dirname(absPath);
  if (!scratchPath) {
    mkdirSync(parent, { recursive: true });
    return;
  }
  const scratchRoot = path.resolve(ensureSessionScratchDir());
  const relative = path.relative(scratchRoot, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to create a directory outside the session scratch root: ${parent}`);
  }
  let current = scratchRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to traverse unsafe scratch directory: ${current}`);
    }
    if (process.platform !== 'win32') chmodSync(current, 0o700);
  }
}

function writeScratchFile(absPath: string, content: string | Buffer): void {
  const scratchRoot = realpathSync(ensureSessionScratchDir());
  const parent = realpathSync(path.dirname(absPath));
  const relativeParent = path.relative(scratchRoot, parent);
  if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) {
    throw new Error(`Refusing to write through an unsafe scratch directory: ${absPath}`);
  }
  const verifiedPath = path.join(parent, path.basename(absPath));
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(
    verifiedPath,
    constants.O_WRONLY | constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error(`Refusing to write an unsafe scratch file: ${absPath}`);
    }
    ftruncateSync(fd, 0);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

export function writeProjectFile(
  rootDir: string,
  filePath: string,
  content: string,
): { absPath: string; changed: boolean } {
  const absPath = resolveProjectPath(rootDir, filePath);
  const scratchPath = classifyProjectPath(rootDir, filePath) === 'scratch';
  if (existsSync(absPath)) {
    try {
      const existingContent = readFileSync(absPath, 'utf-8');
      if (existingContent === content) {
        return { absPath, changed: false };
      }
    } catch {
      // If we can't read it for some reason, proceed with write
    }
  }
  mkdirForWrite(absPath, scratchPath);
  if (scratchPath) {
    writeScratchFile(absPath, content);
  } else {
    writeFileSync(absPath, content, 'utf-8');
  }
  return { absPath, changed: true };
}

export function writeProjectFileBuffer(
  rootDir: string,
  filePath: string,
  content: Buffer,
): { absPath: string; changed: boolean } {
  const absPath = resolveProjectPath(rootDir, filePath);
  const scratchPath = classifyProjectPath(rootDir, filePath) === 'scratch';
  if (existsSync(absPath)) {
    try {
      const existingContent = readFileSync(absPath);
      if (existingContent.equals(content)) {
        return { absPath, changed: false };
      }
    } catch {
      // If we can't read it for some reason, proceed with write
    }
  }
  mkdirForWrite(absPath, scratchPath);
  if (scratchPath) {
    writeScratchFile(absPath, content);
  } else {
    writeFileSync(absPath, content);
  }
  return { absPath, changed: true };
}

export function deleteProjectFile(
  rootDir: string,
  filePath: string,
): {
  deleted: boolean;
  absPath: string;
  content?: string;
} {
  const absPath = resolveProjectPath(rootDir, filePath);
  if (!existsSync(absPath)) {
    return { deleted: false, absPath };
  }
  let content: string | undefined;
  try {
    if (!lstatSync(absPath).isSymbolicLink()) {
      content = readFileSync(absPath, 'utf-8');
    }
  } catch {
    content = undefined;
  }
  unlinkSync(absPath);
  return { deleted: true, absPath, content };
}

export function readProjectFile(rootDir: string, filePath: string): string {
  const absPath = resolveProjectPath(rootDir, filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  return readFileSync(absPath, 'utf-8');
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

export interface ChangeOperation {
  action: 'create' | 'update' | 'delete' | 'run';
  filePath?: string;
  content?: string;
  command?: string;
}

export async function applyChanges(
  operations: ChangeOperation[],
  rootDir: string,
  {
    autoYes = false,
  }: {
    autoYes?: boolean;
  } = {},
): Promise<void> {
  const silent = isTuiMode();
  if (!operations.length) {
    if (!silent) console.log(chalk.yellow('\n⚠  No changes to apply.'));
    return;
  }
  const fileOps = operations.filter((op) => op.action !== 'run');
  const cmdOps = operations.filter((op) => op.action === 'run');
  if (!silent) console.log(
    chalk.bold(
      `\n📝 Applying ${fileOps.length} file change(s) and ${cmdOps.length} command(s):\n`,
    ),
  );
  for (const op of operations) {
    switch (op.action) {
      case 'create':
      case 'update': {
        if (op.filePath && op.content !== undefined) {
          writeProjectFile(rootDir, op.filePath, op.content);
          const icon = op.action === 'create' ? '✨' : '✏️ ';
          const label = op.action === 'create' ? 'Created' : 'Updated';
          if (!silent) console.log(chalk.green(`  ${icon} ${label}: ${op.filePath}`));
        }
        break;
      }

      case 'delete': {
        if (op.filePath) {
          try {
            const result = deleteProjectFile(rootDir, op.filePath);
            if (result.deleted) {
              if (!silent) console.log(chalk.red(`  🗑️  Deleted: ${op.filePath}`));
            } else {
              if (!silent) console.log(
                chalk.yellow(
                  `  ⚠  Could not delete ${op.filePath}: file not found`,
                ),
              );
            }
          } catch (err: any) {
            if (!silent) console.log(
              chalk.yellow(
                `  ⚠  Could not delete ${op.filePath}: ${err.message}`,
              ),
            );
          }
        }
        break;
      }
      case 'run': {
        if (op.command) {
          if (!silent) console.log(chalk.bold.yellow(`\n  ⚡ Command: ${op.command}`));
          if (!autoYes) {
            const proceed = await confirm(
              chalk.yellow(`  ⚠  Run this command? [y/N] `),
            );
            if (!proceed) {
              if (!silent) console.log(chalk.dim(`  ⏭  Skipped: ${op.command}`));
              break;
            }
          }
          const result = await runCommand(op.command, rootDir);
          if (result.exitCode !== 0) {
            if (!silent) console.log(
              chalk.red(
                `  ⚠  Command failed (exit ${result.exitCode}). Continuing…`,
              ),
            );
            if (!silent && result.output) {
              console.log(chalk.dim(truncate(result.output, 1000)));
            }
          }
        }
        break;
      }
      default:
        if (!silent) console.log(
          chalk.yellow(`  ⚠  Unknown action "${(op as any).action}"`),
        );
    }
  }
  if (!silent) console.log(chalk.bold.green('\n✅ All operations complete.\n'));
}
