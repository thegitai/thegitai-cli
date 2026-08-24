import chalk from '../colors.js';
import path from 'node:path';
import { normalizeProjectRelativePath } from '../artifact-policy.js';
import {
  classifyProjectPath,
  readProjectFile,
  writeProjectFile,
} from '../patcher.js';
import { repairFilePath } from './path-suggest.js';
import { isTuiMode } from '../runtime-mode.js';
import { getCurrentFileHash, resolveRedactionTokens } from '../session-safety.js';
import {
  invalidateShellDiagnosticsCache,
  runShellDiagnostics,
} from './shell-diagnostics.js';
import { ensurePermission } from '../permissions.js';
import { ToolContext, ToolResponse } from './types.js';

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.xlsx', '.docx']);

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (pos <= haystack.length) {
    const i = haystack.indexOf(needle, pos);
    if (i === -1) break;
    count++;
    pos = i + needle.length;
  }
  return count;
}

function similarityScore(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta || !tb) return 0;
  const shorter = ta.length < tb.length ? ta : tb;
  const longer = ta.length < tb.length ? tb : ta;
  let common = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) common++;
  }
  const prefixRatio = common / longer.length;
  if (longer.includes(shorter) && shorter.length >= 4) {
    return Math.max(prefixRatio, shorter.length / longer.length);
  }
  return prefixRatio;
}

