import {
  bundledSkillNamed,
  discoverSkills,
  findSkill,
  loadSkillContent,
  skillFolders,
} from '../skills/discovery.js';
import { isValidSkillName } from '../skills/types.js';
import type { ToolContext, ToolResponse } from './types.js';

export function useSkill(context: ToolContext, args: Record<string, unknown>): ToolResponse {
  const name = String(args.name ?? '').trim().replace(/^\//, '');
  if (!name) {
    return { ok: false, error: 'name is required', failureCategory: 'missing_required_argument' };
  }
  if (!isValidSkillName(name)) {
    return { ok: false, error: `No skill named "${name.slice(0, 80)}" is installed.`, failureCategory: 'not_found' };
  }
  const discovery = discoverSkills(context.rootDir, context.env ?? process.env);
  const skill = findSkill(discovery, name);
  if (!skill) {
    if (bundledSkillNamed(name)) {
      return {
        ok: true,
        name,
        scope: 'bundled',
        ...skillFolders(context.rootDir, context.env ?? process.env),
      };
    }
    return { ok: false, error: `No skill named "${name}" is installed.`, failureCategory: 'not_found' };
  }
  const loaded = loadSkillContent(skill);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, failureCategory: 'invalid_argument' };
  }
  return {
    ok: true,
    name: skill.name,
    scope: skill.scope,
    dir: skill.dir,
    content: loaded.content,
    ...(loaded.truncated ? { contentTruncated: true } : {}),
    files: loaded.files,
    ...(loaded.filesTruncated ? { filesTruncated: true } : {}),
  };
}
