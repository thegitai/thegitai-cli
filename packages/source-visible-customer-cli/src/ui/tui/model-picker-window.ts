export function modelPickerWindow(
  rowCount: number,
  selectedRow: number,
  capacity: number,
): { start: number; end: number } {
  const count = Math.min(rowCount, Math.max(1, capacity));
  const start = Math.max(0, Math.min(
    selectedRow - Math.floor(count / 2),
    rowCount - count,
  ));
  return { start, end: start + count };
}

export function modelPickerScrollLabel(
  above: number,
  below: number,
  width: number,
): string {
  const full = `↑ ${above} more above  •  ↓ ${below} more below`;
  return full.length <= width ? full : `↑ ${above} above · ↓ ${below} below`;
}
