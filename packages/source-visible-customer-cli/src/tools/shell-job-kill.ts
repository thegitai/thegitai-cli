import { killBackgroundJob } from '../background-jobs.js';
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

export async function shellJobKill(
  context: ToolContext,
  args: {
    job_id?: string;
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
  const result = await killBackgroundJob(jobId, {
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
  let finalOutput = redactConnectionStringCredentials(result.finalOutput ?? '');
  if (result.droppedChars) {
    finalOutput = `... (${result.droppedChars} chars of older output dropped) ...\n${finalOutput}`;
  }
  finalOutput = boundJobToolOutput(finalOutput);
  return {
    ok: true,
    jobId: snapshot.id,
    command: snapshot.command,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    alreadyFinished: result.alreadyFinished === true,
    ranMs: (snapshot.endedAt ?? Date.now()) - snapshot.startedAt,
    finalOutput,
  };
}
