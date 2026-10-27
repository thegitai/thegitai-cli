import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFile } from './frontmatter.js';
import {
  BUNDLED_SKILLS,
  SKILL_ARGUMENT_HINT_MAX_CHARS,
  SKILL_CONTENT_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_FILE_LIST_LIMIT,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_NAME,
  SKILL_MAX_ENTRIES,
  cleanSkillText,
  isValidSkillName,
  parseSkillInvocation,
  type InvokedSkill,
  type SkillCatalogueEntry,
} from './types.js';

export type LocalSkillScope = 'personal' | 'project';

export interface DiscoveredSkill {
  name: string;
  description: string;
  scope: LocalSkillScope;
  dir: string;
  file: string;
  typedOnly: boolean;
  argumentHint?: string;
}

export interface SkillProblem {
  scope: LocalSkillScope;
  dir: string;
  message: string;
}

export interface SkillDiscovery {
  personalRoot: string;
  projectRoot: string | null;
  skills: DiscoveredSkill[];
  shadowed: DiscoveredSkill[];
  problems: SkillProblem[];
}

const MAX_SKILL_DIRS_PER_ROOT = 300;
const SKIPPED_LISTING_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);

const parsedCache = new Map<string, { mtimeMs: number; size: number; result: ParsedSkill }>();

type ParsedSkill =
  | { ok: true; skill: Omit<DiscoveredSkill, 'scope' | 'dir' | 'file'>; body: string }
  | { ok: false; message: string };

export function personalSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = String(env.THEGITAI_HOME ?? '').trim();
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.thegitai'), 'skills');
}

export function projectSkillsRoot(rootDir: string): string {
  return path.join(path.resolve(rootDir), '.thegitai', 'skills');
}

function safeRealpath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseSkill(file: string, folderName: string): ParsedSkill {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { ok: false, message: `No ${SKILL_FILE_NAME} in this folder.` };
  }
  if (!stat.isFile()) return { ok: false, message: `${SKILL_FILE_NAME} is not a file.` };
  if (stat.size > SKILL_FILE_MAX_BYTES) {
    return { ok: false, message: `${SKILL_FILE_NAME} is larger than ${SKILL_FILE_MAX_BYTES / 1024} KB.` };
  }
  const cached = parsedCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }
  let result: ParsedSkill;
  try {
    result = interpretSkillFile(readFileSync(file, 'utf8'), folderName);
  } catch (error) {
    result = { ok: false, message: `Could not read ${SKILL_FILE_NAME}: ${(error as Error).message}` };
  }
  parsedCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}

export function interpretSkillFile(text: string, folderName: string): ParsedSkill {
  const parsed = parseSkillFile(text);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  const rawName = parsed.data.name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : folderName;
  if (!isValidSkillName(name)) {
    return {
      ok: false,
      message: `Invalid name "${String(name).slice(0, 80)}": use 1-64 lowercase letters, digits and single hyphens.`,
    };
  }
  if (name !== folderName) {
    return { ok: false, message: `The name "${name}" must match its folder name "${folderName}".` };
  }
  const description = cleanSkillText(parsed.data.description, SKILL_DESCRIPTION_MAX_CHARS);
  if (!description) return { ok: false, message: 'Missing description in the frontmatter.' };
  const argumentHint = cleanSkillText(parsed.data['argument-hint'], SKILL_ARGUMENT_HINT_MAX_CHARS);
  return {
    ok: true,
    skill: {
      name,
      description,
      typedOnly: parsed.data['disable-model-invocation'] === true,
      ...(argumentHint ? { argumentHint } : {}),
    },
    body: parsed.body,
  };
}

function scanRoot(root: string, scope: LocalSkillScope, containment: string | null) {
  const skills: DiscoveredSkill[] = [];
  const problems: SkillProblem[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { skills, problems };
  }
  const folders = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_SKILL_DIRS_PER_ROOT);
  for (const folder of folders) {
    const dir = path.join(root, folder);
    let isDirectory = false;
    try {
      isDirectory = statSync(dir).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;
    const file = path.join(dir, SKILL_FILE_NAME);
    if (containment) {
      const realFile = safeRealpath(file);
      if (realFile && !isInside(containment, realFile)) {
        problems.push({ scope, dir, message: `${SKILL_FILE_NAME} links outside the project, so it was not loaded.` });
        continue;
      }
    }
    const parsed = parseSkill(file, folder);
    if (!parsed.ok) {
      problems.push({ scope, dir, message: parsed.message });
      continue;
    }
    skills.push({ ...parsed.skill, scope, dir, file });
  }
  return { skills, problems };
}

