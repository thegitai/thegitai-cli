import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Types only — web-tree-sitter is a build-time devDependency for typings. The
// runtime is vendored (required below); the published package ships no
// web-tree-sitter runtime dependency.
import type {
  Language as TreeSitterLanguage,
  Node as TreeSitterNode,
  Parser as TreeSitterParser,
  Tree as TreeSitterTree,
} from 'web-tree-sitter';
import { addSignatureForNode } from './extractors/index.js';
import {
  getRepoMapLanguageForFile,
  RepoMapLanguageConfig,
} from './repo-map-languages.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// web-tree-sitter is vendored (see vendor/web-tree-sitter/NOTICE) so the
// published package has zero runtime dependencies. Resolve the vendored CommonJS
// runtime relative to this compiled file: dist/src/ -> dist/vendor in the
// published layout, with the source tree as a dev fallback. The .cjs locates its
// own web-tree-sitter.wasm next to itself via __dirname, so no locateFile
// override is needed.
function resolveVendoredTreeSitter(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'vendor', 'web-tree-sitter', 'web-tree-sitter.cjs'),
    path.resolve(__dirname, '..', '..', 'vendor', 'web-tree-sitter', 'web-tree-sitter.cjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
const TreeSitter = require(resolveVendoredTreeSitter());
let parserInitPromise: Promise<void> | null = null;
const parserCache: Record<string, TreeSitterParser> = Object.create(null);
const languageCache: Record<string, TreeSitterLanguage> = Object.create(null);

export interface ParsedRepoSource {
  code: string;
  languageConfig: RepoMapLanguageConfig;
  languageId: string;
  tree: TreeSitterTree;
}

function getWasmPath(wasmFile: string): string {
  const candidates = [
    path.resolve(__dirname, '..', 'parsers', wasmFile),
    path.resolve(__dirname, '..', '..', 'parsers', wasmFile),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

async function initParserRuntime(): Promise<void> {
  if (!parserInitPromise) {
    const ts = TreeSitter;
    const initFn =
      ts.init ||
      ts.default?.init ||
      ts.Parser?.init ||
      ts.default?.Parser?.init;
    parserInitPromise =
      typeof initFn === 'function' ? initFn() : Promise.resolve();
  }
  await parserInitPromise;
}

function createParser(): TreeSitterParser | null {
  const ParserClass =
    TreeSitter.Parser || TreeSitter.default?.Parser || TreeSitter.default;
  if (typeof ParserClass !== 'function') {
    return null;
  }
  try {
    return Reflect.construct(ParserClass, []) as TreeSitterParser;
  } catch {
    return null;
  }
}

async function getParserForLanguage(
  languageConfig: RepoMapLanguageConfig,
): Promise<TreeSitterParser | null> {
  if (parserCache[languageConfig.id]) {
    return parserCache[languageConfig.id];
  }
  try {
    await initParserRuntime();
    const wasmPath = getWasmPath(languageConfig.wasmFile);
    if (!existsSync(wasmPath)) {
      return null;
    }
    let language = languageCache[languageConfig.id];
    if (!language) {
      const ts = TreeSitter;
      const LanguageClass = ts.Language || ts.default?.Language;
      if (!LanguageClass?.load) {
        return null;
      }
      language = await LanguageClass.load(wasmPath);
      languageCache[languageConfig.id] = language;
    }
    const parser = createParser();
    if (!parser) {
      return null;
    }
    parser.setLanguage(language);
    parserCache[languageConfig.id] = parser;
    return parser;
  } catch {
    return null;
  }
}

export async function parseRepoSource(
  relPath: string,
  code: string,
): Promise<ParsedRepoSource | null> {
  const languageConfig = getRepoMapLanguageForFile(relPath, path);
  if (!languageConfig) {
    return null;
  }
  const parser = await getParserForLanguage(languageConfig);
  if (!parser) {
    return null;
  }
  try {
    const tree = parser.parse(code);
    if (!tree) {
      return null;
    }
    return {
      code,
      languageConfig,
      languageId: languageConfig.id,
      tree,
    };
  } catch {
    return null;
  }
}

export function collectNodeSignatures(
  node: TreeSitterNode | null,
  languageId: string,
  limit: number = Number.POSITIVE_INFINITY,
): string[] {
  const signatures: string[] = [];

  function visit(current: TreeSitterNode | null): void {
    if (!current || signatures.length >= limit) return;
    addSignatureForNode(current, languageId, signatures);
    if (signatures.length >= limit) return;
    for (let i = 0; i < current.namedChildCount; i++) {
      visit(current.namedChild(i));
      if (signatures.length >= limit) return;
    }
  }

  visit(node);
  return signatures;
}

export function getNodePrimarySignature(
  node: TreeSitterNode | null,
  languageId: string,
): string | null {
  return collectNodeSignatures(node, languageId, 1)[0] ?? null;
}

export function getStructuralChildren(
  node: TreeSitterNode | null,
): TreeSitterNode[] {
  const body = node?.childForFieldName?.('body');
  const source = body && body.namedChildCount > 0 ? body : node;
  const children: TreeSitterNode[] = [];
  if (!source) {
    return children;
  }
  for (let i = 0; i < source.namedChildCount; i++) {
    const child = source.namedChild(i);
    if (child && child.startIndex < child.endIndex) {
      children.push(child);
    }
  }
  return children;
}
