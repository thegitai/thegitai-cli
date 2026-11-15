import type { ClientLocalClock } from './api/contracts.js';

function pad(value: number): string {
  return String(Math.abs(Math.trunc(value))).padStart(2, '0');
}

export function localTimestamp(now: Date = new Date()): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date}T${time}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export function collectLocalClock(now: Date = new Date()): ClientLocalClock {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { localTime: localTimestamp(now), ...(timeZone ? { timeZone } : {}) };
}
