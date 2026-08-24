import { randomUUID } from 'node:crypto';
import { DEFAULT_THEGITAI_HOST } from './default-host.js';

export interface AuthorizedServerConfig {
  serverUrl: string;
  token: string;
}

export const TRACE_ID_HEADER = 'x-thegitai-trace-id';
export const CLIENT_HEADER = 'x-thegitai-client';
export const CLIENT_PLATFORM_HEADER = 'x-thegitai-client-platform';

export interface TraceContext {
  traceId: string;
  headers: Record<string, string>;
}

export class ServerApiError extends Error {
  readonly status: number;
  readonly traceId: string;
  readonly code: string;

  constructor(message: string, status: number, traceId: string, code = '') {
    super(traceId ? `${message}\nTrace ID: ${traceId}` : message);
    this.name = 'ServerApiError';
    this.status = status;
    this.traceId = traceId;
    this.code = code;
  }
}

export function createTraceId(): string {
  return `tr_${randomUUID().replace(/-/g, '')}`;
}

export function createTraceContext(traceId = createTraceId()): TraceContext {
  return {
    traceId,
    headers: {
      [TRACE_ID_HEADER]: traceId,
      [CLIENT_HEADER]: 'cli',
      [CLIENT_PLATFORM_HEADER]: `${process.platform}/${process.arch}`,
    },
  };
}

// Per-attempt ceiling so a stalled connection (dropped SYN, half-open socket)
// fails fast and can be retried, instead of hanging on undici's long defaults.
export const REQUEST_TIMEOUT_MS = 8000;

// The startup handshake (/v1/models, /v1/auth/whoami) is answered by the server
// in single-digit milliseconds, so an attempt that stalls for seconds has lost a
// packet somewhere on the path — waiting longer never recovers it, opening a
// fresh connection usually does. Keep the per-attempt ceiling short and retry
// sooner instead.
export const STARTUP_REQUEST_TIMEOUT_MS = 3000;

// Hard ceiling on the whole startup handshake, retries and backoff included. A
// bad network must cost the user a few seconds and a warning, never half a
// minute of dead air in front of a blank terminal.
export const STARTUP_DEADLINE_MS = 10_000;

/** Per-attempt timeout plus the retry ladder a caller is willing to fund. */
export interface RetryBudget {
  retries?: number;
  baseDelayMs?: number;
  deadlineMs?: number;
  timeoutMs?: number;
}

// More attempts than the default ladder, each cheaper, all of it bounded. Tuned
// for the shape of the failure we actually see: the origin replies in ~2ms, so
// a stalled attempt is a lost packet and the next connection usually succeeds
// immediately.
export const STARTUP_RETRY_BUDGET: RetryBudget = {
  retries: 3,
  baseDelayMs: 200,
  deadlineMs: STARTUP_DEADLINE_MS,
  timeoutMs: STARTUP_REQUEST_TIMEOUT_MS,
};

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * True for transport-level failures where the request never received a valid
 * HTTP response — DNS/connect/reset/timeout. Safe to retry for idempotent GETs.
 * An HTTP status failure (`ServerApiError`) is NOT transient: a 401/403/5xx is a
 * real answer from the server and must surface, not spin in a retry loop.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof ServerApiError) return false;
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    name?: string;
    message?: string;
    code?: string;
    cause?: { code?: string } | undefined;
  };
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.code ?? err.cause?.code;
  if (code) {
    // A named cause code is authoritative. Retry only known transport codes;
    // anything else that surfaces a specific code — TLS/cert validation
    // (CERT_HAS_EXPIRED, SELF_SIGNED_CERT_IN_CHAIN, ERR_TLS_CERT_ALTNAME_INVALID,
    // …), HTTP/2 protocol errors, etc. — is a real, non-transient fault the user
    // must see, not something to retry then bury under the cached/offline path.
    return TRANSIENT_NETWORK_CODES.has(code);
  }
  // No specific code: Node's global fetch surfaces bare connection failures as
  // `TypeError: fetch failed`, which is a transport blip worth retrying.
  if (error instanceof TypeError && /fetch failed/i.test(err.message ?? '')) {
    return true;
  }
  return false;
}

/**
 * Run an idempotent request, retrying only transient transport failures with
 * exponential backoff. A single dropped packet on startup should never be fatal.
 *
 * `deadlineMs` caps the total wall-clock cost of the ladder. Without it the
 * caller's budget is the *product* of the per-attempt timeout and the retry
 * count — three 8s attempts plus backoff is 26 seconds of a terminal sitting
 * there saying nothing, which reads as a hang rather than a retry.
 */
