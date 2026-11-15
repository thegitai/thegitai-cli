import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RECHECK_MISSING_MS = 60_000;

let checked: { available: boolean; at: number } | null = null;

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      continue;
    }
  }
  return null;
}

function probe(env: NodeJS.ProcessEnv): boolean {
  const found = onPath('git', env);
  if (!found) return false;
  let real = found;
  try {
    real = fs.realpathSync(found);
  } catch {
    return false;
  }
  if (real !== '/usr/bin/git') return true;
  try {
    const dir = execFileSync('/usr/bin/xcode-select', ['-p'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return fs.existsSync(path.join(dir, 'usr', 'bin', 'git'));
  } catch {
    return false;
  }
}

export function gitAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'darwin') return true;
  if (checked && (checked.available || Date.now() - checked.at < RECHECK_MISSING_MS)) {
    return checked.available;
  }
  checked = { available: probe(env), at: Date.now() };
  return checked.available;
}
