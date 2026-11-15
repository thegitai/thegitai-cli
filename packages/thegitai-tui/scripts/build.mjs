import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(packageRoot, '..', '..');
const crateRoot = packageRoot;
const binDir = path.join(packageRoot, 'bin');
const binaryName =
  process.platform === 'win32' ? 'thegitai-tui.exe' : 'thegitai-tui';
const targetBinary = path.join(crateRoot, 'target', 'release', binaryName);
const outputBinary = path.join(binDir, binaryName);
const remap = `--remap-path-prefix=${os.homedir()}=/usr/src`;

mkdirSync(binDir, { recursive: true });

function install(source) {
  copyFileSync(source, outputBinary);
  if (process.platform !== 'win32') chmodSync(outputBinary, 0o755);
}

function hasCargo() {
  const probe = spawnSync('cargo', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return !probe.error && probe.status === 0;
}

function reviewedArtifact() {
  const candidate = path.join(
    repoRoot,
    'thegitai-public',
    `tui-${process.platform}-${process.arch}`,
    binaryName,
  );
  return existsSync(candidate) ? candidate : null;
}

if (!hasCargo()) {
  const artifact = reviewedArtifact();
  if (!artifact) {
    console.error(
      'No Rust toolchain (https://rustup.rs) and no reviewed binary at ' +
        `thegitai-public/tui-${process.platform}-${process.arch}/${binaryName}.`,
    );
    process.exit(1);
  }
  console.error(
    `cargo not found; using the reviewed binary from ${path.relative(repoRoot, artifact)}. ` +
      'Rust changes in this checkout are NOT included - run build:public on a machine with the toolchain.',
  );
  install(artifact);
  process.exit(0);
}

const build = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', path.join(crateRoot, 'Cargo.toml')],
  {
    cwd: crateRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
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

install(targetBinary);
