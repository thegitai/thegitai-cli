import chalk from '../colors.js';
import { classifyProjectPath, deleteProjectFile } from '../patcher.js';
import { isTuiMode } from '../runtime-mode.js';
import {
  invalidateShellDiagnosticsCache,
  runShellDiagnostics,
} from './shell-diagnostics.js';
import { ensurePermission } from '../permissions.js';
import { ToolContext, ToolResponse } from './types.js';

export async function deleteFile(
  context: ToolContext,
  args: {
    filePath?: string;
  },
): Promise<ToolResponse> {
  const { rootDir } = context;
  const filePath = String(args.filePath ?? '').trim();
  if (!filePath) {
    return { ok: false, error: 'filePath is required' };
  }
  const pathKind = classifyProjectPath(rootDir, filePath);
  if (pathKind === 'outside') {
    return {
      ok: false,
      filePath,
      error: `Refusing to delete outside the project root: ${filePath}. Deletable locations are the project root and the session scratch directory ($THEGITAI_SCRATCH_DIR).`,
      failureCategory: 'invalid_argument',
      failureDetails: {
        category: 'invalid_argument',
        tool: 'delete_file',
        action:
          'Delete files inside the project root, or use an absolute path under the session scratch directory ($THEGITAI_SCRATCH_DIR).',
      },
    };
  }
  // Scratch files are throwaway and never part of the repo: no project
  // indexing, no shell diagnostics.
  const scratchPath = pathKind === 'scratch';
  // Session scratch is outside the repo and dies with the session, so gating it
  // would be pure noise. Only the user's actual project is protected. Runs after
  // the hard path/policy blocks above so no grant can bypass them.
  if (!scratchPath) {
    const denied = await ensurePermission(
      context,
      {
        bucket: 'delete',
        title: 'Approve file deletion?',
        body: `Delete ${filePath}`,
        filePath,
      },
      'delete_file',
      { filePath },
    );
    if (denied) {
      if (!isTuiMode()) console.log(chalk.dim(`  ⏭  Delete skipped: ${filePath}`));
      return denied;
    }
  }
  const result = deleteProjectFile(rootDir, filePath);
  if (result.deleted) {
    if (!scratchPath) {
      invalidateShellDiagnosticsCache(rootDir, filePath);
    }
    if (!isTuiMode()) console.log(chalk.red(`  🗑️  Deleted: ${filePath}`));
  }
  return {
    ok: true,
    filePath,
    changed: result.deleted,
    deleted: result.deleted,
    ...(scratchPath ? { scratch: true } : {}),
    content: result.content,
    diagnostics:
      result.deleted && !scratchPath ? runShellDiagnostics(rootDir) : undefined,
  };
}
