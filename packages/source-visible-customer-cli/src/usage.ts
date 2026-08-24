import type { WhoAmIResponse } from './api/contracts.js';

const USAGE_WINDOWS = [
  ['5-hour', '5-hourly'],
  ['Weekly', 'weekly'],
  ['Monthly', 'monthly'],
] as const;

function formatUtcMinute(value: string | null): string {
  if (!value) return 'no active usage';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const pad = (part: number) => String(part).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    '-',
    pad(date.getUTCMonth() + 1),
    '-',
    pad(date.getUTCDate()),
    ' ',
    pad(date.getUTCHours()),
    ':',
    pad(date.getUTCMinutes()),
    ' UTC',
  ].join('');
}

function formatPercentLeft(value: number): string {
  const percent = Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
  }).format(percent)}% left`;
}

export function formatUsageText(response: WhoAmIResponse): string {
  const { customer, usage } = response;
  const lines = [`Usage for ${customer.email}`, ''];

  if (!usage) {
    lines.push('Usage is not available for this account yet.');
    return lines.join('\n');
  }

  lines.push('Window     Left        Resets');
  for (const [label, key] of USAGE_WINDOWS) {
    const value = formatPercentLeft(Number(usage.percentLeft[key] ?? 0));
    lines.push(
      `${label.padEnd(10)} ${value.padEnd(11)} ${formatUtcMinute(usage.resetsAt[key])}`,
    );
  }

  return lines.join('\n');
}
