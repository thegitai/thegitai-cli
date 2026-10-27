











export interface SlashCommandOption {
  command: string;
  description: string;






  aliases?: string[];
  skill?: boolean;
}

export const SLASH_COMMANDS: SlashCommandOption[] = [
  { command: '/model', description: 'Choose a model and project reasoning effort' },
  { command: '/help', description: 'Show available chat commands' },
  { command: '/usage', description: 'Show account usage percentage and reset times' },
  {
    command: '/resume',
    description: 'Open the session picker to resume a previous session',
  },
  { command: '/new', description: 'start a new conversation; this session remains saved' },
  { command: '/mcp', description: 'Check MCP connections and available tools' },
  { command: '/skills', description: 'List installed skills, or add one: /skills add <source>' },
  { command: '/jobs', description: 'Background jobs: pick to view output or kill' },
  {
    command: '/notify',
    description: 'Toggle desktop notifications when a turn ends (Ctrl+G)',
  },
  { command: '/report', description: 'Report a bug privately on the TheGitAI website' },
  { command: '/about', description: 'Show version and platform info' },
  { command: '/logout', description: 'Sign out and quit' },
  { command: '/exit', description: 'Quit the current session', aliases: ['/quit'] },
];


export const SLASH_COMMAND_SUGGESTION_LIMIT = 5;

let skillCommands: SlashCommandOption[] = [];

export function setSkillSlashCommands(
  skills: Array<{ name: string; description: string; argumentHint?: string }>,
): void {
  const builtins = new Set(SLASH_COMMANDS.flatMap((option) => [option.command, ...(option.aliases ?? [])]));
  skillCommands = skills
    .filter((skill) => !builtins.has(`/${skill.name}`))
    .map((skill) => ({
      command: `/${skill.name}`,
      description: skill.argumentHint ? `${skill.argumentHint} · ${skill.description}` : skill.description,
      skill: true,
    }));
}

export function isSkillSlashCommand(option: SlashCommandOption): boolean {
  return option.skill === true;
}

function allSlashCommands(): SlashCommandOption[] {
  return skillCommands.length ? [...SLASH_COMMANDS, ...skillCommands] : SLASH_COMMANDS;
}

export function getInputCommandToken(input: string): string {
  const trimmed = String(input ?? '').trimStart();
  const match = trimmed.match(/^\/[^\s]*/);
  const token = match?.[0] ?? '';


  if (token.indexOf('/', 1) !== -1) return '';
  return token;
}










export function slashCommandMatchesToken(
  option: SlashCommandOption,
  token: string,
): boolean {
  return option.command === token || (option.aliases?.includes(token) ?? false);
}




const MATCH_EXACT = 0;
const MATCH_PREFIX = 100;
const MATCH_OVERTYPED = 200;
const MATCH_TYPO = 300;
const MATCH_IN_NAME = 400;
const MATCH_IN_DESCRIPTION = 500;
const MATCH_NONE = 600;






function typoBudget(body: string): number {
  if (body.length <= 3) return 0;
  if (body.length <= 5) return 1;
  return 2;
}








function editDistanceWithin(a: string, b: string, max: number): number | null {
  if (a === b) return 0;
  if (max <= 0) return null;
  if (Math.abs(a.length - b.length) > max) return null;
  const width = b.length + 1;
  let beforePrevious: number[] = [];
  let previous: number[] = Array.from({ length: width }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = new Array(width);
    current[0] = i;
    let best = i;
    for (let j = 1; j < width; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      let cost = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitution,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, beforePrevious[j - 2]! + 1);
      }
      current[j] = cost;
      if (cost < best) best = cost;
    }


    if (best > max) return null;
    beforePrevious = previous;
    previous = current;
  }
  const distance = previous[b.length]!;
  return distance <= max ? distance : null;
}

function scoreSlashCommand(option: SlashCommandOption, token: string): number {
  const command = option.command;
  const body = token.slice(1);


  if (!body) return MATCH_PREFIX;
  const spellings = [command, ...(option.aliases ?? [])];
  if (slashCommandMatchesToken(option, token)) return MATCH_EXACT;
  if (spellings.some((spelling) => spelling.startsWith(token))) return MATCH_PREFIX;





  const overtyped = spellings.find((spelling) => token.startsWith(spelling));
  if (overtyped) {
    return MATCH_OVERTYPED + Math.min(token.length - overtyped.length, 99);
  }
  const distances = spellings
    .map((spelling) => editDistanceWithin(body, spelling.slice(1), typoBudget(body)))
    .filter((distance): distance is number => distance !== null);
  if (distances.length) return MATCH_TYPO + Math.min(...distances);
  if (command.includes(body)) return MATCH_IN_NAME;
  if (option.description.toLowerCase().includes(body)) return MATCH_IN_DESCRIPTION;
  return MATCH_NONE;
}

function rankSlashCommands(input: string): SlashCommandOption[] {
  const token = getInputCommandToken(input).toLowerCase();
  if (!token) return [];
  return allSlashCommands().map((option, order) => ({
    option,
    order,
    score: scoreSlashCommand(option, token),
  }))
    .filter((entry) => entry.score < MATCH_NONE)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.option);
}







export function getSlashCommandSuggestions(input: string): SlashCommandOption[] {
  return rankSlashCommands(input).slice(0, SLASH_COMMAND_SUGGESTION_LIMIT);
}


export function getHiddenSlashCommandCount(input: string): number {
  return Math.max(0, rankSlashCommands(input).length - SLASH_COMMAND_SUGGESTION_LIMIT);
}
