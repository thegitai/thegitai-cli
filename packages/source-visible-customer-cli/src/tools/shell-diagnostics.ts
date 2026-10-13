import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

export interface CodeRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CodeDiagnostic extends CodeRange {
  filePath: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

const CHECK_TIMEOUT = 60000;
const MAX_RAW_OUTPUT = 512 * 1024;
const FILE_DIAGNOSTICS_CACHE_TTL_MS = 5000;
const PROJECT_DIAGNOSTICS_CACHE_TTL_MS = 30000;
type Language = 'rust' | 'go' | 'python' | 'typescript' | 'javascript';
const EXT_TO_LANGUAGE: Record<string, Language> = {
  '.rs': 'rust',
  '.go': 'go',
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

function detectLanguageFromFile(filePath: string): Language | null {
  return EXT_TO_LANGUAGE[path.extname(filePath).toLowerCase()] ?? null;
}

function detectLanguageFromProject(rootDir: string): Language | null {
  if (existsSync(path.join(rootDir, 'Cargo.toml'))) return 'rust';
  if (existsSync(path.join(rootDir, 'go.mod'))) return 'go';
  if (existsSync(path.join(rootDir, 'tsconfig.json'))) return 'typescript';
  if (existsSync(path.join(rootDir, 'package.json'))) return 'javascript';
  if (
    existsSync(path.join(rootDir, 'setup.py')) ||
    existsSync(path.join(rootDir, 'pyproject.toml'))
  )
    return 'python';
  return null;
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], {
      timeout: 5000,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

function runCheck(
  cmd: string,
  args: string[],
  rootDir: string,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: rootDir,
      encoding: 'utf-8',
      maxBuffer: MAX_RAW_OUTPUT,
      timeout: CHECK_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

function parseRustDiagnostics(
  stdout: string,
  rootDir: string,
): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.reason !== 'compiler-message') continue;
    const cm = msg.message;
    if (!cm?.spans?.length) continue;
    const severity =
      cm.level === 'error'
        ? 'error'
        : cm.level === 'warning'
          ? 'warning'
          : cm.level === 'note'
            ? 'info'
            : 'hint';
    for (const span of cm.spans) {
      if (!span.is_primary) continue;
      let filePath = span.file_name ?? '';
      if (path.isAbsolute(filePath)) {
        filePath = path.relative(rootDir, filePath);
      }
      diagnostics.push({
        filePath,
        severity: severity as CodeDiagnostic['severity'],
        message: cm.message,
        source: 'rustc',
        code: cm.code?.code ?? undefined,
        startLine: span.line_start ?? 1,
        startColumn: span.column_start ?? 1,
        endLine: span.line_end ?? span.line_start ?? 1,
        endColumn: span.column_end ?? span.column_start ?? 1,
      });
    }
  }
  return diagnostics;
}

function runRustCheck(rootDir: string): CodeDiagnostic[] | null {
  if (!existsSync(path.join(rootDir, 'Cargo.toml'))) return null;
  if (!commandExists('cargo')) return null;
  const result = runCheck(
    'cargo',
    ['check', '--message-format=json', '--quiet'],
    rootDir,
  );
  return parseRustDiagnostics(`${result.stdout}\n${result.stderr}`, rootDir);
}

const GO_DIAG_RE = /^(.+?):(\d+):(\d+):\s*(.+)$/;

function parseGoDiagnostics(output: string, rootDir: string): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(GO_DIAG_RE);
    if (!m) continue;
    let filePath = m[1];
    if (filePath.startsWith('./')) filePath = filePath.slice(2);
    if (path.isAbsolute(filePath)) filePath = path.relative(rootDir, filePath);
    const lineNum = parseInt(m[2], 10);
    const col = parseInt(m[3], 10);
    diagnostics.push({
      filePath,
      severity: 'error',
      message: m[4].trim(),
      source: 'go',
      startLine: lineNum,
      startColumn: col,
      endLine: lineNum,
      endColumn: col,
    });
  }
  return diagnostics;
}