export async function retryTransient<T>(
  run: () => Promise<T>,
  {
    retries = 2,
    baseDelayMs = 400,
    deadlineMs,
    now = () => Date.now(),
  }: {
    retries?: number;
    baseDelayMs?: number;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): Promise<T> {
  const startedAt = now();
  const remainingMs = () =>
    deadlineMs == null ? Infinity : deadlineMs - (now() - startedAt);
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retries || !isTransientNetworkError(error)) throw error;
      const delayMs = baseDelayMs * 2 ** attempt;
      // Only sleep if the budget can still fund the retry it is waiting for.
      // Burning the remaining time on a backoff we cannot act on would trade a
      // fast, honest failure for a slow one.
      if (remainingMs() <= delayMs) throw error;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function normalizeServerUrl(serverUrl: string): string {
  const normalized = String(serverUrl || DEFAULT_THEGITAI_HOST)
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('Server URL must start with http:// or https://.');
  }
  return normalized;
}

// A non-JSON error body is summarized down to this many code points. Long
// enough to carry a real sentence from an origin that answers in plain text,
// short enough that nothing can flood the transcript.
const MAX_NON_JSON_BODY_CHARS = 200;

// Wording for the statuses only an intermediary produces. Our own server always
// answers /v1 with the JSON error envelope, so reaching these means the request
// died between the CLI and the server — the user needs to know that, not what
// the proxy's HTML said.
const GATEWAY_STATUS_MESSAGES: Record<number, string> = {
  502: 'Could not reach the TheGitAI server (bad gateway).',
  503: 'The TheGitAI server is temporarily unavailable.',
  504: 'The TheGitAI server did not respond in time (gateway timeout).',
  520: 'The connection to the TheGitAI server failed (edge error 520).',
  521: 'The TheGitAI server is not accepting connections (edge error 521).',
  522: 'The connection to the TheGitAI server timed out (edge error 522).',
  523: 'The TheGitAI server is unreachable (edge error 523).',
  524: 'The TheGitAI server did not respond in time (edge error 524).',
};

// Truncate by code point, never by UTF-16 unit: slicing mid-surrogate leaves an
// unpaired half that breaks rendering and poisons anything that persists it.
function truncateByCodePoint(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const points = Array.from(text);
  if (points.length <= maxChars) return text;
  return `${points.slice(0, maxChars).join('').trimEnd()}…`;
}

/**
 * Renders a body that isn't our JSON error envelope as a single short line.
 *
 * Intermediaries answer in HTML, not JSON: the Cloudflare edge, nginx, a
 * corporate proxy, a hotel captive portal. Using that page as the error message
 * put a whole ~13KB Cloudflare 524 interstitial — markup, inline <script>, and
 * the user's own IP — into the terminal when a turn timed out on
 * 2026-08-14. Keep the status wording and the Ray ID (support asks for it);
 * throw the page away.
 */
export function nonJsonErrorMessage(body: string, status: number): string {
  const rayId = /Cloudflare Ray ID:\s*(?:<[^>]*>\s*)*([0-9a-f]{8,})/i.exec(
    body,
  )?.[1];
  const gateway = GATEWAY_STATUS_MESSAGES[status];
  const summary = truncateByCodePoint(
    body
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    MAX_NON_JSON_BODY_CHARS,
  );
  const base = gateway ?? (summary || `Request failed with ${status}`);
  return rayId ? `${base} (Cloudflare Ray ID: ${rayId})` : base;
}

/**
 * Turn-failure category for a request that died between the CLI and the server,
 * or `null` when the failure came from the server itself and already carries a
 * category of its own.
 */
export function gatewayFailureCategory(error: unknown): string | null {
  if (!(error instanceof ServerApiError)) return null;
  return error.status in GATEWAY_STATUS_MESSAGES ? 'gateway_error' : null;
}

export async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: { message: nonJsonErrorMessage(text, response.status) },
    };
  }
}

export function failureMessage(data: any, status: number): string {
  return String(
    data?.error?.message ?? data?.message ?? `Request failed with ${status}`,
  );
}

export function failureCode(data: any): string {
  return typeof data?.error?.code === 'string' ? data.error.code : '';
}

export function isAuthenticationError(error: unknown): error is ServerApiError {
  return error instanceof ServerApiError && error.status === 401;
}

export function authenticationErrorMessage(error: ServerApiError): string {
  return error.code === 'AUTH_TOKEN_EXPIRED'
    ? 'Your login expired after 48 hours of inactivity. Run `ai login` and resume this saved session.'
    : 'Your login is no longer valid. Run `ai login` and resume this saved session.';
}

export async function readErrorResponse(
  response: Response,
  traceId = response.headers.get(TRACE_ID_HEADER) ?? '',
): Promise<Error> {
  const data = await readJsonResponse(response);
  return new ServerApiError(
    failureMessage(data, response.status),
    response.status,
    traceId,
    failureCode(data),
  );
}

export async function authorizedJson({
  config,
  path,
  method = 'GET',
  body = null,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: {
  config: AuthorizedServerConfig;
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<any> {
  const trace = createTraceContext();
  const response = await fetchImpl(
    `${normalizeServerUrl(config.serverUrl)}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...trace.headers,
        ...headers,
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new ServerApiError(
      failureMessage(data, response.status),
      response.status,
      trace.traceId,
      failureCode(data),
    );
  }
  return data;
}
