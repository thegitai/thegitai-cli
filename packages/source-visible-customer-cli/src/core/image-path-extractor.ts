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
// Bare-path characters: exclude whitespace, quotes, prose terminators, ':' (so we
// don't swallow URL schemes or trailing "see foo.png:" prose) and bracket/brace/paren
// delimiters on both sides (so markdown "![alt](x.png)" / "(x.png)" don't leak in).
const BARE_CHAR = "[^\\s\"'<>,:;!?()\\[\\]{}]";
// A bare token may carry backslash-escaped spaces (terminal drag-and-drop) and an
// optional Windows drive prefix ("C:\\" or "C:/").
const BARE_PATH = `(?:[A-Za-z]:[\\\\/])?(?:\\\\ |${BARE_CHAR})+\\.${EXT}`;

const IMAGE_PATH_PATTERN = new RegExp(
  `"([^"]*\\.${EXT})"` +
    `|'([^']*\\.${EXT})'` +
    `|file://(\\S*\\.${EXT})` +
    `|(${BARE_PATH})`,
  'gi',
);

// A leftward extension token uses the same alphabet as a bare path: BARE_CHARs
// (plus "\ " escapes) with an optional drive prefix. Anything else — quotes,
// brackets, a URL scheme's ":" — stops the extension at a prose boundary.
const EXTENSION_TOKEN = new RegExp(`^(?:[A-Za-z]:[\\\\/])?(?:\\\\ |${BARE_CHAR})+$`);
// Generous cap: macOS screenshot names ("Screen Shot <date> at <time> AM.png")
// carry five plain spaces.
const MAX_EXTENSION_TOKENS = 8;

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

// A bare path whose filename contains a plain (unescaped, unquoted) space splits
// at the space, so the regex match is only the tail token — "image.png" out of
// "/downloads/realistic image.png". Extend the match leftward one space-separated
// token at a time and return the longest candidate that names a real file, so the
// typed path attaches the file the user actually named. Existence-gated: prose
// around a path can never produce a phantom attachment. When the tail token
// itself names a real file it is an explicit reference; a longer on-disk
// candidate may override it only when the widened portion carries directory
// evidence (a path separator, as "docs/screen shot.png" does) — a plain prose
// word never swallows an explicitly typed existing filename ("look at
// screenshot.png" keeps screenshot.png even if "at screenshot.png" exists).
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
    // Exactly one plain space to the left; a double space or other whitespace
    // reads as prose, and "\ " escapes already belong to the base match.
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
    // A bare match containing "://" is a URL scheme remnant (e.g. the "p://" tail
    // of "http://…" caught by the drive-letter prefix), never a local file path.
    // Scope this to the bare branch only — a quoted value may legitimately be a
    // file:// URL, which the quoted branch below decodes.
    if (match[4] != null && raw.includes('://')) continue;
    let inner: string;
    if (match[1] != null || match[2] != null) {
      const quoted = (match[1] ?? match[2])!;
      // A quoted value can itself be a file:// URL ("file:///a/b%20c.png"); it
      // still needs percent-decoding, so route it through the same decoder.
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
      // file:// URL: decode percent-escapes (e.g. "%20") to the real filesystem
      // path. A malformed URL (bad %-escape) must be skipped, never thrown:
      // ordinary prose containing a broken file:// URL should not abort the turn.
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
      // Bare path: first widen the match across plain spaces to the longest
      // on-disk file, then unescape "\\ " sequences produced by terminal
      // drag-and-drop.
      raw = extendBareMatchAcrossSpaces(input, match.index, raw, cwd);
      inner = raw.replace(/\\ /g, ' ');
    }
    const resolvedPath = path.isAbsolute(inner) ? inner : path.resolve(cwd, inner);
    // A widened bare match covers input text to its left (raw is exactly
    // input.slice(start, …), since each hop consumed real input tokens). An
    // earlier detection inside that span — "foo.png" within "foo.png copy.png"
    // — is part of this one filename, not a separate image: drop it so it is
    // neither attached nor marker-replaced ahead of the full name. Match ends
    // ascend with the regex scan, so popping from the tail visits every
    // overlapping predecessor.
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

// An extension-less candidate must still LOOK like a path the user meant: a
// quoted string, or a bare token carrying a directory separator. Bare prose
// words are never probed — "check the readme" must not stat every noun.
const EXTENSIONLESS_CANDIDATE = new RegExp(
  `"([^"]*[\\\\/][^"]*)"` +
  `|'([^']*[\\\\/][^']*)'` +
  `|((?:[A-Za-z]:[\\\\/])?(?:\\\\ |${BARE_CHAR})*[\\\\/](?:\\\\ |${BARE_CHAR})+)`,
  'g',
);

/**
 * Read just the magic bytes. A path the user typed may be a 10MB image or a
 * multi-gigabyte video that happens to sit in the same folder — deciding from a
 * 12-byte header costs nothing either way.
 */
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
        // Nothing useful to do about a failed close on a read-only probe.
      }
    }
  }
}

/**
 * Find images the extension-based pass could not see. A user who drags a file
 * in, or types a screenshot path their tool saved without a suffix, gets an
 * attachment instead of silence — the failure mode that once sent the model
 * down a 12-round ffmpeg-and-OCR detour to read an image it was holding the
 * path to. Content sniffing, not naming, decides: a `.ts` file named in the
 * same sentence is not an image and never attaches.
 */
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
    // The extension pass already owns anything with a known image suffix.
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
  // Named-by-extension paths win; anything left over is probed by content, so a
  // suffix-less path the user typed still attaches.
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
  // Seed new markers after the highest existing index, not the existing count.
  // The TUI can submit a sparse attachment set (e.g. [Image #2] kept after
  // [Image #1] was deleted from the prompt), so counting would reuse an index
  // still present in the prompt and make the model inspect the wrong image.
  const maxExistingIndex = existing.reduce(
    (highest, a) => Math.max(highest, a.index ?? 0),
    0,
  );

  // Attachments already on the message spend from the same byte budget as the
  // ones we are about to add — five images are allowed, but not five of the
  // largest allowed size.
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
      // The user's own file can be moved or deleted mid-session, and on a
      // resume it may be gone entirely; the session copy is what keeps the
      // image analyzable for the rest of the conversation. It also assigns the
      // marker number, so [Image #N] and the stored file are the same N and a
      // marker means one image for the whole session.
      const cached = tryCacheAttachmentBytes({
        base64Data: loaded.base64Data,
        mimeType: loaded.mimeType,
      });
      // No store (no bound session, or the write failed): fall back to
      // numbering within this message, which is all the information left.
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
