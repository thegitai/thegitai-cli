#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(packageRoot, 'bin');
const targetBinary = path.join(targetDir, 'thegitai-tui');
const targetExists = existsSync(targetBinary);

const tuiPackageDir = path.join(packageRoot, '..', 'thegitai-tui');
const builtBinary = path.join(tuiPackageDir, 'bin', 'thegitai-tui');

const sourceCandidates = [
  process.env.THEGITAI_TUI_BINARY,
  builtBinary,
].filter(Boolean);

let sourceBinary = sourceCandidates.find((candidate) => existsSync(candidate));

// Workspace prepare order is not guaranteed (this package sorts before
// thegitai-tui alphabetically), and the binary is gitignored, so on a fresh
// install / CI checkout it usually isn't there yet. Build it on demand — but
// only when we have nothing to copy at all; if a target already exists we leave
// the on-demand build to the source-binary path so we don't rebuild needlessly.
if (!sourceBinary && !targetExists && existsSync(tuiPackageDir)) {
  console.error('ratatui binary not found; building it from the thegitai-tui crate…');
  const build = spawnSync('npm', ['--prefix', tuiPackageDir, 'run', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error(
      'Failed to build the ratatui binary. Install a Rust toolchain (https://rustup.rs) and retry.',
    );
    process.exit(build.status ?? 1);
  }
  if (existsSync(builtBinary)) {
    sourceBinary = builtBinary;
  }
}

if (!sourceBinary) {
  // No source to copy from. If a target is already present (e.g. published
  // tarball or a prior build), keep it; otherwise we genuinely cannot proceed.
  if (targetExists) {
    process.exit(0);
  }
  console.error(
    `Missing ratatui binary. Checked: ${sourceCandidates.join(', ')}. Run npm run build:tui at the repo root first.`,
  );
  process.exit(1);
}

// Copy when the target is missing or the freshly built source is newer. The
// old "skip if target exists" guard meant Rust changes never reached the
// customer CLI on a normal `build:client`, silently shipping a stale binary
// (issue #308: bracketed-paste fix built but had no effect until copied).
const sourceIsNewer =
  !targetExists ||
  statSync(sourceBinary).mtimeMs > statSync(targetBinary).mtimeMs;
if (sourceIsNewer) {
  mkdirSync(targetDir, { recursive: true });
  const tempBinary = path.join(targetDir, `.thegitai-tui-${process.pid}.tmp`);
  try {
    copyFileSync(sourceBinary, tempBinary);
    chmodSync(tempBinary, 0o755);
    renameSync(tempBinary, targetBinary);
  } catch (error) {
    if (existsSync(tempBinary)) {
      unlinkSync(tempBinary);
    }
    if (error && error.code === 'ETXTBSY' && targetExists) {
      console.warn(
        'thegitai-tui binary is in use; kept the existing copy. Quit running CLI sessions, then rerun npm run build:client for the latest renderer.',
      );
    } else {
      throw error;
    }
  }
}
