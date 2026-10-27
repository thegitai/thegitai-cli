import { existsSync, readFileSync } from 'fs';
import path from 'path';
import {
  normalizeProjectRelativePath,
  shouldIgnoreArtifactPath,
} from '../artifact-policy.js';
import {
  buildSecretFilePreview,
  isDotenvLikePath,
  looksLikeEditableDotenv,
  shouldUseSecretFilePreview,
} from '../secret-preview.js';
import { readProjectFile } from '../patcher.js';
import { isWithinSessionScratchDir } from '../scratch-dir.js';
import { repairFilePath } from './path-suggest.js';
import {
  dotenvFitsRedactionBudget,
  getCurrentFileHash,
  recordReadCoverage,
  redactContentWithStableTokens,
  redactDotenvWithStableTokens,
} from '../session-safety.js';
import { readFileRange, truncate } from '../utils.js';
import { ToolContext, ToolResponse } from './types.js';
import { IMAGE_MIME_BY_EXT } from '../core/image-limits.js';
import { readImageFile } from './read-image-file.js';
import { isSkillsRelativePath } from '../skills/discovery.js';

const MAX_FILE_READ_CHARS = 12000;
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.xlsx', '.docx']);

export async function readFile(
  context: ToolContext | string,
  args: {
    filePath?: string;
    startLine?: number;
    endLine?: number;
  },
): Promise<ToolResponse> {
  const rootDir = typeof context === 'string' ? context : context.rootDir;
  const safety = typeof context === 'string' ? undefined : context.safety;
  const filePath = repairFilePath(rootDir, String(args.filePath ?? '').trim());
  if (!filePath) {
    return { ok: false, error: 'filePath is required' };
  }
  const projectPath = normalizeProjectRelativePath(rootDir, filePath);
  const scratchPath =
    path.isAbsolute(filePath) && isWithinSessionScratchDir(filePath);

  if (!projectPath && !path.isAbsolute(filePath)) {
    return {
      ok: false,
      error: `Refusing to access path outside the project root: ${filePath}`,
    };
  }

  if (projectPath && shouldIgnoreArtifactPath(projectPath) && !isSkillsRelativePath(projectPath)) {
    return {
      ok: false,
      error: 'This path is not permitted.',
    };
  }
  const documentExt = path.extname(projectPath ?? filePath).toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(documentExt)) {
    return {
      ok: false,
      error: `Use read_document for ${documentExt} files.`,
      failureCategory: 'invalid_argument',
    };
  }


  if (IMAGE_MIME_BY_EXT[documentExt] && typeof context !== 'string') {
    return readImageFile(context, { path: filePath });
  }
  let content: string;
  if (projectPath || scratchPath) {
    try {
      content = readProjectFile(rootDir, filePath);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const notFound = /^File does not exist:/.test(message);
      return {
        ok: false,
        error: message,
        ...(notFound ? { failureCategory: 'not_found' as const } : {}),
      };
    }
  } else {
    const absPath = path.resolve(filePath);
    if (!existsSync(absPath)) {
      return {
        ok: false,
        error: `File does not exist: ${filePath}`,
        failureCategory: 'not_found',
      };
    }
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  const previewPath = projectPath ?? filePath;




  const editableDotenv =
    Boolean(projectPath) &&
    Boolean(safety) &&
    isDotenvLikePath(previewPath) &&
    looksLikeEditableDotenv(content) &&
    dotenvFitsRedactionBudget(content);
  if (shouldUseSecretFilePreview(previewPath, content) && !editableDotenv) {
    return {
      ok: true,
      ...buildSecretFilePreview(previewPath, content),
    };
  }

  const range = readFileRange(
    content,
    args.startLine ? Number(args.startLine) : undefined,
    args.endLine ? Number(args.endLine) : undefined,
  );
  const hash = projectPath ? getCurrentFileHash(rootDir, filePath) : null;
  const redacted =
    projectPath && safety
      ? editableDotenv
        ? redactDotenvWithStableTokens(safety, range.content, projectPath, hash)
        : redactContentWithStableTokens(safety, range.content, projectPath, hash)
      : { content: range.content, tokens: [] };
  const contentTruncated = redacted.content.length > MAX_FILE_READ_CHARS;
  const deliveredEndLine = contentTruncated
    ? Math.min(
        range.endLine,
        range.startLine +
          redacted.content.slice(0, MAX_FILE_READ_CHARS).split('\n').length -
          1,
      )
    : range.endLine;
  const fullFile =
    range.startLine === 1 &&
    deliveredEndLine === range.totalLines &&
    !contentTruncated;
  if (projectPath && safety) {
    recordReadCoverage(safety, {
      filePath: projectPath,
      hash,
      fullFile,
      startLine: range.startLine,
      endLine: deliveredEndLine,
      totalLines: range.totalLines,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    ok: true,
    filePath: projectPath ?? filePath,
    totalLines: range.totalLines,
    startLine: range.startLine,
    endLine: deliveredEndLine,
    content: truncate(redacted.content, MAX_FILE_READ_CHARS),
    contentHash: hash,
    readCoverage: {
      fullFile,
      hash,
      cacheStatus: 'fresh',
      contentTruncated,
    },
    redactionTokens: redacted.tokens,
  };
}