function runGoCheck(rootDir: string): CodeDiagnostic[] | null {
  if (!existsSync(path.join(rootDir, 'go.mod'))) return null;
  if (!commandExists('go')) return null;
  const result = runCheck('go', ['build', './...'], rootDir);
  return parseGoDiagnostics(`${result.stdout}\n${result.stderr}`, rootDir);
}

function parseRuffDiagnostics(
  stdout: string,
  rootDir: string,
): CodeDiagnostic[] {
  let items: any[];
  try {
    items = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    let filePath = item.filename ?? '';
    if (path.isAbsolute(filePath)) filePath = path.relative(rootDir, filePath);
    return {
      filePath,
      severity: 'warning' as const,
      message: item.message ?? '',
      source: 'ruff',
      code: item.code ?? undefined,
      startLine: item.location?.row ?? 1,
      startColumn: item.location?.column ?? 1,
      endLine: item.end_location?.row ?? item.location?.row ?? 1,
      endColumn: item.end_location?.column ?? item.location?.column ?? 1,
    };
  });
}

const PYCOMPILE_RE = /File "(.+?)", line (\d+)/;
const PYCOMPILE_ERR_RE = /^(\w*Error):\s*(.+)$/m;

function parsePyCompileDiagnostics(
  stderr: string,
  rootDir: string,
  filePath: string,
): CodeDiagnostic[] {
  const locMatch = stderr.match(PYCOMPILE_RE);
  const errMatch = stderr.match(PYCOMPILE_ERR_RE);
  if (!locMatch && !errMatch) return [];
  let diagPath = filePath;
  if (locMatch?.[1]) {
    diagPath = path.isAbsolute(locMatch[1])
      ? path.relative(rootDir, locMatch[1])
      : locMatch[1];
  }
  const lineNum = locMatch ? parseInt(locMatch[2], 10) : 1;
  const message = errMatch
    ? `${errMatch[1]}: ${errMatch[2]}`
    : (stderr.trim().split('\n').pop() ?? 'Syntax error');
  return [
    {
      filePath: diagPath,
      severity: 'error',
      message,
      source: 'python',
      startLine: lineNum,
      startColumn: 1,
      endLine: lineNum,
      endColumn: 1,
    },
  ];
}

function runPythonCheck(
  rootDir: string,
  filePath?: string,
): CodeDiagnostic[] | null {
  if (commandExists('ruff')) {
    const target = filePath || '.';
    const result = runCheck(
      'ruff',
      ['check', '--output-format=json', '--', target],
      rootDir,
    );
    return parseRuffDiagnostics(result.stdout, rootDir);
  }
  if (filePath) {
    const result = runCheck('python', ['-m', 'py_compile', filePath], rootDir);
    if (result.exitCode !== 0) {
      return parsePyCompileDiagnostics(result.stderr, rootDir, filePath);
    }
    return [];
  }
  return null;
}

const TSC_DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s*(\w+)\s+(TS\d+):\s*(.+)$/;

function parseTscDiagnostics(
  output: string,
  rootDir: string,
): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(TSC_DIAG_RE);
    if (!m) continue;
    let filePath = m[1];
    if (path.isAbsolute(filePath)) filePath = path.relative(rootDir, filePath);
    diagnostics.push({
      filePath,
      severity: m[4] === 'error' ? 'error' : 'warning',
      message: m[6].trim(),
      source: 'tsc',
      code: m[5],
      startLine: parseInt(m[2], 10),
      startColumn: parseInt(m[3], 10),
      endLine: parseInt(m[2], 10),
      endColumn: parseInt(m[3], 10),
    });
  }
  return diagnostics;
}

function runTypeScriptCheck(rootDir: string): CodeDiagnostic[] | null {
  if (!existsSync(path.join(rootDir, 'tsconfig.json'))) return null;
  const result = runCheck(
    'npx',
    ['tsc', '--noEmit', '--pretty', 'false'],
    rootDir,
  );
  return parseTscDiagnostics(`${result.stdout}\n${result.stderr}`, rootDir);
}

