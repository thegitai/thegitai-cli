import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { interpretSkillFile } from './discovery.js';
import { parseSkillFile } from './frontmatter.js';
import { SKILL_FILE_MAX_BYTES, SKILL_FILE_NAME } from './types.js';

export type SkillSource =
  | { kind: 'local'; path: string }
  | { kind: 'github'; owner: string; repo: string; ref: string | null; subpath: string };

export interface PreparedSkillFile {
  relPath: string;
  content: Buffer;
  executable: boolean;
}

export interface PreparedSkill {
  name: string;
  description: string;
  origin: string;
  files: PreparedSkillFile[];
}

export type PrepareResult =
  | { ok: true; skill: PreparedSkill }
  | { ok: false; error: string };

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 8;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function cleanSubpath(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/')
    .replace(/\/SKILL\.md$/i, '')
    .replace(/^SKILL\.md$/i, '');
}

export function parseSkillSource(raw: string, cwd: string): SkillSource | null {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (!value) return null;
  const url = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)((?:\/[^\s]*)?))?\/?$/i);
  if (url) {
    const [, owner, repo, ref, rest] = url;
    if (!GITHUB_SEGMENT.test(owner!) || !GITHUB_SEGMENT.test(repo!)) return null;
    return { kind: 'github', owner: owner!, repo: repo!, ref: ref ?? null, subpath: cleanSubpath(rest ?? '') };
  }
  const local = path.resolve(cwd, expandHome(value));
  if (/^(?:[./~]|[A-Za-z]:[\\/])/.test(value) || existsSync(local)) {
    return { kind: 'local', path: local };
  }
  const short = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^\s@]+)*)(?:@([^\s]+))?$/);
  if (short) {
    const [, owner, repo, rest, ref] = short;
    return { kind: 'github', owner: owner!, repo: repo!, ref: ref ?? null, subpath: cleanSubpath(rest ?? '') };
  }
  return null;
}

