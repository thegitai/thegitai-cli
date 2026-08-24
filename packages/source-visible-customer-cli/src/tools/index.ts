import type { ToolCall } from '../types.js';
import { shellJobOutput } from './shell-job-output.js';
import { deleteFile } from './delete-file.js';
import { getDiagnostics } from './get-diagnostics.js';
import { grepCode } from './grep-code.js';
import { listDirectories } from './list-directories.js';
import { listCheckpoints } from './list-checkpoints.js';
import { listFiles } from './list-files.js';
import { listSessionEdits } from './list-session-edits.js';
import { patchFile } from './patch-file.js';
import { readDocument } from './read-document.js';
import { readFile } from './read-file.js';
import { replaceDocumentText } from './replace-document-text.js';
import { runShellCommand } from './run-command.js';
import { runNodeScript } from './run-node-script.js';
import {
  restoreFilesToCheckpoint,
  restoreToCheckpoint,
} from './restore-checkpoint.js';
import { shellJobKill } from './shell-job-kill.js';
import { strReplace } from './str-replace.js';
import type { ToolContext, ToolResponse } from './types.js';
import { undoEdit } from './undo-edit.js';
import { updateTodos } from './update-todos.js';
import { readImageFile } from './read-image-file.js';
import { saveGeneratedImage } from './save-generated-image.js';
import { writeFile } from './write-file.js';

export type ToolFn = (
  context: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResponse> | ToolResponse;

export const TOOL_MAP: Record<string, ToolFn> = {
  list_files: (context, args) => listFiles(context, args),
  list_directories: (context, args) => listDirectories(context, args),
  read_file: (context, args) => readFile(context, args),
  read_document: (context, args) => readDocument(context.rootDir, args, context.env),
  replace_document_text: replaceDocumentText as ToolFn,
  grep_code: (context, args) => grepCode(context.rootDir, args),
  get_diagnostics: (context, args) => getDiagnostics(context, args),
  list_checkpoints: (context) => listCheckpoints(context),
  list_session_edits: (context) => listSessionEdits(context),
  restore_to_checkpoint: restoreToCheckpoint as ToolFn,
  restore_files_to_checkpoint: restoreFilesToCheckpoint as ToolFn,
  patch_file: patchFile as ToolFn,
  str_replace: strReplace as ToolFn,
  write_file: writeFile as ToolFn,
  delete_file: deleteFile as ToolFn,
  undo_edit: undoEdit as ToolFn,
  run_command: runShellCommand as ToolFn,
  run_node_script: runNodeScript as ToolFn,
  shell_job_output: shellJobOutput as ToolFn,
  shell_job_kill: shellJobKill as ToolFn,
  update_todos: updateTodos as ToolFn,
  // The agent addresses images it can see by index, and those are analyzed
  // where the vision model runs. This entry handles the other case — an image
  // named by a path on THIS machine — by reading the file so it can be
  // analyzed. Reading is all that happens here.
  analyze_image: (context, args) => readImageFile(context, args),
  // Server produces the pixels; this only writes them under the local state dir.
  // A tool-call without generatedImage bytes is a server/client mismatch — do
  // not treat the model's description args as a malformed image payload.
  generate_image: (_context, args) => {
    if (!String(args.base64Data ?? '').trim()) {
      return {
        ok: false,
        error:
          'This CLI build cannot generate images without server-supplied image bytes. Update TheGitAI CLI.',
        failureCategory: 'tool_exception',
      };
    }
    return saveGeneratedImage(args);
  },
};

function invalidToolCall(error: string): ToolResponse {
  return {
    ok: false,
    error,
    failureCategory: 'malformed_arguments',
  };
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export async function dispatchTool(
  context: ToolContext,
  call: ToolCall,
): Promise<ToolResponse> {
  const toolName = String(call?.name ?? '').trim();
  if (!toolName) {
    return invalidToolCall('Tool call name is required.');
  }
  const toolFn = TOOL_MAP[toolName];
  if (!toolFn) {
    return {
      ok: false,
      error: `Unknown tool: ${toolName}`,
      failureCategory: 'unknown_tool',
    };
  }
  return await toolFn(context, normalizeArgs(call.args));
}
