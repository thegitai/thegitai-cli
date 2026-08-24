import {
  isSensitiveProjectPath,
  normalizeProjectRelativePath,
  shouldIgnoreArtifactPath,
} from '../artifact-policy.js';
import { runShellDiagnostics } from './shell-diagnostics.js';
import { ToolContext, ToolResponse } from './types.js';

export async function getDiagnostics(
  context: ToolContext,
  args: {
    filePath?: string;
    limit?: number;
  },
): Promise<ToolResponse> {
  const filePath = String(args.filePath ?? '').trim() || undefined;
  const projectPath = filePath
    ? normalizeProjectRelativePath(context.rootDir, filePath)
    : undefined;
  if (projectPath && shouldIgnoreArtifactPath(projectPath)) {
    return {
      ok: false,
      error: 'This path is not permitted.',
    };
  }
  if (projectPath && isSensitiveProjectPath(projectPath)) {
    return {
      ok: false,
      error: 'This path is not permitted.',
    };
  }
  const limit = args.limit ?? 50;
  return runShellDiagnostics(context.rootDir, filePath, limit);
}