const JS_IMPORT_RE =
  /import\s+(?:type\s+)?([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
const JS_SIDE_EFFECT_IMPORT_RE = /import\s+['"]([^'"]+)['"]/g;

function resolveJavaScriptImport(rootDir: string, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const fromDir = path.dirname(path.join(rootDir, fromFile));
  const base = specifier.startsWith('/')
    ? path.join(rootDir, specifier)
    : path.resolve(fromDir, specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return path.relative(rootDir, candidate);
  }
  return path.relative(rootDir, base);
}

function exportedNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(
    /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1]!);
  }
  for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const list = match[1] ?? '';
    for (const raw of list.split(',')) {
      const name = raw.trim().split(/\s+as\s+/i).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(content)) names.add('default');
  return names;
}

function packageDeps(rootDir: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

function runJavaScriptStaticCheck(
  rootDir: string,
  filePath: string,
): CodeDiagnostic[] {
  const absPath = path.join(rootDir, filePath);
  let content = '';
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }
  const deps = packageDeps(rootDir);
  const diagnostics: CodeDiagnostic[] = [];
  const builtin = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ]);
  const imports: {
    specifier: string;
    names: string[];
    line: number;
  }[] = [];
  for (const match of content.matchAll(JS_IMPORT_RE)) {
    const importClause = (match[1] ?? '').trim();
    const specifier = match[2] ?? '';
    const namedImports = importClause.match(/\{([^}]+)\}/)?.[1] ?? '';
    const names = namedImports
      ? namedImports
          .split(',')
          .map((raw) => raw.trim().split(/\s+as\s+/i)[0]?.trim())
          .filter(Boolean) as string[]
      : [];
    const defaultImport = importClause.replace(/\{[^}]+\}/, '').split(',')[0]?.trim();
    if (
      defaultImport &&
      defaultImport !== '*' &&
      !defaultImport.startsWith('* ')
    ) {
      names.unshift('default');
    }
    const line = content.slice(0, match.index ?? 0).split('\n').length;
    imports.push({ specifier, names, line });
  }
  for (const match of content.matchAll(JS_SIDE_EFFECT_IMPORT_RE)) {
    const specifier = match[1] ?? '';
    const line = content.slice(0, match.index ?? 0).split('\n').length;
    imports.push({ specifier, names: [], line });
  }
  for (const item of imports) {
    if (!item.specifier.startsWith('.') && !item.specifier.startsWith('/')) {
      const pkg = packageName(item.specifier);
      if (!builtin.has(pkg) && !builtin.has(item.specifier) && !deps.has(pkg)) {
        diagnostics.push({
          filePath,
          severity: 'error',
          message: `Package "${pkg}" is imported but not listed in package.json dependencies.`,
          source: 'node-import',
          startLine: item.line,
          startColumn: 1,
          endLine: item.line,
          endColumn: 1,
        });
      }
      continue;
    }
    const resolved = resolveJavaScriptImport(rootDir, filePath, item.specifier);
    if (!resolved || !existsSync(path.join(rootDir, resolved))) {
      diagnostics.push({
        filePath,
        severity: 'error',
        message: `Imported module "${item.specifier}" does not resolve.`,
        source: 'node-import',
        startLine: item.line,
        startColumn: 1,
        endLine: item.line,
        endColumn: 1,
      });
      continue;
    }
    let importedContent = '';
    try {
      importedContent = readFileSync(path.join(rootDir, resolved), 'utf-8');
    } catch {
      continue;
    }
    const exports = exportedNames(importedContent);
    for (const name of item.names) {
      if (exports.has(name)) continue;
      diagnostics.push({
        filePath,
        severity: 'error',
        message: `Module "${item.specifier}" does not export "${name}".`,
        source: 'node-import',
        startLine: item.line,
        startColumn: 1,
        endLine: item.line,
        endColumn: 1,
      });
    }
  }
  return diagnostics;
}

