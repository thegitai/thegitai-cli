import chalk from '../colors.js';
import { startBackgroundJob } from '../background-jobs.js';
import {
  getBlockedCommandReason,
  runCommand,
} from '../executor.js';
import { ensurePermission } from '../permissions.js';
import { isTuiMode } from '../runtime-mode.js';
import { redactConnectionStringCredentials } from '../secret-preview.js';
import { buildNestedGitHint } from '../session-safety.js';
import {
  buildDeferredShellDiagnostics,
  invalidateShellDiagnosticsCache,
} from './shell-diagnostics.js';
import { ToolContext, ToolResponse } from './types.js';

const MAX_OUTPUT_CHARS = 4000;

export async function runShellCommand(
  context: ToolContext,
  args: {
    command?: string;
    timeout_ms?: number;
    background?: boolean;
  },
): Promise<ToolResponse> {
  const {
    rootDir,
    requestSudoPassword,
    onStatus,
  } = context;
  const command = String(args.command ?? '').trim();
  if (!command) {
    return { ok: false, error: 'command is required' };
  }
  const runInBackground = args.background === true;
  const hasTimeout = typeof args.timeout_ms === 'number' && args.timeout_ms > 0;
  const repoHint = buildNestedGitHint(rootDir, command);
  // A managed background job satisfies the long-running-server timeout rule:
  // the startup wait window is bounded and the process stays managed after it.
  const blockedReason = getBlockedCommandReason(
    command,
    hasTimeout || runInBackground,
    rootDir,
  );
  if (blockedReason) {
    const error = blockedReason;
    if (!isTuiMode()) console.log(chalk.red(`\n  ✖ ${error}`));
    return {
      ok: false,
      blocked: true,
      command,
      error,
      repoHint,
    };
  }
  if (!isTuiMode()) console.log(chalk.bold.yellow(`\n  ⚡ Command: ${command}`));
  // Runs after the blocked-command denylist above, so no grant can unblock a
  // command the policy refuses outright.
  const denied = await ensurePermission(
    context,
    {
      bucket: 'run',
      title: 'Approve command?',
      body: runInBackground
        ? `${command}\n\nRuns as a managed background job until it exits or is killed.`
        : command,
      command,
    },
    'run_command',
    { command },
  );
  if (denied) {
    if (!isTuiMode()) console.log(chalk.dim(`  ⏭  Skipped: ${command}`));
    return denied;
  }

  if (runInBackground) {
    return runBackgroundCommand(context, command, args.timeout_ms, repoHint);
  }

  const result = await runCommand(command, rootDir, {
    requestSudoPassword,
    timeout: typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : undefined,
  });
  invalidateShellDiagnosticsCache(rootDir);
  const diagnostics = buildDeferredShellDiagnostics('run_command');


  // Redact connection-string passwords so shell output (e.g. `cat .env`,
  // `printenv`) cannot leak them into history or telemetry.
  const output =
    typeof result.output === 'string'
      ? boundCommandOutput(redactConnectionStringCredentials(result.output))
      : result.output;

  return {
    ok: result.exitCode === 0,
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output,
    diagnostics,
    repoHint,
  };
}

export function boundCommandOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const headSize = Math.floor(MAX_OUTPUT_CHARS * 0.2);
  const tailSize = MAX_OUTPUT_CHARS - headSize;
  return (
    output.slice(0, headSize) +
    `\n\n... (${output.length - headSize - tailSize} chars truncated) ...\n\n` +
    output.slice(-tailSize)
  );
}

async function runBackgroundCommand(
  context: ToolContext,
  command: string,
  timeoutMs: number | undefined,
  repoHint: string,
): Promise<ToolResponse> {
  const { rootDir, onStatus } = context;
  const started = await startBackgroundJob(command, rootDir, {
    startupWaitMs:
      typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined,
    sessionId: context.sessionId,
  });
  if (!started.ok || !started.snapshot) {
    if (!isTuiMode()) console.log(chalk.red(`\n  ✖ ${started.error}`));
    return {
      ok: false,
      blocked: true,
      command,
      error: started.error ?? 'Background job failed to start.',
      repoHint,
    };
  }
  const snapshot = started.snapshot;
  invalidateShellDiagnosticsCache(rootDir);
  const output = boundCommandOutput(
    redactConnectionStringCredentials(started.startupOutput ?? '').trim(),
  );
  if (snapshot.status === 'running') {
    return {
      ok: true,
      backgrounded: true,
      command,
      jobId: snapshot.id,
      status: 'running',
      pid: snapshot.pid,
      output,
      note: `Background job ${snapshot.id} is running. Use shell_job_output to poll status and new output, and shell_job_kill to stop it.`,
      repoHint,
    };
  }
  return {
    ok: snapshot.exitCode === 0,
    backgrounded: true,
    command,
    jobId: snapshot.id,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    output,
    note: `Background job ${snapshot.id} finished during the startup window.`,
    repoHint,
  };
}
