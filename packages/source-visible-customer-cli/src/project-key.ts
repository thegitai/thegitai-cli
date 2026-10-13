import { createHash } from 'node:crypto';
import path from 'node:path';

export function getSessionProjectKey(rootDir: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const projectName =
    path.basename(resolvedRoot).replace(/[^a-zA-Z0-9._-]/g, '_') || 'project';
  const hash = createHash('sha256')
    .update(resolvedRoot)
    .digest('hex')
    .slice(0, 16);
  return `${projectName}-${hash}`;
}
