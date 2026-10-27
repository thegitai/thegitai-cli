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
import { diagnoseEditedFile } from './shell-diagnostics.js';
import { ensurePermission } from '../permissions.js';
import { ToolContext, ToolResponse } from './types.js';

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.xlsx', '.docx']);

const MAX_WRITE_PREVIEW_LINES = 400;







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



  if (!scratchPath) {



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

  let diagnostics: Awaited<ReturnType<typeof diagnoseEditedFile>> | undefined;
  if (!scratchPath) {
    diagnostics = await diagnoseEditedFile(rootDir, filePath, 'write_file', context.diagnosticsPlan);
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
