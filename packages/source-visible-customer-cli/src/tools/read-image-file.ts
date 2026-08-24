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

/**
 * Reads an image file so the agent can analyze it.
 *
 * This is the client's half of a path-form `analyze_image` call. The image
 * lives on this machine, so this is where it is read; the returned bytes are
 * handed straight back and the analysis itself happens where the vision model
 * runs. Nothing here interprets the image — it is a bounded file read, the same
 * shape as reading a PDF for `read_document`.
 *
 * The copy in the session image store is what makes the image addressable by
 * index afterwards, so a follow-up question about the same picture does not
 * read the file again.
 */
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

  // No path, but an [Image #N] the current message does not carry: markers are
  // session-monotonic and match the stored filename, so this names an image
  // from an earlier message in the same session. The store is the only place
  // those bytes still live.
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
  // Exactly read_file's rule: a relative path must stay inside the project, an
  // absolute path is the user's own to name. run_command could read any of
  // these anyway, so this adds no reach.
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
    // Already this session's own copy: read it where it is instead of filing a
    // duplicate under a new number. The model is told to analyze images by
    // their "Session image path", so this is the ordinary case.
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
      // Consumed by the caller and replaced with the analysis before anything
      // reaches history: base64 in a tool result would otherwise be recorded
      // and replayed on every subsequent request in the turn.
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
