import type { ImageMimeType } from '../types.js';








export const MAX_IMAGES_PER_MESSAGE = 5;


export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;












export const MAX_TOTAL_IMAGE_BYTES_PER_MESSAGE = 20 * 1024 * 1024;


export function approximateBase64DecodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function totalAttachmentBytes(
  attachments: ReadonlyArray<{ base64Data: string }>,
): number {
  return attachments.reduce(
    (sum, attachment) => sum + approximateBase64DecodedBytes(attachment.base64Data),
    0,
  );
}

export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, ImageMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const IMAGE_EXT_BY_MIME: Readonly<Record<ImageMimeType, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function isSupportedImageMimeType(mime: string): mime is ImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mime);
}







export function sniffImageMimeType(bytes: Buffer): ImageMimeType | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') {
    return 'image/gif';
  }
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function imageExtensionForMime(mime: ImageMimeType): string {
  return IMAGE_EXT_BY_MIME[mime] ?? '.png';
}
