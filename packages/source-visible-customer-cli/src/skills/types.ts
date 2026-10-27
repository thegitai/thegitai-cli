export type SkillScope = 'personal' | 'project' | 'bundled';

export interface SkillCatalogueEntry {
  name: string;
  description: string;
  scope: SkillScope;
  typedOnly?: boolean;
  argumentHint?: string;
}

export interface InvokedSkill {
  name: string;
  arguments: string;
  scope?: SkillScope;
  dir?: string;
  content?: string;
  contentTruncated?: boolean;
  files?: string[];
  filesTruncated?: boolean;
  personalSkillsDir?: string;
  projectSkillsDir?: string;
}

export const USE_SKILL_TOOL_NAME = 'use_skill';
export const SKILL_FILE_NAME = 'SKILL.md';
export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;
export const SKILL_ARGUMENT_HINT_MAX_CHARS = 120;
export const SKILL_MAX_ENTRIES = 100;
export const SKILL_FILE_MAX_BYTES = 256 * 1024;
export const SKILL_CONTENT_MAX_CHARS = 60_000;
export const SKILL_ARGUMENTS_MAX_CHARS = 8_000;
export const SKILL_DIR_MAX_CHARS = 1024;
export const SKILL_FILE_LIST_LIMIT = 100;

export const BUNDLED_SKILLS: SkillCatalogueEntry[] = [
  {
    name: 'skill-creator',
    description:
      'Create a new skill or improve an existing one: a folder with a SKILL.md that teaches TheGitAI a repeatable workflow. Use when the user asks to make, write, or edit a skill.',
    scope: 'bundled',
    argumentHint: '[what the skill should do]',
  },
];

export function isValidSkillName(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SKILL_NAME_MAX_CHARS &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export function cleanSkillText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function parseSkillInvocation(
  input: string,
): { name: string; arguments: string } | null {
  const match = String(input ?? '').trimStart().match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/);
  if (!match || !isValidSkillName(match[1])) return null;
  return {
    name: match[1]!,
    arguments: String(match[2] ?? '').trim().slice(0, SKILL_ARGUMENTS_MAX_CHARS),
  };
}