function buildClosestMatchHint(content: string, oldString: string): string {
  const contentLines = content.split('\n');
  const needleLines = oldString
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 3);
  if (needleLines.length === 0) return '';
  const target = needleLines[0]!;
  const scored: { lineNum: number; line: string; score: number }[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i]!;
    if (!line.trim()) continue;
    const score = similarityScore(target, line);
    if (score >= 0.5) {
      scored.push({ lineNum: i + 1, line, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  if (!top.length) return '';
  const formatted = top
    .map((hint) => `  line ${hint.lineNum}: ${hint.line}`)
    .join('\n');
  return `\nClosest lines in the file:\n${formatted}\n\nRe-read the file to get the exact text before retrying.`;
}

function buildStrReplacePreview(oldString: string, newString: string): string {
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  const minus = oldLines.map((l) => `-${l}`).join('\n');
  const plus = newLines.map((l) => `+${l}`).join('\n');
  return `@@ str_replace @@\n${minus}\n${plus}`;
}

export async function strReplace(
  context: ToolContext,
  args: {
    filePath?: string;
    file_path?: string;
    old_string?: string;
    oldString?: string;
    new_string?: string;
    newString?: string;
    replace_all?: boolean;
    replaceAll?: boolean;
  },
): Promise<ToolResponse> {
  const { rootDir } = context;
  const filePath = repairFilePath(
    rootDir,
    String(args.filePath ?? args.file_path ?? '').trim(),
  );
  let oldString =
    typeof args.old_string === 'string'
      ? args.old_string
      : typeof args.oldString === 'string'
        ? args.oldString
        : '';
  let newString =
    typeof args.new_string === 'string'
      ? args.new_string
      : typeof args.newString === 'string'
        ? args.newString
        : '';
  const replaceAll = args.replace_all === true || args.replaceAll === true;

  if (!filePath) {
    return { ok: false, error: 'file_path is required' };
  }
  if (oldString.length === 0) {
    return { ok: false, error: 'old_string is required and must be non-empty' };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      filePath,
      error:
        ext === '.docx'
          ? 'Use replace_document_text for .docx files.'
          : `Use read_document for ${ext} files; text replacement is not supported.`,
      failureCategory: 'invalid_argument',
    };
  }

  const pathKind = classifyProjectPath(rootDir, filePath);
  if (pathKind === 'outside') {
    return {
      ok: false,
      filePath,
      error: `Refusing to edit outside the project root: ${filePath}. Editable locations are the project root and the session scratch directory ($THEGITAI_SCRATCH_DIR).`,
      failureCategory: 'invalid_argument',
      failureDetails: {
        category: 'invalid_argument',
        tool: 'str_replace',
        action:
          'Edit files inside the project root, or use an absolute path under the session scratch directory ($THEGITAI_SCRATCH_DIR) for temporary files.',
      },
    };
  }
  // Scratch files are throwaway and never part of the repo: no project
  // indexing, no shell diagnostics.
  const scratchPath = pathKind === 'scratch';

  let originalContent: string;
  try {
    originalContent = readProjectFile(rootDir, filePath);
  } catch (err: any) {
    return {
      ok: false,
      error: `Cannot read file for str_replace: ${err.message}. Use write_file to create new files.`,
    };
  }
  const currentHash = getCurrentFileHash(rootDir, filePath);
  const coveragePath = normalizeProjectRelativePath(rootDir, filePath) ?? filePath;
  oldString = resolveRedactionTokens(
    context.safety,
    oldString,
    coveragePath,
    currentHash,
  );
  newString = resolveRedactionTokens(
    context.safety,
    newString,
    coveragePath,
    currentHash,
  );

  const n = countOccurrences(originalContent, oldString);
  if (n === 0) {
    const hint = buildClosestMatchHint(originalContent, oldString);
    return {
      ok: false,
      filePath,
      error: `String not found in file.${hint}`,
      failureCategory: 'conflict',
      failureDetails: {
        category: 'conflict',
        tool: 'str_replace',
        action:
          'The oldString text does not exist in this file. Do not keep editing imagined code; retry with oldString copied exactly from read_file output or use patch_file with exact current context.',
      },
    };
  }
  if (n >= 2 && !replaceAll) {
    return {
      ok: false,
      error: `old_string matches ${n} locations. Provide more surrounding context to make it unique, or set replace_all: true.`,
    };
  }

  const preview = buildStrReplacePreview(oldString, newString);
  if (!isTuiMode()) {
    console.log(chalk.bold(`\n  📋 str_replace preview for ${filePath}:`));
    for (const line of preview.split('\n')) {
      if (line.startsWith('+')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red(line));
      } else if (line.startsWith('@@')) {
        console.log(chalk.cyan(line));
      } else {
        console.log(chalk.dim(line));
      }
    }
    console.log();
  }
  // Session scratch is outside the repo and dies with the session, so it is
  // exempt here exactly as it is in write_file and delete_file — otherwise
  // which edit primitive the model picks would decide whether it prompts.
  if (!scratchPath) {
    const denied = await ensurePermission(
      context,
      {
        bucket: 'edit',
        title: 'Approve patch?',
        body: 'Review changes before applying.',
        filePath,
        diff: preview,
      },
      'str_replace',
      { filePath },
    );
    if (denied) {
      if (!isTuiMode()) console.log(chalk.dim(`  ⏭  str_replace skipped: ${filePath}`));
      return denied;
    }
  }
  const nextContent = originalContent.split(oldString).join(newString);
  const { changed } = writeProjectFile(rootDir, filePath, nextContent);
  const replacements = changed ? (replaceAll ? n : 1) : 0;

  let diagnostics: ReturnType<typeof runShellDiagnostics> | undefined;
  if (!scratchPath) {
    invalidateShellDiagnosticsCache(rootDir, filePath);
    diagnostics = runShellDiagnostics(rootDir, filePath);
  }
  const originalLines = originalContent.split('\n').length;
  const nextLines = nextContent.split('\n').length;

  if (!isTuiMode()) {
    const actionLabel = changed ? 'str_replace' : 'str_replace (no change)';
    const color = changed ? chalk.green : chalk.yellow;
    console.log(
      color(
        `  ✏️  ${actionLabel}: ${filePath} (${originalLines} → ${nextLines} lines, ${replacements} replacement(s))`,
      ),
    );
  }
  
  return {
    ok: true,
    filePath,
    changed,
    operation: 'str_replace',
    ...(scratchPath ? { scratch: true } : {}),
    replacements,
    bytesWritten: Buffer.byteLength(nextContent, 'utf-8'),
    diagnostics,
    message: changed ? undefined : 'The provided replacement resulted in no changes to the file content.',
  };
}
