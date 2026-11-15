import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { storeSessionImageBytes } from '../core/session-image-store.js';
import { denialNote, userSaid, type ComputerDesktop } from '../permissions.js';
import { scopedSessionId } from '../session-context.js';
import type { ToolContext, ToolResponse } from './types.js';

export const COMPUTER_OPERATIONS = [
  'list_apps',
  'open_app',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'set_value',
  'type_text',
  'press_key',
  'scroll',
  'drag',
  'zoom',
  'hover',
  'move_window',
] as const;

const CALL_TIMEOUT_MS = 90_000;
const TYPE_MS_PER_CHARACTER = 20;

type Pending = { resolve: (value: any) => void; timer: NodeJS.Timeout };

let helper: {
  proc: ChildProcess;
  pending: Map<number, Pending>;
  nextId: number;
  inUse: boolean;
  path: string;
  env: NodeJS.ProcessEnv;
} | null = null;

const currentTurn = new AsyncLocalStorage<symbol>();
const computerUsers = new Set<symbol>();

function defaultHelperPath(env: NodeJS.ProcessEnv): string | null {


  const home = env.HOME?.trim();
  const dataHome = env.XDG_DATA_HOME?.trim() || (home ? path.join(home, '.local', 'share') : '');
  return dataHome ? path.join(dataHome, 'thegitai', 'computer', 'helper') : null;
}

export function computerHelperPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidate = String(env.THEGITAI_COMPUTER_HELPER ?? '').trim() || defaultHelperPath(env);
  if (!candidate) return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function startHelper(helperPath: string, env: NodeJS.ProcessEnv) {


  const proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], env });
  const state = { proc, pending: new Map<number, Pending>(), nextId: 1, inUse: false, path: helperPath, env };
  readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = state.pending.get(Number(message?.id));
    if (!waiting) return;
    state.pending.delete(Number(message.id));
    clearTimeout(waiting.timer);
    waiting.resolve(message);
  });
  const fail = (reason: string) => {
    for (const [id, waiting] of state.pending) {
      clearTimeout(waiting.timer);
      waiting.resolve({ id, ok: false, error: reason });
    }
    state.pending.clear();
    if (helper === state) helper = null;
  };
  proc.on('exit', (code) => fail(`The desktop helper stopped (exit ${code}).`));
  proc.on('error', (error) => fail(`The desktop helper could not start: ${error.message}`));
  return state;
}

function send(
  helperPath: string,
  env: NodeJS.ProcessEnv,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  if (!helper) helper = startHelper(helperPath, env);
  const state = helper;
  if (request.op !== 'end') state.inUse = true;
  const id = state.nextId++;
  const owner = currentTurn.getStore();
  const stop = (): boolean => {
    if (!state.pending.has(id) || helper !== state) return false;
    if ([...computerUsers].some((user) => user !== owner)) return false;
    state.inUse = false;
    state.proc.stdin!.write(`${JSON.stringify({ op: 'end', id: state.nextId++ })}\n`);
    return true;
  };
  const timeoutMs = CALL_TIMEOUT_MS +
    (request.op === 'type_text' ? String(request.text ?? '').length * TYPE_MS_PER_CHARACTER : 0);
  return new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      const stopped = stop();
      state.pending.delete(id);
      const seconds = Math.round(timeoutMs / 1000);
      resolve({
        id,
        ok: false,
        error: `The desktop helper did not answer within ${seconds}s${stopped ? ', so the action was stopped' : ''}.`,
      });
    }, timeoutMs);
    state.pending.set(id, { resolve, timer });
    state.proc.stdin!.write(`${JSON.stringify({ ...request, id })}\n`);
    signal?.addEventListener('abort', stop, { once: true });
  }).finally(() => signal?.removeEventListener('abort', stop));
}

const taskChoices = new Map<string, ComputerDesktop | 'denied'>();
const pendingChoices = new Map<string, Promise<ComputerDesktop | null>>();
const deniedNotes = new Map<string, string>();

function conversation(): string {
  return scopedSessionId() ?? '';
}

function promptBody(): string {
  const background = process.platform === 'darwin'
    ? 'In the background, it works on a virtual display in your login session. Adding the display can briefly move your pointer before restoring it. Targeted input is experimental: some apps can take focus or ignore gestures. Hover requires control on your screen. You can move the same running window to your desktop afterward. '
    : 'In the background, it works on a screen of its own with its own mouse and keyboard, so you keep yours. ';
  return background +
  'You can watch it in a small window.\n' +
  "On your screen, it moves your pointer and types until it's done. Press Esc anytime to take over.";
}

