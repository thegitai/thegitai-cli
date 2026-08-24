import chalk from '../colors.js';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { ensurePermission } from '../permissions.js';
import { isTuiMode } from '../runtime-mode.js';
import {
  buildDeferredShellDiagnostics,
  invalidateShellDiagnosticsCache,
} from './shell-diagnostics.js';
import { ToolContext, ToolResponse } from './types.js';
import { ensureSessionScratchDir } from '../scratch-dir.js';

const DEFAULT_TIMEOUT = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_CAPTURE_CHARS = 1024 * 1024;
const COMMAND_LABEL = 'node --input-type=module <script via stdin>';
const MAX_APPROVAL_SCRIPT_CHARS = 4000;

function describeNodeScriptForApproval(script: string): string {
  if (script.length <= MAX_APPROVAL_SCRIPT_CHARS) {
    return `${COMMAND_LABEL}\n${script}`;
  }
  return `${COMMAND_LABEL}\n${script.slice(0, MAX_APPROVAL_SCRIPT_CHARS)}\n... (${
    script.length - MAX_APPROVAL_SCRIPT_CHARS
  } more characters truncated)`;
}

interface NodeScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
}

function appendCapturedText(current: string, chunk: string): string {
  if (!chunk || current.length >= MAX_CAPTURE_CHARS) return current;
  return current + chunk.slice(0, MAX_CAPTURE_CHARS - current.length);
}

function trimOutput(text: string): string {
  if (!text) return '';
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const headSize = Math.floor(MAX_OUTPUT_CHARS * 0.2);
  const tailSize = MAX_OUTPUT_CHARS - headSize;
  return (
    text.slice(0, headSize) +
    `\n\n... (${text.length - headSize - tailSize} chars truncated) ...\n\n` +
    text.slice(-tailSize)
  );
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      child.kill(signal);
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function buildOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): string {
  if (exitCode === 0) return trimOutput(stdout.trim());
  return trimOutput([stdout, stderr].filter(Boolean).join('\n').trim());
}

function executeNodeScript(
  rootDir: string,
  script: string,
  timeout?: number,
): Promise<NodeScriptResult> {
  const effectiveTimeout = typeof timeout === 'number' && timeout > 0
    ? timeout
    : DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: rootDir,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        CI: 'true',
        npm_config_yes: 'true',
        npm_config_progress: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        // The prompt advertises $THEGITAI_SCRATCH_DIR for temporary
        // scripts/files; node snippets must see it exactly like run_command.
        THEGITAI_SCRATCH_DIR: ensureSessionScratchDir(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        stdout,
        stderr,
        output: buildOutput(stdout, stderr, exitCode),
        timedOut,
      });
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 2000);
      killTimer.unref?.();
    }, effectiveTimeout);
    timeoutTimer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout = appendCapturedText(stdout, text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr = appendCapturedText(stderr, text);
    });
    child.on('error', (error: Error) => {
      stderr = appendCapturedText(
        stderr,
        error.message ? `${error.message}\n` : '',
      );
      finish(1);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(timedOut || signal === 'SIGTERM' || signal === 'SIGKILL'
        ? 1
        : code ?? 1);
    });
    child.stdin?.end(script);
  });
}

export async function runNodeScript(
  context: ToolContext,
  args: {
    script?: string;
    timeout_ms?: number;
  },
): Promise<ToolResponse> {
  const { rootDir } = context;
  const script = typeof args.script === 'string' ? args.script : '';
  if (!script.trim()) {
    return { ok: false, error: 'script is required' };
  }

  const commandForApproval = describeNodeScriptForApproval(script);
  if (!isTuiMode()) {
    console.log(
      chalk.bold.yellow(`\n  ⚡ Node script:\n${commandForApproval}\n`),
    );
    console.log(chalk.dim(`    in: ${rootDir}\n`));
  }
  // A node script is arbitrary inline code, so there is no prefix worth
  // remembering: only "once" or the whole run bucket make sense here.
  const denied = await ensurePermission(
    context,
    {
      bucket: 'run',
      title: 'Approve node script?',
      body: commandForApproval,
    },
    'run_node_script',
    { command: COMMAND_LABEL },
  );
  if (denied) {
    if (!isTuiMode()) {
      console.log(chalk.dim(`  ⏭  Skipped: ${COMMAND_LABEL}`));
    }
    return denied;
  }

  const result = await executeNodeScript(
    rootDir,
    script,
    typeof args.timeout_ms === 'number' && args.timeout_ms > 0
      ? args.timeout_ms
      : undefined,
  );
  invalidateShellDiagnosticsCache(rootDir);

  return {
    ok: result.exitCode === 0,
    command: COMMAND_LABEL,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.output,
    diagnostics: buildDeferredShellDiagnostics('run_node_script'),
  };
}
