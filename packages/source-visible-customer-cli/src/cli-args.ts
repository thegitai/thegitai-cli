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

/** Whether anything after the first token is prompt text rather than a flag. */
function hasPromptWordsAfter(args: string[]): boolean {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    // These take a value, which is a session id and not prompt text.
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
  // `login` is now a word that continues into a session, so treating the first
  // token as a command whenever it merely *starts* the line would drop it:
  // `ai login page is broken` would silently open a billable session on "page
  // is broken". Flags are not prompt words, so `ai login -y` is still the
  // subcommand.
  //
  // This applies to `login` alone. `whoami` and `logout` do not continue into
  // a session, so for them a trailing word has no prompt to be rescued into —
  // demoting them would convert a command that was about to run into exactly
  // the billable session this rule exists to prevent.
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

  // Skip the subcommand token itself. `login` now falls through into a normal
  // session once the user is signed in, so leaving "login" in the loop would
  // sweep it into the prompt and open a session asking about the word "login".
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

    // An unrecognized dashed token is a mistyped flag, not prompt text, or it
    // would be swept into the prompt and silently start a billable session.
    // Flag the first one so the caller can fail fast instead. Quoted prompts
    // are a single argv entry with spaces, so they never look like a bare
    // option here. This applies to subcommands too: none of them take flags
    // any more, so `ai login --no-browser` names the removed flag out loud
    // rather than quietly ignoring it.
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
