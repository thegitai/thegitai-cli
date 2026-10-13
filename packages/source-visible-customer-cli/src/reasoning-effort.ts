export const REASONING_EFFORTS = ['default', 'low', 'balanced', 'deep'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  default: 'Default',
  low: 'Low',
  balanced: 'Balanced',
  deep: 'Deep',
};

export const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  default: 'Uses our recommended setting for this model.',
  low: 'Favors quicker responses and lower reasoning cost.',
  balanced: 'Balances reasoning depth, speed, and cost.',
  deep: 'Favors thorough reasoning; may take longer and cost more.',
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort === value);
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (value === undefined) return 'default';
  if (isReasoningEffort(value)) return value;
  throw new Error('Invalid reasoning effort. Choose Default, Low, Balanced, or Deep.');
}

export function cycleReasoningEffort(
  effort: ReasoningEffort,
  direction: -1 | 1,
): ReasoningEffort {
  const index = REASONING_EFFORTS.indexOf(effort);
  return REASONING_EFFORTS[
    (index + direction + REASONING_EFFORTS.length) % REASONING_EFFORTS.length
  ]!;
}
