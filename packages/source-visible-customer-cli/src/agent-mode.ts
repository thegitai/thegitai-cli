import type { ToolCall } from './types.js';

export const AGENT_MODES = ['default', 'auto-accept', 'plan'] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

const PLAN_MODE_TOOL_NAMES = new Set([
  'list_files',
  'list_directories',
  'read_file',
  'grep_code',
  'read_document',
  'analyze_image',
  'run_command',
  // Read-only status polling of an existing managed job. Starting
  // (background: true) and killing jobs stay blocked in plan mode.
  'shell_job_output',
  // Session-visible progress list only; touches no files.
  'update_todos',
]);

const PLAN_MODE_RUN_COMMAND_NAMES = new Set([
  'pwd',
  'ls',
  'find',
  'fd',
  'rg',
  'grep',
  'cat',
  'sed',
  'nl',
  'head',
  'tail',
  'wc',
  'jq',
]);

const PLAN_MODE_RUN_COMMAND_ACTION =
  'Plan mode is read-only inspection only. Use read_file, read_document, grep_code, list_files, list_directories, symbol tools, or a bounded file/directory reading command. Switch to Default mode for tests, builds, diagnostics, installs, project execution, network probes, or edits.';

export function normalizeAgentMode(value: unknown): AgentMode {
  return AGENT_MODES.includes(value as AgentMode)
    ? (value as AgentMode)
    : 'default';
}

export function nextAgentMode(mode: AgentMode): AgentMode {
  if (mode === 'default') return 'auto-accept';
  if (mode === 'auto-accept') return 'plan';
  return 'default';
}

export function agentModeAllowsTool(mode: AgentMode, toolName: string): boolean {
  return mode !== 'plan' || PLAN_MODE_TOOL_NAMES.has(toolName);
}

/**
 * Blank out quoted spans so shell metacharacters inside quotes are not mistaken
 * for real operators. Shared with the permission layer, which uses it to decide
 * whether a command is a single command.
 */
export function getUnquotedShellText(command: string): string {
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  let text = '';
  for (const char of String(command)) {
    if (escaped) {
      escaped = false;
      text += ' ';
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      text += ' ';
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      text += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      text += ' ';
      continue;
    }
    text += char;
  }
  return text;
}

function planModeRunCommandBlockReason(command: string): string | null {
  const raw = String(command);
  const text = getUnquotedShellText(command).trim();
  if (!text) return 'Plan mode run_command requires a command.';
  if (
    /[<>]/.test(text) ||
    /\$\(/.test(text) ||
    /\bfind\b[\s\S]*(?:\s-delete\b|\s-exec\b)/.test(text) ||
    /\bsed\b[\s\S]*(?:^|\s|["'])-i(?:\b|[A-Za-z])/.test(raw)
  ) {
    return PLAN_MODE_RUN_COMMAND_ACTION;
  }
  const segments = text
    .split(/\s*(?:&&|\|\||;|\|)\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return 'Plan mode run_command requires a command.';
  for (const segment of segments) {
    const tokens = segment.match(/\S+/g) ?? [];
    let commandName = '';
    for (const token of tokens) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (token === 'command') continue;
      commandName = token;
      break;
    }
    commandName = commandName.split('/').pop() ?? commandName;
    if (!PLAN_MODE_RUN_COMMAND_NAMES.has(commandName)) {
      return PLAN_MODE_RUN_COMMAND_ACTION;
    }
  }
  return null;
}

export function buildAgentModeToolBlockedResult(
  mode: AgentMode,
  call: ToolCall,
) {
  if (mode !== 'plan') return null;
  if (!PLAN_MODE_TOOL_NAMES.has(call.name)) {
    return buildPlanModeToolBlockedResult(call.name);
  }
  if (call.name !== 'run_command') return null;
  // Starting a managed background job is never read-only, even when the
  // command itself is on the plan-mode inspection allowlist.
  if (
    call.args?.background === true
  ) {
    return buildPlanModeToolBlockedResult(
      call.name,
      PLAN_MODE_RUN_COMMAND_ACTION,
    );
  }
  const command = String(call.args?.command ?? call.args?.cmd ?? '');
  const reason = planModeRunCommandBlockReason(command);
  return reason ? buildPlanModeToolBlockedResult(call.name, reason) : null;
}

export function buildPlanModeToolBlockedResult(
  toolName: string,
  action = 'Plan mode is read-only inspection only. Ask any needed question, use allowed inspection tools, or tell the user to switch modes before execution.',
) {
  return {
    ok: false,
    failureCategory: 'policy_blocked' as const,
    failureDetails: {
      category: 'policy_blocked' as const,
      tool: toolName,
      action,
    },
    error: `Plan mode blocked ${toolName}. ${action}`,
  };
}

export function agentModeLabel(mode: AgentMode): string {
  if (mode === 'auto-accept') return 'Auto-Accept';
  if (mode === 'plan') return 'Plan · read-only';
  return 'Default';
}
