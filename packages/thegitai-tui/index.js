import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export function resolveTuiBinaryPath() {
  const binaryName =
    process.platform === 'win32' ? 'thegitai-tui.exe' : 'thegitai-tui';
  const binaryPath = path.join(packageRoot, 'bin', binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Missing thegitai-tui binary at ${binaryPath}. Run npm run build inside packages/thegitai-tui.`,
    );
  }
  return binaryPath;
}

export function spawnTuiProcess(options = {}) {
  const binaryPath = resolveTuiBinaryPath();
  return spawn(binaryPath, [], {
    stdio: ['pipe', 'inherit', 'pipe'],
    env: { ...process.env, ...options.env },
  });
}
