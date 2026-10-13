import { isQuotaExceededError, ServerApiError } from './api/http.js';
import { USAGE_WINDOWS, formatUtcMinute, usageWindowLabel } from './usage.js';

export interface QuotaNotice {
  title: string;
  body: string;
}









export function buildQuotaNotice(error: unknown): QuotaNotice | null {
  if (!(error instanceof ServerApiError) || !isQuotaExceededError(error)) {
    return null;
  }
  const label = usageWindowLabel(String(error.details.window ?? ''));


  const inSentence = label.toLowerCase();
  const resetsAt = error.details.resetsAt ?? null;
  const lines: string[] = [];
  if (label) {
    const reset = resetsAt ? formatUtcMinute(resetsAt) : '';
    lines.push(
      reset && reset !== 'unknown'
        ? `You've used your ${inSentence} limit. It resets at ${reset}.`
        : `You've used your ${inSentence} limit.`,
    );
  } else {


    lines.push(firstMessageLine(error));
  }
  lines.push(
    label
      ? `Run /usage to see your ${otherWindowNames(label)} windows.`
      : 'Run /usage to see your remaining usage.',
  );
  return { title: 'Usage limit reached', body: lines.join('\n') };
}


function otherWindowNames(usedLabel: string): string {
  const names = USAGE_WINDOWS.map(([name]) => name)
    .filter((name) => name !== usedLabel)
    .map((name) => name.toLowerCase());
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : (names[0] ?? '');
}


function firstMessageLine(error: ServerApiError): string {
  return String(error.message ?? '').split('\n')[0]?.trim() || 'Usage limit reached.';
}
