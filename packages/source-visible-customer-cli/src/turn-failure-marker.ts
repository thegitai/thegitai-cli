const TURN_FAILURE_MARKER_PATTERN =
  /^Turn failed before completion: ([a-z][a-z0-9_-]*)\.?$/i;

export function formatTurnFailureMarker(category: string): string {
  const normalized = category.trim().toLowerCase();
  const safeCategory = /^[a-z][a-z0-9_-]*$/.test(normalized)
    ? normalized
    : 'unknown_error';
  return `Turn failed before completion: ${safeCategory}.`;
}

export function isTurnFailureMarker(text: string): boolean {
  return TURN_FAILURE_MARKER_PATTERN.test(text.trim());
}
