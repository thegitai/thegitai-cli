import { createHash } from 'node:crypto';
import {
  Client,
  StdioClientTransport,
  getDefaultEnvironment,
  StreamableHTTPClientTransport,
  AjvJsonSchemaValidator,
  type JsonSchemaValidator,
  ToolListChangedNotificationSchema,
} from './mcp-sdk.js';
import {
  expandMcpValue,
  readMcpConfig,
  validateMcpServer,
  type McpServerConfig,
} from './mcp-config.js';
import {
  mcpToolName,
  mcpCatalogueError,
  type McpToolDefinition,
} from './mcp-types.js';
import { ensurePermission } from './permissions.js';
import type { SessionState } from './session.js';
import type { ToolCall } from './types.js';
import type { ToolResponse } from './tools/types.js';
import { getCliVersion } from './version.js';

type Entry = {
  config?: McpServerConfig;
  fingerprint: string;
  client?: Client;
  tools: Map<
    string,
    {
      definition: McpToolDefinition;
      validate: JsonSchemaValidator<unknown>;
      schemaHash: string;
    }
  >;
  status: string;
  refreshedAt: number;
  retryAt: number;
  dirty: boolean;
  catalogueError?: string;
};

const REFRESH_MS = 60000;
const RETRY_MS = 60000;

