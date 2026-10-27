import type { WhoAmIResponse } from './api/contracts.js';

export const USAGE_WINDOWS = [
  ['5-hour', '5-hourly'],
  ['Weekly', 'weekly'],
  ['Monthly', 'monthly'],
] as const;


export function usageWindowLabel(key: string): string {
  return USAGE_WINDOWS.find(([, id]) => id === key)?.[0] ?? '';
}

export function formatUtcMinute(value: string | null): string {
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

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
};

export function formatUsageText(response: WhoAmIResponse): string {
  const { customer, usage } = response;
  const lines = [`Usage for ${customer.email}`, ''];

  if (!usage) {
    lines.push('Usage is not available for this account yet.');
    return lines.join('\n');
  }

  if (usage.plan) {
    lines.push(`Plan: ${PLAN_NAMES[usage.plan] ?? usage.plan}`, '');
  }
  lines.push('Window     Left        Resets');
  for (const [label, key] of USAGE_WINDOWS) {
    const value = formatPercentLeft(Number(usage.percentLeft[key] ?? 0));
    lines.push(
      `${label.padEnd(10)} ${value.padEnd(11)} ${formatUtcMinute(usage.resetsAt[key])}`,
    );
  }
  if (usage.autoOnly) {
    const value = formatPercentLeft(Number(usage.autoPercentLeft ?? 0));
    lines.push(
      `${'Auto extra'.padEnd(10)} ${value.padEnd(11)} ${formatUtcMinute(usage.resetsAt.monthly)}`,
      '',
      ...(usage.autoExtraSpent
        ? [
            'Your monthly allowance and extra Auto usage are used up. Usage',
            'resumes when your plan renews.',
          ]
        : [
            'Your monthly allowance is used up. Auto options in /model still work',
            'on extra usage until it runs out or your plan renews.',
          ]),
    );
  }

  return lines.join('\n');
}
