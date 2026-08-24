import chalk from './colors.js';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'fs';
import { createRequire } from 'node:module';
import os from 'os';
import path from 'path';
import type { IPty } from '@lydell/node-pty';
import {
  ARTIFACT_INSPECT_BLOCK_DIRS,
  getBlockedArtifactInspectDir,
  relativeProjectPath,
} from './artifact-policy.js';
import { emitCommandOutput, isTuiMode } from './runtime-mode.js';
import {
  ensureSessionScratchDir,
  isInsideTheGitAiScratch,
  sessionScratchDir,
} from './scratch-dir.js';

const requireFromHere = createRequire(import.meta.url);

type NodePty = typeof import('@lydell/node-pty');
let nodePtyCache: NodePty | null | undefined;

// @lydell/node-pty ships its native binding as platform-specific optional
// packages. If none is installed for this OS/arch the require throws; we cache
// the failure and fall back to the non-interactive child_process path. A pty is
// only needed to answer interactive sudo prompts.
function loadNodePty(): NodePty | null {
  if (nodePtyCache !== undefined) return nodePtyCache;
  try {
    nodePtyCache = requireFromHere('@lydell/node-pty') as NodePty;
  } catch {
    nodePtyCache = null;
  }
  return nodePtyCache;
}

const COMMON_TOOLCHAIN_BIN_DIRS = ['/usr/local/go/bin'];
export interface SudoPasswordRequest {
  command: string;
  prompt: string;
  signal?: AbortSignal;
}

export type SudoPasswordRequester = (
  request: SudoPasswordRequest,
) => Promise<string | null>;

function detectVenvBin(dir: string): string | null {
  for (const name of ['.venv', 'venv', 'env']) {
    const bin = path.join(dir, name, 'bin');
    if (existsSync(path.join(bin, 'python'))) return bin;
  }
  return null;
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 6000;
const MAX_CAPTURE_CHARS = 1024 * 1024;
const EXPLORATORY_COMMAND_PATTERN = /\b(ls|find|tree|fd|rg)\b/;
const FILE_INSPECTION_COMMAND_PATTERN =
  /\b(ls|find|tree|fd|rg|grep|cat|sed|head|tail|less|more)\b/;
const DETACHED_JOB_PATTERN = /\$!|\b(nohup|disown|setsid)\b/;
const LONG_RUNNING_SERVER_PATTERN =
  /\b((npm|pnpm|yarn)\s+run\s+(dev|start|preview)|next\s+dev|next\s+start|nuxi?\s+(dev|preview)|vite(\s+dev)?|webpack(-dev-server)?\s+serve)\b/;
const BLOCKED_PATH_INSPECT_DIRS = ARTIFACT_INSPECT_BLOCK_DIRS;

function getUnquotedShellText(command: string): string {
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  let text = '';
  for (const char of String(command)) {
    if (escaped) {
      escaped = false;
      text += ' ';
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      text += ' ';
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      text += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      text += ' ';
      continue;
    }
    text += char;
  }
  return text;
}

function hasUnquotedBackgroundAmpersand(command: string): boolean {
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  const text = String(command);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char !== '&') continue;
    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (previous === '&' || next === '&') continue;
    if (previous === '>' || previous === '<' || next === '>') continue;
    return true;
  }
  return false;
}

function hasBackgroundOrDetachedShell(command: string): boolean {
  return (
    DETACHED_JOB_PATTERN.test(getUnquotedShellText(command)) ||
    hasUnquotedBackgroundAmpersand(command)
  );
}

