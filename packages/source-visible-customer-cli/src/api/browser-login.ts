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

// Matched to the server's authorization-code lifetime, which is the 10 minutes
// RFC 6749 recommends as the maximum. Waiting longer than the code can live
// bought nothing: it left a window where this prompt kept asking for a code
// that could no longer be exchanged, and the server returns the same error for
// "expired" as for "mistyped", so neither side could tell the user to stop.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function shutDownServer(server: http.Server): void {
  // Drop any lingering (keep-alive) connections so the event loop empties and
  // the CLI exits instead of hanging after a successful login.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close();
}

export interface BrowserLoginResult extends CliAuthConfig {
  customer: AuthCustomer;
}

/**
 * The user pressed Ctrl+C at the sign-in prompt. Node's readline turns that
 * into an AbortError on the pending question rather than raising SIGINT, so
 * without a distinct type it reaches the top level looking like a crash —
 * exactly the wrong impression for the documented way out of this screen.
 */
export class SignInCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled.');
    this.name = 'SignInCancelledError';
  }
}

export function isSignInCancelled(error: unknown): boolean {
  return error instanceof SignInCancelledError;
}

function isAbortError(error: unknown): boolean {
  const err = error as { name?: string; code?: string };
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

export interface BrowserLoginOptions {
  serverUrl?: string;
  /** Injectable for tests; defaults to the real browser opener. */
  openBrowser?: (url: string) => Promise<boolean>;
  /**
   * Reads an authorization code the user pastes in. Runs concurrently with the
   * loopback listener and is aborted the moment the browser redirect wins, so
   * it must reject (or never settle) when the signal fires. It must also block
   * until the user actually supplies something — an implementation that
   * returns immediately would spin, since empty input is re-asked rather than
   * accepted (see readPastedResult).
   */
  promptCode?: (signal: AbortSignal) => Promise<string>;
  /** Called with the website URL so the CLI can print it. */
  onUrl?: (url: string) => void;
  /** Called with whether the browser opener actually launched something. */
  onBrowserOpen?: (opened: boolean) => void;
  /** Called when a pasted code was rejected, before the prompt is re-offered. */
  onPasteRejected?: (message: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  deviceName?: string;
}

export function resolveWebsiteUrl(): string {
  // The public CLI always signs in through the official TheGitAI website. There
  // is no override path here so the published package cannot be pointed at a
  // clone host.
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
    // Rosetta runs x64 Node on Apple Silicon but still reports Apple CPUs.
    if (os.cpus().some((cpu) => cpu.model.includes('Apple'))) {
      return 'Apple Silicon';
    }
  } catch {
    // Fall through to Intel below.
  }
  return 'Intel';
}

/**
 * Human-readable OS label, e.g. "Ubuntu 26.04 LTS", "macOS 15.5, Apple
 * Silicon", "Windows 11 Pro". Never throws — a login must not fail because a
 * platform detail could not be read.
 */
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
        // Bare "macOS" is still useful alongside the architecture.
      }
      return `${version ? `macOS ${version}` : 'macOS'}, ${macArchLabel()}`;
    }
    if (process.platform === 'win32') {
      let label = '';
      try {
        label = os.version();
      } catch {
        // Fall back to the raw release number below.
      }
      // Windows 11 still brands its version string "Windows 10 ..."; builds
      // >= 22000 are Windows 11.
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

/**
 * Appends the OS label to the device name shown on the authorize page and
 * stored in cli_auth_requests.device_name, so support can tell Apple Silicon
 * from Intel (and distro/Windows versions) when tracing device-specific
 * problems. Applied to custom THEGITAI_DEVICE_NAME overrides too. Capped well
 * under the server's 200-char device_name limit.
 */
export function withOperatingSystemInfo(name: string): string {
  const trimmed = name.trim();
  const osLabel = describeOperatingSystem();
  const combined =
    osLabel && !trimmed.includes(osLabel)
      ? `${trimmed} (${osLabel})`
      : trimmed;
  return combined.slice(0, 180);
}

/** PKCE (RFC 7636, S256): a random verifier and its SHA-256 challenge. */
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

/**
 * Runs the paste route until it produces a signed-in result, or until the
 * browser redirect wins and aborts it.
 *
 * This route resolves a *result*, not a code, because only an accepted code is
 * a reason to stop waiting on the browser. Two kinds of non-answer are
 * therefore re-asked rather than allowed to settle the race:
 *
 * - Empty input. A bare Enter at a blinking prompt is the most ordinary
 *   keystroke there is, and the paste box is now shown to everyone — including
 *   the majority whose browser is about to succeed. Letting `''` win would
 *   abandon a redirect still in flight and close the very listener it is about
 *   to hit.
 * - A code the server rejects. A typo or an expired code should cost one more
 *   line of typing, not the whole sign-in and the browser route with it.
 *
 * Re-asking cannot spin: `promptCode` blocks on user input, and at EOF Node's
 * readline never settles the question at all.
 */
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
    // Hand the event loop a turn before asking again. A prompt that blocks on
    // real input yields anyway, but one that returns immediately would spin on
    // the microtask queue and starve the very I/O the loopback route needs —
    // turning a misbehaving prompt into a hung process rather than a busy one.
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Aborted: the other route already won, so this one must never settle.
  return await new Promise<BrowserLoginResult>(() => {});
}

/**
 * Browser-based login. Starts a loopback server so the website can redirect the
 * one-time code back automatically, and — at the same time — lets the user
 * paste a code in by hand. Both routes are live from the first frame and the
 * first one to produce a code wins, so no mode has to be chosen up front:
 * loopback covers "browser on this machine", paste covers everything else
 * (SSH, containers, a browser on your phone). Either way the code is exchanged
 * for a token using the PKCE verifier, and the CLI never sees credentials.
 */
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
          'Sign-in timed out. Authorization codes last 10 minutes — run `ai` again to start over.',
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
      // `Connection: close` plus closeAllConnections() ensures the browser's
      // keep-alive socket is torn down so the process can exit after login.
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

  // Both routes are live from here. Whichever produces a code first wins; the
  // loser is torn down. A rejection that arrives *after* the race has settled
  // is no longer anyone's problem (the abort we just fired causes one), so it
  // is parked on a promise that never settles rather than surfacing as an
  // unhandled rejection.
  let raceSettled = false;
  const untilSettled = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((error: unknown) => {
      if (raceSettled) return new Promise<T>(() => {});
      throw error;
    });

  // Each route runs all the way to a signed-in result, so the race settles
  // only on an outcome worth abandoning the other route for.
  //
  // The two routes treat a failed exchange differently, on purpose. A pasted
  // code is re-asked, because the thing that failed is something the user can
  // retype. A code from our own callback is not: it came straight from the
  // redirect, there is nothing for the user to correct, and the browser
  // interaction that produced it is already spent — so the failure is real and
  // final, and it ends the sign-in rather than leaving a prompt open that
  // cannot lead anywhere.
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
      // Our own abort only fires after the race is over, so anything aborting
      // this prompt while the race is live is the user pressing Ctrl+C.
      if (!raceSettled && isAbortError(error)) throw new SignInCancelledError();
      if (!raceSettled) {
        // A prompt that broke for some other reason must not take a browser
        // redirect down with it. Stop offering the paste route and let the
        // loopback finish on its own.
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
