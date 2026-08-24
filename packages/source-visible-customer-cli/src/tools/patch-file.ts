import chalk from '../colors.js';
import path from 'node:path';
import { normalizeProjectRelativePath } from '../artifact-policy.js';
import {
  applyUnifiedPatch,
  classifyProjectPath,
  readProjectFile,
  renderDiffPreview,
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

export async function patchFile(
  context: ToolContext,
  args: {
    filePath?: string;
    patch?: string;
  },
): Promise<ToolResponse> {
  const { rootDir } = context;
  const filePath = repairFilePath(rootDir, String(args.filePath ?? '').trim());
  let patch = typeof args.patch === 'string' ? args.patch : '';
  if (!filePath) {
    return { ok: false, error: 'filePath is required' };
  }
  if (!patch.trim()) {
    return { ok: false, error: 'patch is required' };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      filePath,
      error:
        ext === '.docx'
          ? 'Use replace_document_text for .docx files.'
          : `Use read_document for ${ext} files; patching is not supported.`,
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
        tool: 'patch_file',
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
      error: `Cannot read file for patching: ${err.message}. Use write_file to create new files.`,
    };
  }
  const coveragePath = normalizeProjectRelativePath(rootDir, filePath) ?? filePath;
  patch = resolveRedactionTokens(
    context.safety,
    patch,
    coveragePath,
    getCurrentFileHash(rootDir, filePath),
  );
  let patchedContent: string;
  try {
    patchedContent = applyUnifiedPatch(originalContent, patch);
  } catch (err: any) {
    return {
      ok: false,
      filePath,
      error: `Patch failed: ${err.message}`,
      failureCategory: 'conflict',
      failureDetails: {
        category: 'conflict',
        tool: 'patch_file',
        action:
          'Re-read the full file and rebuild the patch against the current exact file content.',
      },
    };
  }
  renderDiffPreview(filePath, patch);
  // Session scratch is outside the repo and dies with the session, so it is
  // exempt here exactly as it is in write_file and delete_file — otherwise
  // which edit primitive the model picks would decide whether it prompts.
  if (!scratchPath) {
    // A patch can introduce a file as well as change one, so the bucket
    // follows what happens on disk rather than the tool's name.
    const denied = await ensurePermission(
      context,
      {
        bucket: getCurrentFileHash(rootDir, filePath) === null ? 'create' : 'edit',
        title: 'Approve patch?',
        body: 'Review changes before applying.',
        filePath,
        diff: patch,
      },
      'patch_file',
      { filePath },
    );
    if (denied) {
      if (!isTuiMode()) console.log(chalk.dim(`  ⏭  Patch skipped: ${filePath}`));
      return denied;
    }
  }
  const { changed } = writeProjectFile(rootDir, filePath, patchedContent);

  let diagnostics: ReturnType<typeof runShellDiagnostics> | undefined;
  if (!scratchPath) {
    invalidateShellDiagnosticsCache(rootDir, filePath);
    diagnostics = runShellDiagnostics(rootDir, filePath);
  }
  const originalLines = originalContent.split('\n').length;
  const patchedLines = patchedContent.split('\n').length;

  if (!isTuiMode()) {
    const actionLabel = changed ? 'Patched' : 'Patched (no change)';
    const color = changed ? chalk.green : chalk.yellow;
    console.log(
      color(
        `  ✏️  ${actionLabel}: ${filePath} (${originalLines} → ${patchedLines} lines)`,
      ),
    );
  }

  return {
    ok: true,
    filePath,
    changed,
    operation: 'patch',
    ...(scratchPath ? { scratch: true } : {}),
    bytesWritten: Buffer.byteLength(patchedContent, 'utf-8'),
    diagnostics,
  };
}
