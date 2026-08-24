import {
  drainBackgroundJobNotifications,
  getBackgroundJob,
  type KillBackgroundJobResult,
} from './background-jobs.js';
import {
  canStoreEditSnapshot,
  isEditToolName,
  isGitWorkTree,
  MAX_EDIT_JOURNAL_RECORDS,
  operationFromSnapshots,
  readFileEditSnapshot,
  type FileEditSnapshot,
} from './edit-journal.js';
import {
  clearEditFailure,
  collectCommandMutations,
  captureMutationBaseline,
  ensureActiveCheckpoint,
  type MutationTracker,
  recordEditFailure,
  recordSessionEdit,
  rememberCheckpointFiles,
} from './session-safety.js';
import {
  buildAgentModeToolBlockedResult,
} from './agent-mode.js';
import { classifyProjectPath } from './patcher.js';
import { dispatchTool } from './tools/index.js';
import { PATH_REPAIRING_EDIT_TOOLS, repairFilePath } from './tools/path-suggest.js';
import {
  invalidateShellDiagnosticsCache,
  runShellDiagnostics,
} from './tools/shell-diagnostics.js';
import type { ToolResponse } from './tools/types.js';
import type { SessionState } from './session.js';
import type { ToolCall } from './types.js';
import { extractTodosArg } from './todo-list.js';

const EDIT_FILE_PATH_ARG_ALIASES = [
  'filePath',
  'file_path',
  'filepath',
  'path',
  'file',
  'filename',
] as const;

interface BackgroundCommandTracker {
  tracker: MutationTracker;
  toolName: string;
  toolCallId: string | null;
  turnId: string | null;
}

const backgroundCommandTrackers = new Map<string, BackgroundCommandTracker>();

function toolCallSummary(call: ToolCall): string {
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  if (call.name === 'run_command') {
    return String(args.command ?? args.cmd ?? '').trim();
  }
  if (call.name === 'run_node_script') {
    return String(args.script ?? '').trim().slice(0, 120);
  }
  if (
    call.name === 'shell_job_output' ||
    call.name === 'shell_job_kill'
  ) {
    return String(args.job_id ?? '').trim();
  }
  if (call.name === 'update_todos') {
    const raw = extractTodosArg(args);
    const todos = Array.isArray(raw) ? raw : [];
    if (todos.length === 0) return '';
    return `${todos.length} item${todos.length === 1 ? '' : 's'}`;
  }
  const filePath = getEditToolFilePath(call);
  if (filePath) return filePath;
  if (typeof args.query === 'string') return args.query.slice(0, 120);
  return '';
}

export function formatToolCallForStatus(call: ToolCall): string {
  const summary = toolCallSummary(call);
  return summary ? `Tool: ${call.name} ${summary}` : `Tool: ${call.name}`;
}

