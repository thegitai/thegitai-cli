import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

export function runWithSession<T>(sessionId: string, fn: () => T): T {
  const id = String(sessionId ?? '').trim();
  if (!id) return fn();
  return storage.run(id, fn);
}

export function scopedSessionId(): string | null {
  return storage.getStore() ?? null;
}
