import os from 'node:os';
import path from 'node:path';

const STORE_DIR = 'thegitai';

export function getClientStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = String(env.THEGITAI_STATE_DIR ?? env.THEGITAI_SESSION_DIR ?? '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (process.platform === 'win32') {
    return path.join(
      env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      STORE_DIR,
    );
  }
  const stateHome = String(env.XDG_STATE_HOME ?? '').trim();
  return path.join(
    stateHome || path.join(os.homedir(), '.local', 'state'),
    STORE_DIR,
  );
}
