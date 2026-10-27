import os from 'node:os';
import path from 'node:path';
import { discoverSkills, type DiscoveredSkill, type SkillDiscovery } from './skills/discovery.js';
import { BUNDLED_SKILLS } from './skills/types.js';

export const SKILLS_ADD_USAGE = '/skills add <owner/repo/path, GitHub URL, or folder> [--project]';

function displayPath(target: string, rootDir: string): string {
  const relative = path.relative(rootDir, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  const home = os.homedir();
  if (target === home) return '~';
  if (target.startsWith(`${home}${path.sep}`)) return `~/${target.slice(home.length + 1).split(path.sep).join('/')}`;
  return target;
}

export type SkillsPickerGroup = 'personal' | 'project' | 'bundled' | 'not-loaded';

export interface SkillsPickerItem {
  name: string;
  group: SkillsPickerGroup;
  description: string;
  path: string | null;
  notes: string[];
  usable: boolean;
}

export const SKILLS_PICKER_GROUP_TITLES: Record<SkillsPickerGroup, string> = {
  personal: 'Personal',
  project: 'Project',
  bundled: 'Built in',
  'not-loaded': 'Not loaded',
};

export const SKILLS_PICKER_ADD_HINT = '/skills add <source> installs one from GitHub or a folder';

export function buildSkillsPickerItems(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  builtinCommands: string[],
  discovery: SkillDiscovery = discoverSkills(rootDir, env),
): SkillsPickerItem[] {
  const builtins = new Set(builtinCommands);
  const local = (skill: DiscoveredSkill): SkillsPickerItem => {
    const clashes = builtins.has(`/${skill.name}`);
    const notes: string[] = [];
    if (skill.typedOnly) notes.push('runs only when you type it');
    if (clashes) notes.push(`/${skill.name} opens the built-in command; the agent can still use it`);
    return {
      name: skill.name,
      group: skill.scope,
      description: skill.description,
      path: displayPath(skill.dir, rootDir),
      notes,
      usable: !clashes,
    };
  };
  const localNames = new Set(discovery.skills.map((skill) => skill.name));
  return [
    ...discovery.skills.filter((skill) => skill.scope === 'personal').map(local),
    ...discovery.skills.filter((skill) => skill.scope === 'project').map(local),
    ...BUNDLED_SKILLS.filter((skill) => !localNames.has(skill.name)).map((skill) => ({
      name: skill.name,
      group: 'bundled' as const,
      description: skill.description,
      path: null,
      notes: [],
      usable: true,
    })),
    ...discovery.problems.map((problem) => ({
      name: path.basename(problem.dir),
      group: 'not-loaded' as const,
      description: problem.message,
      path: displayPath(problem.dir, rootDir),
      notes: [],
      usable: false,
    })),
    ...discovery.shadowed.map((skill) => ({
      name: skill.name,
      group: 'not-loaded' as const,
      description: 'Hidden by your personal skill with the same name.',
      path: displayPath(skill.dir, rootDir),
      notes: [],
      usable: false,
    })),
  ];
}
