import {
  MAX_JOB_WAIT_MS,
  readBackgroundJobOutput,
} from '../background-jobs.js';
import { redactConnectionStringCredentials } from '../secret-preview.js';
import { ToolContext, ToolResponse } from './types.js';

const MAX_JOB_TOOL_OUTPUT_CHARS = 64 * 1024;

function boundJobToolOutput(output: string): string {
  if (output.length <= MAX_JOB_TOOL_OUTPUT_CHARS) return output;
  const headSize = Math.floor(MAX_JOB_TOOL_OUTPUT_CHARS * 0.2);
  const tailSize = MAX_JOB_TOOL_OUTPUT_CHARS - headSize;
  return (
    output.slice(0, headSize) +
    `\n\n... (${output.length - headSize - tailSize} chars truncated) ...\n\n` +
    output.slice(-tailSize)
  );
}

export async function shellJobOutput(
  context: ToolContext,
  args: {
    job_id?: string;
    wait_ms?: number;
  },
): Promise<ToolResponse> {
  const jobId = String(args.job_id ?? '').trim();
  if (!jobId) {
    return {
      ok: false,
      error: 'job_id is required',
      failureCategory: 'missing_required_argument',
    };
  }
  const waitMs =
    typeof args.wait_ms === 'number' && args.wait_ms > 0
      ? Math.min(args.wait_ms, MAX_JOB_WAIT_MS)
      : 0;
  const result = await readBackgroundJobOutput(jobId, {
    waitMs,
    sessionId: context.sessionId,
  });
  if (!result.ok || !result.snapshot) {
    return {
      ok: false,
      error: result.error ?? 'Background job lookup failed.',
      failureCategory: 'not_found',
    };
  }
  const snapshot = result.snapshot;
  let newOutput = redactConnectionStringCredentials(result.newOutput ?? '');
  if (result.droppedChars) {
    newOutput = `... (${result.droppedChars} chars of older output dropped) ...\n${newOutput}`;
  }
  newOutput = boundJobToolOutput(newOutput);
  return {
    ok: true,
    jobId: snapshot.id,
    command: snapshot.command,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    elapsedMs: (snapshot.endedAt ?? Date.now()) - snapshot.startedAt,
    newOutput,
  };
}
