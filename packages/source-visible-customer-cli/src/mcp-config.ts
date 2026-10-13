import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getClientStateDir } from './client-state.js';

export type McpServerConfig = {
  disabled?: boolean;
  timeout?: number;
} & (
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: 'http'; url: string; headers?: Record<string, string> }
);
export type McpConfig = { mcpServers: Record<string, unknown> };

export function mcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getClientStateDir(env), 'mcp.json');
}

function stringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

export function validateMcpServer(
  name: string,
  value: unknown,
): McpServerConfig {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      'MCP server names must contain 1–64 letters, numbers, underscores or hyphens.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid MCP configuration for ${name}.`);
  }
  const item = value as Record<string, unknown>;
  const type = item.type ?? (item.command ? 'stdio' : 'http');
  const allowed = new Set([
    'type',
    'disabled',
    'timeout',
    ...(type === 'stdio' ? ['command', 'args', 'env'] : ['url', 'headers']),
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) {
    throw new Error(
      `Unknown MCP configuration field for ${name}. Supported transports: stdio and http.`,
    );
  }
  if (item.disabled !== undefined && typeof item.disabled !== 'boolean')
    throw new Error(`Invalid disabled flag for ${name}.`);
  if (
    item.timeout !== undefined &&
    (!Number.isInteger(item.timeout) ||
      Number(item.timeout) < 1000 ||
      Number(item.timeout) > 300000)
  ) {
    throw new Error(
      `MCP timeout for ${name} must be 1000–300000 milliseconds.`,
    );
  }
  const common = {
    disabled: item.disabled as boolean | undefined,
    timeout: item.timeout as number | undefined,
  };
  if (
    type === 'stdio' &&
    typeof item.command === 'string' &&
    item.command.trim()
  ) {
    if (
      item.args !== undefined &&
      (!Array.isArray(item.args) ||
        !item.args.every((arg) => typeof arg === 'string'))
    )
      throw new Error(`Invalid args for ${name}.`);
    if (
      item.env !== undefined &&
      (!stringMap(item.env) ||
        Object.keys(item.env).some(
          (key) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key),
        ))
    )
      throw new Error(`Invalid env for ${name}.`);
    return {
      ...common,
      type,
      command: item.command,
      args: item.args as string[] | undefined,
      env: item.env as Record<string, string> | undefined,
    };
  }
  if (type === 'http' && typeof item.url === 'string') {
    const hasVariable = /\$\{[a-zA-Z_][a-zA-Z0-9_]*(?::-[^}]*)?\}/.test(
      item.url,
    );
    const url = hasVariable ? null : new URL(item.url);
    if (
      url &&
      (!['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password)
    )
      throw new Error(
        `Invalid HTTP URL for ${name}. Use headers for authentication.`,
      );
    if (item.headers !== undefined && !stringMap(item.headers))
      throw new Error(`Invalid headers for ${name}.`);
    return {
      ...common,
      type,
      url: item.url,
      headers: item.headers as Record<string, string> | undefined,
    };
  }
  throw new Error(`MCP server ${name} needs a stdio command or HTTP URL.`);
}

export function readMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  let raw: string;
  try {
    raw = readFileSync(mcpConfigPath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { mcpServers: {} };
    throw error;
  }
  let config: McpConfig;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${mcpConfigPath(env)}.`);
  }
  if (
    !config?.mcpServers ||
    typeof config.mcpServers !== 'object' ||
    Array.isArray(config.mcpServers)
  )
    throw new Error('MCP configuration needs an mcpServers object.');
  return config;
}

export function writeMcpConfig(
  config: McpConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = mcpConfigPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

export function expandMcpValue(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name] ?? fallback;
      if (resolved === undefined)
        throw new Error(`Missing environment variable ${name}.`);
      return resolved;
    },
  );
}
