import { getUnquotedShellText } from './agent-mode.js';
import type { ToolResponse } from './tools/types.js';










export const PERMISSION_BUCKETS = ['create', 'edit', 'delete', 'run', 'browse', 'mcp'] as const;

export type PermissionBucket = (typeof PERMISSION_BUCKETS)[number];






export interface SessionGrants {
  buckets: PermissionBucket[];
  commandPrefixes: string[];






  origins?: string[];
  mcpTools?: string[];
}

export type PermissionDecision =
  | { kind: 'once' }
  | { kind: 'always-bucket' }
  | { kind: 'always-prefix'; prefix: string }
  | { kind: 'always-origin'; origin: string }
  | { kind: 'always-mcp-tool'; tool: string }
  | { kind: 'deny' };

export interface PermissionOption {
  label: string;
  decision: PermissionDecision;
}

export interface PermissionRequest {
  bucket: PermissionBucket;
  mcpTool?: string;
  mcpLabel?: string;
  title: string;
  body: string;
  filePath?: string;
  diff?: string;

  command?: string;

  origin?: string;
}

export type PermissionRequester = (
  request: PermissionRequest & { options: PermissionOption[] },
) => Promise<PermissionDecision>;

export interface PermissionContext {
  autoYes: boolean;
  grants?: SessionGrants;
  requestPermission?: PermissionRequester | null;
}

export function createSessionGrants(): SessionGrants {
  return { buckets: [], commandPrefixes: [], origins: [] };
}

export function bucketActionLabel(bucket: PermissionBucket): string {
  if (bucket === 'create') return 'create files';
  if (bucket === 'edit') return 'edit files';
  if (bucket === 'delete') return 'delete files';
  if (bucket === 'browse') return 'act on any website';
  if (bucket === 'mcp') return 'use MCP tools';
  return 'run commands';
}








export function originForUrl(url: string): string | null {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol === 'about:' || parsed.protocol === 'chrome:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isOriginGranted(
  grants: SessionGrants | undefined,
  origin: string | null,
): boolean {
  if (!grants || !origin) return false;
  return grants.origins?.includes(origin) === true;
}

export function grantOrigin(grants: SessionGrants, origin: string): void {
  const normalized = String(origin ?? '').trim();
  if (!normalized) return;
  const origins = grants.origins ??= [];
  if (!origins.includes(normalized)) origins.push(normalized);
}







const NO_PREFIX_GRANT_BINARIES = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'shred',
  'sudo',
  'doas',
  'su',
  'chmod',
  'chown',
  'chgrp',
  'kill',
  'pkill',
  'killall',
  'shutdown',
  'reboot',
  'curl',
  'wget',
  'ssh',
  'scp',
  'nc',
  'eval',
  'exec',
  'source',
]);







const INTERPRETER_OR_WRAPPER_BINARIES = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'python',
  'python2',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
  'awk',
  'gawk',
  'sed',
  'env',
  'timeout',
  'xargs',
  'nohup',
  'setsid',
  'watch',
  'script',
  'nice',
  'ionice',
  'stdbuf',
  'time',
  'sudo',
  'doas',
  'su',
  'find',
  'make',
]);






const SCRIPT_RUNNER_VERBS = new Set(['run', 'exec', 'run-script', 'x', 'dlx']);







const VERB_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]*$/;


const BINARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;







const SHELL_CONTROL_OPERATOR_PATTERN = /[&|;<>\n]/;