function runJavaScriptCheck(
  rootDir: string,
  filePath?: string,
): CodeDiagnostic[] | null {
  if (existsSync(path.join(rootDir, 'tsconfig.json'))) {
    return runTypeScriptCheck(rootDir);
  }
  if (filePath) {
    const result = runCheck('node', ['--check', filePath], rootDir);
    const staticDiagnostics = runJavaScriptStaticCheck(rootDir, filePath);
    if (result.exitCode !== 0) {
      const msg = (result.stderr || result.stdout).trim();
      const lineMatch = msg.match(/:(\d+)\b/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 1;
      return [
        {
          filePath,
          severity: 'error',
          message: msg.split('\n').pop() ?? 'Syntax error',
          source: 'node',
          startLine: lineNum,
          startColumn: 1,
          endLine: lineNum,
          endColumn: 1,
        },
        ...staticDiagnostics,
      ];
    }
    return staticDiagnostics;
  }
  return null;
}

function countBySeverity(diagnostics: CodeDiagnostic[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
  }
  return { errors, warnings };
}

function formatShellDiagnosticsOutput(
  diagnostics: CodeDiagnostic[],
  otherFileErrorCount: number = 0,
): string {
  let output: string;
  if (!diagnostics.length) {
    output = 'Diagnostics: clean (via build check)';
  } else {
    const lines = diagnostics.map((d) => {
      const source = d.source ? ` ${d.source}` : '';
      const code = d.code != null ? ` (${d.code})` : '';
      return `- ${d.severity.toUpperCase()} ${d.filePath}:${d.startLine}:${d.startColumn}${source}${code} ${d.message}`;
    });
    output = `Diagnostics via build check (${diagnostics.length})\n${lines.join('\n')}`;
  }
  if (otherFileErrorCount > 0) {
    output += `\n\n${otherFileErrorCount} additional error(s) in other project files — call get_diagnostics without a filePath to see the full project picture before declaring success.`;
  }
  return output;
}

export interface ShellDiagnosticsResult {
  ok: boolean;
  provider: 'shell';
  available: boolean;
  filePath?: string;
  diagnostics: CodeDiagnostic[];
  diagnosticCount: number;
  errorCount: number;
  warningCount: number;
  command: string;
  output: string;
}

export interface DeferredShellDiagnosticsResult {
  provider: 'shell';
  deferred: true;
  trigger:
    | 'write_file'
    | 'patch_file'
    | 'str_replace'
    | 'undo_edit'
    | 'run_command'
    | 'run_node_script';
  filePath?: string;
  output: string;
}

type DiagnosticScope = 'project' | 'file';

interface ShellDiagnosticsCacheEntry {
  expiresAt: number;
  scope: DiagnosticScope;
  command: string;
  available: boolean;
  diagnostics: CodeDiagnostic[];
}
const shellDiagnosticsCache = new Map<string, ShellDiagnosticsCacheEntry>();

const FILE_EXT_AFFECTS_LANGUAGES: ReadonlyMap<string, readonly Language[]> = new Map([
  ['.ts', ['typescript', 'javascript']],
  ['.tsx', ['typescript', 'javascript']],
  ['.mts', ['typescript', 'javascript']],
  ['.cts', ['typescript', 'javascript']],
  ['.js', ['typescript', 'javascript']],
  ['.jsx', ['typescript', 'javascript']],
  ['.mjs', ['typescript', 'javascript']],
  ['.cjs', ['typescript', 'javascript']],
  ['.rs', ['rust']],
  ['.go', ['go']],
  ['.py', ['python']],
]);

const BUILD_MANIFEST_AFFECTS_LANGUAGES: ReadonlyMap<string, readonly Language[]> = new Map([
  ['tsconfig.json', ['typescript', 'javascript']],
  ['jsconfig.json', ['typescript', 'javascript']],
  ['package.json', ['typescript', 'javascript']],
  ['package-lock.json', ['typescript', 'javascript']],
  ['yarn.lock', ['typescript', 'javascript']],
  ['pnpm-lock.yaml', ['typescript', 'javascript']],
  ['Cargo.toml', ['rust']],
  ['Cargo.lock', ['rust']],
  ['go.mod', ['go']],
  ['go.sum', ['go']],
  ['pyproject.toml', ['python']],
  ['setup.py', ['python']],
  ['setup.cfg', ['python']],
  ['requirements.txt', ['python']],
  ['Pipfile', ['python']],
  ['Pipfile.lock', ['python']],
]);

function projectCacheKey(rootDir: string, language: Language): string {
  return `${rootDir}::project::${language}`;
}

function fileCacheKey(rootDir: string, filePath: string): string {
  return `${rootDir}::file::${filePath}`;
}

function cloneDiagnostics(diagnostics: CodeDiagnostic[]): CodeDiagnostic[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic }));
}

