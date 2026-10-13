import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readBundledRipgrepPath(): string | null {
  try {
    const ripgrep = require('@vscode/ripgrep') as { rgPath?: unknown };
    const rgPath = ripgrep.rgPath;
    return typeof rgPath === 'string' && existsSync(rgPath) ? rgPath : null;
  } catch {
    return null;
  }
}

export function getRipgrepPath(): string {
  return readBundledRipgrepPath() ?? 'rg';
}

export function getRipgrepPathCandidates(): string[] {
  const bundled = readBundledRipgrepPath();
  return bundled ? [bundled, 'rg'] : ['rg'];
}

export function isRipgrepExecutionUnavailable(error: any): boolean {
  return (
    error?.code === 'ENOENT' ||
    error?.code === 'EACCES' ||
    error?.code === 'ENOEXEC' ||
    error?.errno === -2 ||
    error?.errno === -13 ||
    error?.errno === -8 ||
    error?.errno === -26
  );
}
