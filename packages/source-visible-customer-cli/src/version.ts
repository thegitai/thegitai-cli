import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@thegitai/cli';





export const UNKNOWN_CLI_VERSION = '0.0.0';






export function getCliVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as { name?: unknown; version?: unknown };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {

    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return UNKNOWN_CLI_VERSION;
}

export function getPlatformTag(): string {
  return `${process.platform}-${process.arch}`;
}

export function formatVersionLine(): string {
  return `ai ${getCliVersion()} (${getPlatformTag()}, node ${process.version})`;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);



  if (leftNumeric && rightNumeric) {
    const a = Number(left);
    const b = Number(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}


export function isReadableCliVersion(value: string): boolean {
  return parseVersion(value) !== null;
}








export function compareCliVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }

  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < shared; index++) {
    const ordering = comparePrereleaseIdentifier(
      a.prerelease[index] as string,
      b.prerelease[index] as string,
    );
    if (ordering !== 0) return ordering;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}
