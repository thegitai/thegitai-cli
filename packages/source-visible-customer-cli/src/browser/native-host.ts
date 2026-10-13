import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_IDS, NATIVE_HOST_NAME } from './protocol.js';




















function browserConfigRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = env.HOME ?? os.homedir();
  if (platform === 'win32') {




    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Google', 'Chrome Beta', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(local, 'Vivaldi', 'User Data'),
    ];
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return [
      path.join(support, 'Google', 'Chrome'),
      path.join(support, 'Google', 'Chrome Beta'),
      path.join(support, 'Chromium'),
      path.join(support, 'Microsoft Edge'),
      path.join(support, 'BraveSoftware', 'Brave-Browser'),
      path.join(support, 'Vivaldi'),
      path.join(support, 'Arc', 'User Data'),
    ];
  }
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return [
    path.join(configHome, 'google-chrome'),
    path.join(configHome, 'google-chrome-beta'),
    path.join(configHome, 'chromium'),
    path.join(configHome, 'microsoft-edge'),
    path.join(configHome, 'BraveSoftware', 'Brave-Browser'),
    path.join(configHome, 'vivaldi'),
  ];
}

export interface NativeHostRegistration {

  manifests: string[];
  launcherPath: string;
  changed: boolean;
  errors: string[];
}

function thegitaiHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return env.THEGITAI_HOME ?? path.join(local, 'thegitai');
  }
  return env.THEGITAI_HOME ?? path.join(env.HOME ?? os.homedir(), '.thegitai');
}










function writeLauncher(
  env: NodeJS.ProcessEnv,
  hostScript: string,
  platform: NodeJS.Platform = process.platform,
): {
  launcherPath: string;
  changed: boolean;
} {
  const dir = thegitaiHome(env, platform);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {








    const launcherPath = path.join(dir, 'browser-bridge-host.bat');
    const contents = [
      '@echo off',

      `"${process.execPath}" "${hostScript}" %*`,
      '',
    ].join('\r\n');
    const existingBat = fs.existsSync(launcherPath)
      ? fs.readFileSync(launcherPath, 'utf8')
      : null;
    if (existingBat === contents) return { launcherPath, changed: false };
    fs.writeFileSync(launcherPath, contents);
    return { launcherPath, changed: true };
  }
  const launcherPath = path.join(dir, 'browser-bridge-host.sh');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const contents = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hostScript)} "$@"\n`;
  const existing = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath, 'utf8') : null;
  if (existing === contents) {


    try {
      fs.chmodSync(launcherPath, 0o700);
    } catch {

    }
    return { launcherPath, changed: false };
  }
  fs.writeFileSync(launcherPath, contents, { mode: 0o700 });
  fs.chmodSync(launcherPath, 0o700);
  return { launcherPath, changed: true };
}

function resolveHostScript(): string {

  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'bin', 'browser-host.js');
}

export function registerNativeHost({
  env = process.env,
  platform = process.platform,
  hostScript = resolveHostScript(),
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  hostScript?: string;
} = {}): NativeHostRegistration {
  const errors: string[] = [];
  const manifests: string[] = [];
  let changed = false;

  const { launcherPath, changed: launcherChanged } = writeLauncher(env, hostScript, platform);
  changed = launcherChanged;

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'TheGitAI browser bridge',
    path: launcherPath,
    type: 'stdio',




    allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

  if (platform === 'win32') {
    return registerWindowsNativeHost({ env, serialized, launcherPath, changed });
  }

  for (const root of browserConfigRoots(env, platform)) {
    if (!fs.existsSync(root)) continue;
    const dir = path.join(root, 'NativeMessagingHosts');
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (existing !== serialized) {
        fs.writeFileSync(file, serialized, { mode: 0o600 });
        changed = true;
      }
      manifests.push(file);
    } catch (error: any) {
      errors.push(`${file}: ${error?.message ?? error}`);
    }
  }

  return { manifests, launcherPath, changed, errors };
}







const WINDOWS_REGISTRY_ROOTS: ReadonlyArray<{ userData: string; key: string }> = [
  { userData: 'Google\\Chrome', key: 'Software\\Google\\Chrome' },
  { userData: 'Google\\Chrome Beta', key: 'Software\\Google\\Chrome Beta' },
  { userData: 'Chromium', key: 'Software\\Chromium' },
  { userData: 'Microsoft\\Edge', key: 'Software\\Microsoft\\Edge' },
  { userData: 'BraveSoftware\\Brave-Browser', key: 'Software\\BraveSoftware\\Brave-Browser' },
  { userData: 'Vivaldi', key: 'Software\\Vivaldi' },
];



















function registerWindowsNativeHost({
  env,
  serialized,
  launcherPath,
  changed,
}: {
  env: NodeJS.ProcessEnv;
  serialized: string;
  launcherPath: string;
  changed: boolean;
}): NativeHostRegistration {
  const errors: string[] = [];
  const manifests: string[] = [];
  let dirty = changed;

  const manifestPath = path.join(thegitaiHome(env, 'win32'), `${NATIVE_HOST_NAME}.json`);
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const existing = fs.existsSync(manifestPath)
      ? fs.readFileSync(manifestPath, 'utf8')
      : null;
    if (existing !== serialized) {
      fs.writeFileSync(manifestPath, serialized);
      dirty = true;
    }
    manifests.push(manifestPath);
  } catch (error: any) {
    errors.push(`${manifestPath}: ${error?.message ?? error}`);
    return { manifests, launcherPath, changed: dirty, errors };
  }

  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  for (const browser of WINDOWS_REGISTRY_ROOTS) {



    if (!fs.existsSync(path.join(local, browser.userData, 'User Data'))) continue;
    const key = `HKCU\\${browser.key}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
    try {
      const current = readRegistryDefault(key);
      if (current === manifestPath) continue;
      execFileSync(
        'reg.exe',
        ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
        { timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      dirty = true;
    } catch (error: any) {
      errors.push(`${key}: ${error?.message ?? error}`);
    }
  }

  return { manifests, launcherPath, changed: dirty, errors };
}


function readRegistryDefault(key: string): string | null {
  try {
    const output = execFileSync('reg.exe', ['query', key, '/ve'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const match = /\(Default\)\s+REG_SZ\s+(.+?)\s*$/m.exec(output);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}








export function chromiumProcessRunning(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    try {



      const output = execFileSync('tasklist.exe', ['/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /"(chrome|chromium|msedge|brave|vivaldi)\.exe"/i.test(output);
    } catch {
      return false;
    }
  }
  try {
    const output = execFileSync('ps', ['-eo', 'comm='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\n').some((line) => isBrowserProcessName(line));
  } catch {
    return false;
  }
}





















const BROWSER_PROCESS_NAME =
  /^(google[ -]?chrome|chrome|chromium|brave|msedge|microsoft[ -]?edge|vivaldi)/i;


const NOT_A_BROWSER_PROCESS = /crashpad|crashhandler|native|sandbox|driver|updater?\b/i;

export function isBrowserProcessName(psLine: string): boolean {
  const name = psLine.trim().split('/').pop()?.trim() ?? '';
  if (!name) return false;
  if (NOT_A_BROWSER_PROCESS.test(name)) return false;
  return BROWSER_PROCESS_NAME.test(name);
}
