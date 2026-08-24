import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@thegitai/cli';
const UNKNOWN_VERSION = '0.0.0';

// Resolve the package version at runtime by walking up from this module to the
// nearest package.json named @thegitai/cli. This works in both layouts: the
// compiled binary (dist/bin/ai.js → ../../package.json) and the source tree run
// under tsx in tests (src/version.ts → ../package.json). The name guard avoids
// picking up an unrelated manifest if the file is ever nested elsewhere.
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
      // No package.json at this level (or unreadable); keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return UNKNOWN_VERSION;
}

export function getPlatformTag(): string {
  return `${process.platform}-${process.arch}`;
}

export function formatVersionLine(): string {
  return `ai ${getCliVersion()} (${getPlatformTag()}, node ${process.version})`;
}
