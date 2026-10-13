import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from '../client-state.js';
import {
  pruneStaleSessions,
  startBrowserBridge,
  type BrowserBridge,
  type BrowserBridgeStatus,
} from './bridge.js';
import { chromiumProcessRunning } from './native-host.js';









let bridge: BrowserBridge | null = null;
let recentEvents: { event: string; data: Record<string, unknown>; at: number }[] = [];

const processKey = `${process.pid.toString(36)}${crypto.randomBytes(3).toString('hex')}`;

export function ensureBrowserBridge(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): BrowserBridge {
  if (bridge) return bridge;
  const env = options.env ?? process.env;


  pruneStaleSessions(env);
  bridge = startBrowserBridge({
    sessionKey: processKey,
    label: path.basename(options.cwd) || 'TheGitAI',
    cwd: options.cwd,
    env,
  });
  bridge.onEvent((event, data) => {
    if (event === 'connected') rememberBrowserExtensionSeen(env);
    recentEvents.push({ event, data, at: Date.now() });
    if (recentEvents.length > 50) recentEvents.splice(0, recentEvents.length - 50);
  });
  return bridge;
}

function browserExtensionMarkerPath(env: NodeJS.ProcessEnv): string {
  return path.join(getClientStateDir(env), 'browser-extension-seen');
}









function rememberBrowserExtensionSeen(env: NodeJS.ProcessEnv): void {
  try {
    const marker = browserExtensionMarkerPath(env);
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch {

  }
}


export function browserExtensionSeen(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.existsSync(browserExtensionMarkerPath(env));
  } catch {

    return true;
  }
}










export function startBrowserDiscoveryInBackground(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): void {
  setImmediate(() => {
    try {
      ensureBrowserBridge(options);
    } catch {

    }
  });
}

export function currentBrowserBridge(): BrowserBridge | null {
  return bridge;
}
















export function releaseBrowserAfterTurn(): void {
  const active = bridge;
  if (!active?.status().connected) return;
  void active
    .request('release', {}, { timeoutMs: 5000 })
    .catch(() => {

    });
}

export function closeBrowserBridge(): void {
  bridge?.close();
  bridge = null;
  recentEvents = [];
}

export function drainBrowserEvents(): { event: string; data: Record<string, unknown> }[] {
  const events = recentEvents.map(({ event, data }) => ({ event, data }));
  recentEvents = [];
  return events;
}

export interface BrowserAvailability {
  connected: boolean;




  everConnected: boolean;
  browsers: BrowserBridgeStatus['browsers'];
  selected: string | null;

  hint?: string;
}

export function browserAvailability(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): BrowserAvailability {
  const active = ensureBrowserBridge(options);
  const status = active.status();
  if (status.connected) {
    return {
      connected: true,
      everConnected: true,
      browsers: status.browsers,
      selected: status.selected,
    };
  }
  const hint = connectionHint({
    registrationError: status.registrationErrors[0] ?? null,
    everConnected: status.everConnected,
    chromeRunning: () => chromiumProcessRunning(),
    extensionSeen: () => browserExtensionSeen(options.env),
  });
  return {
    connected: false,
    everConnected: status.everConnected,
    browsers: [],
    selected: null,
    hint,
  };
}









export function connectionHint(state: {
  registrationError: string | null;
  everConnected: boolean;
  chromeRunning: () => boolean;
  extensionSeen: () => boolean;
}): string {
  if (state.registrationError) {
    return `TheGitAI could not register its browser bridge with Chrome: ${state.registrationError}`;
  }
  if (state.everConnected) {
    return 'The browser was connected to this session but is disconnected now. Check Chrome and the connection status shown by the TheGitAI extension.';
  }
  if (!state.chromeRunning()) {
    return 'Chrome does not appear to be running. Open Chrome with the TheGitAI extension enabled and check its connection status.';
  }
  if (state.extensionSeen()) {
    return 'The TheGitAI extension has connected on this machine before, but has not connected to this session yet. Check the connection status shown by the extension.';
  }
  return 'Chrome is running, but no browser connection reached this session. Check that the TheGitAI extension is installed and enabled, and inspect its connection status.';
}








export function resyncBrowserBridge(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  try {
    return ensureBrowserBridge(options).resync();
  } catch {
    return false;
  }
}
