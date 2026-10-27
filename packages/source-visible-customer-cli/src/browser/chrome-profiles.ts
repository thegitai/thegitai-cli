import fs from 'node:fs';
import path from 'node:path';
import { EXTENSION_IDS } from './protocol.js';

export function chromeUserDataDirs(userDataDir = ''): string[] {
  if (userDataDir) return [userDataDir];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      ['Google', 'Chrome'],
      ['Google', 'Chrome Beta'],
      ['Chromium'],
      ['BraveSoftware', 'Brave-Browser'],
      ['Microsoft', 'Edge'],
    ].map((parts) => path.join(local, ...parts, 'User Data'));
  }
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge'].map(
      (dir) => path.join(support, dir),
    );
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    ...['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map(
      (dir) => path.join(config, dir),
    ),
    path.join(home, 'snap', 'chromium', 'common', 'chromium'),
  ];
}

const UUID_TAIL = '[0-9a-f]{0,8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function chromeProfileLabel(idOrPrefix: string, userDataDir = ''): string {
  const wanted = String(idOrPrefix ?? '').toLowerCase();
  if (!/^[0-9a-f]{6}/.test(wanted) || !/^[0-9a-f-]+$/.test(wanted)) return '';
  const pattern =
    wanted.length >= 36 ? null : new RegExp(`${wanted}${UUID_TAIL.replace('{0,8}', `{${8 - Math.min(wanted.length, 8)}}`)}`);
  for (const dataDir of chromeUserDataDirs(userDataDir)) {
    let profiles: Record<string, { name?: unknown }>;
    try {
      profiles = JSON.parse(fs.readFileSync(path.join(dataDir, 'Local State'), 'utf8'))?.profile?.info_cache ?? {};
    } catch {
      continue;
    }
    for (const [profileDir, info] of Object.entries(profiles)) {
      for (const extensionId of EXTENSION_IDS) {
        const store = path.join(dataDir, profileDir, 'Local Extension Settings', extensionId);
        let files: string[];
        try {
          files = fs.readdirSync(store);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!/\.(log|ldb)$/.test(file)) continue;
          try {
            const full = path.join(store, file);
            if (fs.statSync(full).size > 8 * 1024 * 1024) continue;
            const text = fs.readFileSync(full).toString('latin1');
            if (pattern ? !pattern.test(text) : !text.includes(wanted)) continue;
          } catch {
            continue;
          }
          const name = String(info?.name ?? '').trim().slice(0, 60);
          return name ? `${name} (${profileDir})` : profileDir;
        }
      }
    }
  }
  return '';
}
