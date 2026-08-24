import { getUnquotedShellText } from './agent-mode.js';
import type { ToolResponse } from './tools/types.js';

/**
 * What a single approval can grant. These are deliberately coarse: the point is
 * that "let the agent edit files" and "let the agent run commands" are separate
 * decisions, not that every tool gets its own switch.
 *
 * `create` and `edit` are split because they carry different risk — creating a
 * file cannot destroy work, overwriting one can — and `delete` is split from
 * both because it is the only bucket that removes something outright.
 */
export const PERMISSION_BUCKETS = ['create', 'edit', 'delete', 'run'] as const;

export type PermissionBucket = (typeof PERMISSION_BUCKETS)[number];

/**
 * Grants live for the session only and are never written to disk. That is what
 * makes it safe to have no revoke UI: the blast radius of a mis-click is one
 * session, and `/new` clears it.
 */
export interface SessionGrants {
  buckets: PermissionBucket[];
  commandPrefixes: string[];
}

export type PermissionDecision =
  | { kind: 'once' }
  | { kind: 'always-bucket' }
  | { kind: 'always-prefix'; prefix: string }
  | { kind: 'deny' };

export interface PermissionOption {
  label: string;
  decision: PermissionDecision;
}

export interface PermissionRequest {
  bucket: PermissionBucket;
  title: string;
  body: string;
  filePath?: string;
  diff?: string;
  /** Present only for the `run` bucket; drives the prefix grant option. */
  command?: string;
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
  return { buckets: [], commandPrefixes: [] };
}

export function bucketActionLabel(bucket: PermissionBucket): string {
  if (bucket === 'create') return 'create files';
  if (bucket === 'edit') return 'edit files';
  if (bucket === 'delete') return 'delete files';
  return 'run commands';
}

/**
 * Binaries whose whole point is to destroy, escalate, or reach the network. A
 * prefix grant for these is never offered — "always allow: rm" is a footgun no
 * matter how carefully it is worded. They can still be approved once, or swept
 * up by an explicit whole-bucket grant, which at least says what it is.
 */
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

/**
 * Interpreters and wrappers. Their first argument is a *program*, not a
 * subcommand, so a prefix built from the binary name proves nothing about what
 * will run: a grant for `bash` earned by `bash -c echo-safe` would also cover
 * `bash -c "rm -rf ./build"`. Never offer a prefix for these.
 */
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

/**
 * Verbs that themselves dispatch to arbitrary user-defined code (package
 * scripts). `npm run` covers every script in package.json, so a grant stops at
 * the verb only when the specific script is named too.
 */
const SCRIPT_RUNNER_VERBS = new Set(['run', 'exec', 'run-script', 'x', 'dlx']);

/**
 * A bare verb: no flags, no paths, no extensions, no substitution. Colons are
 * allowed because namespaced scripts and tasks are the norm — `npm run
 * test:unit`, `rails db:migrate` — and a colon cannot turn a word into a path
 * or a flag.
 */
const VERB_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]*$/;

/** A plausible executable name once reduced to its basename. */
const BINARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Control operators that let one approved-looking command carry another. Checked
 * against the quote-stripped text so a literal `&&` inside a commit message does
 * not cost the command its prefix. Newlines count: a two-line command is two
 * commands.
 */
const SHELL_CONTROL_OPERATOR_PATTERN = /[&|;<>\n]/;

/**
 * Command substitution, checked against the RAW command. `getUnquotedShellText`
 * treats a backtick as a quote delimiter and blanks out what it wraps, so asking
 * it about backticks reports nothing and `npm test \`rm -rf /\`` would sail
 * through an `npm test` grant. Substitution also survives double quotes, so the
 * raw string is the only honest thing to test.
 */
