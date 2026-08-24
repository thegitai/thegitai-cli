#!/usr/bin/env node

import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// tree-sitter-runtime resolves grammars from dist/parsers first; the package
// ships only dist/, so the wasm grammars must be copied in or published
// installs silently lose repo-map parsing.
const sourceDir = path.join(packageRoot, 'parsers');
const targetDir = path.join(packageRoot, 'dist', 'parsers');

if (!existsSync(sourceDir)) {
  console.error(`Missing parsers directory at ${sourceDir}.`);
  process.exit(1);
}

cpSync(sourceDir, targetDir, { recursive: true });
