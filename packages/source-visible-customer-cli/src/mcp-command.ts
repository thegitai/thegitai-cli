import {
  mcpConfigPath,
  readMcpConfig,
  validateMcpServer,
  writeMcpConfig,
} from './mcp-config.js';

export const MCP_HELP = `MCP servers (saved for your user account on this machine):
  ai mcp add <name> -- <command> [args...]
  ai mcp add --transport http <name> <url> [--header 'Name: value']
  ai mcp add --env KEY=value <name> -- <command> [args...]
  Options: -t/--transport, -e/--env, -H/--header, -s/--scope user
  ai mcp add-json <name> '<JSON configuration>'
  ai mcp list
  ai mcp get <name>
  ai mcp remove <name>
  ai mcp enable <name>
  ai mcp disable <name>

Use /mcp inside a session to check connections and available tools.
Local servers run on your machine. Add only servers you trust.
HTTP supports headers; browser-based OAuth sign-in is not supported yet.`;

export function runMcpCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const [action, ...input] = args;
  const rest: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const token = input[index]!;
    if (token === '--') {
      rest.push(...input.slice(index));
      break;
    }
    if (token === '--scope' || token === '-s') {
      const scope = input[++index];
      if (scope !== 'user')
        throw new Error(
          'Only --scope user is supported. Project and local MCP scope are not available.',
        );
    } else rest.push(token);
  }
  if (!action || action === '--help' || action === '-h') return MCP_HELP;
  const config = readMcpConfig(env);
  if (action === 'list' && rest.length === 0) {
    return [
      mcpConfigPath(env),
      ...Object.entries(config.mcpServers).map(([name, value]) => {
        if (value && typeof value === 'object' && 'disabled' in value && value.disabled === true) return `${name} · disabled`;
        try {
          const item = validateMcpServer(name, value);
          return `${name} · ${item.type} · ${item.disabled ? 'disabled' : 'enabled'}`;
        } catch (error) {
          return `${name} · failed: ${String((error as Error).message)}`;
        }
      }),
      ...(Object.keys(config.mcpServers).length
        ? []
        : ['No MCP servers configured.']),
      'Use /mcp in a session to check connections.',
    ].join('\n');
  }
  if (action === 'add' || action === 'add-json') {
    let name: string;
    let value: unknown;
    if (action === 'add-json') {
      if (rest.length !== 2)
        throw new Error('Usage: ai mcp add-json <name> <JSON>');
      name = rest[0]!;
      try {
        value = JSON.parse(rest[1]!);
      } catch {
        throw new Error('Invalid MCP JSON configuration.');
      }
    } else {
      const positional: string[] = [];
      const vars: Record<string, string> = {};
      const headers: Record<string, string> = {};
      let transport = 'stdio';
      let command: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const token = rest[i]!;
        const arg =
          (
            {
              '-t': '--transport',
              '-e': '--env',
              '-H': '--header',
              '-s': '--scope',
            } as Record<string, string>
          )[token] ?? token;
        if (arg === '--') {
          command = rest.slice(i + 1);
          break;
        }
        if (['--transport', '--env', '--header'].includes(arg)) {
          const value = rest[++i];
          if (!value) throw new Error(`Missing value for ${arg}.`);
          if (arg === '--transport') transport = value;
          else {
            const separator = arg === '--env' ? '=' : ':';
            const at = value.indexOf(separator);
            if (at < 1)
              throw new Error(
                `Expected ${arg === '--env' ? 'KEY=value' : 'Name: value'} for ${arg}.`,
              );
            (arg === '--env' ? vars : headers)[value.slice(0, at).trim()] =
              value.slice(at + 1).trim();
          }
        } else if (arg.startsWith('-'))
          throw new Error(`Unknown MCP option: ${arg}`);
        else positional.push(arg);
      }
      name = positional[0] ?? '';
      if (
        transport === 'http' &&
        positional.length === 2 &&
        !command.length &&
        !Object.keys(vars).length
      )
        value = { type: 'http', url: positional[1], headers };
      else if (
        transport === 'stdio' &&
        positional.length === 1 &&
        command.length &&
        !Object.keys(headers).length
      )
        value = {
          type: 'stdio',
          command: command[0],
          args: command.slice(1),
          env: vars,
        };
      else throw new Error(MCP_HELP);
    }
    if (Object.hasOwn(config.mcpServers, name))
      throw new Error(
        `MCP server ${name} already exists. Remove it before replacing it.`,
      );
    Object.defineProperty(config.mcpServers, name, {
      value: validateMcpServer(name, value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    const name = rest[0] ?? '';
    if (
      rest.length !== 1 ||
      !['get', 'remove', 'enable', 'disable'].includes(action)
    )
      throw new Error(MCP_HELP);
    if (!Object.hasOwn(config.mcpServers, name))
      throw new Error(`Unknown MCP server: ${name}`);
    const raw = config.mcpServers[name];
    if (action === 'remove') {
      delete config.mcpServers[name];
    } else if (action === 'disable') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error(
          'This entry cannot be disabled. Remove it with ai mcp remove.',
        );
      config.mcpServers[name] = { ...raw, disabled: true };
    } else {
      const item = validateMcpServer(name, raw);
      if (action === 'get')
        return JSON.stringify(
          {
            name,
            type: item.type,
            disabled: item.disabled === true,
            timeout: item.timeout ?? 60000,
            ...(item.type === 'stdio'
              ? {
                  command: item.command,
                  argumentCount: item.args?.length ?? 0,
                  environmentVariables: Object.keys(item.env ?? {}),
                }
              : { headerNames: Object.keys(item.headers ?? {}) }),
            configFile: mcpConfigPath(env),
          },
          null,
          2,
        );
      item.disabled = false;
      config.mcpServers[name] = item;
    }
  }
  writeMcpConfig(config, env);
  return `MCP configuration saved to ${mcpConfigPath(env)}. Changes apply on the next turn or /mcp.`;
}
