import { displayWidth, sliceToWidth } from './text.js';

export function fitModelLabel(label: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(label) <= width) return label;
  const name = label.replace(/\s+\([^()]+\)$/, '');
  if (displayWidth(name) <= width) return name;
  if (width === 1) return '…';
  return `${sliceToWidth(name, width - 1)}…`;
}