async function askForDesktop(context: ToolContext, key: string): Promise<ComputerDesktop | null> {
  if (!context.requestPermission) return null;
  const decision = await context.requestPermission({
    bucket: 'computer',
    alwaysAsk: true,
    title: 'TheGitAI wants to use apps on this computer',
    body: promptBody(),
    options: [
      { label: 'Allow in the background', decision: { kind: 'computer', desktop: 'background', session: false } },
      { label: 'Allow on my screen', decision: { kind: 'computer', desktop: 'screen', session: false } },
      {
        label: 'Allow in the background for this session',
        decision: { kind: 'computer', desktop: 'background', session: true },
      },
      { label: 'Allow on my screen for this session', decision: { kind: 'computer', desktop: 'screen', session: true } },
      { label: 'Deny', decision: { kind: 'deny' } },
    ],
  });
  if (decision.kind !== 'computer') {
    taskChoices.set(key, 'denied');
    deniedNotes.set(key, denialNote(decision));
    return null;
  }
  if (decision.session && context.grants) context.grants.computer = decision.desktop;
  taskChoices.set(key, decision.desktop);
  return decision.desktop;
}

function chooseDesktop(context: ToolContext): Promise<ComputerDesktop | null> {
  const remembered = context.grants?.computer;
  if (remembered) return Promise.resolve(remembered);
  const key = conversation();
  const choice = taskChoices.get(key);
  if (choice === 'denied') return Promise.resolve(null);
  if (choice) return Promise.resolve(choice);
  let pending = pendingChoices.get(key);
  if (!pending) {
    pending = askForDesktop(context, key).finally(() => pendingChoices.delete(key));
    pendingChoices.set(key, pending);
  }
  return pending;
}

export async function withComputerTurn<T>(run: () => Promise<T>): Promise<T> {
  const token = Symbol();
  const key = conversation();
  try {
    return await currentTurn.run(token, run);
  } finally {
    computerUsers.delete(token);
    taskChoices.delete(key);
    deniedNotes.delete(key);
    if (computerUsers.size === 0) await releaseComputerAfterTurn();
  }
}

async function releaseComputerAfterTurn(): Promise<void> {
  if (!helper?.inUse) return;
  helper.inUse = false;
  await send(helper.path, helper.env, { op: 'end' });
}

export function disconnectComputerHelper(): void {
  const state = helper;
  helper = null;
  if (!state) return;
  for (const [id, waiting] of state.pending) {
    clearTimeout(waiting.timer);
    waiting.resolve({ id, ok: false, error: 'The CLI session closed.' });
  }
  state.pending.clear();
  state.proc.stdin?.end();
}

export function computerTool(operation: (typeof COMPUTER_OPERATIONS)[number]) {
  return async (context: ToolContext, args: Record<string, unknown>): Promise<ToolResponse> => {
    const env = context.env ?? process.env;
    const helperPath = computerHelperPath(env);
    if (!helperPath) {
      return {
        ok: false,
        error: 'Desktop control is not set up on this machine.',
        failureCategory: 'policy_blocked',
      };
    }
    const desktop = await chooseDesktop(context);
    context.signal?.throwIfAborted();
    if (!desktop) {
      return {
        ok: false,
        error: context.requestPermission
          ? `The user did not allow TheGitAI to use apps on this computer for this request. Do not use the computer tools again for it; do it another way or tell the user.${userSaid(deniedNotes.get(conversation()) ?? '')}`
          : 'Using apps on this computer needs the user to allow it, and they cannot be asked here.',
        failureCategory: 'user_declined',
      };
    }
    const title = String(args.title ?? '').trim();
    context.onStatus(title || operation.replace(/_/g, ' '));
    const turn = currentTurn.getStore();
    if (turn) computerUsers.add(turn);
    const reply = await send(helperPath, env, { ...args, op: operation, desktop }, context.signal);
    if (!reply?.ok) {
      return {
        ok: false,
        error: String(reply?.error ?? 'The desktop helper failed.'),
        failureCategory: reply?.cancelled ? 'user_declined' : 'command_failed',
        desktop,
      };
    }
    const { png, width, height, text } = reply;
    const result: ToolResponse = { ok: true, state: String(text ?? ''), desktop };
    if (typeof png === 'string') {
      result.screenshot = { width, height };
      result.imageBytes = { base64Data: png, mimeType: 'image/png' };
      if (context.sessionId) {
        try {
          const stored = storeSessionImageBytes({
            sessionId: context.sessionId,
            base64Data: png,
            mimeType: 'image/png',
            env: context.env,
          });
          result.imageBytes.cachePath = stored.cachePath;
          result.imageBytes.index = stored.index;
        } catch {}
      }
    }
    return result;
  };
}
