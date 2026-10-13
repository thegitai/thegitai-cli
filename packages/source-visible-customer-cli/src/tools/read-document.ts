import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  isSensitiveProjectPath,
  normalizeProjectRelativePath,
} from '../artifact-policy.js';
import { repairFilePath, suggestClosestPath } from './path-suggest.js';
import { readCliAuthConfig } from '../api/auth.js';
import type { AuthorizedServerConfig } from '../api/http.js';
import type { ToolResponse } from './types.js';

export function normalizeDocumentText(raw: unknown): string {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  let output = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0) {
      output += ' ';
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += text.charAt(index) + text.charAt(index + 1);
        index += 1;
      } else {
        output += String.fromCharCode(0xfffd);
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += String.fromCharCode(0xfffd);
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) {
      output += ' ';
      continue;
    }
    output += text.charAt(index);
  }
  return output;
}

async function parseDocumentOnServer(
  config: AuthorizedServerConfig,
  fileName: string,
  fileData: Buffer,
  ext: string,
  args: {
    firstPage?: unknown;
    lastPage?: unknown;
    firstParagraph?: unknown;
    lastParagraph?: unknown;
  },
): Promise<ToolResponse> {
  const includePageArgs = ext === '.pdf';
  const includeParagraphArgs = ext === '.docx';
  const response = await globalThis.fetch(
    `${config.serverUrl.replace(/\/+$/, '')}/v1/document/parse`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileName,
        fileData: fileData.toString('base64'),
        ...(includePageArgs && args.firstPage !== undefined
          ? { firstPage: args.firstPage }
          : {}),
        ...(includePageArgs && args.lastPage !== undefined
          ? { lastPage: args.lastPage }
          : {}),
        ...(includeParagraphArgs && args.firstParagraph !== undefined
          ? { firstParagraph: args.firstParagraph }
          : {}),
        ...(includeParagraphArgs && args.lastParagraph !== undefined
          ? { lastParagraph: args.lastParagraph }
          : {}),
      }),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      error: `Server document parse failed: ${data?.error?.message ?? response.status}`,
    };
  }
  return data as ToolResponse;
}

export async function readDocument(
  rootDir: string,
  args: {
    filePath?: string;
    firstPage?: unknown;
    lastPage?: unknown;
    firstParagraph?: unknown;
    lastParagraph?: unknown;
  },
  env?: NodeJS.ProcessEnv,
): Promise<ToolResponse> {
  const raw = repairFilePath(rootDir, String(args.filePath ?? '').trim());
  if (!raw) {
    return { ok: false, error: 'filePath is required' };
  }

  const resolvedPath = path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
  const projectPath = normalizeProjectRelativePath(rootDir, resolvedPath);
  if (projectPath && isSensitiveProjectPath(projectPath)) {
    return {
      ok: false,
      error: 'This path is not permitted.',
    };
  }

  if (!existsSync(resolvedPath)) {
    const suggestion = suggestClosestPath(rootDir, resolvedPath);
    return {
      ok: false,
      error: suggestion
        ? `File not found: ${resolvedPath}. Did you mean "${suggestion}"? Note the exact punctuation (e.g. curly apostrophe ’ vs straight ').`
        : `File not found: ${resolvedPath}`,
      failureCategory: 'not_found',
    };
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== '.pdf' && ext !== '.xlsx' && ext !== '.docx') {
    return {
      ok: false,
      error: `Unsupported file type: "${ext}". read_document only supports .pdf, .xlsx, and .docx.`,
    };
  }

  const authConfig = readCliAuthConfig(env);
  if (!authConfig) {
    return {
      ok: false,
      error: 'Document parsing requires a server connection. Please log in first.',
    };
  }

  let fileData: Buffer;
  try {
    fileData = readFileSync(resolvedPath);
  } catch (err: any) {
    return { ok: false, error: `Failed to read file: ${err.message}` };
  }

  const result = await parseDocumentOnServer(
    authConfig,
    path.basename(resolvedPath),
    fileData,
    ext,
    args,
  );
  if (result.ok) {
    result.filePath = path.relative(rootDir, resolvedPath) || resolvedPath;
  }
  return result;
}
