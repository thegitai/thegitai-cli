import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { registerNativeHost } from './native-host.js';
import {
  BROWSER_PROTOCOL_VERSION,
  browserRuntimeDir,
  protocolMismatchMessage,
  sessionKeyFromRecordFile,
  sessionRecordPath,
  sessionSocketPath,
  socketIsFile,
  type BrowserIdentity,
  type SessionAnnouncement,
  type SocketFrame,
} from './protocol.js';












const DEFAULT_TIMEOUT_MS = 30000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
}

interface ConnectedBrowser {
  identity: BrowserIdentity;
  socket: net.Socket;
  pending: Map<string, PendingRequest>;
}

export class BrowserBridgeError extends Error {
  readonly code: string;

  constructor(message: string, code = 'browser_error') {
    super(message);
    this.name = 'BrowserBridgeError';
    this.code = code;
  }
}

function rejectDisconnectedRequests(browser: ConnectedBrowser): void {
  for (const pending of browser.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(
      new BrowserBridgeError(
        `The browser disconnected while ${pending.op} was in flight, so its outcome is unknown. Check the page before doing anything that could repeat.`,
        'disconnected',
      ),
    );
  }
  browser.pending.clear();
}

export interface BrowserBridge {
  readonly sessionKey: string;
  status(): BrowserBridgeStatus;




  resync(): boolean;
  request(
    op: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number; browser?: string },
  ): Promise<any>;
  selectBrowser(key: string): boolean;
  onEvent(listener: (event: string, data: Record<string, unknown>) => void): () => void;
  close(): void;
}

export interface BrowserBridgeStatus {
  connected: boolean;

  everConnected: boolean;
  browsers: BrowserIdentity[];
  selected: string | null;
  socketPath: string;
  registrationErrors: string[];
}

function safeUnlink(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {

  }
}

export function startBrowserBridge({
  sessionKey,
  label,
  cwd,
  env = process.env,
}: {
  sessionKey: string;
  label: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): BrowserBridge {
  const dir = browserRuntimeDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = sessionSocketPath(dir, sessionKey);
  const recordPath = sessionRecordPath(dir, sessionKey);




  if (socketIsFile()) safeUnlink(socketPath);

  const browsers = new Map<string, ConnectedBrowser>();




  const sockets = new Set<net.Socket>();
  const listeners = new Set<(event: string, data: Record<string, unknown>) => void>();
  let selected: string | null = null;
  let everConnected = false;
  let closed = false;

  const registration = registerNativeHost({ env });

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    let buffer = '';
    let key: string | null = null;

    socket.on('data', (chunk) => {
      if (socket.destroyed) return;
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.trim()) continue;
        let frame: SocketFrame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.t === 'hello') {
          if (frame.protocol !== BROWSER_PROTOCOL_VERSION) {
            const message = protocolMismatchMessage(frame.protocol);
            for (const listener of listeners) listener('protocol_mismatch', { message });
            socket.destroy();
            return;
          }
          const announced = frame.browser?.key ?? crypto.randomUUID();
          const existing = key ? browsers.get(key) : null;
          const displaced = browsers.get(announced);
          if (displaced && displaced.socket !== socket) {
            displaced.socket.destroy();
            rejectDisconnectedRequests(displaced);
          }
          if (existing?.socket === socket) {










            if (announced !== key) {
              browsers.delete(key!);
              browsers.set(announced, existing);
              if (selected === key) selected = announced;
            }
            existing.identity = frame.browser;
            existing.socket = socket;
          } else {
            browsers.set(announced, {
              identity: frame.browser,
              socket,
              pending: new Map(),
            });
            if (!selected) selected = announced;
          }
          key = announced;
          everConnected = true;
          for (const listener of listeners) {
            listener('connected', { browser: frame.browser as unknown as Record<string, unknown> });
          }
          continue;
        }
        const browser = key ? browsers.get(key) : null;
        if (!browser || browser.socket !== socket) continue;
        if (frame.t === 'res') {
          const pending = browser.pending.get(frame.id);
          if (!pending) continue;
          browser.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.ok) pending.resolve(frame.result);
          else pending.reject(new BrowserBridgeError(frame.error ?? 'Browser operation failed.', frame.code ?? 'browser_error'));
          continue;
        }
        if (frame.t === 'event') {
          for (const listener of listeners) listener(frame.event, frame.data ?? {});
        }
      }
    });

    const drop = () => {
      sockets.delete(socket);
      if (!key) return;
      const browser = browsers.get(key);







      if (!browser || browser.socket !== socket) return;
      browsers.delete(key);
      if (selected === key) selected = browsers.keys().next().value ?? null;
      rejectDisconnectedRequests(browser);
      for (const listener of listeners) listener('disconnected', { browser: key });
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  server.listen(socketPath, () => {
    try {


      fs.chmodSync(socketPath, 0o600);
    } catch {


    }
    const announcement: SessionAnnouncement = {
      protocol: BROWSER_PROTOCOL_VERSION,
      session: sessionKey,
      pid: process.pid,
      label,
      cwd,
      startedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(recordPath, `${JSON.stringify(announcement)}\n`, { mode: 0o600 });
    } catch {


    }
  });

  server.on('error', () => {



  });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const browser of browsers.values()) rejectDisconnectedRequests(browser);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    browsers.clear();
    server.close();
    safeUnlink(socketPath);
    safeUnlink(recordPath);
  };

  process.once('exit', close);

  return {
    sessionKey,
    status() {
      return {
        connected: browsers.size > 0,
        everConnected,
        browsers: [...browsers.values()].map((browser) => browser.identity),
        selected,
        socketPath,
        registrationErrors: registration.errors,
      };
    },













    resync() {
      if (closed || browsers.size > 0 || sockets.size === 0) return false;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return true;
    },
    selectBrowser(key: string) {
      if (!browsers.has(key)) return false;
      selected = key;
      return true;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(op, args = {}, options = {}) {
      const key = options.browser ?? selected;
      const target = key ? browsers.get(key) : null;
      if (!target && options.browser) {
        return Promise.reject(
          new BrowserBridgeError('The Chrome profile chosen for this conversation is not connected.', 'chosen_profile_missing'),
        );
      }
      if (!target) {
        return Promise.reject(
          new BrowserBridgeError('No browser is connected to this session.', 'not_connected'),
        );
      }
      const id = crypto.randomUUID();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          target.pending.delete(id);
          reject(
            new BrowserBridgeError(
              `The browser did not answer ${op} within ${Math.round(timeoutMs / 1000)}s, so its outcome is unknown. Look at the page before repeating anything that changes state.`,
              'timeout',
            ),
          );
        }, timeoutMs);
        target.pending.set(id, { resolve, reject, timer, op });
        target.socket.write(`${JSON.stringify({ t: 'req', id, op, args })}\n`, (error) => {
          if (!error) return;
          target.pending.delete(id);
          clearTimeout(timer);
          reject(new BrowserBridgeError(`Could not reach the browser: ${error.message}`, 'write_failed'));
        });
      });
    },
    close,
  };
}


export function pruneStaleSessions(env: NodeJS.ProcessEnv = process.env): void {
  const dir = browserRuntimeDir(env);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const key = sessionKeyFromRecordFile(entry);
    if (!key) continue;
    const file = path.join(dir, entry);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionAnnouncement;
      process.kill(record.pid, 0);
    } catch (error: any) {

      if (error?.code === 'EPERM') continue;
      safeUnlink(file);

      if (socketIsFile()) safeUnlink(sessionSocketPath(dir, key));
    }
  }
}
