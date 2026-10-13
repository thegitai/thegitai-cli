export interface RepoMapLanguageConfig {
  id: string;
  displayName: string;
  wasmFile: string;
  extensions: string[];
}

export const REPO_MAP_LANGUAGE_CONFIGS: RepoMapLanguageConfig[] = [
  {
    id: 'javascript',
    displayName: 'JavaScript',
    wasmFile: 'tree-sitter-javascript.wasm',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    id: 'typescript',
    displayName: 'TypeScript',
    wasmFile: 'tree-sitter-typescript.wasm',
    extensions: ['.ts', '.mts', '.cts'],
  },
  {
    id: 'tsx',
    displayName: 'TSX',
    wasmFile: 'tree-sitter-tsx.wasm',
    extensions: ['.tsx'],
  },
  {
    id: 'python',
    displayName: 'Python',
    wasmFile: 'tree-sitter-python.wasm',
    extensions: ['.py'],
  },
  {
    id: 'go',
    displayName: 'Go',
    wasmFile: 'tree-sitter-go.wasm',
    extensions: ['.go'],
  },
  {
    id: 'rust',
    displayName: 'Rust',
    wasmFile: 'tree-sitter-rust.wasm',
    extensions: ['.rs'],
  },
  {
    id: 'php',
    displayName: 'PHP',
    wasmFile: 'tree-sitter-php.wasm',
    extensions: ['.php'],
  },
  {
    id: 'java',
    displayName: 'Java',
    wasmFile: 'tree-sitter-java.wasm',
    extensions: ['.java'],
  },
  {
    id: 'c',
    displayName: 'C',
    wasmFile: 'tree-sitter-c.wasm',
    extensions: ['.c'],
  },
  {
    id: 'cpp',
    displayName: 'C++',
    wasmFile: 'tree-sitter-cpp.wasm',
    extensions: ['.cpp', '.hpp', '.cc', '.h'],
  },
  {
    id: 'csharp',
    displayName: 'C#',
    wasmFile: 'tree-sitter-c-sharp.wasm',
    extensions: ['.cs'],
  },
  {
    id: 'objc',
    displayName: 'Objective-C',
    wasmFile: 'tree-sitter-objc.wasm',
    extensions: ['.m'],
  },
  {
    id: 'html',
    displayName: 'HTML',
    wasmFile: 'tree-sitter-html.wasm',
    extensions: ['.html', '.htm'],
  },
  {
    id: 'css',
    displayName: 'CSS',
    wasmFile: 'tree-sitter-css.wasm',
    extensions: ['.css', '.scss'],
  },
  {
    id: 'ruby',
    displayName: 'Ruby',
    wasmFile: 'tree-sitter-ruby.wasm',
    extensions: ['.rb'],
  },
];

export const REPO_MAP_LANGUAGE_BY_EXTENSION = new Map<
  string,
  RepoMapLanguageConfig
>(
  REPO_MAP_LANGUAGE_CONFIGS.flatMap((config) =>
    config.extensions.map((extension) => [extension, config]),
  ),
);

export function getRepoMapLanguageForFile(
  filePath: string,
  pathModule: any,
): RepoMapLanguageConfig | null {
  const extension = pathModule.extname(filePath).toLowerCase();
  return REPO_MAP_LANGUAGE_BY_EXTENSION.get(extension) ?? null;
}

export function listRepoMapWasmFiles(): string[] {
  return REPO_MAP_LANGUAGE_CONFIGS.map((config) => config.wasmFile);
}
