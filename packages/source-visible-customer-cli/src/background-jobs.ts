import chalk from './colors.js';
import { ChildProcess, spawn } from 'child_process';
import {
  buildCommandEnv,
  commandUsesSudo,
  resolveCommandShell,
  sanitizeCommandText,
  terminateChild,
} from './executor.js';
import { isTuiMode } from './runtime-mode.js';
import { redactConnectionStringCredentials } from './secret-preview.js';

export type BackgroundJobStatus = 'running' | 'exited' | 'killed' | 'error';

export interface BackgroundJobSnapshot {
  id: string;
  sessionId: string;
  command: string;
  status: BackgroundJobStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type BackgroundJobUpdateHook = (snapshot: BackgroundJobSnapshot) => void;

interface BackgroundJobRecord {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  status: BackgroundJobStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
  // Tail-bounded capture: `buffer` holds the most recent output while
  // `totalCaptured` counts everything ever written, so readers can detect
  // dropped output. `readOffset` is the per-job model/tool read cursor.
  buffer: string;
  totalCaptured: number;
  readOffset: number;
  firstOutputLine: string | null;
  firstOutputFragment: string;
  killRequested: boolean;
  removeOnSettle: boolean;
  exitWaiters: Array<() => void>;
  outputWaiters: Array<() => void>;
}

const MAX_RUNNING_JOBS = 8;
const MAX_FINISHED_JOBS = 20;
const MAX_JOB_BUFFER_CHARS = 200 * 1024;

export const DEFAULT_STARTUP_WAIT_MS = 5000;

export const MAX_JOB_WAIT_MS = 30_000;

const KILL_ESCALATION_MS = 2000;

const jobs = new Map<string, BackgroundJobRecord>();
let jobCounter = 0;
let activeSessionId: string | null = null;
let updateHook: BackgroundJobUpdateHook | null = null;
let exitCleanupRegistered = false;
// Finished-job transitions the model has not been told about yet. Drained
// into a system note on the next model round so a crashed dev server gets
// reacted to without polling.
let pendingModelNotifications: BackgroundJobSnapshot[] = [];

export function setBackgroundJobUpdateHook(
  hook: BackgroundJobUpdateHook | null,
): void {
  updateHook = hook;
}

function normalizeSessionId(sessionId?: string | null): string {
  return String(sessionId ?? activeSessionId ?? 'default').trim() || 'default';
}

function sessionFilter(sessionId?: string | null): string | null {
  const value = String(sessionId ?? activeSessionId ?? '').trim();
  return value || null;
}

function belongsToSession(
  record: BackgroundJobRecord,
  sessionId?: string | null,
): boolean {
  const filter = sessionFilter(sessionId);
  return !filter || record.sessionId === filter;
}

export function setBackgroundJobSession(sessionId: string | null): void {
  const next = String(sessionId ?? '').trim() || null;
  if (activeSessionId && activeSessionId !== next) {
    killAllBackgroundJobs({ sessionId: activeSessionId, remove: true });
    pendingModelNotifications = pendingModelNotifications.filter(
      (snapshot) => snapshot.sessionId === next,
    );
  }
  activeSessionId = next;
}

function snapshotOf(record: BackgroundJobRecord): BackgroundJobSnapshot {
  return {
    id: record.id,
    sessionId: record.sessionId,
    command: record.command,
    status: record.status,
    pid: record.child.pid ?? null,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

function notifyUpdate(record: BackgroundJobRecord): void {
  if (!belongsToSession(record)) return;
  try {
    updateHook?.(snapshotOf(record));
  } catch {}
}

function logJobStatus(record: BackgroundJobRecord): void {
  if (isTuiMode()) return;
  if (record.status === 'running') {
    console.log(
      chalk.cyan(`\n  ⚙ Background job ${record.id} started: ${record.command}`),
    );
    return;
  }
  if (record.status === 'killed') {
    console.log(chalk.dim(`\n  ■ Background job ${record.id} killed.`));
    return;
  }
  if (record.status === 'error') {
    console.log(chalk.red(`\n  ✖ Background job ${record.id} failed to run.`));
    return;
  }
  const color = record.exitCode === 0 ? chalk.green : chalk.red;
  console.log(
    color(
      `\n  ${record.exitCode === 0 ? '✓' : '✖'} Background job ${record.id} exited with code ${record.exitCode ?? 1}`,
    ),
  );
}

function appendJobOutput(record: BackgroundJobRecord, chunk: string): void {
  if (!chunk) return;
  if (record.firstOutputLine == null) {
    record.firstOutputFragment = `${record.firstOutputFragment}${chunk}`.slice(0, 8000);
    const firstLine = record.firstOutputFragment
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
    if (firstLine) {
      record.firstOutputLine = firstLine;
    }
  }
  record.totalCaptured += chunk.length;
  record.buffer += chunk;
  if (record.buffer.length > MAX_JOB_BUFFER_CHARS) {
    record.buffer = record.buffer.slice(
      record.buffer.length - MAX_JOB_BUFFER_CHARS,
    );
  }
  const waiters = record.outputWaiters;
  record.outputWaiters = [];
  for (const waiter of waiters) waiter();
}

function settleJob(
  record: BackgroundJobRecord,
  status: BackgroundJobStatus,
  exitCode: number | null,
  signal: string | null,
): void {
  if (record.status !== 'running') return;
  record.status = status;
  record.exitCode = exitCode;
  record.signal = signal;
  record.endedAt = Date.now();
  const waiters = [...record.exitWaiters, ...record.outputWaiters];
  record.exitWaiters = [];
  record.outputWaiters = [];
  for (const waiter of waiters) waiter();
  if (jobs.has(record.id) && belongsToSession(record)) {
    pendingModelNotifications.push(snapshotOf(record));
  }
  logJobStatus(record);
  if (status === 'killed' || record.removeOnSettle) {
    jobs.delete(record.id);
  } else {
    pruneFinishedJobs();
  }
  notifyUpdate(record);
}

function pruneFinishedJobs(): void {
  const finished = [...jobs.values()].filter(
    (record) => record.status !== 'running',
  );
  if (finished.length <= MAX_FINISHED_JOBS) return;
  finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const record of finished.slice(0, finished.length - MAX_FINISHED_JOBS)) {
    jobs.delete(record.id);
  }
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  // Last-resort net: kill every still-running job synchronously when this
  // process exits, so no managed job ever outlives its session.
  process.on('exit', () => {
    for (const record of jobs.values()) {
      if (record.status !== 'running') continue;
      terminateChild(record.child, 'SIGKILL');
    }
  });
}

function sanitizeJobText(record: BackgroundJobRecord, raw: string): string {
  return redactConnectionStringCredentials(
    sanitizeCommandText(record.command, raw, record.cwd),
  );
}

function readNewOutput(record: BackgroundJobRecord): {
  newOutput: string;
  droppedChars: number;
} {
  const dropped = record.totalCaptured - record.buffer.length;
  const droppedUnread = Math.max(dropped - record.readOffset, 0);
  const start = Math.max(record.readOffset - dropped, 0);
  const raw = record.buffer.slice(start);
  record.readOffset = record.totalCaptured;
  return {
    newOutput: sanitizeJobText(record, raw),
    droppedChars: droppedUnread,
  };
}

function waitForJobEvent(
  record: BackgroundJobRecord,
  waitMs: number,
  kind: 'exit' | 'output',
): Promise<void> {
  if (record.status !== 'running' || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = kind === 'exit' ? record.exitWaiters : record.outputWaiters;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = waiters.indexOf(finish);
      if (index !== -1) waiters.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(finish, Math.min(waitMs, MAX_JOB_WAIT_MS));
    timer.unref?.();
    waiters.push(finish);
  });
}

export interface StartBackgroundJobResult {
  ok: boolean;
  error?: string;
  snapshot?: BackgroundJobSnapshot;
  startupOutput?: string;
  droppedChars?: number;
}

export async function startBackgroundJob(
  command: string,
  cwd: string,
  {
    startupWaitMs,
    sessionId,
  }: { startupWaitMs?: number; sessionId?: string | null } = {},
): Promise<StartBackgroundJobResult> {
  if (commandUsesSudo(command)) {
    return {
      ok: false,
      error:
        'sudo commands cannot run as background jobs because the password prompt is interactive. Run it in the foreground instead.',
    };
  }
  const running = [...jobs.values()].filter(
    (record) => record.status === 'running' && belongsToSession(record, sessionId),
  );
  if (running.length >= MAX_RUNNING_JOBS) {
    return {
      ok: false,
      error: `Too many background jobs are already running (${running.length}). Kill one with shell_job_kill first.`,
    };
  }
  registerExitCleanup();
  const id = `bg_${++jobCounter}`;
  const child = spawn(command, {
    cwd,
    shell: resolveCommandShell(),
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildCommandEnv(cwd),
  });
  child.stdin?.end();
  const record: BackgroundJobRecord = {
    id,
    sessionId: normalizeSessionId(sessionId),
    command,
    cwd,
    child,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    endedAt: null,
    buffer: '',
    totalCaptured: 0,
    readOffset: 0,
    firstOutputLine: null,
    firstOutputFragment: '',
    killRequested: false,
    removeOnSettle: false,
    exitWaiters: [],
    outputWaiters: [],
  };
  jobs.set(id, record);
  child.stdout?.on('data', (chunk: Buffer) => {
    appendJobOutput(record, chunk.toString('utf-8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    appendJobOutput(record, chunk.toString('utf-8'));
  });
  child.on('error', (error: Error) => {
    appendJobOutput(record, error.message ? `${error.message}\n` : '');
    terminateChild(child, 'SIGKILL');
    settleJob(record, 'error', 1, null);
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    settleJob(
      record,
      record.killRequested ? 'killed' : 'exited',
      code ?? (signal ? 1 : 0),
      signal,
    );
  });
  logJobStatus(record);
  notifyUpdate(record);

  const waitMs = Math.min(
    Math.max(startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS, 0),
    MAX_JOB_WAIT_MS,
  );
  await waitForJobEvent(record, waitMs, 'exit');
  const { newOutput, droppedChars } = readNewOutput(record);
  return {
    ok: true,
    snapshot: snapshotOf(record),
    startupOutput: newOutput,
    droppedChars,
  };
}

export function getBackgroundJob(
  id: string,
  { sessionId }: { sessionId?: string | null } = {},
): BackgroundJobSnapshot | null {
  const record = jobs.get(String(id ?? '').trim());
  return record && belongsToSession(record, sessionId) ? snapshotOf(record) : null;
}

export function listBackgroundJobs({
  sessionId,
}: { sessionId?: string | null } = {}): BackgroundJobSnapshot[] {
  return [...jobs.values()]
    .filter((record) => belongsToSession(record, sessionId))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(snapshotOf);
}

export function getJobOutputTail(id: string, maxLines: number): string[] {
  const record = jobs.get(String(id ?? '').trim());
  if (!record || !belongsToSession(record) || maxLines <= 0) return [];
  const lines = sanitizeJobText(record, record.buffer)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines);
}

export function getJobOutputPreview(
  id: string,
  maxTailLines: number,
): { firstLine: string; tailLines: string[] } | null {
  const record = jobs.get(String(id ?? '').trim());
  if (!record || !belongsToSession(record)) return null;
  const firstLine = record.firstOutputLine
    ? sanitizeJobText(record, record.firstOutputLine).trim()
    : '';
  return {
    firstLine,
    tailLines: getJobOutputTail(id, maxTailLines),
  };
}

export function getJobBufferedOutput(
  id: string,
): { output: string; droppedChars: number } | null {
  const record = jobs.get(String(id ?? '').trim());
  if (!record || !belongsToSession(record)) return null;
  return {
    output: sanitizeJobText(record, record.buffer),
    droppedChars: Math.max(record.totalCaptured - record.buffer.length, 0),
  };
}

export interface ReadBackgroundJobResult {
  ok: boolean;
  error?: string;
  snapshot?: BackgroundJobSnapshot;
  newOutput?: string;
  droppedChars?: number;
}

export async function readBackgroundJobOutput(
  id: string,
  { waitMs, sessionId }: { waitMs?: number; sessionId?: string | null } = {},
): Promise<ReadBackgroundJobResult> {
  const record = jobs.get(String(id ?? '').trim());
  if (!record || !belongsToSession(record, sessionId)) {
    return { ok: false, error: unknownJobError(id) };
  }
  if (waitMs && waitMs > 0 && record.status === 'running') {
    const hasUnread = record.totalCaptured > record.readOffset;
    if (!hasUnread) await waitForJobEvent(record, waitMs, 'output');
  }
  const { newOutput, droppedChars } = readNewOutput(record);
  return { ok: true, snapshot: snapshotOf(record), newOutput, droppedChars };
}

export interface KillBackgroundJobResult {
  ok: boolean;
  error?: string;
  alreadyFinished?: boolean;
  snapshot?: BackgroundJobSnapshot;
  finalOutput?: string;
  droppedChars?: number;
}

// Kill attempts graceful termination first (SIGTERM to the process group),
// then force-kills (SIGKILL) if the job is still alive after 2 s.
export async function killBackgroundJob(
  id: string,
  {
    waitMs = 5000,
    sessionId,
  }: { waitMs?: number; sessionId?: string | null } = {},
): Promise<KillBackgroundJobResult> {
  const record = jobs.get(String(id ?? '').trim());
  if (!record || !belongsToSession(record, sessionId)) {
    return { ok: false, error: unknownJobError(id) };
  }
  if (record.status !== 'running') {
    const { newOutput, droppedChars } = readNewOutput(record);
    const snapshot = snapshotOf(record);
    if (record.status === 'killed') {
      jobs.delete(record.id);
    }
    return {
      ok: true,
      alreadyFinished: true,
      snapshot,
      finalOutput: newOutput,
      droppedChars,
    };
  }
  record.killRequested = true;
  terminateChild(record.child, 'SIGTERM');
  const killTimer = setTimeout(() => {
    if (record.status === 'running') {
      terminateChild(record.child, 'SIGKILL');
    }
  }, KILL_ESCALATION_MS);
  killTimer.unref?.();
  await waitForJobEvent(record, Math.max(waitMs, KILL_ESCALATION_MS + 1000), 'exit');
  clearTimeout(killTimer);
  const { newOutput, droppedChars } = readNewOutput(record);
  return {
    ok: true,
    snapshot: snapshotOf(record),
    finalOutput: newOutput,
    droppedChars,
  };
}

export function killAllBackgroundJobs(
  {
    sessionId,
    remove = false,
  }: { sessionId?: string | null; remove?: boolean } = {},
): void {
  for (const record of jobs.values()) {
    if (!belongsToSession(record, sessionId)) continue;
    if (record.status !== 'running') continue;
    record.killRequested = true;
    record.removeOnSettle = record.removeOnSettle || remove;
    terminateChild(record.child, 'SIGTERM');
    const killTimer = setTimeout(() => {
      if (record.status === 'running') {
        terminateChild(record.child, 'SIGKILL');
      }
    }, KILL_ESCALATION_MS);
    killTimer.unref?.();
  }
}

export function hasRunningBackgroundJobs({
  sessionId,
}: { sessionId?: string | null } = {}): boolean {
  for (const record of jobs.values()) {
    if (!belongsToSession(record, sessionId)) continue;
    if (record.status === 'running') return true;
  }
  return false;
}

function formatRunTime(snapshot: BackgroundJobSnapshot): string {
  const ms = (snapshot.endedAt ?? Date.now()) - snapshot.startedAt;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

// Returns a system note describing job transitions the model has not seen,
// clearing the queue — or null when there is nothing to report.
export function drainBackgroundJobNotifications(
  { sessionId }: { sessionId?: string | null } = {},
): string | null {
  if (pendingModelNotifications.length === 0) return null;
  const filter = sessionFilter(sessionId);
  const pending = filter
    ? pendingModelNotifications.filter((snapshot) => snapshot.sessionId === filter)
    : pendingModelNotifications;
  pendingModelNotifications = filter
    ? pendingModelNotifications.filter((snapshot) => snapshot.sessionId !== filter)
    : [];
  if (pending.length === 0) return null;
  const lines = pending.map((snapshot) => {
    const ran = formatRunTime(snapshot);
    if (snapshot.status === 'error') {
      return `Background job ${snapshot.id} (${snapshot.command}) failed to start.`;
    }
    if (snapshot.status === 'killed') {
      return `Background job ${snapshot.id} (${snapshot.command}) was killed after ${ran}.`;
    }
    return `Background job ${snapshot.id} (${snapshot.command}) exited with code ${snapshot.exitCode ?? 1} after ${ran}.`;
  });
  const hasReadableFinalOutput = pending.some(
    (snapshot) => snapshot.status !== 'killed',
  );
  return `${lines.join(' ')}${hasReadableFinalOutput ? ' Use shell_job_output to read any final output.' : ''}`;
}

function unknownJobError(id: string): string {
  const known = listBackgroundJobs().map((job) => job.id);
  const hint = known.length
    ? ` Known jobs: ${known.join(', ')}.`
    : ' No background jobs have been started this session.';
  return `Unknown background job id: ${String(id ?? '').trim() || '(empty)'}.${hint}`;
}
