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


export interface ServerApiErrorDetails {
  window?: string;
  resetsAt?: string;
  percentLeft?: number;
}

export class ServerApiError extends Error {
  readonly status: number;
  readonly traceId: string;
  readonly code: string;
  readonly details: ServerApiErrorDetails;

  constructor(
    message: string,
    status: number,
    traceId: string,
    code = '',
    details: ServerApiErrorDetails = {},
  ) {
    super(traceId ? `${message}\nTrace ID: ${traceId}` : message);
    this.name = 'ServerApiError';
    this.status = status;
    this.traceId = traceId;
    this.code = code;
    this.details = details;
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



export const REQUEST_TIMEOUT_MS = 8000;






export const STARTUP_REQUEST_TIMEOUT_MS = 3000;




export const STARTUP_DEADLINE_MS = 10_000;


export interface RetryBudget {
  retries?: number;
  baseDelayMs?: number;
  deadlineMs?: number;
  timeoutMs?: number;
}





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





    return TRANSIENT_NETWORK_CODES.has(code);
  }


  if (error instanceof TypeError && /fetch failed/i.test(err.message ?? '')) {
    return true;
  }
  return false;
}










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




const MAX_NON_JSON_BODY_CHARS = 200;





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



function truncateByCodePoint(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const points = Array.from(text);
  if (points.length <= maxChars) return text;
  return `${points.slice(0, maxChars).join('').trimEnd()}…`;
}











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












const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPROTO',
  'ERR_STREAM_PREMATURE_CLOSE',
]);











const TRANSPORT_PHRASES: [RegExp, string][] = [
  [/\bsocket hang up\b/i, 'socket hang up'],
  [/\bother side closed\b/i, 'other side closed'],
  [/\bpremature close\b/i, 'premature close'],
  [/\bterminated\b/i, 'terminated'],
  [/\bfetch failed\b/i, 'fetch failed'],
  [/\bnetwork timeout\b/i, 'network timeout'],
  [/\bnetwork error\b/i, 'network error'],
  [/\bheaders timeout\b/i, 'headers timeout'],
  [/\bbody timeout\b/i, 'body timeout'],
];














export function transportFailureDetail(error: unknown): string | null {
  if (error instanceof ServerApiError) return null;
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const queue: any[] = [error];
  while (queue.length && seen.size < 24) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const code = String((current as any).code ?? '');
    if (TRANSPORT_CODES.has(code) || /^UND_ERR_[A-Z_]+$/.test(code)) {
      if (!parts.includes(code)) parts.push(code);
    }
    const message = String((current as any).message ?? '');
    for (const [pattern, label] of TRANSPORT_PHRASES) {
      if (pattern.test(message) && !parts.includes(label)) parts.push(label);
    }

    if ((current as any).cause) queue.push((current as any).cause);
    const nested = (current as any).errors;
    if (Array.isArray(nested)) queue.push(...nested);
  }
  return parts.length ? parts.slice(0, 3).join(' <- ') : null;
}

function isTransportFailure(error: unknown): boolean {
  return transportFailureDetail(error) !== null;
}






export function gatewayFailureCategory(error: unknown): string | null {
  if (isTransportFailure(error)) return 'connection_error';
  if (!(error instanceof ServerApiError)) return null;

  if (isQuotaExceededError(error)) return 'quota_exceeded';
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

export function failureDetails(data: any): ServerApiErrorDetails {
  const error = data?.error;
  if (!error || typeof error !== 'object') return {};
  return {
    ...(typeof error.window === 'string' ? { window: error.window } : {}),
    ...(typeof error.resetsAt === 'string' ? { resetsAt: error.resetsAt } : {}),
    ...(typeof error.percentLeft === 'number'
      ? { percentLeft: error.percentLeft }
      : {}),
  };
}

export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';


export function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof ServerApiError)) return false;
  if (error.code === QUOTA_EXCEEDED_CODE) return true;


  return error.status === 429 && !error.code;
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
    failureDetails(data),
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
      failureDetails(data),
    );
  }
  return data;
}
