import { isPlanRequiredError, isQuotaExceededError, ServerApiError } from './api/http.js';
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
  const reset = resetsAt ? formatUtcMinute(resetsAt) : '';
  const knownReset = reset && reset !== 'unknown' ? reset : '';
  if (error.details.autoAvailable) {
    return {
      title: 'Usage limit reached',
      body: [
        knownReset
          ? `You've used your monthly allowance. Auto options in /model still work on a limited extra allowance until it runs out or your plan renews at ${knownReset}.`
          : "You've used your monthly allowance. Auto options in /model still work on a limited extra allowance until it runs out or your plan renews.",
        'Run /usage for details.',
      ].join('\n'),
    };
  }
  const lines: string[] = [];
  if (label) {
    lines.push(
      knownReset
        ? `You've used your ${inSentence} limit. It resets at ${knownReset}.`
        : `You've used your ${inSentence} limit.`,
    );
  } else {


    lines.push(firstMessageLine(error));
  }
  if (error.details.upgradeUrl) {
    lines.push(`Upgrade for more usage at ${error.details.upgradeUrl}`);
  }
  lines.push(
    label
      ? `Run /usage to see your ${otherWindowNames(label)} windows.`
      : 'Run /usage to see your remaining usage.',
  );
  return { title: 'Usage limit reached', body: lines.join('\n') };
}

export function buildPlanRequiredNotice(error: unknown): QuotaNotice | null {
  if (!(error instanceof ServerApiError) || !isPlanRequiredError(error)) {
    return null;
  }
  return {
    title: 'Plus or Pro model',
    body: firstMessageLine(error).replace(/\.\s+(?=Upgrade at )/, '.\n'),
  };
}

export function buildRefusalNotice(error: unknown): QuotaNotice | null {
  return buildPlanRequiredNotice(error) ?? buildQuotaNotice(error);
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
