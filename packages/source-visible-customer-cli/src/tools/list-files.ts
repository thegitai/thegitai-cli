import { clampInteger } from '../utils.js';
import { listFilesystemFiles } from './path-listing.js';
import { ToolContext, ToolResponse } from './types.js';

export async function listFiles(
  context: ToolContext,
  args: {
    pattern?: string;
    limit?: number;
  },
): Promise<ToolResponse> {
  const pattern = String(args.pattern ?? '').trim();
  const limit = clampInteger(args.limit, 200, 500);
  const files = listFilesystemFiles(context.rootDir, { pattern, limit });
  return {
    ok: true,
    pattern,
    files,
    total: files.length,
  };
}
