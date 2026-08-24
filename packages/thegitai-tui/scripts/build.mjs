import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const crateRoot = packageRoot;
const binDir = path.join(packageRoot, 'bin');
const targetBinary = path.join(
  crateRoot,
  'target',
  'release',
  'thegitai-tui',
);
const outputBinary = path.join(binDir, 'thegitai-tui');
const remap = `--remap-path-prefix=${os.homedir()}=/usr/src`;

mkdirSync(binDir, { recursive: true });

const build = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', path.join(crateRoot, 'Cargo.toml')],
  {
    cwd: crateRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      RUSTFLAGS: [process.env.RUSTFLAGS, remap].filter(Boolean).join(' '),
    },
  },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(targetBinary)) {
  console.error(`Missing release binary at ${targetBinary}`);
  process.exit(1);
}

copyFileSync(targetBinary, outputBinary);
chmodSync(outputBinary, 0o755);
