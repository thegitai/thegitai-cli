






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







export function mutedStyle(
  env: NodeJS.ProcessEnv = process.env,
): MutedSpanStyle {
  if (isDarkTerminalBackground(env)) {
    return { color: 'ansi256(247)' };
  }
  return { color: 'gray' };
}





export function mutedColor(env: NodeJS.ProcessEnv = process.env): string {
  if (isDarkTerminalBackground(env)) {
    return 'ansi256(247)';
  }
  return 'gray';
}
