import chalk from '../colors.js';
import {
  hashStoredContent,
  readFileEditSnapshot,
  storedContentBuffer,
  type AssistantEditRecord,
} from '../edit-journal.js';
import {
  deleteProjectFile,
  writeProjectFile,
  writeProjectFileBuffer,
} from '../patcher.js';
import { isTuiMode } from '../runtime-mode.js';
import {
  invalidateShellDiagnosticsCache,
  runShellDiagnostics,
} from './shell-diagnostics.js';
import { ToolContext, ToolResponse } from './types.js';

type UndoTarget = 'last_assistant_edit' | 'last_turn' | 'file' | 'edit_id';

function normalizeTarget(value: unknown): UndoTarget {
  const text = String(value ?? '').trim();
  if (
    text === 'last_turn' ||
    text === 'file' ||
    text === 'edit_id' ||
    text === 'last_assistant_edit'
  ) {
    return text;
  }
  return 'last_assistant_edit';
}

function activeRecords(records: AssistantEditRecord[]): AssistantEditRecord[] {
  return records.filter((record) => !record.revertedAt);
}

function latestRecord(records: AssistantEditRecord[]): AssistantEditRecord | null {
  return records.length ? records[records.length - 1]! : null;
}

function selectRecords(
  records: AssistantEditRecord[],
  target: UndoTarget,
  editId: string,
  filePath: string,
): AssistantEditRecord[] {
  const active = activeRecords(records);
  if (target === 'edit_id') {
    return active.filter((record) => record.id === editId);
  }
  if (target === 'file') {
    const latest = latestRecord(
      active.filter((record) => record.filePath === filePath),
    );
    return latest ? [latest] : [];
  }
  if (target === 'last_turn') {
    const latest = latestRecord(active);
    if (!latest) return [];
    if (!latest.turnId) return [latest];
    return active.filter((record) => record.turnId === latest.turnId).reverse();
  }
  const latest = latestRecord(active);
  return latest ? [latest] : [];
}

function validateUndoPlan(rootDir: string, records: AssistantEditRecord[]) {
  const simulatedHashes = new Map<string, string | null>();
  for (const record of records) {
    let currentHash: string | null;
    if (simulatedHashes.has(record.filePath)) {
      currentHash = simulatedHashes.get(record.filePath) ?? null;
    } else {
      const current = readFileEditSnapshot(rootDir, record.filePath);
      if (current.error) {
        return {
          ok: false,
          error: `Cannot inspect ${record.filePath} before undo: ${current.error}`,
          editId: record.id,
          filePath: record.filePath,
          expectedHash: record.afterHash,
          currentHash: current.hash,
        };
      }
      currentHash = current.hash;
    }
    if (currentHash !== record.afterHash) {
      return {
        ok: false,
        error:
          `Cannot undo ${record.id} for ${record.filePath}: ` +
          'the file changed after the assistant edit.',
        editId: record.id,
        filePath: record.filePath,
        expectedHash: record.afterHash,
        currentHash,
      };
    }
    const needsPreimage =
      record.operation === 'update' || record.operation === 'delete';
    if (needsPreimage) {
      if (record.beforeContent === null || record.beforeHash === null) {
        return {
          ok: false,
          error: `Cannot undo ${record.id}: the stored pre-edit snapshot is incomplete.`,
          editId: record.id,
          filePath: record.filePath,
          expectedHash: record.beforeHash,
          currentHash,
        };
      }
      const beforeContentHash = hashStoredContent(
        record.beforeContent,
        record.beforeContentEncoding,
      );
      if (beforeContentHash !== record.beforeHash) {
        return {
          ok: false,
          error: `Cannot undo ${record.id}: stored before-content hash does not match the edit record.`,
          editId: record.id,
          filePath: record.filePath,
          expectedHash: record.beforeHash,
          currentHash: beforeContentHash,
        };
      }
    }
    simulatedHashes.set(
      record.filePath,
      record.operation === 'create' ? null : record.beforeHash,
    );
  }
  return { ok: true };
}

async function applyUndo(context: ToolContext, record: AssistantEditRecord) {
  const { rootDir } = context;
  if (record.operation === 'create') {
    deleteProjectFile(rootDir, record.filePath);
    return { changed: true };
  }
  if (record.beforeContent === null) {
    throw new Error(
      `Cannot undo ${record.id}: the stored pre-edit snapshot is incomplete.`,
    );
  }
  const { changed } =
    record.beforeContentEncoding === 'base64'
      ? writeProjectFileBuffer(
          rootDir,
          record.filePath,
          storedContentBuffer(record.beforeContent, record.beforeContentEncoding),
        )
      : writeProjectFile(rootDir, record.filePath, record.beforeContent);
  return { changed };
}

function summarizeUndoRecord(record: AssistantEditRecord) {
  return {
    id: record.id,
    filePath: record.filePath,
    operation: record.operation,
    toolName: record.toolName,
    turnId: record.turnId,
  };
}

export async function undoEdit(
  context: ToolContext,
  args: {
    target?: string;
    editId?: string;
    edit_id?: string;
    filePath?: string;
    file_path?: string;
    dryRun?: boolean;
    dry_run?: boolean;
  },
): Promise<ToolResponse> {
  const records = context.editJournal ?? [];
  const target = normalizeTarget(args.target);
  const editId = String(args.editId ?? args.edit_id ?? '').trim();
  const filePath = String(args.filePath ?? args.file_path ?? '').trim();
  if (target === 'edit_id' && !editId) {
    return {
      ok: false,
      failureCategory: 'missing_required_argument',
      error: 'editId is required when target is edit_id',
    };
  }
  if (target === 'file' && !filePath) {
    return {
      ok: false,
      failureCategory: 'missing_required_argument',
      error: 'filePath is required when target is file',
    };
  }
  const selected = selectRecords(records, target, editId, filePath);
  if (!selected.length) {
    return {
      ok: false,
      failureCategory: 'not_found',
      error: 'No active assistant edit matched the undo request.',
      target,
      editId: editId || undefined,
      filePath: filePath || undefined,
    };
  }
  const validation = validateUndoPlan(context.rootDir, selected);
  if (!validation.ok) {
    return {
      ok: false,
      failureCategory: 'conflict',
      error: validation.error,
      editId: validation.editId,
      filePath: validation.filePath,
      expectedHash: validation.expectedHash,
      currentHash: validation.currentHash,
    };
  }
  const dryRun = args.dryRun === true || args.dry_run === true;
  let anyChanged = false;
  if (!dryRun) {
    for (const record of selected) {
      const result = await applyUndo(context, record);
      if (result.changed) {
        anyChanged = true;
      }
      context.markEditReverted?.(record.id, context.currentToolCallId ?? 'undo_edit');
    }
    invalidateShellDiagnosticsCache(context.rootDir);
  }
  const previewed = dryRun ? selected.map(summarizeUndoRecord) : [];
  const reverted = dryRun ? [] : selected.map(summarizeUndoRecord);
  if (!isTuiMode()) {
    const files = (dryRun ? previewed : reverted)
      .map((record) => record.filePath)
      .join(', ');
    const actionLabel = anyChanged || dryRun ? 'Undo' : 'Undo (no change)';
    console.log(chalk.green(`  ${actionLabel} ${dryRun ? 'preview' : 'edit'}: ${files}`));
  }
  return {
    ok: true,
    operation: 'undo_edit',
    target,
    changed: anyChanged,
    dryRun,
    previewed,
    reverted,
    gitWorkTree: selected.some((record) => record.gitWorkTree),
    diagnostics: dryRun ? undefined : runShellDiagnostics(context.rootDir),
  };
}
