import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getClientStateDir } from './client-state.js';






export interface Preferences {

  notifications: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  notifications: true,
};

export function getPreferencesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getClientStateDir(env), 'prefs.json');
}

export function readPreferences(env: NodeJS.ProcessEnv = process.env): Preferences {
  const filePath = getPreferencesPath(env);
  if (!existsSync(filePath)) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Preferences>;
    return {



      notifications:
        parsed.notifications === false ? false : DEFAULT_PREFERENCES.notifications,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writePreferences(
  preferences: Preferences,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = getPreferencesPath(env);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });


  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
