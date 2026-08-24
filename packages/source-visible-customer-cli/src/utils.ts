export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    dot += valA * valB;
    magA += valA * valA;
    magB += valB * valB;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function truncate(text: string, maxChars: number = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

// For table cells and one-line previews: truncate() embeds a newline marker
// that breaks single-line layouts (it leaked "... (truncated)" into the
// resume picker), so this collapses whitespace and ellipsizes instead.
export function singleLinePreview(text: string, maxChars: number): string {
  const collapsed = String(text ?? '')
    .replace(/\n\.\.\. \(truncated\)\s*$/, '…')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function clampInteger(
  value: any,
  fallback: number,
  max: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(numeric), max);
}

export interface FileRange {
  totalLines: number;
  startLine: number;
  endLine: number;
  content: string;
}

export function readFileRange(
  content: string,
  startLine?: number,
  endLine?: number,
): FileRange {
  const lines = content.split('\n');
  const safeStart = startLine ? Math.max(1, startLine) : 1;
  const safeEnd = endLine ? Math.max(safeStart, endLine) : lines.length;
  const selected = lines.slice(safeStart - 1, safeEnd);
  return {
    totalLines: lines.length,
    startLine: safeStart,
    endLine: safeStart + selected.length - 1,
    content: selected.join('\n'),
  };
}