const COMMAND_SUBSTITUTION_PATTERN = /`|\$\(/;

function normalizeCommand(command: string): string {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

interface ParsedCommand {







  canonical: string;
  tokens: string[];
}






function parseCommand(command: string): ParsedCommand | null {
  const raw = String(command ?? '');
  if (!raw.trim()) return null;
  if (COMMAND_SUBSTITUTION_PATTERN.test(raw)) return null;


  if (SHELL_CONTROL_OPERATOR_PATTERN.test(getUnquotedShellText(raw))) return null;

  const all = normalizeCommand(raw).match(/\S+/g) ?? [];
  const tokens: string[] = [];
  for (const token of all) {


    if (!tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (!tokens.length && token === 'command') continue;
    tokens.push(token);
  }
  if (!tokens.length) return null;
  const binary = (tokens[0]!.split('/').pop() ?? '').trim();
  if (!binary) return null;
  tokens[0] = binary;
  return { canonical: tokens.join(' '), tokens };
}










function grantPrefixFromTokens(tokens: string[]): string | null {
  const binary = tokens[0]!;
  if (!BINARY_PATTERN.test(binary)) return null;
  if (NO_PREFIX_GRANT_BINARIES.has(binary)) return null;
  if (INTERPRETER_OR_WRAPPER_BINARIES.has(binary)) return null;




  const verb = tokens[1];
  if (!verb || !VERB_PATTERN.test(verb)) return null;

  if (SCRIPT_RUNNER_VERBS.has(verb)) {


    const script = tokens[2];
    if (!script || !VERB_PATTERN.test(script)) return null;
    return `${binary} ${verb} ${script}`;
  }
  return `${binary} ${verb}`;
}





export function commandGrantPrefix(command: string): string | null {
  const parsed = parseCommand(command);
  return parsed ? grantPrefixFromTokens(parsed.tokens) : null;
}

export function isBucketGranted(
  grants: SessionGrants | undefined,
  bucket: PermissionBucket,
): boolean {
  return Boolean(grants?.buckets.includes(bucket));
}

export function isCommandGranted(
  grants: SessionGrants | undefined,
  command: string,
): boolean {
  if (!grants) return false;
  if (grants.buckets.includes('run')) return true;
  if (!grants.commandPrefixes.length) return false;
  const parsed = parseCommand(command);
  if (!parsed) return false;


  if (grantPrefixFromTokens(parsed.tokens) === null) return false;
  return grants.commandPrefixes.some(
    (prefix) =>
      parsed.canonical === prefix || parsed.canonical.startsWith(`${prefix} `),
  );
}

export function grantBucket(
  grants: SessionGrants,
  bucket: PermissionBucket,
): void {
  if (!grants.buckets.includes(bucket)) grants.buckets.push(bucket);
}

export function grantCommandPrefix(
  grants: SessionGrants,
  prefix: string,
): void {
  const normalized = normalizeCommand(prefix);
  if (!normalized) return;
  if (!grants.commandPrefixes.includes(normalized)) {
    grants.commandPrefixes.push(normalized);
  }
}





export function buildPermissionOptions(
  bucket: PermissionBucket,
  command?: string,
  origin?: string,
): PermissionOption[] {
  const options: PermissionOption[] = [
    { label: 'Approve once', decision: { kind: 'once' } },
  ];
  const prefix = bucket === 'run' && command ? commandGrantPrefix(command) : null;
  if (prefix) {
    options.push({
      label: `Always allow: ${prefix}`,
      decision: { kind: 'always-prefix', prefix },
    });
  }
  if (bucket === 'browse' && origin) {
    options.push({
      label: `Allow this site for the session: ${origin}`,
      decision: { kind: 'always-origin', origin },
    });
  }
  options.push({
    label: `Always allow: ${bucketActionLabel(bucket)}`,
    decision: { kind: 'always-bucket' },
  });
  options.push({ label: 'Deny', decision: { kind: 'deny' } });
  return options;
}






function declinedSubject(bucket: PermissionBucket): {
  noun: string;
  effect: string;
} {
  if (bucket === 'mcp') return { noun: 'MCP tool call', effect: 'The MCP tool was not called' };
  if (bucket === 'run') {
    return { noun: 'command', effect: 'Nothing was executed' };
  }
  if (bucket === 'create') {
    return { noun: 'file creation', effect: 'Nothing was created' };
  }
  if (bucket === 'delete') {
    return { noun: 'file deletion', effect: 'Nothing was deleted' };
  }
  if (bucket === 'browse') {
    return { noun: 'browser action', effect: 'The page was not touched' };
  }
  return { noun: 'edit', effect: 'Nothing was changed' };
}

function declinedResponse(
  bucket: PermissionBucket,
  toolName: string,
  extra: Record<string, unknown>,
): ToolResponse {
  const { noun, effect } = declinedSubject(bucket);
  return {
    ok: false,
    skipped: true,
    ...extra,
    failureCategory: 'user_declined',
    failureDetails: {
      category: 'user_declined',
      tool: toolName,
      action:
        'Respect the real user’s decision. Do not retry the same or an equivalent action; reconsider the approach or ask one specific question if needed.',
    },
    error:
      `The real user rejected this proposed ${noun}. ${effect}; this was not a tool failure or an automated system skip.`,
  };
}








export async function ensurePermission(
  context: PermissionContext,
  request: PermissionRequest,
  toolName: string,
  extra: Record<string, unknown> = {},
): Promise<ToolResponse | null> {
  if (context.autoYes) return null;
  if (request.mcpTool && context.grants?.mcpTools?.includes(request.mcpTool)) return null;
  if (isBucketGranted(context.grants, request.bucket)) return null;
  if (
    request.bucket === 'run' &&
    request.command &&
    isCommandGranted(context.grants, request.command)
  ) {
    return null;
  }
  if (
    request.bucket === 'browse' &&
    isOriginGranted(context.grants, request.origin ?? null)
  ) {
    return null;
  }
  if (!context.requestPermission) {
    return {
      ok: false,
      ...extra,
      error: `requestPermission is required when autoYes is false (${toolName})`,
    };
  }
  const options: PermissionOption[] = request.mcpTool ? [
    { label: 'Approve once', decision: { kind: 'once' } },
    { label: 'Allow this MCP tool for the session', decision: { kind: 'always-mcp-tool', tool: request.mcpTool } },
    { label: 'Deny', decision: { kind: 'deny' } },
  ] : buildPermissionOptions(
    request.bucket,
    request.command,
    request.origin,
  );
  const decision = await context.requestPermission({ ...request, options });
  if (decision.kind === 'deny') {
    return declinedResponse(request.bucket, toolName, extra);
  }
  if (context.grants) {
    if (decision.kind === 'always-mcp-tool' && decision.tool === request.mcpTool) {
      (context.grants.mcpTools ??= []).push(decision.tool);
    } else if (decision.kind === 'always-bucket') {
      grantBucket(context.grants, request.bucket);
    } else if (decision.kind === 'always-prefix') {
      grantCommandPrefix(context.grants, decision.prefix);
    } else if (decision.kind === 'always-origin') {
      grantOrigin(context.grants, decision.origin);
    }
  }
  return null;
}
