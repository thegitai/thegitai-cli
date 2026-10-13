import {
  isTransientNetworkError,
  ServerApiError,
  transportFailureDetail,
} from './http.js';

export const TURN_RECOVERY_DELAY_MS = 10_000;
export const TURN_RECOVERY_RETRIES = 3;
export const TURN_REQUEST_TIMEOUT_MS = 30_000;
export const TURN_STREAM_IDLE_TIMEOUT_MS = 60_000;

const RETRYABLE_TURN_STATUSES = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function isRetryableTurnStatus(status: number): boolean {
  return RETRYABLE_TURN_STATUSES.has(status);
}






export function isRetryableTurnFailure(error: unknown): boolean {
  if (error instanceof ServerApiError) return isRetryableTurnStatus(error.status);
  return isTransientNetworkError(error);
}

export function interruptedStream(
  message = 'The turn stream ended before the turn finished.',
): Error {
  return Object.assign(new Error(message), { code: 'ECONNRESET' });
}

export type TurnRecoveryStatus =
  | { phase: 'waiting'; retry: number }
  | { phase: 'reconnecting'; retry: number }
  | { phase: 'reconnected' }
  | { phase: 'restored' }


  | { phase: 'continuing' }
  | { phase: 'continued' };

export function formatTurnRecoveryStatus(status: TurnRecoveryStatus): string {
  if (status.phase === 'waiting') {
    return `Connection interrupted · retrying in ${TURN_RECOVERY_DELAY_MS / 1000}s · retry ${status.retry}/${TURN_RECOVERY_RETRIES}`;
  }
  if (status.phase === 'reconnecting') {
    return `Reconnecting · retry ${status.retry}/${TURN_RECOVERY_RETRIES}`;
  }
  if (status.phase === 'reconnected') return 'Reconnected';
  if (status.phase === 'continuing') return 'Server restarted · continuing from the finished steps';
  if (status.phase === 'continued') return 'Server restarted · continued from the finished steps';
  return 'Connection restored · continued the same turn';
}

export const TURN_RECOVERY_EXHAUSTED = 'TURN_RECOVERY_EXHAUSTED';

export function isTurnRecoveryExhausted(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === TURN_RECOVERY_EXHAUSTED;
}

function recoveryExhausted(operation: string, cause: unknown): Error {
  const detail = transportFailureDetail(cause);
  const reason =
    detail ?? (cause instanceof ServerApiError ? `HTTP ${cause.status}` : 'no response');
  return Object.assign(
    new Error(
      `Connection lost while ${operation} (${reason}). Reconnecting failed after ${TURN_RECOVERY_RETRIES} retries. Some actions in this turn may already have completed.`,
      { cause },
    ),
    { code: TURN_RECOVERY_EXHAUSTED },
  );
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface TurnRecovery {





  run<T>(operation: string, attempt: () => Promise<T>, caller?: AbortSignal): Promise<T>;

  retryAfter(token: object, operation: string, error: unknown, caller?: AbortSignal): Promise<void>;

  reconnected(token: object): void;

  restored(token: object): void;
}






export function createTurnRecovery({
  signal,
  onStatus = () => {},
  sleep = abortableDelay,
}: {
  signal: AbortSignal;
  onStatus?: (status: TurnRecoveryStatus) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): TurnRecovery {
  const affected = new Set<object>();
  let retry = 0;
  let gate: Promise<void> | null = null;
  let exhausted: Error | null = null;

  async function retryAfter(
    token: object,
    operation: string,
    error: unknown,
    caller: AbortSignal = signal,
  ): Promise<void> {
    signal.throwIfAborted();
    withdrawIfAborted(token, caller);
    if (exhausted) throw exhausted;
    if (!isRetryableTurnFailure(error)) throw error;
    affected.add(token);
    if (!gate) {
      if (retry === TURN_RECOVERY_RETRIES) {
        exhausted = recoveryExhausted(operation, error);
        throw exhausted;
      }
      retry += 1;
      const current = retry;
      onStatus({ phase: 'waiting', retry: current });
      gate = sleep(TURN_RECOVERY_DELAY_MS, signal)
        .then(() => {
          signal.throwIfAborted();
          onStatus({ phase: 'reconnecting', retry: current });
        })
        .finally(() => {
          gate = null;
        });
    }
    if (caller === signal) {
      await gate;
      return;
    }
    await untilAborted(gate, caller).catch((reason) => {
      withdrawIfAborted(token, caller);
      throw reason;
    });
  }

  function withdrawIfAborted(token: object, caller: AbortSignal): void {
    if (!caller.aborted) return;
    affected.delete(token);
    throw caller.reason;
  }

  function reconnected(token: object): void {
    if (!affected.has(token) || gate || exhausted) return;
    onStatus({ phase: 'reconnected' });
  }

  function restored(token: object): void {
    if (!affected.delete(token)) return;
    if (affected.size > 0 || gate || exhausted) return;
    retry = 0;
    onStatus({ phase: 'restored' });
  }

  async function run<T>(
    operation: string,
    attempt: () => Promise<T>,
    caller: AbortSignal = signal,
  ): Promise<T> {
    const token = {};
    for (;;) {
      signal.throwIfAborted();
      withdrawIfAborted(token, caller);
      if (exhausted) throw exhausted;
      try {
        const value = await attempt();
        restored(token);
        return value;
      } catch (error) {
        await retryAfter(token, operation, error, caller);
      }
    }
  }

  return { run, retryAfter, reconnected, restored };
}







export async function fetchTurnAttempt(
  fetchImpl: typeof fetch,
  url: string | URL | Request,
  init: RequestInit,
  signal: AbortSignal,
  { readBody = false }: { readBody?: boolean } = {},
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('The request did not get a response in time.', 'TimeoutError'),
      ),
    TURN_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!readBody && response.ok) return response;
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export async function readTurnChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              interruptedStream(
                `The turn stream sent nothing for ${TURN_STREAM_IDLE_TIMEOUT_MS / 1000} seconds.`,
              ),
            ),
          TURN_STREAM_IDLE_TIMEOUT_MS,
        );
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