function validateSkillText(text: string, fallbackName: string):
  | { ok: true; name: string; description: string }
  | { ok: false; error: string } {
  const parsed = parseSkillFile(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const declared = typeof parsed.data.name === 'string' && parsed.data.name.trim() ? parsed.data.name.trim() : fallbackName;
  const interpreted = interpretSkillFile(text, declared);
  if (!interpreted.ok) return { ok: false, error: interpreted.message };
  return { ok: true, name: interpreted.skill.name, description: interpreted.skill.description };
}

function linkOutsideMessage(relPath: string): string {
  return `${relPath} links to a file outside the skill folder. Copy that file into the skill folder, then add the skill again.`;
}

function linkMissingMessage(relPath: string): string {
  return `${relPath} links to a file that does not exist.`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function prepareLocal(sourcePath: string): PrepareResult {
  let dir = sourcePath;
  try {
    if (statSync(dir).isFile()) {
      if (path.basename(dir) !== SKILL_FILE_NAME) {
        return { ok: false, error: `Point to a skill folder, or to its ${SKILL_FILE_NAME}.` };
      }
      dir = path.dirname(dir);
    }
  } catch {
    return { ok: false, error: `Nothing found at ${sourcePath}.` };
  }
  const skillFile = path.join(dir, SKILL_FILE_NAME);
  if (!existsSync(skillFile)) {
    const nested = findNestedSkillDirs(dir);
    if (nested.length) {
      return {
        ok: false,
        error: `${dir} holds several skills. Add one of them:\n${nested.slice(0, 20).map((item) => `  /skills add ${item}`).join('\n')}`,
      };
    }
    return { ok: false, error: `No ${SKILL_FILE_NAME} in ${dir}.` };
  }
  const files: PreparedSkillFile[] = [];
  let total = 0;
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (error) {
    return { ok: false, error: `Could not read ${dir}: ${(error as Error).message}` };
  }
  const walk = (current: string, depth: number): string | null => {
    if (depth > MAX_DEPTH) {
      return `${path.relative(dir, current)} is nested more than ${MAX_DEPTH} folders deep. Move its files higher up in the skill folder.`;
    }
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      let stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const relPath = path.relative(dir, full).split(path.sep).join('/');
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          return linkMissingMessage(relPath);
        }
        if (!isWithin(realDir, target)) return linkOutsideMessage(relPath);
        stat = statSync(full);
      }
      if (stat.isDirectory()) {
        const error = walk(full, depth + 1);
        if (error) return error;
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) return `${full} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
      total += stat.size;
      if (files.length >= MAX_FILES) return `The skill has more than ${MAX_FILES} files.`;
      if (total > MAX_TOTAL_BYTES) return `The skill is larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB.`;
      files.push({
        relPath: path.relative(dir, full).split(path.sep).join('/'),
        content: readFileSync(full),
        executable: (stat.mode & 0o111) !== 0,
      });
    }
    return null;
  };
  try {
    const error = walk(dir, 0);
    if (error) return { ok: false, error };
  } catch (error) {
    return { ok: false, error: `Could not read ${dir}: ${(error as Error).message}` };
  }
  const main = files.find((file) => file.relPath === SKILL_FILE_NAME);
  if (!main || main.content.length > SKILL_FILE_MAX_BYTES) {
    return { ok: false, error: `${SKILL_FILE_NAME} is missing or larger than ${SKILL_FILE_MAX_BYTES / 1024} KB.` };
  }
  const valid = validateSkillText(main.content.toString('utf8'), path.basename(dir));
  if (!valid.ok) return { ok: false, error: valid.error };
  return { ok: true, skill: { name: valid.name, description: valid.description, origin: dir, files } };
}

function findNestedSkillDirs(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 3 || found.length >= 50) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (existsSync(path.join(full, SKILL_FILE_NAME))) found.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return found.sort();
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'thegitai-cli',
  };
  const token = String(env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJson(fetchImpl: typeof fetch, url: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<any> {
  const response = await fetchImpl(url, { headers: githubHeaders(env), signal });
  if (response.status === 404) throw new Error('Repository or path not found on GitHub (private repositories need GITHUB_TOKEN).');
  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub refused the request (rate limit). Try again later, or set GITHUB_TOKEN.');
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  return response.json();
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

type GithubTreeEntry = { path: string; type: string; mode?: string; size?: number };

function treeEntries(tree: any): GithubTreeEntry[] {
  return Array.isArray(tree?.tree) ? tree.tree : [];
}

async function fetchGithubTree(
  source: Extract<SkillSource, { kind: 'github' }>,
  repoUrl: string,
  ref: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; entries: GithubTreeEntry[] } | { ok: false; error: string }> {
  const tree = await fetchJson(fetchImpl, `${repoUrl}/git/trees/${encodeURIComponent(ref)}?recursive=1`, env, signal);
  if (tree?.truncated !== true) return { ok: true, entries: treeEntries(tree) };
  const subpath = source.subpath;
  if (!subpath) {
    return {
      ok: false,
      error: `${source.owner}/${source.repo} is too large to search for skills. Name the skill folder: /skills add ${source.owner}/${source.repo}/path/to/skill`,
    };
  }
  const scoped = await fetchJson(fetchImpl, `${repoUrl}/git/trees/${encodeURIComponent(`${ref}:${subpath}`)}?recursive=1`, env, signal);
  if (scoped?.truncated === true) {
    return {
      ok: false,
      error: `${source.owner}/${source.repo}/${subpath} is too large to search for skills. Name the skill folder itself.`,
    };
  }
  return {
    ok: true,
    entries: treeEntries(scoped).map((entry) => ({ ...entry, path: `${subpath}/${entry.path}` })),
  };
}

async function prepareGithub(
  source: Extract<SkillSource, { kind: 'github' }>,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<PrepareResult> {
  const repoUrl = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const ref = source.ref ?? String((await fetchJson(fetchImpl, repoUrl, env, signal))?.default_branch ?? '');
  if (!ref) return { ok: false, error: 'Could not find the repository default branch.' };
  const tree = await fetchGithubTree(source, repoUrl, ref, env, fetchImpl, signal);
  if (!tree.ok) return tree;
  const blobs = tree.entries.filter((entry) => entry.type === 'blob' && typeof entry.path === 'string');
  const subpath = source.subpath;
  const within = (entryPath: string) => !subpath || entryPath === subpath || entryPath.startsWith(`${subpath}/`);
  const skillDirs = blobs
    .filter((entry) => path.posix.basename(entry.path) === SKILL_FILE_NAME && within(entry.path))
    .map((entry) => path.posix.dirname(entry.path))
    .map((dir) => (dir === '.' ? '' : dir))
    .sort();
  if (!skillDirs.length) {
    return { ok: false, error: `No ${SKILL_FILE_NAME} found in ${source.owner}/${source.repo}${subpath ? `/${subpath}` : ''}.` };
  }
  const chosen = skillDirs.includes(subpath) ? subpath : skillDirs.length === 1 ? skillDirs[0]! : null;
  if (chosen === null) {
    const listed = skillDirs.slice(0, 20).map((dir) => `  /skills add ${source.owner}/${source.repo}/${dir}${source.ref ? `@${source.ref}` : ''}`);
    const more = skillDirs.length > 20 ? `\n  ...and ${skillDirs.length - 20} more` : '';
    return { ok: false, error: `Found ${skillDirs.length} skills there. Add one of them:\n${listed.join('\n')}${more}` };
  }
  const prefix = chosen ? `${chosen}/` : '';
  const selected = blobs.filter((entry) => !prefix || entry.path.startsWith(prefix));
  const nestedDirs = skillDirs.filter((dir) => dir !== chosen && (!chosen || dir.startsWith(prefix)));
  const files = selected.filter((entry) => !nestedDirs.some((dir) => entry.path.startsWith(`${dir}/`)));
  const download = async (repoPath: string): Promise<Buffer | string> => {
    const rawUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodePath(ref)}/${encodePath(repoPath)}`;
    const { Accept: _accept, ...rawHeaders } = githubHeaders(env);
    const response = await fetchImpl(rawUrl, { headers: rawHeaders, signal });
    if (!response.ok) return `Could not download ${repoPath} (${response.status}).`;
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > MAX_FILE_BYTES) return `${repoPath} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
    return content;
  };
  const blobsByPath = new Map(blobs.map((blob) => [blob.path, blob]));
  const insideSkill = (repoPath: string) =>
    chosen ? repoPath === chosen || repoPath.startsWith(prefix) : repoPath !== '..' && !repoPath.startsWith('../');
  const plan: GithubTreeEntry[] = [];
  const relPaths: string[] = [];
  const addEntry = async (entry: GithubTreeEntry, relPath: string, chain: Set<string>): Promise<string | null> => {
    if (entry.mode !== '120000') {
      plan.push(entry);
      relPaths.push(relPath);
      return plan.length > MAX_FILES ? `The skill has more than ${MAX_FILES} files.` : null;
    }
    if (chain.has(entry.path)) return linkMissingMessage(relPath);
    const link = await download(entry.path);
    if (typeof link === 'string') return link;
    const linkTarget = link.toString('utf8').trim();
    if (path.posix.isAbsolute(linkTarget)) return linkOutsideMessage(relPath);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), linkTarget));
    if (!insideSkill(resolved)) return linkOutsideMessage(relPath);
    const nextChain = new Set(chain).add(entry.path);
    const exact = blobsByPath.get(resolved);
    if (exact) return addEntry(exact, relPath, nextChain);
    const under = blobs.filter((blob) => blob.path.startsWith(`${resolved}/`));
    if (!under.length) return linkMissingMessage(relPath);
    for (const blob of under) {
      const error = await addEntry(blob, `${relPath}${blob.path.slice(resolved.length)}`, nextChain);
      if (error) return error;
    }
    return null;
  };
  for (const entry of files) {
    const error = await addEntry(entry, prefix ? entry.path.slice(prefix.length) : entry.path, new Set());
    if (error) return { ok: false, error };
  }
  const declaredTotal = plan.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
  if (declaredTotal > MAX_TOTAL_BYTES) return { ok: false, error: `The skill is larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB.` };
  const prepared: PreparedSkillFile[] = [];
  for (const [index, entry] of plan.entries()) {
    const content = await download(entry.path);
    if (typeof content === 'string') return { ok: false, error: content };
    prepared.push({ relPath: relPaths[index]!, content, executable: entry.mode === '100755' });
  }
  const main = prepared.find((file) => file.relPath === SKILL_FILE_NAME);
  if (!main || main.content.length > SKILL_FILE_MAX_BYTES) {
    return { ok: false, error: `${SKILL_FILE_NAME} is missing or larger than ${SKILL_FILE_MAX_BYTES / 1024} KB.` };
  }
  const fallback = chosen ? path.posix.basename(chosen) : source.repo.toLowerCase();
  const valid = validateSkillText(main.content.toString('utf8'), fallback);
  if (!valid.ok) return { ok: false, error: valid.error };
  return {
    ok: true,
    skill: {
      name: valid.name,
      description: valid.description,
      origin: `github.com/${source.owner}/${source.repo}${chosen ? `/${chosen}` : ''}@${ref}`,
      files: prepared,
    },
  };
}

export async function prepareSkillInstall(
  source: SkillSource,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<PrepareResult> {
  if (source.kind === 'local') return prepareLocal(source.path);
  try {
    return await prepareGithub(source, env, fetchImpl, signal);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function preparedSkillHasScripts(skill: PreparedSkill): boolean {
  return skill.files.some(
    (file) => file.executable || file.relPath.startsWith('scripts/') || /\.(?:sh|bash|zsh|ps1|py|js|mjs|cjs|ts|rb|pl)$/i.test(file.relPath),
  );
}

function safeRelative(relPath: string): string | null {
  const normalized = path.posix.normalize(relPath);
  if (!normalized || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

export function installPreparedSkill(
  skill: PreparedSkill,
  targetRoot: string,
): { ok: true; dir: string } | { ok: false; error: string } {
  const dest = path.join(targetRoot, skill.name);
  if (existsSync(dest)) {
    return { ok: false, error: `A skill named "${skill.name}" already exists at ${dest}. Remove that folder first to replace it.` };
  }
  const staging = path.join(targetRoot, `.${skill.name}.installing-${randomUUID().slice(0, 8)}`);
  try {
    mkdirSync(staging, { recursive: true });
    for (const file of skill.files) {
      const relPath = safeRelative(file.relPath);
      if (!relPath) throw new Error(`Refusing to write ${file.relPath} outside the skill folder.`);
      const target = path.join(staging, ...relPath.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
      if (file.executable && process.platform !== 'win32') chmodSync(target, 0o755);
    }
    renameSync(staging, dest);
    return { ok: true, dir: dest };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: (error as Error).message };
  }
}
