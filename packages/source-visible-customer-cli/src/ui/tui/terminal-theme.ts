/**
 * Terminal background detection for secondary UI chrome.
 *
 * Many terminals export `COLORFGBG` as `foreground;background` (classic ANSI
 * 0–15). Background 0–6 is treated as dark; 7/15 and unknown leave the
 * historical gray+dim styling alone so light themes are unchanged.
 */
export function isDarkTerminalBackground(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(env.COLORFGBG ?? '').trim();
  if (!raw) return false;
  const parts = raw
    .split(/[;:]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const bgToken = parts[parts.length - 1];
  if (!bgToken) return false;
  const bg = Number(bgToken);
  if (!Number.isFinite(bg)) return false;
  return bg >= 0 && bg < 7;
}

export type MutedSpanStyle = { color: string; dim?: boolean };

/**
 * Gray+DIM on a dark background collapses into near-black. On dark terminals
 * use a mid ansi-256 gray without DIM. Elsewhere keep plain `gray` (still
 * muted on light themes) and omit DIM so terminals that never export
 * COLORFGBG — common for dark profiles — stay readable too.
 */
export function mutedStyle(
  env: NodeJS.ProcessEnv = process.env,
): MutedSpanStyle {
  if (isDarkTerminalBackground(env)) {
    return { color: 'ansi256(247)' };
  }
  return { color: 'gray' };
}

/**
 * Sites that used plain `gray` (no dim). On dark terminals lift to the same
 * readable muted gray; light/unknown keep `gray`.
 */
export function mutedColor(env: NodeJS.ProcessEnv = process.env): string {
  if (isDarkTerminalBackground(env)) {
    return 'ansi256(247)';
  }
  return 'gray';
}
