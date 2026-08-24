import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_IMAGE_SIZE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES as SUPPORTED_MIME_TYPES,
  sniffImageMimeType,
} from './image-limits.js';
import type { ImageMimeType } from '../types.js';

export type ClipboardErrorCode =
  | 'NO_TOOL'
  | 'NO_IMAGE'
  | 'READ_FAILED'
  | 'WRITE_FAILED';

export class ClipboardError extends Error {
  constructor(
    message: string,
    public readonly code: ClipboardErrorCode,
  ) {
    super(message);
    this.name = 'ClipboardError';
  }
}

export interface ClipboardImageResult {
  base64Data: string;
  mimeType: ImageMimeType;
}

export function isSupportedImageMimeType(
  mime: string,
): mime is ImageMimeType {
  return SUPPORTED_MIME_TYPES.has(mime);
}

function whichSync(cmd: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [cmd], {
        stdio: 'ignore',
        timeout: 2000,
        windowsHide: true,
      });
      return true;
    }
    execFileSync('which', [cmd], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function isWayland(): boolean {
  return Boolean(
    process.env.WAYLAND_DISPLAY ||
      process.env.XDG_SESSION_TYPE === 'wayland',
  );
}

function isMaxBufferError(err: any): boolean {
  return (
    err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    /maxBuffer/.test(String(err?.message ?? ''))
  );
}

function tryReadWithXclip(): ClipboardImageResult | null {
  if (!whichSync('xclip')) return null;
  try {
    const buf = execFileSync(
      'xclip',
      ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      {
        timeout: 5000,
        maxBuffer: MAX_IMAGE_SIZE_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (buf.length) {
      return { base64Data: buf.toString('base64'), mimeType: 'image/png' };
    }
  } catch (err: any) {
    if (isMaxBufferError(err)) {
      throw new ClipboardError('Clipboard image exceeds 10MB size limit.', 'READ_FAILED');
    }
  }
  return null;
}

function tryReadWithWlPaste(): ClipboardImageResult | null {
  if (!whichSync('wl-paste')) return null;
  try {
    const buf = execFileSync('wl-paste', ['--type', 'image/png'], {
      timeout: 5000,
      maxBuffer: MAX_IMAGE_SIZE_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (buf.length) {
      return { base64Data: buf.toString('base64'), mimeType: 'image/png' };
    }
  } catch (err: any) {
    if (isMaxBufferError(err)) {
      throw new ClipboardError('Clipboard image exceeds 10MB size limit.', 'READ_FAILED');
    }
  }
  return null;
}

function readClipboardLinux(): ClipboardImageResult {
  if (isWayland()) {
    const wlResult = tryReadWithWlPaste();
    if (wlResult) return wlResult;
  }

  const xclipResult = tryReadWithXclip();
  if (xclipResult) return xclipResult;

  if (!isWayland() && !whichSync('xclip')) {
    throw new ClipboardError(
      'xclip is required for clipboard image paste on X11. Install xclip.',
      'NO_TOOL',
    );
  }
  if (isWayland() && !whichSync('wl-paste') && !whichSync('xclip')) {
    throw new ClipboardError(
      'wl-paste or xclip is required for clipboard image paste. Install wl-clipboard or xclip.',
      'NO_TOOL',
    );
  }
  throw new ClipboardError('Clipboard contains no image data.', 'NO_IMAGE');
}

const WINDOWS_CLIPBOARD_IMAGE_PS = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  '$ErrorActionPreference = "Stop";',
  'Add-Type -AssemblyName System.Drawing;',
  '$img = Get-Clipboard -Format Image;',
  'if ($null -eq $img) { exit 2 }',
  '$ms = New-Object System.IO.MemoryStream;',
  '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);',
  '[Convert]::ToBase64String($ms.ToArray())',
].join(' ');

function readClipboardWindows(): ClipboardImageResult {
  try {
    const b64 = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', WINDOWS_CLIPBOARD_IMAGE_PS],
      {
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: MAX_IMAGE_SIZE_BYTES * 2,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    ).trim();
    if (!b64) {
      throw new ClipboardError('Clipboard contains no image data.', 'NO_IMAGE');
    }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) {
      throw new ClipboardError('Clipboard contains no image data.', 'NO_IMAGE');
    }
    if (buf.length > MAX_IMAGE_SIZE_BYTES) {
      throw new ClipboardError('Clipboard image exceeds 10MB size limit.', 'READ_FAILED');
    }
    return { base64Data: b64, mimeType: 'image/png' };
  } catch (err: any) {
    if (err instanceof ClipboardError) throw err;
    if (err?.status === 2) {
      throw new ClipboardError(
        'Clipboard contains no image data. Copy an image first (Win+Shift+S), then press Alt+V.',
        'NO_IMAGE',
      );
    }
    if (isMaxBufferError(err)) {
      throw new ClipboardError('Clipboard image exceeds 10MB size limit.', 'READ_FAILED');
    }
    const detail = [err?.message, err?.stderr?.toString?.()?.trim()]
      .filter(Boolean)
      .join(' — ');
    throw new ClipboardError(
      `Failed to read clipboard image on Windows: ${detail || 'unknown error'}`,
      'READ_FAILED',
    );
  }
}

function readClipboardDarwin(): ClipboardImageResult {
  if (whichSync('pngpaste')) {
    try {
      const buf = execFileSync('pngpaste', ['-'], {
        timeout: 5000,
        maxBuffer: MAX_IMAGE_SIZE_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!buf.length) {
        throw new ClipboardError('Clipboard contains no image data.', 'NO_IMAGE');
      }
      return { base64Data: buf.toString('base64'), mimeType: 'image/png' };
    } catch (err: any) {
      if (err instanceof ClipboardError) throw err;
      if (isMaxBufferError(err)) {
        throw new ClipboardError('Clipboard image exceeds 10MB size limit.', 'READ_FAILED');
      }
      throw new ClipboardError('Clipboard contains no image data.', 'NO_IMAGE');
    }
  }

  throw new ClipboardError(
    'pngpaste is required for clipboard image paste on macOS. Install via: brew install pngpaste',
    'NO_TOOL',
  );
}

export function readClipboardImage(
  platform: NodeJS.Platform = process.platform,
): ClipboardImageResult {
  switch (platform) {
    case 'linux':
      return readClipboardLinux();
    case 'darwin':
      return readClipboardDarwin();
    case 'win32':
      return readClipboardWindows();
    default:
      throw new ClipboardError(
        `Clipboard image paste is not supported on ${platform}.`,
        'NO_TOOL',
      );
  }
}

export function readClipboardText(
  platform: NodeJS.Platform = process.platform,
): string {
  try {
    if (platform === 'darwin') {
      return normalizeClipboardTextOutput(
        execFileSync('pbpaste', [], {
          encoding: 'utf-8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    }
    if (platform === 'win32') {
      return normalizeClipboardTextOutput(
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
          {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ),
      );
    }
    if (platform === 'linux') {
      if (isWayland() && whichSync('wl-paste')) {
        return normalizeClipboardTextOutput(
          execFileSync('wl-paste', ['--type', 'text/plain'], {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }),
        );
      }
      if (whichSync('xclip')) {
        return normalizeClipboardTextOutput(
          execFileSync('xclip', ['-selection', 'clipboard', '-o'], {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }),
        );
      }
    }
  } catch {
    return '';
  }
  return '';
}

function normalizeClipboardTextOutput(text: string): string {
  return text.replace(/\r?\n$/, '');
}

function tryWriteClipboardCommand(
  cmd: string,
  args: string[],
  text: string,
): boolean {
  if (!whichSync(cmd)) return false;
  try {
    execFileSync(cmd, args, {
      input: text,
      timeout: 2000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return true;
  } catch (error: any) {
    throw new ClipboardError(
      `Failed to write clipboard with ${cmd}: ${error.message}`,
      'WRITE_FAILED',
    );
  }
}

export function writeClipboardText(
  text: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const value = String(text ?? '');
  if (platform === 'darwin') {
    if (tryWriteClipboardCommand('pbcopy', [], value)) return;
    throw new ClipboardError('pbcopy is required to copy text on macOS.', 'NO_TOOL');
  }
  if (platform === 'win32') {
    if (tryWriteClipboardCommand('clip.exe', [], value)) return;
    throw new ClipboardError('clip.exe is required to copy text on Windows.', 'NO_TOOL');
  }
  if (platform === 'linux') {
    if (isWayland() && tryWriteClipboardCommand('wl-copy', [], value)) return;
    if (tryWriteClipboardCommand('xclip', ['-selection', 'clipboard'], value)) return;
    if (tryWriteClipboardCommand('xsel', ['--clipboard', '--input'], value)) return;
    throw new ClipboardError(
      'wl-copy, xclip, or xsel is required to copy text. Install wl-clipboard, xclip, or xsel.',
      'NO_TOOL',
    );
  }
  throw new ClipboardError(
    `Clipboard text copy is not supported on ${platform}.`,
    'NO_TOOL',
  );
}

export function loadImageFromFile(filePath: string): ClipboardImageResult {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new ClipboardError(
      `Image file not found: ${resolved}`,
      'READ_FAILED',
    );
  }
  const stat = statSync(resolved);
  if (stat.size > MAX_IMAGE_SIZE_BYTES) {
    throw new ClipboardError(
      `Image file exceeds 10MB limit (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${resolved}`,
      'READ_FAILED',
    );
  }
  const buf = readFileSync(resolved);
  // The bytes decide, and only the bytes. A screenshot saved without a suffix,
  // or a .jpg that is really a PNG, is still a perfectly readable image —
  // treating the extension as the authority is what made extension-less paths
  // silently unattachable. Falling BACK to the extension when detection fails
  // would be just as wrong in the other direction: a text file named
  // `screenshot.png` would be uploaded to a vision model as image/png.
  const mimeType = sniffImageMimeType(buf);
  if (!mimeType) {
    const ext = path.extname(resolved).toLowerCase();
    throw new ClipboardError(
      ext
        ? `"${path.basename(resolved)}" is named ${ext} but its contents are not a supported image. Supported: PNG, JPEG, GIF, WebP.`
        : `Not a supported image file: ${resolved}. Supported: PNG, JPEG, GIF, WebP.`,
      'READ_FAILED',
    );
  }
  return { base64Data: buf.toString('base64'), mimeType };
}