const COMMAND_SUBSTITUTION_PATTERN = /`|\$\(/;

function normalizeCommand(command: string): string {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

interface ParsedCommand {
  /**
   * The command reduced to a stable form: leading env assignments and the
   * `command` wrapper dropped, the executable reduced to its basename. Both
   * storing and matching a grant use this, so `CI=1 /usr/local/bin/npm test`
   * and `npm test` are the same subject rather than two strings that never
   * match each other.
   */
  canonical: string;
  tokens: string[];
}

/**
 * Split a command into its canonical tokens, or null when it is not a single
 * plain command. Returning null is what makes a command ineligible for *both*
 * offering and matching a prefix, so the two can never disagree.
 */
function parseCommand(command: string): ParsedCommand | null {
  const raw = String(command ?? '');
  if (!raw.trim()) return null;
  if (COMMAND_SUBSTITUTION_PATTERN.test(raw)) return null;
  // Quoted operators are inert, so judge those with quoted spans blanked out —
  // otherwise `git commit -m "a && b"` would be refused a prefix.
  if (SHELL_CONTROL_OPERATOR_PATTERN.test(getUnquotedShellText(raw))) return null;

  const all = normalizeCommand(raw).match(/\S+/g) ?? [];
  const tokens: string[] = [];
  for (const token of all) {
    // Leading `FOO=bar` assignments and a literal `command` prefix describe how
    // to run the binary, not which binary it is.
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

/**
 * The prefix safe to remember for an already-parsed command, or null.
 *
 * This fails closed: a prefix is emitted only when the command's shape *proves*
 * where the executable ends and its verb begins. Absence from a denylist is not
 * evidence of safety — those lists are samples of open categories — so anything
 * whose first argument could be a program rather than a subcommand gets no
 * prefix at all.
 */
function grantPrefixFromTokens(tokens: string[]): string | null {
  const binary = tokens[0]!;
  if (!BINARY_PATTERN.test(binary)) return null;
  if (NO_PREFIX_GRANT_BINARIES.has(binary)) return null;
  if (INTERPRETER_OR_WRAPPER_BINARIES.has(binary)) return null;

  // A bare verb is the only thing that proves the boundary. `ls -la` and
  // `node --version` have no verb, so neither gets a prefix — a bare-binary
  // grant would mean "anything this program can do".
  const verb = tokens[1];
  if (!verb || !VERB_PATTERN.test(verb)) return null;

  if (SCRIPT_RUNNER_VERBS.has(verb)) {
    // `npm run` covers every script in package.json, so the script must be
    // named before the grant means anything specific.
    const script = tokens[2];
    if (!script || !VERB_PATTERN.test(script)) return null;
    return `${binary} ${verb} ${script}`;
  }
  return `${binary} ${verb}`;
}

/**
 * The prefix we would offer to remember for a command, or null when no prefix
 * is safe to offer.
 */
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
  // A command that could not itself have produced a prefix must never be
  // matched by one, so `node -e ...` cannot ride in on any grant.
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

/**
 * The choices offered for one request. Deny is always last, and the caller opens
 * the cursor on it, so the safe answer is the one a stray Enter lands on.
 */
export function buildPermissionOptions(
  bucket: PermissionBucket,
  command?: string,
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
  options.push({
    label: `Always allow: ${bucketActionLabel(bucket)}`,
    decision: { kind: 'always-bucket' },
  });
  options.push({ label: 'Deny', decision: { kind: 'deny' } });
  return options;
}

/**
 * Name the thing that was refused. The model reads this, and "rejected this
 * proposed command" tells it something that "rejected this proposed action"
 * does not.
 */
function declinedSubject(bucket: PermissionBucket): {
  noun: string;
  effect: string;
} {
  if (bucket === 'run') {
    return { noun: 'command', effect: 'Nothing was executed' };
  }
  if (bucket === 'create') {
    return { noun: 'file creation', effect: 'Nothing was created' };
  }
  if (bucket === 'delete') {
    return { noun: 'file deletion', effect: 'Nothing was deleted' };
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

/**
 * The single gate every mutating tool goes through. Returns null when the action
 * may proceed, or the failure response the tool should return when it may not.
 *
 * Callers must run their own hard blocks (for example the blocked-command
 * denylist) *before* calling this, so that no grant can unblock them.
 */
export async function ensurePermission(
  context: PermissionContext,
  request: PermissionRequest,
  toolName: string,
  extra: Record<string, unknown> = {},
): Promise<ToolResponse | null> {
  if (context.autoYes) return null;
  if (isBucketGranted(context.grants, request.bucket)) return null;
  if (
    request.bucket === 'run' &&
    request.command &&
    isCommandGranted(context.grants, request.command)
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
  const options = buildPermissionOptions(request.bucket, request.command);
  const decision = await context.requestPermission({ ...request, options });
  if (decision.kind === 'deny') {
    return declinedResponse(request.bucket, toolName, extra);
  }
  if (context.grants) {
    if (decision.kind === 'always-bucket') {
      grantBucket(context.grants, request.bucket);
    } else if (decision.kind === 'always-prefix') {
      grantCommandPrefix(context.grants, decision.prefix);
    }
  }
  return null;
}
