#!/usr/bin/env node

import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// tree-sitter-runtime resolves the vendored web-tree-sitter runtime from
// dist/vendor at runtime; the package ships only dist/, so the vendored .cjs,
// .wasm, and license/notice must be copied in or published installs lose local
// code intelligence.
const sourceDir = path.join(packageRoot, 'vendor');
const targetDir = path.join(packageRoot, 'dist', 'vendor');

if (!existsSync(sourceDir)) {
  console.error(`Missing vendor directory at ${sourceDir}.`);
  process.exit(1);
}

cpSync(sourceDir, targetDir, { recursive: true });