export function createMcpConnections(rootDir: string, env: NodeJS.ProcessEnv) {
  const entries = new Map<string, Entry>();
  const shutdown = new AbortController();
  let pending: Promise<McpToolDefinition[]> | undefined;
  let configError = '';
  let advertised = new Set<string>();
  const expand = (value: string) => expandMcpValue(value, env);
  const expandMap = (value: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expand(item)]),
    );
  const fingerprint = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');

  async function close() {
    shutdown.abort();
    await pending?.catch(() => {});
    await Promise.allSettled(
      [...entries.values()].map((entry) => entry.client?.close()),
    );
    entries.clear();
  }

  function safeError(error: unknown, value: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    const config =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    const values = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : [];
    const secrets = [config.url, ...values(config.env), ...values(config.headers)].filter((item): item is string => typeof item === 'string');
    for (const value of secrets) {
      let secret = value;
      try {
        secret = expand(value);
      } catch {}
      if (secret) message = message.split(secret).join('[redacted]');
    }
    return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000);
  }

  async function refresh(
    name: string,
    value: unknown,
    signal: AbortSignal,
    force: boolean,
  ) {
    let entry = entries.get(name);
    try {
      const item = validateMcpServer(name, value);
      if (item.disabled) {
        await entry?.client?.close();
        entries.delete(name);
        return;
      }
      const resolved = validateMcpServer(
        name,
        item.type === 'stdio'
          ? {
              ...item,
              command: expand(item.command),
              args: (item.args ?? []).map(expand),
              env: expandMap(item.env),
            }
          : {
              ...item,
              url: expand(item.url),
              headers: expandMap(item.headers),
            },
      );
      const digest = fingerprint(resolved);
      if (entry && entry.fingerprint !== digest) {
        await entry.client?.close().catch(() => {});
        entries.delete(name);
        entry = undefined;
      }
      if (entry && !force) {
        if (entry.status !== 'connected' && Date.now() < entry.retryAt) return;
        if (
          entry.status === 'connected' &&
          !entry.dirty &&
          Date.now() - entry.refreshedAt < REFRESH_MS
        )
          return;
      }
      if (!entry?.client || entry.status !== 'connected') {
        await entry?.client?.close().catch(() => {});
        const client = new Client(
          { name: 'thegitai', version: getCliVersion() },
          { capabilities: {} },
        );
        entry = {
          config: item,
          fingerprint: digest,
          client,
          tools: entry?.tools ?? new Map(),
          status: 'connecting',
          refreshedAt: 0,
          retryAt: 0,
          dirty: true,
        };
        entries.set(name, entry);
        const current = entry;
        client.onclose = () => {


          if (current.client !== client) return;
          current.status = 'disconnected';
          current.retryAt = Date.now() + RETRY_MS;
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          current.dirty = true;
        });
        const transport =
          resolved.type === 'stdio'
            ? new StdioClientTransport({
                command: resolved.command,
                args: resolved.args,
                env: {
                  ...Object.fromEntries(
                    Object.keys(getDefaultEnvironment()).flatMap((key) =>
                      env[key] === undefined ? [] : [[key, env[key]!]],
                    ),
                  ),
                  ...resolved.env,
                },
                cwd: rootDir,
                stderr: 'pipe',
              })
            : new StreamableHTTPClientTransport(new URL(resolved.url), {
                requestInit: { headers: resolved.headers },
              });
        if (transport instanceof StdioClientTransport)
          transport.stderr?.on('data', () => {});
        await client.connect(transport, { timeout: 15000, signal });
        entry.status = 'connected';
      }
      const tools: Entry['tools'] = new Map();
      let cursor: string | undefined;
      const cursors = new Set<string>();
      entry.dirty = false;
      do {
        const page = await entry.client!.listTools(
          cursor ? { cursor } : undefined,
          { timeout: 15000, signal },
        );
        for (const tool of page.tools) {
          const nameForModel = mcpToolName(name, tool.name);
          if (tools.has(nameForModel))
            throw new Error('Server returned duplicate tool names.');
          const definition = {
            name: nameForModel,
            serverName: name,
            toolName: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
          };
          const catalogueError = mcpCatalogueError([
            ...[...tools.values()].map((item) => item.definition),
            definition,
          ]);
          if (catalogueError) throw new Error(catalogueError);
          const schemaHash = fingerprint(tool.inputSchema);
          const previous = entry.tools.get(nameForModel);
          tools.set(nameForModel, {
            definition,
            schemaHash,
            validate:
              previous?.schemaHash === schemaHash
                ? previous.validate
                : new AjvJsonSchemaValidator().getValidator(tool.inputSchema),
          });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error('Server repeated a tool-list cursor.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      entry.tools = tools;
      entry.refreshedAt = Date.now();
      entry.retryAt = 0;
    } catch (error) {
      if (!entry) {
        entry = {
          fingerprint: fingerprint(value),
          tools: new Map(),
          status: '',
          refreshedAt: 0,
          retryAt: 0,
          dirty: false,
        };
        entries.set(name, entry);
      }


      const cancelled = signal.aborted;
      const failedClient = entry.client;
      entry.client = undefined;
      await failedClient?.close().catch(() => {});
      entry.status = cancelled
        ? 'not connected'
        : `failed: ${safeError(error, value)}`;
      entry.tools.clear();
      entry.retryAt = cancelled ? 0 : Date.now() + RETRY_MS;
      signal.throwIfAborted();
    }
  }

  async function discoverImpl(
    signal: AbortSignal,
    force: boolean,
  ): Promise<McpToolDefinition[]> {
    signal.throwIfAborted();
    let config: ReturnType<typeof readMcpConfig>;
    try {
      config = readMcpConfig(env);
      configError = '';
    } catch (error) {
      configError = safeError(error, {});
      advertised.clear();
      await Promise.allSettled(
        [...entries.values()].map((entry) => entry.client?.close()),
      );
      entries.clear();
      return [];
    }
    for (const [name, entry] of entries) {
      const value = config.mcpServers[name];
      if (
        !Object.hasOwn(config.mcpServers, name) ||
        (value &&
          typeof value === 'object' &&
          'disabled' in value &&
          value.disabled === true)
      ) {
        await entry.client?.close().catch(() => {});
        entries.delete(name);
      }
    }
    await Promise.allSettled(
      Object.entries(config.mcpServers).map(([name, value]) =>
        refresh(name, value, signal, force),
      ),
    );
    signal.throwIfAborted();
    const tools: McpToolDefinition[] = [];
    for (const name of Object.keys(config.mcpServers)) {
      const entry = entries.get(name);
      if (!entry || entry.status !== 'connected') continue;
      const definitions = [...entry.tools.values()].map(
        (tool) => tool.definition,
      );
      entry.catalogueError = mcpCatalogueError([...tools, ...definitions]);
      if (!entry.catalogueError) tools.push(...definitions);
    }
    advertised = new Set(tools.map((tool) => tool.name));
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  function discover(
    signal?: AbortSignal,
    options: { force?: boolean } = {},
  ): Promise<McpToolDefinition[]> {
    const combined = signal
      ? AbortSignal.any([signal, shutdown.signal])
      : shutdown.signal;
    combined.throwIfAborted();
    if (!pending)
      pending = discoverImpl(combined, options.force === true).finally(() => {
        pending = undefined;
      });
    return pending;
  }

  async function execute(
    session: SessionState,
    call: ToolCall,
  ): Promise<ToolResponse> {
    const match = advertised.has(call.name)
      ? [...entries.entries()].find(
          ([, entry]) =>
            entry.tools.has(call.name) && entry.status === 'connected',
        )
      : undefined;
    if (!match)
      return {
        ok: false,
        error: 'MCP tool is unavailable. Check /mcp.',
        failureCategory: 'unknown_tool',
      };
    const [serverName, entry] = match;
    const tool = entry.tools.get(call.name)!;
    if (session.agentMode === 'plan')
      return {
        ok: false,
        error: 'MCP calls are unavailable in Plan mode.',
        failureCategory: 'policy_blocked',
      };
    const validation = tool.validate(call.args);
    if (!validation.valid)
      return {
        ok: false,
        error: validation.errorMessage,
        failureCategory: 'invalid_argument',
      };
    const denied = await ensurePermission(
      session,
      {
        bucket: 'mcp',
        mcpTool: JSON.stringify([entry.fingerprint, call.name]),
        mcpLabel: label(call.name),
        title: label(call.name) ?? `MCP: ${serverName}`,
        body: JSON.stringify(call.args, null, 2),
      },
      call.name,
    );
    if (denied) return denied;
    session.turnAbortSignal?.throwIfAborted();
    try {
      const result = await entry.client!.callTool(
        { name: tool.definition.toolName, arguments: call.args },
        undefined,
        {
          signal: session.turnAbortSignal,
          timeout: entry.config?.timeout ?? 60000,
        },
      );
      return {
        ok: result.isError !== true,
        mcpResult: result,
        ...(result.isError
          ? {
              error: 'MCP server reported a tool error.',
              failureCategory: 'external_service' as const,
            }
          : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: safeError(error, entry.config),
        outcomeUnknown: true,
        failureCategory: 'external_service',
      };
    }
  }

  function label(name: string): string | undefined {
    for (const entry of entries.values()) {
      const tool = entry.tools.get(name)?.definition;
      if (tool)
        return `MCP: ${tool.serverName} / ${tool.toolName.replace(/[\u0000-\u001f\u007f]/g, ' ')}`;
    }
    return undefined;
  }

  function status(): string {
    let config: ReturnType<typeof readMcpConfig>;
    try {
      config = readMcpConfig(env);
    } catch (error) {
      return `MCP configuration failed: ${safeError(error, {})}\nChat can continue without MCP tools.`;
    }
    const lines = Object.entries(config.mcpServers).map(([name, value]) => {
      const entry = entries.get(name);
      const disabled =
        value &&
        typeof value === 'object' &&
        'disabled' in value &&
        value.disabled === true;
      return `${name.replace(/[\u0000-\u001f\u007f]/g, ' ')} · ${disabled ? 'disabled' : entry?.catalogueError ? `unavailable: ${entry.catalogueError}` : (entry?.status ?? 'not connected')}${entry?.status === 'connected' && !entry.catalogueError ? ` · ${entry.tools.size} tools\n${[...entry.tools.values()].map((tool) => `  ${tool.definition.toolName.replace(/[\u0000-\u001f\u007f]/g, ' ')}`).join('\n')}` : ''}`;
    });
    return [
      configError,
      ...(lines.length ? lines : ['No MCP servers configured.']),
      '',
      'Configure with ai mcp add / remove / enable / disable.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return { discover, execute, status, label, close };
}

export type McpConnections = ReturnType<typeof createMcpConnections>;
export function sessionMcp(session: SessionState): McpConnections {
  return (session.mcp ??= createMcpConnections(session.rootDir, session.env));
}
