import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from '../client-state.js';
import {
  MAX_IMAGE_SIZE_BYTES,
  sniffImageMimeType,
} from '../core/image-limits.js';
import type { ToolResponse } from '../tools/types.js';

const IMAGE_FILE_MODE = 0o600;
const IMAGE_DIR_MODE = 0o700;

export const GENERATED_IMAGES_SUBDIR = 'generated_images';

/** Drop generated PNGs older than this; matches session image retention. */
export const GENERATED_IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getGeneratedImagesDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getClientStateDir(env), GENERATED_IMAGES_SUBDIR);
}

export function sanitizeGeneratedImageBasename(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  const base = trimmed
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/^\.+/, '')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-\.|\.-/g, '.')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!base || base === '.' || base === '..') {
    return `generated-${Date.now()}.png`;
  }
  if (/\.png$/i.test(base)) {
    return base.replace(/\.png$/i, '.png');
  }
  const withoutExt = base.replace(/\.[^.]+$/, '').replace(/-+$/g, '');
  return `${withoutExt || 'generated'}.png`;
}

function uniquePath(dir: string, basename: string): string {
  const candidate = path.join(dir, basename);
  if (!existsSync(candidate)) {
    return candidate;
  }
  const ext = path.extname(basename) || '.png';
  const stem = path.basename(basename, ext);
  for (let i = 2; i < 10_000; i += 1) {
    const next = path.join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(next)) {
      return next;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/**
 * Remove generated images older than the cutoff. Runs alongside the session
 * image sweep so the state dir does not grow without bound.
 */
export function sweepGeneratedImages({
  maxAgeMs = GENERATED_IMAGE_MAX_AGE_MS,
  env = process.env,
  now = Date.now(),
}: {
  maxAgeMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
} = {}): number {
  const dir = getGeneratedImagesDir(env);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      if (now - statSync(filePath).mtimeMs < maxAgeMs) continue;
      rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      // Skip anything we cannot stat or remove; the next sweep retries.
    }
  }
  return removed;
}

/**
 * Write a server-generated image into the local TheGitAI state directory.
 * Client-only primitive — no provider knowledge.
 */
export function saveGeneratedImage(args: {
  base64Data?: unknown;
  mimeType?: unknown;
  suggestedFilename?: unknown;
  filename?: unknown;
  env?: NodeJS.ProcessEnv;
}): ToolResponse {
  const base64Data = String(args.base64Data ?? '').trim();
  if (!base64Data) {
    return {
      ok: false,
      error:
        'This CLI build cannot generate images without server-supplied image bytes. Update TheGitAI CLI.',
      failureCategory: 'tool_exception',
    };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Data, 'base64');
  } catch {
    return {
      ok: false,
      error: 'Generated image bytes are invalid.',
      failureCategory: 'invalid_argument',
    };
  }

  if (bytes.length === 0 || bytes.length > MAX_IMAGE_SIZE_BYTES) {
    return {
      ok: false,
      error: 'Generated image exceeded the allowed size limit.',
      failureCategory: 'invalid_argument',
    };
  }

  const sniffed = sniffImageMimeType(bytes);
  if (sniffed !== 'image/png') {
    return {
      ok: false,
      error: 'Generated image must be a PNG.',
      failureCategory: 'invalid_argument',
    };
  }

  const env = args.env ?? process.env;
  const dir = getGeneratedImagesDir(env);
  mkdirSync(dir, { recursive: true, mode: IMAGE_DIR_MODE });

  const basename = sanitizeGeneratedImageBasename(
    args.suggestedFilename ?? args.filename,
  );
  const target = uniquePath(dir, basename);
  writeFileSync(target, bytes, { mode: IMAGE_FILE_MODE });

  return {
    ok: true,
    path: target,
    message: `Image saved to ${target}`,
  };
}