function getBadGhPrCommandReason(command: string): string | null {
  const text = getUnquotedShellText(command);
  if (
    /\bgh\s+pr\s+diff\s+\S+(?:\s+(?:\d?>&\d+|\d?>\S+|--[A-Za-z0-9-]+(?:=\S+)?))*\s*\|\s*(?:cat|head|tail|sed|awk)\b/i.test(
      text,
    )
  ) {
    return 'Do not page or slice whole PR diffs through shell. Use gh pr view <number> --json files,statusCheckRollup for PR metadata, then git diff <base>...HEAD -- <path> for one changed file at a time.';
  }
  if (/\bgh\s+pr\s+diff\s+\S+\s+--\s+\S+/i.test(text)) {
    return 'gh pr diff accepts only a PR number. For a file-scoped PR diff, use git diff <base>...HEAD -- <path>, or run gh pr diff <number> alone.';
  }
  if (/\bgh\s+pr\s+view\b(?=[^;&|]*--json\b)(?=[^;&|]*\bdiff\b)/i.test(text)) {
    return 'gh pr view --json does not expose a diff field. Use gh pr diff <number> for diff text, or gh pr view <number> --json files,statusCheckRollup for structured PR metadata.';
  }
  return null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskNonPathIgnoreDirTokens(command: string): string {
  let s = String(command);
  s = s.replace(
    /\b(npm|pnpm|yarn|npx)\s+run\s+[^\s;&|)]+/gi,
    '$1 run __pm_script__',
  );
  for (const dir of BLOCKED_PATH_INSPECT_DIRS) {
    if (!/^[a-z0-9@._-]+$/i.test(dir)) continue;
    s = s.replace(
      new RegExp(`\\byarn\\s+${escapeRegex(dir)}\\b`, 'gi'),
      'yarn __pm_script__',
    );
  }
  s = s.replace(
    /\b(nuxt|nuxi|next|vite|webpack|rollup)\s+build\b/gi,
    '$1 __cli_build__',
  );
  return s;
}

function maskHereDocumentBodies(command: string): string {
  const lines = String(command).split('\n');
  const masked: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    masked.push(line);
    const markers = Array.from(
      line.matchAll(/<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_]+))/g),
      (match) => match[1] ?? match[2] ?? match[3] ?? '',
    ).filter(Boolean);
    for (const marker of markers) {
      i += 1;
      while (i < lines.length) {
        const bodyLine = lines[i] ?? '';
        if (bodyLine.trim() === marker) {
          masked.push(bodyLine);
          break;
        }
        masked.push('');
        i += 1;
      }
    }
  }
  return masked.join('\n');
}

function splitShellishTokens(text: string): string[] {
  return text.match(/"[^"]*"|'[^']*'|`[^`]*`|\S+/g) ?? [];
}

function normalizeToken(raw: string): string {
  let token = String(raw).trim();
  if (!token) return '';
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('`') && token.endsWith('`')))
  ) {
    token = token.slice(1, -1);
  }
  token = token.replace(/^[([{]+/, '').replace(/[)\]},;]+$/, '');
  token = token.replace(/:(\d+)(?::\d+)?$/, '').replace(/:+$/, '');
  return token;
}

function hasPathGlob(token: string): boolean {
  return /[*?[\]{}]/.test(token);
}

function hasExplicitPathShape(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  if (token === '.' || token === '..') return true;
  if (
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('~/')
  ) {
    return true;
  }
  return token.includes('/') || token.includes('\\');
}

