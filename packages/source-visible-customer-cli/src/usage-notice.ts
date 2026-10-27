import type { AccountUsage } from './api/contracts.js';
import type { QuotaNotice } from './quota-notice.js';
import { USAGE_WINDOWS } from './usage.js';

function resetDescription(resetsAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const remaining = days > 0
    ? `${days}d ${hours % 24}h`
    : hours > 0
      ? `${hours}h ${minutes % 60}m`
      : `${minutes}m`;
  const time = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(resetsAt);
  return `Usage starts resetting in ${remaining}, at ${time}.`;
}

export function createUsageNoticeTracker() {
  const shown = new Map<string, number>();
  return (usage: AccountUsage, now = Date.now()): QuotaNotice | null => {
    let urgent: { label: string; window: string; used: number; threshold: number; resetsAt: number } | null = null;
    for (const [label, window] of USAGE_WINDOWS) {
      const left = usage?.percentLeft?.[window];
      if (typeof left !== 'number' || !Number.isFinite(left) || left < 0 || left > 100) continue;
      const used = 100 - left;
      if (used < 75) shown.delete(window);
      else if (used < 90 && shown.get(window) === 95) shown.set(window, 80);
      const threshold = used >= 95 ? 95 : used >= 80 ? 80 : 0;
      if (!threshold) continue;
      const reset = usage?.resetsAt?.[window];
      const resetsAt = typeof reset === 'string' ? Date.parse(reset) : NaN;
      if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
      if (!urgent || used > urgent.used) urgent = { label, window, used, threshold, resetsAt };
    }
    if (!urgent || urgent.threshold <= Math.max(0, ...shown.values())) return null;
    shown.set(urgent.window, urgent.threshold);
    const percent = urgent.used === 100 ? 'over 99%' : `${Math.floor(urgent.used)}%`;
    return {
      title: 'Usage notice',
      body: [
        `You've used ${percent} of your ${urgent.label.toLowerCase()} allowance.`,
        resetDescription(urgent.resetsAt, now),
        'Run /usage for details.',
      ].join('\n'),
    };
  };
}
