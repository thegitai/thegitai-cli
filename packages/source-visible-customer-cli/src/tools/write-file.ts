import chalk from '../colors.js';
import path from 'node:path';
import { normalizeProjectRelativePath } from '../artifact-policy.js';
import { classifyProjectPath, writeProjectFile } from '../patcher.js';
import { readFileEditSnapshot } from '../edit-journal.js';
import { isTuiMode } from '../runtime-mode.js';
import {
  getCurrentFileHash,
  hasFreshFullReadCoverage,
  resolveRedactionTokens,
} from '../session-safety.js';
import {
  invalidateShellDiagnosticsCache,
  runShellDiagnostics,
} from './shell-diagnostics.js';
import { ensurePermission } from '../permissions.js';
import { ToolContext, ToolResponse } from './types.js';

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.xlsx', '.docx']);

const MAX_WRITE_PREVIEW_LINES = 400;

/**
 * Take at most `limit` lines from `text` without materialising the rest, and
 * report how many were left behind. `split('\n')` would allocate the whole
 * array first, which for a generated file is exactly the spike the cap exists
 * to avoid — the bound has to apply to the scan, not just to the result.
 */
function boundedLines(
  text: string,
  limit: number,
): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let omitted = 0;
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (lines.length < limit) {
      lines.push(text.slice(start, newline === -1 ? undefined : newline));
    } else {
      omitted += 1;
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return { lines, omitted };
}

/**
 * A write_file preview in the same shape str_replace uses. Bounded because
 * write_file replaces whole files, and an uncapped preview of a generated file
 * would build a six-figure line array for the approval pane to window over.
 */
function buildWritePreview(previous: string | null, next: string): string {
  const rows: string[] = ['@@ write_file @@'];
  const append = (text: string, sign: '-' | '+', marker: string): void => {
    const { lines, omitted } = boundedLines(text, MAX_WRITE_PREVIEW_LINES);
    for (const line of lines) rows.push(`${sign}${line}`);
    if (omitted > 0) {
      rows.push(`@@ ${omitted} more ${marker} line(s) not shown @@`);
    }
  };
  if (previous !== null) append(previous, '-', 'removed');
  append(next, '+', 'added');
  return rows.join('\n');
}

export async function writeFile(
  context: ToolContext,
  args: {
    filePath?: string;
    content?: string;
  },
): Promise<ToolResponse> {
  const { rootDir } = context;
  const filePath = String(args.filePath ?? '').trim();
  let content = typeof args.content === 'string' ? args.content : '';
  if (!filePath) {
    return { ok: false, error: 'filePath is required' };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      filePath,
      error:
        ext === '.docx'
          ? 'Use replace_document_text for .docx files.'
          : `Use read_document for ${ext} files; write_file is not supported.`,
      failureCategory: 'invalid_argument',
    };
  }
  const pathKind = classifyProjectPath(rootDir, filePath);
  if (pathKind === 'outside') {
    return {
      ok: false,
      filePath,
      error: `Refusing to write outside the project root: ${filePath}. Writable locations are the project root and the session scratch directory ($THEGITAI_SCRATCH_DIR).`,
      failureCategory: 'invalid_argument',
      failureDetails: {
        category: 'invalid_argument',
        tool: 'write_file',
        action:
          'Write inside the project root, or use an absolute path under the session scratch directory ($THEGITAI_SCRATCH_DIR) for temporary files.',
      },
    };
  }
  // Scratch files are throwaway and never part of the repo: no stale-overwrite
  // protection (read_file records no coverage for non-project paths, so the
  // check could never be satisfied), no project indexing, no shell
  // diagnostics.
  const scratchPath = pathKind === 'scratch';
  const coveragePath = normalizeProjectRelativePath(rootDir, filePath) ?? filePath;
  const currentHash = getCurrentFileHash(rootDir, filePath);
  if (
    !scratchPath &&
    currentHash !== null &&
    context.safety &&
    !hasFreshFullReadCoverage(context.safety, coveragePath, currentHash)
  ) {
    return {
      ok: false,
      filePath,
      failureCategory: 'conflict',
      error:
        `write_file refused to replace existing file ${filePath} without a fresh full-file read at the current hash.`,
      failureDetails: {
        category: 'conflict',
        tool: 'write_file',
        action:
          'Call read_file for the full file first, then retry write_file only if a full replacement is still necessary. Prefer str_replace or patch_file for targeted edits.',
      },
      currentHash,
    };
  }
  content = resolveRedactionTokens(
    context.safety,
    content,
    coveragePath,
    currentHash,
  );
  // The create/edit split is decided by what is on disk, not by the tool name:
  // write_file both creates and overwrites. Scratch paths are session-local
  // throwaway files, so they are never gated.
  if (!scratchPath) {
    // A binary file's snapshot comes back base64-encoded; rendering that as
    // removed lines would be noise, so the preview shows only what is being
    // written in that case.
    const before = currentHash === null ? null : readFileEditSnapshot(rootDir, filePath);
    const existing =
      before && before.contentEncoding === 'utf8' ? before.content : null;
    const denied = await ensurePermission(
      context,
      {
        bucket: currentHash === null ? 'create' : 'edit',
        title: currentHash === null ? 'Approve new file?' : 'Approve patch?',
        body: 'Review changes before applying.',
        filePath,
        diff: buildWritePreview(existing, content),
      },
      'write_file',
      { filePath },
    );
    if (denied) {
      if (!isTuiMode()) console.log(chalk.dim(`  ⏭  write_file skipped: ${filePath}`));
      return denied;
    }
    // The prompt can sit open for as long as the operator takes to read it. If
    // the target changed underneath, the approval that just came back was for a
    // different file than the one about to be written — a path that was missing
    // when we classified this as a creation may now hold someone else's work.
    if (getCurrentFileHash(rootDir, filePath) !== currentHash) {
      return {
        ok: false,
        filePath,
        failureCategory: 'conflict',
        error:
          `write_file refused: ${filePath} changed on disk while the approval prompt was open.`,
        failureDetails: {
          category: 'conflict',
          tool: 'write_file',
          action:
            'Re-read the file to see its current contents, then decide whether the write is still correct and retry.',
        },
        currentHash,
      };
    }
  }
  const { changed } = writeProjectFile(rootDir, filePath, content);

  let diagnostics: ReturnType<typeof runShellDiagnostics> | undefined;
  if (!scratchPath) {
    invalidateShellDiagnosticsCache(rootDir, filePath);
    diagnostics = runShellDiagnostics(rootDir, filePath);
  }

  if (!isTuiMode()) {
    const icon = changed ? '✨' : '📝';
    const label = changed ? 'Created/Updated' : 'Created/Updated (no change)';
    console.log(chalk.green(`  ${icon} ${label}: ${filePath}`));
  }

  return {
    ok: true,
    filePath,
    changed,
    operation: 'write',
    ...(scratchPath ? { scratch: true } : {}),
    bytesWritten: Buffer.byteLength(content, 'utf-8'),
    diagnostics,
  };
}
