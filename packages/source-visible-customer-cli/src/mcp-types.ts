import { createHash } from 'node:crypto';

export interface McpToolDefinition {
  name: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function mcpToolName(serverName: string, toolName: string): string {
  const label = `${serverName}_${toolName}`
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .slice(0, 36);
  const digest = createHash('sha256')
    .update(JSON.stringify([serverName, toolName]))
    .digest('hex')
    .slice(0, 16);
  return `mcp_${label}_${digest}`;
}

export function isMcpToolName(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('mcp_');
}

export const MCP_MAX_TOOLS = 128;
export const MCP_MAX_CATALOGUE_BYTES = 100 * 1024;
export const MCP_MAX_DESCRIPTION_CHARS = 4096;

export function mcpCatalogueError(
  tools: McpToolDefinition[],
): string | undefined {
  if (tools.length > MCP_MAX_TOOLS)
    return `More than ${MCP_MAX_TOOLS} MCP tools.`;
  if (tools.some((tool) => tool.description.length > MCP_MAX_DESCRIPTION_CHARS))
    return `An MCP tool description exceeds ${MCP_MAX_DESCRIPTION_CHARS} characters.`;
  if (Buffer.byteLength(JSON.stringify(tools), 'utf8') > MCP_MAX_CATALOGUE_BYTES)
    return 'MCP tool definitions exceed 100 KiB (approximately 25,600 tokens).';
  return undefined;
}
