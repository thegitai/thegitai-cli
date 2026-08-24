import { accessSync, constants, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientEnvironmentContext } from './api/contracts.js';
import { ensureSessionScratchDir } from './scratch-dir.js';

const PACKAGE_MANAGER_CANDIDATES = [
  'apt',
  'apt-get',
  'dnf',
  'yum',
  'pacman',
  'zypper',
  'apk',
  'brew',
  'nix',
  'snap',
  'flatpak',
  'winget',
  'choco',
  'scoop',
];

export interface CollectClientEnvironmentOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  release?: string;
  env?: NodeJS.ProcessEnv;
  osReleaseText?: string | null;
  scratchDir?: string;
  executableExists?: (
    command: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => boolean;
}

function detectShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'win32') {
    const comspec = env.COMSPEC;
    return comspec ? path.win32.basename(comspec) : 'unknown';
  }
  const shell = env.SHELL;
  return shell ? path.basename(shell) : 'unknown';
}

function unquoteOsReleaseValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) {
    return trimmed;
  }
  return trimmed
    .slice(1, -1)
    .replace(/\\(["'`$\\])/g, '$1')
    .trim();
}

export function parseLinuxOsRelease(
  text: string,
): Pick<
  ClientEnvironmentContext,
  'distroId' | 'distroName' | 'distroVersion'
> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index);
    const value = unquoteOsReleaseValue(trimmed.slice(index + 1));
    values[key] = value;
  }
  return {
    distroId: values.ID,
    distroName: values.PRETTY_NAME ?? values.NAME,
    distroVersion: values.VERSION_ID ?? values.VERSION,
  };
}

function readLinuxOsReleaseText(
  options: CollectClientEnvironmentOptions,
): string {
  if ('osReleaseText' in options) {
    return options.osReleaseText ?? '';
  }
  try {
    return readFileSync('/etc/os-release', 'utf8');
  } catch {
    return '';
  }
}

function pathEnv(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function windowsExecutableNames(
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
  if (path.extname(command)) return [command];
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

function defaultExecutableExists(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const searchPath = pathEnv(env);
  if (!searchPath) return false;
  const names =
    platform === 'win32' ? windowsExecutableNames(command, env) : [command];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const name of names) {
      try {
        accessSync(path.join(dir, name), constants.X_OK);
        return true;
      } catch {
        try {
          accessSync(path.join(dir, name));
          return platform === 'win32';
        } catch {
          continue;
        }
      }
    }
  }
  return false;
}

function detectPackageManagers(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  executableExists: NonNullable<
    CollectClientEnvironmentOptions['executableExists']
  >,
): string[] {
  return PACKAGE_MANAGER_CANDIDATES.filter((command) =>
    executableExists(command, env, platform),
  );
}

export function collectClientEnvironment(
  options: CollectClientEnvironmentOptions = {},
): ClientEnvironmentContext {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const executableExists = options.executableExists ?? defaultExecutableExists;
  const linuxDistro =
    platform === 'linux'
      ? parseLinuxOsRelease(readLinuxOsReleaseText(options))
      : {};
  return {
    platform,
    arch: options.arch ?? process.arch,
    release: options.release ?? os.release(),
    shell: detectShell(platform, env),
    ...linuxDistro,
    packageManagers: detectPackageManagers(env, platform, executableExists),
    scratchDir: options.scratchDir ?? ensureSessionScratchDir(),
  };
}
