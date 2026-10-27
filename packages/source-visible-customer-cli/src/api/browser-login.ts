import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { openUrl } from '../core/open-url.js';
import type { CliAuthConfig } from './auth.js';
import type { AuthCustomer, AuthResponse } from './contracts.js';
import {
  ServerApiError,
  createTraceContext,
  failureCode,
  failureMessage,
  normalizeServerUrl,
  readJsonResponse,
} from './http.js';
import { DEFAULT_THEGITAI_HOST } from './default-host.js';
import { isAbortError } from '../utils.js';






const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function shutDownServer(server: http.Server): void {


  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close();
}

export interface BrowserLoginResult extends CliAuthConfig {
  customer: AuthCustomer;
}







export class SignInCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled.');
    this.name = 'SignInCancelledError';
  }
}

export function isSignInCancelled(error: unknown): boolean {
  return error instanceof SignInCancelledError;
}

export interface BrowserLoginOptions {
  serverUrl?: string;

  openBrowser?: (url: string) => Promise<boolean>;








  promptCode?: (signal: AbortSignal) => Promise<string>;

  onUrl?: (url: string) => void;

  onBrowserOpen?: (opened: boolean) => void;

  onPasteRejected?: (message: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  deviceName?: string;
}

export function resolveWebsiteUrl(): string {



  return DEFAULT_THEGITAI_HOST.replace(/\/+$/, '');
}

function defaultDeviceName(): string {
  try {
    return `${os.userInfo().username}@${os.hostname()}`;
  } catch {
    return os.hostname();
  }
}

function readLinuxOsPrettyName(): string {
  try {
    const content = readFileSync('/etc/os-release', 'utf8');
    return content.match(/^PRETTY_NAME="?([^"\n]*)"?$/m)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function macArchLabel(): string {
  try {
    if (process.arch === 'arm64') return 'Apple Silicon';

    if (os.cpus().some((cpu) => cpu.model.includes('Apple'))) {
      return 'Apple Silicon';
    }
  } catch {

  }
  return 'Intel';
}






export function describeOperatingSystem(): string {
  try {
    if (process.platform === 'linux') {
      const base = readLinuxOsPrettyName() || `Linux ${os.release()}`;
      return process.arch === 'arm64' ? `${base}, ARM64` : base;
    }
    if (process.platform === 'darwin') {
      let version = '';
      try {
        version = execSync('sw_vers -productVersion', {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
      } catch {

      }
      return `${version ? `macOS ${version}` : 'macOS'}, ${macArchLabel()}`;
    }
    if (process.platform === 'win32') {
      let label = '';
      try {
        label = os.version();
      } catch {

      }


      const build = Number(os.release().split('.')[2] ?? '0');
      if (build >= 22000) label = label.replace(/Windows 10/i, 'Windows 11');
      const base = label || `Windows ${os.release()}`;
      return process.arch === 'arm64' ? `${base}, ARM64` : base;
    }
    return `${process.platform} ${os.release()}`;
  } catch {
    return process.platform;
  }
}








export function withOperatingSystemInfo(name: string): string {
  const trimmed = name.trim();
  const osLabel = describeOperatingSystem();
  const combined =
    osLabel && !trimmed.includes(osLabel)
      ? `${trimmed} (${osLabel})`
      : trimmed;
  return combined.slice(0, 180);
}


export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier, 'utf8')
    .digest('base64url');
  return { verifier, challenge };
}

function buildAuthUrl(
  websiteUrl: string,
  params: {
    codeChallenge: string;
    deviceName: string;
    redirectUri: string;
    state: string;
  },
): string {
  const url = new URL(`${websiteUrl}/cli-auth`);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('device_name', params.deviceName);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  return url.toString();
}

const RESULT_PAGE = (heading: string, detail: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>TheGitAI CLI</title>` +
  `<style>body{font-family:system-ui,sans-serif;background:#0c0d10;color:#e6e7ea;` +
  `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
  `.card{text-align:center;max-width:420px;padding:2rem}h1{font-size:1.4rem}` +
  `p{color:#9aa0a6}</style></head><body><div class="card"><h1>${heading}</h1>` +
  `<p>${detail}</p></div></body></html>`;

async function exchangeCodeForToken({
  serverUrl,
  code,
  codeVerifier,
  fetchImpl,
}: {
  serverUrl: string;
  code: string;
  codeVerifier: string;
  fetchImpl: typeof fetch;
}): Promise<BrowserLoginResult> {
  const trace = createTraceContext();
  const response = await fetchImpl(`${serverUrl}/v1/cli/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...trace.headers },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
  });
  const data = (await readJsonResponse(response)) as AuthResponse | any;
  if (!response.ok) {
    throw new ServerApiError(
      failureMessage(data, response.status),
      response.status,
      trace.traceId,
      failureCode(data),
    );
  }
  const token = String(data?.token ?? '').trim();
  const customer = data?.customer as AuthCustomer | undefined;
  if (!token || !customer?.email) {
    throw new Error('Server returned an invalid login response.');
  }
  return {
    serverUrl,
    token,
    email: customer.email,
    customerType: customer.customer_type === 'ADMIN' ? 'ADMIN' : 'USER',
    customer,
  };
}




















async function readPastedResult({
  promptCode,
  signal,
  serverUrl,
  codeVerifier,
  fetchImpl,
  onPasteRejected,
}: {
  promptCode: (signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  serverUrl: string;
  codeVerifier: string;
  fetchImpl: typeof fetch;
  onPasteRejected?: (message: string) => void;
}): Promise<BrowserLoginResult> {
  while (!signal.aborted) {
    const code = (await promptCode(signal)).trim();
    if (code) {
      try {
        return await exchangeCodeForToken({ serverUrl, code, codeVerifier, fetchImpl });
      } catch (error) {
        if (signal.aborted) break;
        onPasteRejected?.((error as Error).message);
      }
    }




    await new Promise((resolve) => setImmediate(resolve));
  }

  return await new Promise<BrowserLoginResult>(() => {});
}










export async function loginViaBrowser(
  options: BrowserLoginOptions,
): Promise<BrowserLoginResult> {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? DEFAULT_THEGITAI_HOST);
  const websiteUrl = resolveWebsiteUrl();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const openBrowser = options.openBrowser ?? openUrl;
  const onUrl = options.onUrl ?? (() => {});
  const deviceName = withOperatingSystemInfo(
    options.deviceName ?? defaultDeviceName(),
  );
  const { verifier, challenge } = generatePkce();

  const state = crypto.randomBytes(16).toString('base64url');
  const server = http.createServer();
  let timer: NodeJS.Timeout | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      shutDownServer(server);
      reject(
        new Error(
          'Sign-in timed out. Authorization codes last 10 minutes - run `ai` again to start over.',
        ),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    server.on('request', (req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const code = requestUrl.searchParams.get('code') ?? '';
      const returnedState = requestUrl.searchParams.get('state') ?? '';


      if (!code || returnedState !== state) {
        res.writeHead(400, { 'content-type': 'text/html', connection: 'close' });
        res.end(
          RESULT_PAGE('Login failed', 'The request could not be verified. Please run `ai` again.'),
        );
        clearTimeout(timer);
        shutDownServer(server);
        reject(new Error('The login callback could not be verified.'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      res.end(
        RESULT_PAGE('You are signed in', 'You can close this tab and return to your terminal.'),
      );
      clearTimeout(timer);
      shutDownServer(server);
      resolve(code);
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authUrl = buildAuthUrl(websiteUrl, {
    codeChallenge: challenge,
    deviceName,
    redirectUri,
    state,
  });
  onUrl(authUrl);
  const opened = await openBrowser(authUrl).catch(() => false);
  options.onBrowserOpen?.(opened);






  let raceSettled = false;
  const untilSettled = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((error: unknown) => {
      if (raceSettled) return new Promise<T>(() => {});
      throw error;
    });











  const pasteAbort = new AbortController();
  const routes: Promise<BrowserLoginResult>[] = [
    untilSettled(
      codePromise.then((code) =>
        exchangeCodeForToken({ serverUrl, code, codeVerifier: verifier, fetchImpl }),
      ),
    ),
  ];
  if (options.promptCode) {
    const pasted = readPastedResult({
      promptCode: options.promptCode,
      signal: pasteAbort.signal,
      serverUrl,
      codeVerifier: verifier,
      fetchImpl,
      onPasteRejected: options.onPasteRejected,
    }).catch((error: unknown) => {


      if (!raceSettled && isAbortError(error)) throw new SignInCancelledError();
      if (!raceSettled) {



        return new Promise<BrowserLoginResult>(() => {});
      }
      throw error;
    });
    routes.push(untilSettled(pasted));
  }

  try {
    return await Promise.race(routes);
  } finally {
    raceSettled = true;
    pasteAbort.abort();
    if (timer) clearTimeout(timer);
    shutDownServer(server);
  }
}
