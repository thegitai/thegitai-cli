import chalk from '../colors.js';
import { isTuiMode } from '../runtime-mode.js';
import {
  createPromptCheckpoint,
  restoreCheckpointFiles,
} from '../session-safety.js';
import {
  invalidateShellDiagnosticsCache,
  runShellDiagnostics,
} from './shell-diagnostics.js';
import { ToolContext, ToolResponse } from './types.js';

function normalizeFilePaths(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

export async function restoreToCheckpoint(
  context: ToolContext,
  args: {
    checkpointId?: string;
    checkpoint_id?: string;
    filePaths?: string[];
    file_paths?: string[];
    dryRun?: boolean;
    dry_run?: boolean;
  },
): Promise<ToolResponse> {
  if (!context.safety) {
    return { ok: false, error: 'No session safety state is available.' };
  }
  const checkpointId = String(args.checkpointId ?? args.checkpoint_id ?? '').trim();
  if (!checkpointId) {
    return {
      ok: false,
      failureCategory: 'missing_required_argument',
      error: 'checkpointId is required',
    };
  }
  const filePaths = normalizeFilePaths(args.filePaths ?? args.file_paths);
  const dryRun = args.dryRun === true || args.dry_run === true;
  const checkpoint = context.safety.checkpoints.find(
    (item) => item.id === checkpointId,
  );
  if (!checkpoint) {
    return {
      ok: false,
      failureCategory: 'not_found',
      checkpointId,
      error: `Checkpoint not found: ${checkpointId}`,
    };
  }
  if (dryRun) {
    const targets = filePaths?.length
      ? checkpoint.files.filter((file) => filePaths.includes(file.filePath))
      : checkpoint.files;
    return {
      ok: true,
      checkpointId,
      dryRun: true,
      changed: false,
      restored: [],
      preview: targets.map((file) => ({
        filePath: file.filePath,
        exists: file.exists,
        hash: file.hash,
        restorable: !file.skipped && (file.content !== null || !file.exists),
        skipped: file.skipped,
      })),
    };
  }
  const result = await restoreCheckpointFiles({
    state: context.safety,
    rootDir: context.rootDir,
    checkpointId,
    filePaths,
    currentTurnId: context.currentTurnId ?? null,
    currentToolCallId: context.currentToolCallId ?? null,
  });
  if (!result.ok) {
    return {
      ...result,
      failureCategory: 'conflict',
      failureDetails: {
        category: 'conflict',
        tool: 'restore_to_checkpoint',
        action:
          'Inspect the listed files before retrying restore. The tool refused to overwrite unknown current content.',
      },
    };
  }
  invalidateShellDiagnosticsCache(context.rootDir);
  createPromptCheckpoint(
    context.safety,
    `after restore ${checkpointId}`,
    context.currentTurnId ?? null,
  );
  if (!isTuiMode()) {
    console.log(
      chalk.green(
        `  Restored checkpoint ${checkpointId}: ${result.restored
          .map((item) => item.filePath)
          .join(', ')}`,
      ),
    );
  }
  return {
    ...result,
    operation: 'restore_to_checkpoint',
    diagnostics: runShellDiagnostics(context.rootDir),
  };
}

export async function restoreFilesToCheckpoint(
  context: ToolContext,
  args: {
    checkpointId?: string;
    checkpoint_id?: string;
    filePaths?: string[];
    file_paths?: string[];
    dryRun?: boolean;
    dry_run?: boolean;
  },
): Promise<ToolResponse> {
  const filePaths = normalizeFilePaths(args.filePaths ?? args.file_paths) ?? [];
  if (!filePaths.length) {
    return {
      ok: false,
      failureCategory: 'missing_required_argument',
      error: 'filePaths is required for restore_files_to_checkpoint',
    };
  }
  return restoreToCheckpoint(context, {
    ...args,
    filePaths,
  });
}
