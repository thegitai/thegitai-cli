import { clampInteger } from '../utils.js';
import { listFilesystemDirectories } from './path-listing.js';
import { ToolContext, ToolResponse } from './types.js';

export async function listDirectories(
  context: ToolContext,
  args: {
    pattern?: string;
    limit?: number;
  },
): Promise<ToolResponse> {
  const pattern = String(args.pattern ?? '').trim();
  const limit = clampInteger(args.limit, 200, 500);
  const directories = listFilesystemDirectories(context.rootDir, {
    pattern,
    limit,
  });
  return {
    ok: true,
    pattern,
    directories,
    total: directories.length,
  };
}