function getEditToolFilePath(call: ToolCall): string {
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  if (call.name === 'replace_document_text') {
    const outputPath = args.outputPath ?? args.output_path;
    if (typeof outputPath === 'string' && outputPath.trim()) {
      return outputPath.trim();
    }
  }
  for (const key of EDIT_FILE_PATH_ARG_ALIASES) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// replace_document_text repairs its source filePath but writes a separate
// outputPath verbatim (a write target must not be fold-matched onto a different
// existing file). When an outputPath is given, the snapshot path it returns is
// that raw output, so it must not be repaired.
function editToolWritesSeparateOutput(call: ToolCall): boolean {
  if (call.name !== 'replace_document_text') return false;
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const output = args.outputPath ?? args.output_path;
  return typeof output === 'string' && output.trim().length > 0;
}

async function collectTrackedCommandMutations({
  session,
  result,
  tracker,
  toolName,
  toolCallId,
  turnId,
}: {
  session: SessionState;
  result: Record<string, any>;
  tracker: MutationTracker;
  toolName: string;
  toolCallId: string | null;
  turnId: string | null;
}): Promise<void> {
  const checkpoint = ensureActiveCheckpoint(session.clientState.safety, turnId);
  const records = collectCommandMutations({
    state: session.clientState.safety,
    rootDir: session.rootDir,
    tracker,
    toolName,
    toolCallId,
    turnId,
    checkpointId: checkpoint.id,
  });
  if (!records.length) return;
  invalidateShellDiagnosticsCache(session.rootDir);
  rememberCheckpointFiles(
    session.clientState.safety,
    session.rootDir,
    records.map((record) => record.filePath),
    turnId,
  );
  // Filesystem mutation counts come from the mutation baseline tracker, which
  // is the authoritative source now that the local chunk index is gone.
  result.repoSync = {
    added: records.filter((record) => record.operation === 'create').length,
    modified: records.filter((record) => record.operation === 'update').length,
    removed: records.filter((record) => record.operation === 'delete').length,
  };
  result.sessionEdits = records.map((record) => ({
    id: record.id,
    filePath: record.filePath,
    operation: record.operation,
    beforeHash: record.beforeHash,
    afterHash: record.afterHash,
  }));
  result.diagnostics = runShellDiagnostics(session.rootDir);
}

export async function collectBackgroundJobUiKillMutations({
  session,
  jobId,
  result,
}: {
  session: SessionState;
  jobId: string;
  result: KillBackgroundJobResult;
}): Promise<void> {
  const normalizedJobId = String(jobId ?? result.snapshot?.id ?? '').trim();
  if (!normalizedJobId || !result.ok) return;
  const tracked = backgroundCommandTrackers.get(normalizedJobId);
  if (!tracked) return;
  const mutationResult = result as Record<string, any>;
  await collectTrackedCommandMutations({
    session,
    result: mutationResult,
    tracker: tracked.tracker,
    toolName: tracked.toolName,
    toolCallId: tracked.toolCallId,
    turnId: tracked.turnId,
  });
  if (result.snapshot?.status === 'running') {
    tracked.tracker = captureMutationBaseline(session.rootDir);
  } else {
    backgroundCommandTrackers.delete(normalizedJobId);
  }
}

export async function collectBackgroundJobUiOutputMutations({
  session,
  jobId,
}: {
  session: SessionState;
  jobId: string;
}): Promise<void> {
  const normalizedJobId = String(jobId ?? '').trim();
  if (!normalizedJobId) return;
  const tracked = backgroundCommandTrackers.get(normalizedJobId);
  if (!tracked) return;
  const snapshot = getBackgroundJob(normalizedJobId, {
    sessionId: session.sessionId,
  });
  if (!snapshot) return;
  await collectTrackedCommandMutations({
    session,
    result: {},
    tracker: tracked.tracker,
    toolName: tracked.toolName,
    toolCallId: tracked.toolCallId,
    turnId: tracked.turnId,
  });
  if (snapshot.status === 'running') {
    tracked.tracker = captureMutationBaseline(session.rootDir);
  } else {
    backgroundCommandTrackers.delete(normalizedJobId);
  }
}

function recordAssistantEdit(
  session: SessionState,
  call: ToolCall,
  result: any,
  before: FileEditSnapshot | null,
): void {
  if (!before || !isEditToolName(call.name) || result?.scratch === true) return;
  if (!result || typeof result !== 'object' || result.ok !== true) {
    const filePath = getEditToolFilePath(call);
    if (filePath && result?.error) {
      const failure = recordEditFailure(
        session.clientState.safety,
        filePath,
        call.name,
        String(result.error),
      );
      if (failure && failure.count >= 2) {
        result.staleViewEscalation = {
          filePath,
          failedEditAttempts: failure.count,
          action:
            'Re-read the full file and inspect diagnostics before retrying this edit.',
        };
      }
    }
    return;
  }
  const filePath = String(result.filePath ?? getEditToolFilePath(call)).trim();
  if (!filePath) return;
  const after = readFileEditSnapshot(session.rootDir, filePath);
  if (before.error || after.error) return;
  const operation = operationFromSnapshots(before, after);
  if (!operation || !canStoreEditSnapshot(before)) return;
  if ((operation === 'update' || operation === 'delete') && before.content === null) {
    return;
  }
  const id = `edit_${++session.clientState.editCounter}`;
  session.clientState.editJournal.push({
    id,
    turnId: session.turnState.id,
    toolCallId: call.id,
    toolName: call.name,
    filePath,
    operation,
    beforeHash: before.hash,
    afterHash: after.hash,
    beforeContent: operation === 'create' ? null : before.content,
    beforeContentEncoding: before.contentEncoding,
    createdAt: new Date().toISOString(),
    revertedAt: null,
    revertedByToolCallId: null,
    gitWorkTree: isGitWorkTree(session.rootDir),
  });
  if (session.clientState.editJournal.length > MAX_EDIT_JOURNAL_RECORDS) {
    session.clientState.editJournal.splice(
      0,
      session.clientState.editJournal.length - MAX_EDIT_JOURNAL_RECORDS,
    );
  }
  const checkpoint = ensureActiveCheckpoint(
    session.clientState.safety,
    session.turnState.id,
  );
  recordSessionEdit(session.clientState.safety, {
    kind: 'tool_edit',
    turnId: session.turnState.id,
    toolCallId: call.id,
    toolName: call.name,
    filePath,
    operation,
    beforeHash: before.hash,
    afterHash: after.hash,
    beforeContent: operation === 'create' ? null : before.content,
    beforeContentEncoding: before.contentEncoding,
    checkpointId: checkpoint.id,
  });
  clearEditFailure(session.clientState.safety, filePath);
}

export async function executeLocalToolCall(
  session: SessionState,
  call: ToolCall,
): Promise<ToolResponse> {
  session.onStatus(formatToolCallForStatus(call));
  try {
    const agentModeBlocked = buildAgentModeToolBlockedResult(
      session.agentMode,
      call,
    );
    if (agentModeBlocked) {
      const result = agentModeBlocked;
      session.onToolEvent?.({ call, result });
      return result;
    }
    // Snapshot the real file the edit tool will touch. Tools that repair their
    // path internally (str_replace/patch_file/replace_document_text) must be
    // snapshotted against the repaired path, or the pre-edit snapshot targets
    // the unrepaired path and the edit is journaled as a `create` and undone by
    // deleting the user's file. write_file/delete_file consume the raw path, so
    // repairing their snapshot would instead journal a phantom edit of a
    // different file — keep them on the raw path.
    const rawEditFilePath = isEditToolName(call.name)
      ? getEditToolFilePath(call)
      : '';
    const filePathBeforeEdit =
      rawEditFilePath &&
      PATH_REPAIRING_EDIT_TOOLS.has(call.name) &&
      !editToolWritesSeparateOutput(call)
        ? repairFilePath(session.rootDir, rawEditFilePath)
        : rawEditFilePath;
    const tracksRepositoryEdit =
      filePathBeforeEdit &&
      classifyProjectPath(session.rootDir, filePathBeforeEdit) === 'project';
    if (tracksRepositoryEdit) {
      rememberCheckpointFiles(
        session.clientState.safety,
        session.rootDir,
        [filePathBeforeEdit],
        session.turnState.id,
      );
    }
    const beforeEditSnapshot = tracksRepositoryEdit
      ? readFileEditSnapshot(session.rootDir, filePathBeforeEdit)
      : null;
    const commandTracker =
      call.name === 'run_command' || call.name === 'run_node_script'
        ? captureMutationBaseline(session.rootDir)
        : null;
    const context = {
      rootDir: session.rootDir,
      sessionId: session.sessionId,
      autoYes: session.autoYes,
      grants: session.grants,
      requestPermission: session.requestPermission,
      requestSudoPassword: session.requestSudoPassword,
      onStatus: session.onStatus,
      editJournal: session.clientState.editJournal,
      safety: session.clientState.safety,
      currentTurnId: session.turnState.id,
      currentToolCallId: call.id,
      env: session.env,
      markEditReverted: (editId: string, toolCallId: string) => {
        const record = session.clientState.editJournal.find((entry) => entry.id === editId);
        if (record) {
          record.revertedAt = new Date().toISOString();
          record.revertedByToolCallId = toolCallId;
        }
      },
    };
    const result = await dispatchTool(context, call);
    recordAssistantEdit(session, call, result, beforeEditSnapshot);
    if (result && typeof result === 'object' && commandTracker) {
      await collectTrackedCommandMutations({
        session,
        result,
        tracker: commandTracker,
        toolName: call.name,
        toolCallId: call.id,
        turnId: session.turnState.id,
      });
      if (
        call.name === 'run_command' &&
        result.backgrounded === true &&
        result.status === 'running' &&
        result.jobId
      ) {
        backgroundCommandTrackers.set(String(result.jobId), {
          tracker: captureMutationBaseline(session.rootDir),
          toolName: call.name,
          toolCallId: call.id,
          turnId: session.turnState.id,
        });
      }
    }
    if (
      result &&
      typeof result === 'object' &&
      (call.name === 'shell_job_output' || call.name === 'shell_job_kill')
    ) {
      const jobId = String(result.jobId ?? call.args?.job_id ?? '').trim();
      const tracked = backgroundCommandTrackers.get(jobId);
      if (tracked) {
        await collectTrackedCommandMutations({
          session,
          result,
          tracker: tracked.tracker,
          toolName: tracked.toolName,
          toolCallId: tracked.toolCallId,
          turnId: tracked.turnId,
        });
        if (result.status === 'running') {
          tracked.tracker = captureMutationBaseline(session.rootDir);
        } else {
          backgroundCommandTrackers.delete(jobId);
        }
      }
    }
    if (result && typeof result === 'object') {
      const backgroundJobUpdate = drainBackgroundJobNotifications({
        sessionId: session.sessionId,
      });
      if (backgroundJobUpdate) {
        (result as any).backgroundJobUpdate = backgroundJobUpdate;
      }
    }
    session.onToolEvent?.({ call, result });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      failureCategory: 'tool_exception' as const,
      failureDetails: {
        category: 'tool_exception' as const,
        tool: call.name,
        action:
          'Retry with corrected parameters or report the tool exception if it persists.',
      },
      error: error instanceof Error ? error.message : String(error),
    };
    session.onToolEvent?.({ call, result });
    return result;
  }
}
