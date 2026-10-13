export const AUTH_COMMANDS = new Set(['login', 'whoami', 'logout']);

export interface ParsedArgs {
  command: string | null;
  autoYes: boolean;
  help: boolean;
  version: boolean;
  usage: boolean;
  session: string | null;
  listSessions: boolean;
  unknownOption: string | null;
  prompt: string;
}


function hasPromptWordsAfter(args: string[]): boolean {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--session' || arg === '--resume') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return true;
  }
  return false;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const firstArg = args[0];










  const command =
    firstArg && AUTH_COMMANDS.has(firstArg) &&
    (firstArg !== 'login' || !hasPromptWordsAfter(args))
      ? firstArg
      : null;
  let autoYes = false;
  let help = false;
  let version = false;
  let usage = false;
  let session: string | null = null;
  let listSessions = false;
  let unknownOption: string | null = null;
  const promptParts: string[] = [];




  for (let i = command ? 1 : 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--yes' || arg === '-y') {
      autoYes = true;
      continue;
    }

    if ((arg === '--session' || arg === '--resume') && i + 1 < args.length) {
      session = args[i + 1] ?? null;
      i += 1;
      continue;
    }

    if (arg === '--list-sessions') {
      listSessions = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }

    if (arg === '--usage') {
      usage = true;
      continue;
    }








    if (unknownOption === null && /^-/.test(arg)) {
      unknownOption = arg;
      continue;
    }

    promptParts.push(arg);
  }

  return {
    command,
    autoYes,
    help,
    version,
    usage,
    session,
    listSessions,
    unknownOption,
    prompt: promptParts.join(' ').trim(),
  };
}
