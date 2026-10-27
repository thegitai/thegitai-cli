import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from './client-state.js';

const INSTALL_ID_PATTERN = /^[a-f0-9]{32}$/;

let cached: string | null | undefined;

function readInstallId(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return INSTALL_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function getInstallId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (cached !== undefined) return cached;
  const file = path.join(getClientStateDir(env), 'install-id');
  const existing = readInstallId(file);
  if (existing) return (cached = existing);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const id = randomBytes(16).toString('hex');
    writeFileSync(file, `${id}\n`, { mode: 0o600, flag: 'wx' });
    return (cached = id);
  } catch {
    return (cached = readInstallId(file));
  }
}
