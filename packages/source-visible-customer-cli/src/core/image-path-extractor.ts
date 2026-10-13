import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImageFromFile } from './clipboard.js';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TOTAL_IMAGE_BYTES_PER_MESSAGE,
  approximateBase64DecodedBytes,
  sniffImageMimeType,
  totalAttachmentBytes,
} from './image-limits.js';
import { tryCacheAttachmentBytes } from './session-image-store.js';
import type { ImageAttachment } from '../types.js';

const EXT = '(?:png|jpe?g|gif|webp)';



const BARE_CHAR = "[^\\s\"'<>,:;!?()\\[\\]{}]";


const BARE_PATH = `(?:[A-Za-z]:[\\\\/])?(?:\\\\ |${BARE_CHAR})+\\.${EXT}`;

const IMAGE_PATH_PATTERN = new RegExp(
  `"([^"]*\\.${EXT})"` +
    `|'([^']*\\.${EXT})'` +
    `|file://(\\S*\\.${EXT})` +
    `|(${BARE_PATH})`,
  'gi',
);




const EXTENSION_TOKEN = new RegExp(`^(?:[A-Za-z]:[\\\\/])?(?:\\\\ |${BARE_CHAR})+$`);


const MAX_EXTENSION_TOKENS = 8;

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}












function extendBareMatchAcrossSpaces(
  input: string,
  matchStart: number,
  raw: string,
  cwd: string,
): string {
  const baseInner = raw.replace(/\\ /g, ' ');
  const baseExists = isFile(
    path.isAbsolute(baseInner) ? baseInner : path.resolve(cwd, baseInner),
  );
  let best: string | null = null;
  let candidate = raw;
  let start = matchStart;
  let addedSeparator = false;
  for (let hops = 0; hops < MAX_EXTENSION_TOKENS; hops++) {


    if (start < 2 || input[start - 1] !== ' ' || /\s/.test(input[start - 2]!)) break;
    let i = start - 2;
    while (i >= 0 && !/\s/.test(input[i]!)) i--;
    const tokenStart = i + 1;
    const token = input.slice(tokenStart, start - 1);
    if (!EXTENSION_TOKEN.test(token)) break;
    candidate = `${token} ${candidate}`;
    start = tokenStart;
    addedSeparator = addedSeparator || /[\\/]/.test(token);
    if (baseExists && !addedSeparator) continue;
    const inner = candidate.replace(/\\ /g, ' ');
    const resolved = path.isAbsolute(inner) ? inner : path.resolve(cwd, inner);
    if (isFile(resolved)) best = candidate;
  }
  return best ?? raw;
}

function detectImagePaths(input: string, cwd: string): Map<string, string[]> {
  const regex = new RegExp(IMAGE_PATH_PATTERN.source, IMAGE_PATH_PATTERN.flags);
  const detected: Array<{ resolvedPath: string; raw: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    let raw = match[0];




    if (match[4] != null && raw.includes('://')) continue;
    let inner: string;
    if (match[1] != null || match[2] != null) {
      const quoted = (match[1] ?? match[2])!;


      if (/^file:\/\//i.test(quoted)) {
        try {
          inner = fileURLToPath(quoted);
        } catch {
          continue;
        }
      } else {
        inner = quoted;
      }
    } else if (match[3] != null) {



      try {
        inner = fileURLToPath(raw);
      } catch {
        try {
          inner = decodeURIComponent(match[3]);
        } catch {
          continue;
        }
      }
    } else {



      raw = extendBareMatchAcrossSpaces(input, match.index, raw, cwd);
      inner = raw.replace(/\\ /g, ' ');
    }
    const resolvedPath = path.isAbsolute(inner) ? inner : path.resolve(cwd, inner);







    const start = match.index - (raw.length - match[0].length);
    while (detected.length > 0) {
      const prev = detected[detected.length - 1]!;
      if (prev.start + prev.raw.length <= start) break;
      detected.pop();
    }
    detected.push({ resolvedPath, raw, start });
  }
  const rawsByPath = new Map<string, string[]>();
  for (const { resolvedPath, raw } of detected) {
    const existing = rawsByPath.get(resolvedPath);
    if (existing) {
      existing.push(raw);
    } else {
      rawsByPath.set(resolvedPath, [raw]);
    }
  }
  return rawsByPath;
}