function getCommandBaseDir(command: string, rootDir?: string): string | null {
  if (!rootDir) return null;
  const match = String(command).match(
    /^\s*cd\s+((?:"[^"]*"|'[^']*'|`[^`]*`|\S+))\s*&&/,
  );
  if (!match) return rootDir;
  const token = normalizeToken(match[1] ?? '');
  if (!token || hasPathGlob(token) || token.startsWith('~')) return rootDir;
  return path.isAbsolute(token)
    ? path.resolve(token)
    : path.resolve(rootDir, token);
}

function getBlockedProjectPathDir(absPath: string, rootDir: string): string | null {
  const relPath = relativeProjectPath(rootDir, absPath);
  return relPath ? getBlockedArtifactInspectDir(relPath) : null;
}

function isInsideOsTemp(absPath: string): boolean {
  const relPath = path.relative(path.resolve(os.tmpdir()), path.resolve(absPath));
  return (
    relPath === '' ||
    (!relPath.startsWith('..') && !path.isAbsolute(relPath))
  );
}

function isExistingDirectory(absPath: string): boolean {
  try {
    return existsSync(absPath) && statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

// Distinguishes an OS-temp block from a repo generated-dir block so the
// user-facing reason can say the truth about each and point at the sanctioned
// scratch directory instead of a misleading "generated or dependency
// directory" label.
const OS_TEMP_BLOCK_MARKER = 'os-temp:';

function getBlockedOsTempInspection(
  rawToken: string,
  rootDir?: string,
): string | null {
  const token = normalizeToken(rawToken);
  if (!token || !path.isAbsolute(token)) return null;
  const resolved = path.resolve(token);
  if (!isInsideOsTemp(resolved)) return null;
  // The thegitai-* scratch subtrees are the agent's own sanctioned workspace:
  // creating, running, AND listing/inspecting inside them are all legitimate,
  // so they are exempt from the shared-OS-temp scan block below.
  if (isInsideTheGitAiScratch(resolved)) return null;
  if (rootDir) {
    const resolvedRoot = path.resolve(rootDir);
    if (
      resolved === resolvedRoot ||
      relativeProjectPath(resolvedRoot, resolved) !== null
    ) {
      return null;
    }
  }
  if (
    resolved === path.resolve(os.tmpdir()) ||
    hasPathGlob(token) ||
    isExistingDirectory(resolved)
  ) {
    return `${OS_TEMP_BLOCK_MARKER}${path.basename(os.tmpdir()) || os.tmpdir()}`;
  }
  return null;
}

function findBlockedDirForToken(
  rawToken: string,
  rootDir?: string,
  baseDir?: string | null,
  allowBareDirMatch = false,
): string | null {
  const token = normalizeToken(rawToken);
  if (!token || token.startsWith('~') || !rootDir) {
    return null;
  }
  const osTempDir = getBlockedOsTempInspection(rawToken, rootDir);
  if (osTempDir) return osTempDir;
  if (hasExplicitPathShape(token)) {
    const resolved = path.isAbsolute(token)
      ? path.resolve(token)
      : path.resolve(baseDir ?? rootDir, token);
    // 'cd <scratch> && ls ..' escapes the scratch subtree back into the shared
    // temp root, so the OS-temp rules must apply to the RESOLVED target of a
    // relative token, not only to literally-absolute tokens.
    const osTempResolved = getBlockedOsTempInspection(resolved, rootDir);
    if (osTempResolved) return osTempResolved;
    return getBlockedProjectPathDir(resolved, rootDir);
  }
  if (!allowBareDirMatch || !BLOCKED_PATH_INSPECT_DIRS.has(token)) {
    return null;
  }
  const resolved = path.resolve(baseDir ?? rootDir, token);
  return getBlockedProjectPathDir(resolved, rootDir);
}

function isShellControlToken(token: string): boolean {
  return (
    token === '|' ||
    token === '||' ||
    token === '&&' ||
    token === ';' ||
    token === '(' ||
    token === ')'
  );
}

function getOptionValueRole(
  commandName: string,
  option: string,
): 'pattern' | 'path' | null {
  switch (commandName) {
    case 'grep':
    case 'rg':
      if (option === '-e' || option === '--regexp') return 'pattern';
      if (
        option === '-f' ||
        option === '--file' ||
        option === '-g' ||
        option === '--glob'
      ) {
        return 'path';
      }
      return null;
    case 'sed':
      if (option === '-e') return 'pattern';
      if (option === '-f') return 'path';
      return null;
    case 'find':
      if (
        option === '-path' ||
        option === '-ipath' ||
        option === '-wholename' ||
        option === '-iwholename'
      ) {
        return 'path';
      }
      if (option === '-name' || option === '-iname') return 'pattern';
      return null;
    default:
      return null;
  }
}

function splitOptionToken(token: string): {
  optionName: string;
  inlineValue: string | null;
} {
  const eqIndex = token.indexOf('=');
  if (eqIndex === -1) {
    return { optionName: token, inlineValue: null };
  }
  return {
    optionName: token.slice(0, eqIndex),
    inlineValue: token.slice(eqIndex + 1),
  };
}

function shouldAllowBareBlockedDir(
  commandName: string,
  positionalCount: number,
): boolean {
  switch (commandName) {
    case 'ls':
    case 'tree':
    case 'cat':
    case 'head':
    case 'tail':
    case 'less':
    case 'more':
    case 'find':
      return positionalCount >= 1;
    case 'grep':
    case 'rg':
    case 'fd':
    case 'sed':
      return positionalCount >= 2;
    default:
      return false;
  }
}

function findBlockedDirInCommandTokens(
  command: string,
  rootDir?: string,
  baseDir?: string | null,
): string | null {
  if (!rootDir) return null;
  const tokens = splitShellishTokens(command);
  let currentCommand = '';
  let positionalCount = 0;
  let stopOptions = false;
  let optionValueRole: 'pattern' | 'path' | null = null;

  for (const rawToken of tokens) {
    const token = normalizeToken(rawToken);
    if (!token) continue;
    if (isShellControlToken(token)) {
      currentCommand = '';
      positionalCount = 0;
      stopOptions = false;
      optionValueRole = null;
      continue;
    }
    if (!currentCommand) {
      currentCommand = token.toLowerCase();
      positionalCount = 0;
      stopOptions = false;
      optionValueRole = null;
      continue;
    }
    if (optionValueRole) {
      const blockedDir = findBlockedDirForToken(
        token,
        rootDir,
        baseDir,
        optionValueRole === 'path',
      );
      if (blockedDir) return blockedDir;
      optionValueRole = null;
      continue;
    }
    if (!stopOptions && token === '--') {
      stopOptions = true;
      continue;
    }
    if (!stopOptions && token.startsWith('-') && token !== '-') {
      const { optionName, inlineValue } = splitOptionToken(token);
      const optionRole = getOptionValueRole(currentCommand, optionName);
      if (inlineValue != null) {
        const blockedDir = findBlockedDirForToken(
          inlineValue,
          rootDir,
          baseDir,
          optionRole === 'path',
        );
        if (blockedDir) return blockedDir;
        optionValueRole = null;
        continue;
      }
      optionValueRole = optionRole;
      continue;
    }
    positionalCount += 1;
    const blockedDir = findBlockedDirForToken(
      token,
      rootDir,
      baseDir,
      shouldAllowBareBlockedDir(currentCommand, positionalCount),
    );
    if (blockedDir) return blockedDir;
  }
  return null;
}

// The model is handed $THEGITAI_SCRATCH_DIR (and shells define $TMPDIR), so a
// command can reach the OS temp tree through a variable the literal token scan
// cannot see ('cd "$THEGITAI_SCRATCH_DIR" && ls ..'). Expand the known
// temp-pointing variables to their values before analysis so the same rules
// apply either way.
function expandTempEnvRefs(command: string): string {
  // Covers the bare form ($VAR) and every ${VAR...} parameter-expansion form
  // (${VAR}, ${VAR:-default}, ${VAR%suffix}, ...): whatever the shell would
  // produce is either the variable's value or a fallback the operator names,
  // and analyzing the value is the conservative choice for temp-pointing vars.
  return command
    .replace(
      /\$\{THEGITAI_SCRATCH_DIR[^}]*\}|\$THEGITAI_SCRATCH_DIR\b/g,
      sessionScratchDir(),
    )
    .replace(
      /\$\{TMPDIR[^}]*\}|\$TMPDIR\b/g,
      process.env.TMPDIR || os.tmpdir(),
    );
}

function findIgnoredPathInspection(command: string, rootDir?: string): string | null {
  if (!FILE_INSPECTION_COMMAND_PATTERN.test(command)) {
    return null;
  }
  const haystack = maskNonPathIgnoreDirTokens(
    maskHereDocumentBodies(expandTempEnvRefs(command)),
  );
  const baseDir = getCommandBaseDir(haystack, rootDir);
  const blockedDir = findBlockedDirInCommandTokens(haystack, rootDir, baseDir);
  if (blockedDir) {
    return blockedDir;
  }
  if (!rootDir) {
    for (const dir of BLOCKED_PATH_INSPECT_DIRS) {
      const pattern = new RegExp(
        `(^|[\\s"'./])${escapeRegex(dir)}(?=$|[\\s"'./])`,
      );
      if (pattern.test(haystack)) {
        return dir;
      }
    }
  }
  return null;
}

function trimOutput(text: string): string {
  if (!text) return '';
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated)`;
}

function buildCommandPath(
  basePath: string | undefined,
  extraDirs: string[] = [],
): string {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [...extraDirs, ...COMMON_TOOLCHAIN_BIN_DIRS]) {
    if (!dir || seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  for (const dir of String(basePath ?? '').split(path.delimiter)) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs.join(path.delimiter);
}

function isExploratoryCommand(command: string): boolean {
  return EXPLORATORY_COMMAND_PATTERN.test(command);
}

function shouldDropOutputLine(
  line: string,
  rootDir: string,
  baseDir: string | null,
): boolean {
  const tokens = splitShellishTokens(line);
  if (tokens.length === 1) {
    return findBlockedDirForToken(tokens[0], rootDir, baseDir, true) != null;
  }
  for (const token of splitShellishTokens(line)) {
    if (findBlockedDirForToken(token, rootDir, baseDir)) return true;
  }
  return false;
}

function isLsDirectoryHeader(line: string): boolean {
  return /^\.?\/?.+:$/.test(line) && !line.includes(' ');
}

export function sanitizeCommandText(command: string, text: string, rootDir: string): string {
  if (!text) return '';
  const lines = text.split('\n');
  const filtered: string[] = [];
  let insideIgnoredDir = false;
  const baseDir = getCommandBaseDir(command, rootDir);
  for (const line of lines) {
    const trimmed = line.trim();
    if (isLsDirectoryHeader(trimmed)) {
      const dirPath = trimmed.replace(/^\.\//, '').replace(/:$/, '');
      if (shouldDropOutputLine(dirPath, rootDir, baseDir)) {
        insideIgnoredDir = true;
        continue;
      }
      insideIgnoredDir = false;
    }
    if (insideIgnoredDir) continue;
    if (shouldDropOutputLine(trimmed, rootDir, baseDir)) continue;
    filtered.push(line);
  }
  return filtered.join('\n');
}

function appendCapturedText(current: string, chunk: string): string {
  if (!chunk || current.length >= MAX_CAPTURE_CHARS) {
    return current;
  }
  const remaining = MAX_CAPTURE_CHARS - current.length;
  return current + chunk.slice(0, remaining);
}

let activeCommandChild: ChildProcess | null = null;
let activeCommandPty: IPty | null = null;
let activeCommandFinish: ((result: CommandResult) => void) | null = null;

function killPty(child: IPty, signal: 'SIGKILL' | 'SIGTERM'): void {
  try {
    if (process.platform === 'win32') {
      child.kill();
      return;
    }
    child.kill(signal);
  } catch {}
}

export function cancelActiveCommand(): void {
  const child = activeCommandChild;
  const commandPty = activeCommandPty;
  const finish = activeCommandFinish;
  if ((!child && !commandPty) || !finish) return;
  let killEscalated = false;
  const killTimer = setTimeout(() => {
    if (!killEscalated) {
      killEscalated = true;
      if (child) terminateChild(child, 'SIGKILL');
      if (commandPty) killPty(commandPty, 'SIGKILL');
    }
  }, 500);
  killTimer.unref?.();
  if (child) terminateChild(child, 'SIGTERM');
  if (commandPty) killPty(commandPty, 'SIGTERM');
  finish({
    exitCode: 1,
    stdout: '',
    stderr: 'Command cancelled.',
    output: 'Command cancelled.',
    timedOut: false,
    cancelled: true,
  });
}

export function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
      });
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export function getBlockedPathInspectDir(
  command: string,
  rootDir?: string,
): string | null {
  const blocked = findIgnoredPathInspection(command, rootDir);
  return blocked?.startsWith(OS_TEMP_BLOCK_MARKER)
    ? blocked.slice(OS_TEMP_BLOCK_MARKER.length)
    : blocked;
}

export function getBlockedCommandReason(
  command: string,
  hasTimeout?: boolean,
  rootDir?: string,
): string | null {
  const ignoredDir = findIgnoredPathInspection(command, rootDir);
  if (ignoredDir?.startsWith(OS_TEMP_BLOCK_MARKER)) {
    const tempName = ignoredDir.slice(OS_TEMP_BLOCK_MARKER.length);
    // Honest reason + a working alternative: the shared OS temp root can hold
    // other users' and processes' files (which must not be pulled into model
    // context), but the agent's own scratch subtree is fully usable.
    return `Listing or scanning the shared OS temp directory (${tempName}) is blocked because it can contain other users' and processes' files. Use the session scratch directory ${ensureSessionScratchDir()} for temporary scripts and files — creating, running, and listing are all allowed there — or reference an exact file path.`;
  }
  if (ignoredDir) {
    return `Command inspects an off-limits generated or dependency directory (${ignoredDir}). Avoid that path.`;
  }
  const badGhPrCommand = getBadGhPrCommandReason(command);
  if (badGhPrCommand) return badGhPrCommand;
  if (hasBackgroundOrDetachedShell(command)) {
    return 'Command contains an unquoted shell background operator (&). Quote URLs or arguments containing & and run one foreground command.';
  }
  if (!hasTimeout && LONG_RUNNING_SERVER_PATTERN.test(command)) {
    return 'Dev/start/preview server commands require timeout_ms. Use a short timeout to capture startup output.';
  }
  if (
    /\bgit\s+(checkout|restore)\b/.test(command) &&
    !/\bgit\s+checkout\s+-b\b/.test(command)
  ) {
    return 'Refusing git checkout or git restore because it can discard local edits. Create a branch with git checkout -b or ask before reverting.';
  }
  return null;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  cancelled?: boolean;
  blocked?: boolean;
}

export function commandUsesSudo(command: string): boolean {
  return /\bsudo\b/.test(getUnquotedShellText(command));
}

export function sudoPromptFromTail(text: string): string | null {
  const tail = text.slice(-1000).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  // The `\[?` matters. PAM-style sudo asks with `[sudo: authenticate] Password:`,
  // which the literal `[sudo]` branch cannot match, so the next branch used to
  // start matching at `sudo` and swallow the opening bracket — surfacing the
  // prompt as `sudo: authenticate] Password:`. It is captured whole now.
  const match = tail.match(
    /(?:\[sudo\][^\r\n]*password[^\r\n]*: ?|\[?sudo[^\r\n]*password[^\r\n]*: ?|password[^\r\n]*: ?)$/i,
  );
  return match?.[0] ?? null;
}

function isSudoPromptLine(text: string): boolean {
  const cleaned = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
  return /(?:\[sudo\][^\r\n]*password[^\r\n]*:|sudo[^\r\n]*password[^\r\n]*:|^password[^\r\n]*:)/i.test(cleaned);
}

export function stripSudoPromptText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isSudoPromptLine(line))
    .join('\n');
}

function redactSecrets(text: string, secrets: Iterable<string>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[sudo password redacted]');
  }
  return redacted;
}

export function buildCommandEnv(cwd: string): NodeJS.ProcessEnv {
  const venvBin = detectVenvBin(cwd);
  const envPath = buildCommandPath(
    process.env.PATH,
    venvBin ? [venvBin] : [],
  );
  return {
    ...process.env,
    PATH: envPath,
    VIRTUAL_ENV: venvBin
      ? path.dirname(venvBin)
      : process.env.VIRTUAL_ENV || '',
    CI: 'true',
    npm_config_yes: 'true',
    npm_config_progress: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    NUXI_INIT_SKIP_PROMPT: 'true',
    // Sanctioned per-session scratch dir for throwaway scripts and files;
    // inspection inside it is exempt from the shared-OS-temp scan block.
    THEGITAI_SCRATCH_DIR: ensureSessionScratchDir(),
  };
}

let cachedCommandShell: string | true | undefined;

function findBashPath(): string | null {
  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'bash'));
  for (const candidate of [...fromPath, '/bin/bash', '/usr/bin/bash']) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// Node's `shell: true` runs the command through `/bin/sh`, which is `dash` on
// Debian/Ubuntu. Models write bash — `source`, `[[ ]]`, process substitution,
// arrays — and dash rejects all of it with a bare `not found` or `Syntax error`
// that reads like the user's machine is broken, so the model burns turns on
// workarounds instead. Run through a real bash when one exists; fall back to the
// platform default (cmd.exe on Windows, /bin/sh elsewhere) only when it doesn't.
export function resolveCommandShell(): string | true {
  if (cachedCommandShell !== undefined) return cachedCommandShell;
  cachedCommandShell =
    process.platform === 'win32' ? true : (findBashPath() ?? true);
  return cachedCommandShell;
}

function sanitizePtyOutput(
  command: string,
  output: string,
  cwd: string,
  secrets: Iterable<string>,
): string {
  return sanitizeCommandText(
    command,
    stripSudoPromptText(redactSecrets(output, secrets)),
    cwd,
  );
}

async function runPtyCommand(
  command: string,
  cwd: string,
  effectiveTimeout: number,
  exploratory: boolean,
  requestSudoPassword: SudoPasswordRequester,
  nodePty: NodePty,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    let requestingPassword = false;
    let pendingLiveText = '';
    let killTimer: NodeJS.Timeout | null = null;
    const sudoPromptAbort = new AbortController();
    const sudoSecrets = new Set<string>();
    const shell = process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : (process.env.SHELL || '/bin/sh');
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-lc', command];
    const child = nodePty.spawn(shell, args, {
      cols: 120,
      rows: 30,
      cwd,
      env: buildCommandEnv(cwd),
      name: 'xterm-256color',
    });
    activeCommandPty = child;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killPty(child, 'SIGTERM');
      killTimer = setTimeout(() => killPty(child, 'SIGKILL'), 2000);
      killTimer.unref?.();
    }, effectiveTimeout);
    timeoutTimer.unref?.();

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      sudoPromptAbort.abort();
      if (activeCommandPty === child) {
        activeCommandPty = null;
        activeCommandFinish = null;
      }
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    activeCommandFinish = finish;

    const flushLiveText = () => {
      if (!pendingLiveText.trim() || isSudoPromptLine(pendingLiveText)) {
        pendingLiveText = '';
        return;
      }
      emitCommandOutput(`${pendingLiveText}\n`);
      pendingLiveText = '';
    };
    const tuiMode = isTuiMode();
    const writeLiveText = (text: string) => {
      if (exploratory) return;
      const visibleText = stripSudoPromptText(redactSecrets(text, sudoSecrets));
      if (tuiMode) {
        pendingLiveText += visibleText.replace(/\r\n?/g, '\n');
        const liveLines = pendingLiveText.split('\n');
        pendingLiveText = liveLines.pop() ?? '';
        const complete = liveLines
          .filter((line) => line.trim() && !isSudoPromptLine(line))
          .join('\n');
        if (complete) emitCommandOutput(`${complete}\n`);
        return;
      }
      if (visibleText) {
        process.stdout.write(visibleText);
      }
    };

    child.onData((text) => {
      output = appendCapturedText(output, text);
      writeLiveText(text);
      const prompt = sudoPromptFromTail(output);
      if (!prompt || requestingPassword || settled) return;
      requestingPassword = true;
      void requestSudoPassword({
        command,
        prompt,
        signal: sudoPromptAbort.signal,
      })
        .then((password) => {
          requestingPassword = false;
          if (settled) return;
          if (password == null) {
            killPty(child, 'SIGTERM');
            finish({
              exitCode: 1,
              stdout: '',
              stderr: 'Sudo authentication cancelled.',
              output: 'Sudo authentication cancelled.',
              timedOut: false,
              cancelled: true,
            });
            return;
          }
          sudoSecrets.add(password);
          child.write(`${password}\r`);
        })
        .catch(() => {
          requestingPassword = false;
          if (settled) return;
          killPty(child, 'SIGTERM');
          finish({
            exitCode: 1,
            stdout: '',
            stderr: 'Sudo authentication failed.',
            output: 'Sudo authentication failed.',
            timedOut: false,
          });
        });
    });

    child.onExit(({ exitCode }) => {
      flushLiveText();
      const outputText = sanitizePtyOutput(command, output, cwd, sudoSecrets);
      if (exploratory && !tuiMode && outputText.trim()) {
        process.stdout.write(outputText);
        if (!outputText.endsWith('\n')) process.stdout.write('\n');
      }
      if (timedOut) {
        finish({
          exitCode: exitCode || 1,
          stdout: outputText,
          stderr: '',
          output: trimOutput(outputText.trim()),
          timedOut: true,
        });
        return;
      }
      finish({
        exitCode,
        stdout: outputText,
        stderr: '',
        output: trimOutput(outputText.trim()),
        timedOut: false,
      });
    });
  });
}

export async function runCommand(
  command: string,
  cwd: string,
  {
    requestSudoPassword,
    timeout,
  }: {
    requestSudoPassword?: SudoPasswordRequester | null;
    timeout?: number;
  } = {},
): Promise<CommandResult> {
  if (!isTuiMode()) {
    console.log(chalk.cyan(`\n  ▶ Running: ${command}`));
    console.log(chalk.dim(`    in: ${cwd}\n`));
  }
  const hasExplicitTimeout = typeof timeout === 'number' && timeout > 0;
  const effectiveTimeout = hasExplicitTimeout ? timeout : DEFAULT_TIMEOUT;
  const blockedReason = getBlockedCommandReason(
    command,
    hasExplicitTimeout,
    cwd,
  );
  if (blockedReason) {
    if (!isTuiMode()) console.log(chalk.red(`  ✖ ${blockedReason}`));
    return {
      exitCode: 1,
      stdout: '',
      stderr: blockedReason,
      output: blockedReason,
      timedOut: false,
      blocked: true,
    };
  }
  const exploratory = isExploratoryCommand(command);
  if (requestSudoPassword && commandUsesSudo(command)) {
    const nodePty = loadNodePty();
    if (nodePty) {
      return runPtyCommand(
        command,
        cwd,
        effectiveTimeout,
        exploratory,
        requestSudoPassword,
        nodePty,
      );
    }
    // No pty binding installed for this platform — fall through to the
    // non-interactive spawn path. The command still runs; an interactive sudo
    // prompt simply can't be answered here.
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn(command, {
      cwd,
      shell: resolveCommandShell(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCommandEnv(cwd),
    });
    activeCommandChild = child;

    child.stdin?.end();

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 2000);
      killTimer.unref?.();
    }, effectiveTimeout);
    timeoutTimer.unref?.();

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (activeCommandChild === child) {
        activeCommandChild = null;
        activeCommandFinish = null;
      }
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };
    activeCommandFinish = finish;

    const tuiMode = isTuiMode();
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout = appendCapturedText(stdout, text);
      if (exploratory || tuiMode) {
        if (tuiMode && !exploratory) emitCommandOutput(text);
        return;
      }
      const ok = process.stdout.write(text);
      if (!ok) {
        child.stdout?.pause();
        process.stdout.once('drain', () => child.stdout?.resume());
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr = appendCapturedText(stderr, text);
      if (exploratory || tuiMode) {
        if (tuiMode && !exploratory) emitCommandOutput(text);
        return;
      }
      const ok = process.stderr.write(text);
      if (!ok) {
        child.stderr?.pause();
        process.stderr.once('drain', () => child.stderr?.resume());
      }
    });
    child.on('error', (error: Error) => {
      const stdoutText = sanitizeCommandText(command, stdout, cwd);
      const stderrText = sanitizeCommandText(
        command,
        appendCapturedText(stderr, error.message ? `${error.message}\n` : ''),
        cwd,
      );
      const output = trimOutput(
        [stdoutText, stderrText].filter(Boolean).join('\n').trim(),
      );
      if (exploratory && !tuiMode) {
        if (stdoutText.trim()) {
          process.stdout.write(stdoutText);
          if (!stdoutText.endsWith('\n')) process.stdout.write('\n');
        }
        if (stderrText.trim()) {
          process.stderr.write(stderrText);
          if (!stderrText.endsWith('\n')) process.stderr.write('\n');
        }
      }

      if (!tuiMode) console.log(chalk.red('\n  ✖ Command exited with code 1'));
      finish({
        exitCode: 1,
        stdout: stdoutText,
        stderr: stderrText,
        output,
        timedOut,
      });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const stdoutText = sanitizeCommandText(command, stdout, cwd);
      const stderrText = sanitizeCommandText(command, stderr, cwd);

      if (exploratory && !tuiMode) {
        if (stdoutText.trim()) {
          process.stdout.write(stdoutText);
          if (!stdoutText.endsWith('\n')) process.stdout.write('\n');
        }
        if (stderrText.trim()) {
          process.stderr.write(stderrText);
          if (!stderrText.endsWith('\n')) process.stderr.write('\n');
        }
      }
      if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
        if (!tuiMode && !settled) {
          console.log(
            chalk.red(`\n  ✖ Command timed out after ${effectiveTimeout / 1000}s`),
          );
        }
        finish({
          exitCode: code ?? 1,
          stdout: stdoutText,
          stderr: stderrText,
          output: trimOutput(
            [stdoutText, stderrText].filter(Boolean).join('\n').trim(),
          ),
          timedOut: true,
        });
        return;
      }
      if (code === 0) {
        if (!tuiMode) console.log(chalk.green('\n  ✓ Command exited with code 0'));
        finish({
          exitCode: 0,
          stdout: stdoutText,
          stderr: stderrText,
          output: trimOutput(stdoutText.trim()),
          timedOut: false,
        });
        return;
      }
      if (!tuiMode) console.log(chalk.red(`\n  ✖ Command exited with code ${code ?? 1}`));
      finish({
        exitCode: code ?? 1,
        stdout: stdoutText,
        stderr: stderrText,
        output: trimOutput(
          [stdoutText, stderrText].filter(Boolean).join('\n').trim(),
        ),
        timedOut: false,
      });
    });
  });
}
