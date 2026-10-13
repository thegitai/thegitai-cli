import path from 'node:path';
import { normalizeProjectRelativePath } from '../artifact-policy.js';
import {
  SessionImageError,
  getImageStoreSession,
  isSessionStorePath,
  readSessionImage,
  readSessionImageByIndex,
  storeSessionImageFromPath,
} from '../core/session-image-store.js';
import type { ToolContext, ToolResponse } from './types.js';














export async function readImageFile(
  context: ToolContext,
  args: {
    path?: unknown;
    filePath?: unknown;
    file_path?: unknown;
    imageIndex?: unknown;
    image_index?: unknown;
    index?: unknown;
  },
): Promise<ToolResponse> {
  const rawPath = String(
    args.path ?? args.filePath ?? args.file_path ?? '',
  ).trim();





  if (!rawPath) {
    const requested = Number(args.imageIndex ?? args.image_index ?? args.index);
    const stored = Number.isInteger(requested)
      ? readSessionImageByIndex(requested)
      : null;
    if (!stored) {
      return {
        ok: false,
        error: Number.isInteger(requested)
          ? `Image #${requested} is not in this session's image store.`
          : 'path is required and must name an image file on this machine.',
        failureCategory: Number.isInteger(requested)
          ? 'not_found'
          : 'missing_required_argument',
      };
    }
    return {
      ok: true,
      imageBytes: {
        base64Data: stored.base64Data,
        mimeType: stored.mimeType,
        cachePath: stored.cachePath,
        index: stored.index,
      },
    };
  }



  let resolved: string;
  if (path.isAbsolute(rawPath)) {
    resolved = rawPath;
  } else if (normalizeProjectRelativePath(context.rootDir, rawPath)) {
    resolved = path.resolve(context.rootDir, rawPath);
  } else {
    return {
      ok: false,
      error: `Refusing to access path outside the project root: ${rawPath}`,
      failureCategory: 'permission_denied',
    };
  }
  try {



    const stored = isSessionStorePath(resolved)
      ? readSessionImage(resolved)
      : storeSessionImageFromPath({
          sessionId: getImageStoreSession() ?? 'unbound',
          sourcePath: resolved,
        });
    if (!stored) {
      return {
        ok: false,
        error: `Not a readable image: ${resolved}`,
        failureCategory: 'not_found',
      };
    }
    return {
      ok: true,



      imageBytes: {
        base64Data: stored.base64Data,
        mimeType: stored.mimeType,
        filePath: resolved,
        cachePath: stored.cachePath,
        index: stored.index,
      },
    };
  } catch (err: any) {
    if (err instanceof SessionImageError) {
      return {
        ok: false,
        error: err.message,
        failureCategory:
          err.code === 'NOT_FOUND' ? 'not_found' : 'invalid_argument',
      };
    }
    return {
      ok: false,
      error: `Could not read image: ${err?.message ?? err}`,
      failureCategory: 'tool_exception',
    };
  }
}