export function invalidateShellDiagnosticsCache(
  rootDir: string,
  filePath?: string,
): void {
  const prefix = `${rootDir}::`;
  if (!filePath) {
    for (const key of shellDiagnosticsCache.keys()) {
      if (key.startsWith(prefix)) {
        shellDiagnosticsCache.delete(key);
      }
    }
    return;
  }
  const basename = path.basename(filePath);
  const manifestAffected = BUILD_MANIFEST_AFFECTS_LANGUAGES.get(basename);
  if (manifestAffected) {
    for (const language of manifestAffected) {
      shellDiagnosticsCache.delete(projectCacheKey(rootDir, language));
    }
    shellDiagnosticsCache.delete(fileCacheKey(rootDir, filePath));
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const affected = FILE_EXT_AFFECTS_LANGUAGES.get(ext);
  if (!affected) return;
  for (const language of affected) {
    shellDiagnosticsCache.delete(projectCacheKey(rootDir, language));
  }
  shellDiagnosticsCache.delete(fileCacheKey(rootDir, filePath));
}

export function inspectShellDiagnosticsCache(): { keys: string[] } {
  return { keys: [...shellDiagnosticsCache.keys()] };
}

function commandScopeFor(
  language: Language,
  rootDir: string,
  filePath?: string,
): DiagnosticScope {
  switch (language) {
    case 'rust':
    case 'go':
    case 'typescript':
      return 'project';
    case 'javascript':
      return existsSync(path.join(rootDir, 'tsconfig.json')) ? 'project' : 'file';
    case 'python':
      return filePath ? 'file' : 'project';
  }
}

export function buildDeferredShellDiagnostics(
  trigger: DeferredShellDiagnosticsResult['trigger'],
  filePath?: string,
): DeferredShellDiagnosticsResult {
  if (trigger === 'run_command' || trigger === 'run_node_script') {
    return {
      provider: 'shell',
      deferred: true,
      trigger,
      filePath: filePath ?? undefined,
      output:
        `${trigger} did not rerun project diagnostics automatically. ` +
        `Use the command output for direct verification when applicable, and call get_diagnostics${filePath ? ` for ${filePath}` : ''} only if the command changed build-relevant files or you need project-wide compiler feedback.`,
    };
  }
  return {
    provider: 'shell',
    deferred: true,
    trigger,
    filePath: filePath ?? undefined,
    output:
      `${trigger} updated files without rerunning project diagnostics automatically. ` +
      `Batch related edits first, then call get_diagnostics (without a filePath for project-wide errors${filePath ? `, or with filePath="${filePath}" for this file only` : ''}) before declaring success.`,
  };
}

function buildUnavailableResult(
  filePath: string | undefined,
  command: string,
  reason: string,
): ShellDiagnosticsResult {
  return {
    ok: true,
    provider: 'shell',
    available: false,
    filePath: filePath ?? undefined,
    diagnostics: [],
    diagnosticCount: 0,
    errorCount: 0,
    warningCount: 0,
    command,
    output: reason,
  };
}

function applyFilePathFilter(
  diagnostics: CodeDiagnostic[],
  filePath: string | undefined,
): { focused: CodeDiagnostic[]; otherFileErrorCount: number } {
  if (!filePath) {
    return { focused: diagnostics, otherFileErrorCount: 0 };
  }
  const normalizedTarget = filePath.replace(/^\.\//, '');
  const focused: CodeDiagnostic[] = [];
  let otherFileErrorCount = 0;
  for (const diagnostic of diagnostics) {
    const normalizedDiag = diagnostic.filePath.replace(/^\.\//, '');
    if (
      normalizedDiag === normalizedTarget ||
      normalizedDiag.endsWith(`/${normalizedTarget}`)
    ) {
      focused.push(diagnostic);
    } else if (diagnostic.severity === 'error') {
      otherFileErrorCount += 1;
    }
  }
  return { focused, otherFileErrorCount };
}

function runDiagnosticsCommand(
  language: Language,
  rootDir: string,
  filePath: string | undefined,
): { command: string; diagnostics: CodeDiagnostic[] | null } {
  switch (language) {
    case 'rust':
      return {
        command: 'cargo check --message-format=json --quiet',
        diagnostics: runRustCheck(rootDir),
      };
    case 'go':
      return {
        command: 'go build ./...',
        diagnostics: runGoCheck(rootDir),
      };
    case 'python':
      return {
        command: commandExists('ruff')
          ? `ruff check ${filePath || '.'}`
          : `python -m py_compile ${filePath || ''}`,
        diagnostics: runPythonCheck(rootDir, filePath),
      };
    case 'typescript':
      return {
        command: 'npx tsc --noEmit',
        diagnostics: runTypeScriptCheck(rootDir),
      };
    case 'javascript':
      return {
        command: existsSync(path.join(rootDir, 'tsconfig.json'))
          ? 'npx tsc --noEmit'
          : `node --check ${filePath || ''}`,
        diagnostics: runJavaScriptCheck(rootDir, filePath),
      };
  }
}

export function runShellDiagnostics(
  rootDir: string,
  filePath?: string,
  limit: number = 50,
): ShellDiagnosticsResult {
  const language = filePath
    ? detectLanguageFromFile(filePath)
    : detectLanguageFromProject(rootDir);

  if (!language) {
    return buildUnavailableResult(
      filePath,
      '',
      `No build check command available${filePath ? ` for ${filePath}` : ''}.`,
    );
  }

  const scope = commandScopeFor(language, rootDir, filePath);
  const cacheKey =
    scope === 'project'
      ? projectCacheKey(rootDir, language)
      : fileCacheKey(rootDir, filePath!);
  const now = Date.now();
  const cached = shellDiagnosticsCache.get(cacheKey);

  let rawDiagnostics: CodeDiagnostic[];
  let command: string;
  let available: boolean;

  if (cached && cached.expiresAt > now && cached.scope === scope) {
    rawDiagnostics = cached.diagnostics;
    command = cached.command;
    available = cached.available;
  } else {
    const outcome = runDiagnosticsCommand(language, rootDir, filePath);
    command = outcome.command;
    if (outcome.diagnostics === null) {
      available = false;
      rawDiagnostics = [];
    } else {
      available = true;
      rawDiagnostics = outcome.diagnostics;
    }
    shellDiagnosticsCache.set(cacheKey, {
      expiresAt:
        now +
        (scope === 'project'
          ? PROJECT_DIAGNOSTICS_CACHE_TTL_MS
          : FILE_DIAGNOSTICS_CACHE_TTL_MS),
      scope,
      command,
      available,
      diagnostics: rawDiagnostics,
    });
  }

  if (!available) {
    return buildUnavailableResult(
      filePath,
      command,
      `No build check command available${filePath ? ` for ${filePath}` : ''} (no project configuration found).`,
    );
  }

  const { focused, otherFileErrorCount } = applyFilePathFilter(
    rawDiagnostics,
    filePath,
  );
  const limited = focused.slice(0, limit);
  const counts = countBySeverity(limited);
  return {
    ok: true,
    provider: 'shell',
    available: true,
    filePath: filePath || undefined,
    diagnostics: cloneDiagnostics(limited),
    diagnosticCount: focused.length,
    errorCount: counts.errors,
    warningCount: counts.warnings,
    command,
    output: formatShellDiagnosticsOutput(limited, otherFileErrorCount),
  };
}