const EXTENSIONLESS_CANDIDATE = new RegExp(
  `"([^"]*[\\\\/][^"]*)"` +
  `|'([^']*[\\\\/][^']*)'` +
  `|((?:[A-Za-z]:[\\\\/])?(?:\\\\ |${BARE_CHAR})*[\\\\/](?:\\\\ |${BARE_CHAR})+)`,
  'g',
);






function sniffFileHeader(resolvedPath: string): Buffer | null {
  let fd: number | null = null;
  try {
    const stat = statSync(resolvedPath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_IMAGE_SIZE_BYTES) return null;
    fd = openSync(resolvedPath, 'r');
    const header = Buffer.alloc(12);
    const read = readSync(fd, header, 0, 12, 0);
    return read === 12 ? header : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {

      }
    }
  }
}









function detectExtensionlessImagePaths(
  input: string,
  cwd: string,
  alreadyDetected: ReadonlySet<string>,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const regex = new RegExp(
    EXTENSIONLESS_CANDIDATE.source,
    EXTENSIONLESS_CANDIDATE.flags,
  );
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    const raw = match[0];
    const inner = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\\ /g, ' ');
    if (!inner || inner.includes('://')) continue;

    if (/\.(?:png|jpe?g|gif|webp)$/i.test(inner)) continue;
    const resolvedPath = path.isAbsolute(inner)
      ? inner
      : path.resolve(cwd, inner);
    if (alreadyDetected.has(resolvedPath) || found.has(resolvedPath)) continue;
    const header = sniffFileHeader(resolvedPath);
    if (!header || !sniffImageMimeType(header)) continue;
    found.set(resolvedPath, [raw]);
  }
  return found;
}

export interface AutoAttachResult {
  sanitizedInput: string;
  attachments: ImageAttachment[];
  errors: string[];
}

export function autoAttachImages(
  input: string,
  cwd: string,
  existing: ImageAttachment[] = [],
): AutoAttachResult {
  const max = MAX_IMAGES_PER_MESSAGE;
  const rawsByPath = detectImagePaths(input, cwd);


  for (const [resolvedPath, rawForms] of detectExtensionlessImagePaths(
    input,
    cwd,
    new Set(rawsByPath.keys()),
  )) {
    rawsByPath.set(resolvedPath, rawForms);
  }
  let sanitizedInput = input;
  const attachments: ImageAttachment[] = [];
  const errors: string[] = [];




  const maxExistingIndex = existing.reduce(
    (highest, a) => Math.max(highest, a.index ?? 0),
    0,
  );




  let budgetUsed = totalAttachmentBytes(existing);

  for (const [resolvedPath, rawForms] of rawsByPath) {
    if (existing.length + attachments.length >= max) break;
    if (!existsSync(resolvedPath)) continue;
    try {
      const loaded = loadImageFromFile(resolvedPath);
      const bytes = approximateBase64DecodedBytes(loaded.base64Data);
      if (budgetUsed + bytes > MAX_TOTAL_IMAGE_BYTES_PER_MESSAGE) {
        errors.push(
          `${path.basename(resolvedPath)} was not attached: it would put this message over the ${Math.round(MAX_TOTAL_IMAGE_BYTES_PER_MESSAGE / 1024 / 1024)}MB combined image limit.`,
        );
        continue;
      }
      budgetUsed += bytes;





      const cached = tryCacheAttachmentBytes({
        base64Data: loaded.base64Data,
        mimeType: loaded.mimeType,
      });


      const idx = cached?.index ?? maxExistingIndex + attachments.length + 1;
      attachments.push({
        index: idx,
        mimeType: loaded.mimeType,
        base64Data: loaded.base64Data,
        source: 'file',
        filePath: resolvedPath,
        ...(cached ? { cachePath: cached.cachePath } : {}),
      });
      for (const raw of rawForms) {
        sanitizedInput = sanitizedInput.replace(raw, `[Image #${idx}]`);
      }
    } catch (err: any) {
      errors.push(err.message);
    }
  }

  return { sanitizedInput, attachments, errors };
}
