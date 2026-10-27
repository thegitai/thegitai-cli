import os from 'node:os';
import path from 'node:path';










export const BROWSER_PROTOCOL_VERSION = 1;

export const NATIVE_HOST_NAME = 'ai.thegit.browser_bridge';



















export const EXTENSION_IDS: readonly string[] = [

  'neleeiihdnddldafklledbkembkfagol',

  'jipbjphlelfilkhdjkfdficafjhgjfmk',
];

export interface BrowserIdentity {

  key: string;
  browser: string;
  profile: string;

  platform?: string;
  extensionVersion?: string;
  lastFocusedAt?: number;
}

export interface HostHelloFrame {
  t: 'hello';
  protocol: number;
  browser: BrowserIdentity;
}

export interface RequestFrame {
  t: 'req';
  id: string;
  op: string;
  args?: Record<string, unknown>;
}

export interface ResponseFrame {
  t: 'res';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface EventFrame {
  t: 'event';
  event: string;
  data?: Record<string, unknown>;
}

export type SocketFrame = HostHelloFrame | RequestFrame | ResponseFrame | EventFrame;











export function browserRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');



    return path.join(env.THEGITAI_HOME ?? path.join(local, 'thegitai'), 'browser');
  }
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime)) {
    return path.join(runtime, 'thegitai', 'browser');
  }
  return path.join(env.THEGITAI_HOME ?? path.join(os.homedir(), '.thegitai'), 'browser');
}







const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';












export function sessionSocketPath(
  dir: string,
  sessionKey: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return `${WINDOWS_PIPE_PREFIX}thegitai-browser-${sessionKey}`;
  }
  return path.join(dir, `s-${sessionKey}.sock`);
}


export function socketIsFile(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}


export function sessionKeyFromRecordFile(fileName: string): string | null {
  const match = /^s-(.+)\.json$/.exec(fileName);
  return match ? match[1]! : null;
}

export function sessionRecordPath(dir: string, sessionKey: string): string {
  return path.join(dir, `s-${sessionKey}.json`);
}

export interface SessionAnnouncement {
  protocol: number;
  session: string;
  pid: number;
  label: string;
  cwd: string;
  startedAt: string;
}

export function protocolMismatchMessage(theirs: unknown): string {
  const version = Number(theirs);
  if (!Number.isInteger(version)) {
    return 'The TheGitAI extension did not report a protocol version. Update both TheGitAI and the extension.';
  }
  if (version < BROWSER_PROTOCOL_VERSION) {
    return `The TheGitAI extension speaks browser protocol v${version}; this CLI speaks v${BROWSER_PROTOCOL_VERSION}. Update the extension from the Chrome Web Store.`;
  }
  return `The TheGitAI extension speaks browser protocol v${version}; this CLI speaks v${BROWSER_PROTOCOL_VERSION}. Update TheGitAI: npm i -g @thegitai/cli`;
}
