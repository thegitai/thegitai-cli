#!/usr/bin/env node

import { chmodSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const targetArg = process.argv[2];
const binPath = targetArg ? path.resolve(process.cwd(), targetArg) : null;

if (!binPath || !existsSync(binPath)) {
  process.exit(0);
}

const stat = statSync(binPath);
const desiredMode = stat.mode | 0o111;

if ((stat.mode & 0o111) !== 0o111) {
  chmodSync(binPath, desiredMode);
}
