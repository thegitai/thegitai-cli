import path from 'node:path';

export interface ArtifactNameSet extends Iterable<string> {
  has: (value: string) => boolean;
}

function createArtifactNameSet(values: readonly string[]): ArtifactNameSet {
  const lookup = Object.fromEntries(values.map((value) => [value, true]));
  return {
    has: (value: string) => lookup[value] === true,
    *[Symbol.iterator]() {
      yield* values;
    },
  };
}

export const ARTIFACT_IGNORE_FILES = createArtifactNameSet([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock.bak',
]);

export const BINARY_ARTIFACT_EXTENSIONS = createArtifactNameSet([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wav',
  '.ogg',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.pdf',
  '.doc',
  '.docx',
  '.docm',
  '.dot',
  '.dotx',
  '.dotm',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.map',
  '.min.js',
  '.min.css',
]);

const REPO_METADATA_DIRS = [
  '.git',
  '.thegitai',
  '.thegitai-debug',
];

const EDITOR_METADATA_DIRS = [
  '.idea',
  '.vscode',
  '.fleet',
  '.zed',
  '.history',
  '.vs',
];

const PACKAGE_DEPENDENCY_DIRS = [
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  'env',
];

const GENERATED_OUTPUT_DIRS = [
  '.next',
  '.nuxt',
  '.output',
  '.vercel',
  '.vite',
  '.svelte-kit',
  '.angular',
  '.astro',
  '.expo',
  '.parcel-cache',
  '.serverless',
  '.build',
  'DerivedData',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'tmp',
  'temp',
  'obj',
];

const TOOL_CACHE_DIRS = [
  '.turbo',
  '.yarn',
  '.pnpm-store',
  '.npm',
  '.gradle',
  '.terraform',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.sass-cache',
  '.cache',
  '.tox',
  '.nox',
  '.dart_tool',
  '__pycache__',
];

export const ARTIFACT_IGNORE_DIRS = createArtifactNameSet([
  ...REPO_METADATA_DIRS,
  ...EDITOR_METADATA_DIRS,
  ...PACKAGE_DEPENDENCY_DIRS,
  ...GENERATED_OUTPUT_DIRS,
  ...TOOL_CACHE_DIRS,
]);

export const ARTIFACT_INSPECT_BLOCK_DIRS = ARTIFACT_IGNORE_DIRS;

export const ARTIFACT_IGNORE_PATH_PREFIXES = [
  'storage/framework/cache',
  'storage/framework/sessions',
  'storage/framework/views',
  'storage/logs',
  'bootstrap/cache',
  'var/cache',
  'var/log',
];

export const ARTIFACT_FALLBACK_IGNORE_GLOBS = [
  ...[...ARTIFACT_IGNORE_DIRS].flatMap((dir) => [
    `${dir}/**`,
    `**/${dir}/**`,
  ]),
  '.env',
  '.env.*',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  ...ARTIFACT_IGNORE_PATH_PREFIXES.map((prefix) => `${prefix}/**`),
];

// Kept in lockstep with the server's secret-path check: the client repair guard
// and the server-side secret check must agree on what counts as a secret, or a
// quoted/curly secret path the client repairs (e.g. service-account.json) slips
// past the server check, which keys off the original tool-call args.
const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^\.?npmrc$/i,
  /^\.?pypirc$/i,
  /^credentials(?:\..*)?$/i,
  /^secrets?(?:\..*)?$/i,
  /^service[-_]?account(?:\..*)?\.json$/i,
  /^.*credentials.*\.json$/i,
] as const;

const SENSITIVE_PATH_PATTERNS = [
  /(^|[/\\])\.aws[/\\]credentials$/i,
  /(^|[/\\])\.config[/\\]gcloud[/\\]/i,
  /(^|[/\\])credentials?([._-]|$)/i,
  /(^|[/\\])secrets?([._-]|$)/i,
  /(^|[/\\])private[-_]?key([._-]|$)/i,
  /(^|[/\\])service[-_]?account/i,
  /\.(?:pem|key|p12|pfx)$/i,
] as const;

export function normalizeArtifactPath(relPath: string): string {
  return String(relPath ?? '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');
}

export function getIgnoredArtifactDir(relPath: string): string | null {
  const parts = normalizeArtifactPath(relPath).split('/').filter(Boolean);
  return parts.find((part) => ARTIFACT_IGNORE_DIRS.has(part)) ?? null;
}

export function getBlockedArtifactInspectDir(relPath: string): string | null {
  const parts = normalizeArtifactPath(relPath).split('/').filter(Boolean);
  return parts.find((part) => ARTIFACT_INSPECT_BLOCK_DIRS.has(part)) ?? null;
}

export function matchesArtifactIgnorePrefix(relPath: string): boolean {
  const normalized = normalizeArtifactPath(relPath);
  for (const prefix of ARTIFACT_IGNORE_PATH_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

export function shouldIgnoreArtifactPath(relPath: string): boolean {
  return (
    getIgnoredArtifactDir(relPath) !== null ||
    matchesArtifactIgnorePrefix(relPath)
  );
}

export function isSensitiveProjectPath(value: unknown): boolean {
  const normalized = normalizeArtifactPath(String(value ?? '').trim());
  if (!normalized) return false;
  const base = path.posix.basename(normalized);
  return (
    SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(base)) ||
    SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function relativeProjectPath(rootDir: string, absPath: string): string | null {
  const relPath = path.relative(path.resolve(rootDir), path.resolve(absPath));
  if (
    !relPath ||
    relPath === '.' ||
    relPath.startsWith('..') ||
    path.isAbsolute(relPath)
  ) {
    return null;
  }
  return relPath;
}

export function normalizeProjectRelativePath(
  rootDir: string,
  targetPath: string,
): string | null {
  const absPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(rootDir, targetPath);
  return relativeProjectPath(rootDir, absPath);
}