export function discoverSkills(rootDir: string, env: NodeJS.ProcessEnv = process.env): SkillDiscovery {
  const personalRoot = personalSkillsRoot(env);
  const projectRootCandidate = projectSkillsRoot(rootDir);
  const samePlace =
    path.resolve(projectRootCandidate) === path.resolve(personalRoot) ||
    (safeRealpath(projectRootCandidate) ?? '') === (safeRealpath(personalRoot) ?? ' ');
  const projectRoot = samePlace ? null : projectRootCandidate;
  const personal = scanRoot(personalRoot, 'personal', null);
  const projectContainment = safeRealpath(path.resolve(rootDir));
  const project = projectRoot
    ? scanRoot(projectRoot, 'project', projectContainment)
    : { skills: [], problems: [] };
  const skills: DiscoveredSkill[] = [];
  const shadowed: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const skill of [...personal.skills, ...project.skills]) {
    if (seen.has(skill.name)) {
      shadowed.push(skill);
      continue;
    }
    seen.add(skill.name);
    skills.push(skill);
  }
  const problems = [...personal.problems, ...project.problems];
  for (const extra of skills.splice(SKILL_MAX_ENTRIES)) {
    problems.push({ scope: extra.scope, dir: extra.dir, message: `Only the first ${SKILL_MAX_ENTRIES} skills are loaded.` });
  }
  return { personalRoot, projectRoot, skills, shadowed, problems };
}

export function skillCatalogue(discovery: SkillDiscovery): SkillCatalogueEntry[] {
  return discovery.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    ...(skill.typedOnly ? { typedOnly: true } : {}),
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
  }));
}

export function bundledSkillNamed(name: string): SkillCatalogueEntry | null {
  return BUNDLED_SKILLS.find((skill) => skill.name === name) ?? null;
}

export function findSkill(discovery: SkillDiscovery, name: string): DiscoveredSkill | null {
  return discovery.skills.find((skill) => skill.name === name) ?? null;
}

function listSkillFiles(dir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (current: string, depth: number) => {
    if (truncated) return;
    if (depth > 4) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_LISTING_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(dir, full).split(path.sep).join('/');
      if (relative === SKILL_FILE_NAME) continue;
      if (files.length >= SKILL_FILE_LIST_LIMIT) {
        truncated = true;
        return;
      }
      files.push(relative);
    }
  };
  walk(dir, 0);
  return { files, truncated };
}

export function loadSkillContent(skill: DiscoveredSkill):
  | { ok: true; content: string; truncated: boolean; files: string[]; filesTruncated: boolean }
  | { ok: false; error: string } {
  const parsed = parseSkill(skill.file, path.basename(skill.dir));
  if (!parsed.ok) return { ok: false, error: parsed.message };
  const truncated = parsed.body.length > SKILL_CONTENT_MAX_CHARS;
  const listing = listSkillFiles(skill.dir);
  return {
    ok: true,
    content: truncated ? parsed.body.slice(0, SKILL_CONTENT_MAX_CHARS) : parsed.body,
    truncated,
    files: listing.files,
    filesTruncated: listing.truncated,
  };
}

export function isSkillsRelativePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized.startsWith('.thegitai/skills/') && !normalized.split('/').includes('..');
}

export function isInsidePersonalSkills(absPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const root = path.resolve(personalSkillsRoot(env));
  const target = path.resolve(absPath);
  return target !== root && isInside(root, target);
}

export function collectSkillRequest(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  input: string,
): { skills: SkillCatalogueEntry[]; invokedSkill?: InvokedSkill } {
  let discovery: SkillDiscovery;
  try {
    discovery = discoverSkills(rootDir, env);
  } catch {
    return { skills: [] };
  }
  const skills = skillCatalogue(discovery);
  const invocation = parseSkillInvocation(input);
  let invokedSkill: InvokedSkill | undefined;
  if (invocation) {
    const local = findSkill(discovery, invocation.name);
    if (local) {
      const loaded = loadSkillContent(local);
      if (loaded.ok) {
        invokedSkill = {
          name: local.name,
          arguments: invocation.arguments,
          scope: local.scope,
          dir: local.dir,
          content: loaded.content,
          ...(loaded.truncated ? { contentTruncated: true } : {}),
          files: loaded.files,
          ...(loaded.filesTruncated ? { filesTruncated: true } : {}),
        };
      }
    } else if (bundledSkillNamed(invocation.name)) {
      invokedSkill = {
        name: invocation.name,
        arguments: invocation.arguments,
        scope: 'bundled',
        ...skillFolders(rootDir, env),
      };
    }
  }
  return { skills, ...(invokedSkill ? { invokedSkill } : {}) };
}

export function skillFolders(
  rootDir: string,
  env: NodeJS.ProcessEnv,
): { personalSkillsDir: string; projectSkillsDir: string } {
  return {
    personalSkillsDir: personalSkillsRoot(env),
    projectSkillsDir: projectSkillsRoot(rootDir),
  };
}
