import chalk from './colors.js';
import { getCliVersion, getPlatformTag } from './version.js';

export interface HelpTextOptions {
  color?: boolean;
}

// The bound keys (Enter/Esc/Ctrl+C/Tab/arrows) are identical across platforms in
// a terminal. The one thing that genuinely differs is the terminal's paste
// shortcut, so surface the one for the host OS (right-click paste works
// everywhere regardless).
function pasteShortcutForPlatform(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Cmd+V';
    case 'win32':
      return 'Ctrl+V';
    default:
      return 'Ctrl+Shift+V';
  }
}

const PASTE_SHORTCUT = pasteShortcutForPlatform();

const HELP_MARKDOWN = [
  '# TheGitAI',
  '',
  'Interactive terminal coding agent. Local repo search, file edits, and',
  'shell commands run on your machine. Model inference and server-executed',
  'tools run on the server.',
  '',
  '## Usage',
  '',
  '- `ai` — start an interactive chat session in the current repo',
  '- `ai "<request>"` — start an interactive session with `<request>` as the first message',
  '- Coding sessions require terminal stdin and stdout; piped prompts are not supported.',
  '',
  '## Auth',
  '',
  '- `ai` — signs you in if you are not already, then starts a session',
  '- `ai login` — the same thing; kept for muscle memory',
  '- Signing in opens your browser. When it cannot open one — over SSH, in a',
  '  container, or when the browser you want is on another device — the same',
  '  screen prints a URL you can open anywhere and takes the code that page',
  '  gives you back. There is no mode to pick and no flag to remember.',
  '- `ai whoami` — show the signed-in account',
  '- `ai --usage` — show account usage percentage and reset times',
  '- `ai logout` — sign out',
  '',
  '## Sessions',
  '',
  '- `ai --list-sessions` — list saved sessions for this repo',
  '- `ai --session <id|name>` — resume a saved session by id or name',
  '- Sessions are stored locally and can be listed or resumed in the same repo.',
  '  Continuing one requires the TheGitAI account used for that session.',
  '',
  '## Options',
  '',
  '- `-y, --yes` — start in Auto-Accept mode',
  '- `-h, --help` — show this help',
  '- `-v, --version` — print the version and exit',
  '',
  '## Modes',
  '',
  '- Default — asks before creating, editing or deleting files and before',
  '  running commands. Each answer can be remembered for the rest of the',
  '  session; see Safety & approvals.',
  '- Auto-Accept — approves shell commands and file edits for the session.',
  '- Plan — read-only; the agent can inspect, ask typed questions, and plan,',
  '  with file-reading shell commands only. It will not edit files or run tests,',
  '  builds, diagnostics, package managers, project code, or network probes.',
  '- In the TUI, Shift+Tab cycles modes, mouse drag copies transcript/footer text, left-click opens rendered links, right-click copies rendered links or pastes in the sticky composer/footer when no selection is active, double-click copies a word, and triple-click copies a row.',
  '',
  '## Keys & clipboard',
  '',
  '- **Enter** sends • **Shift+Tab** cycles modes • **Esc** cancels the turn •',
  '  **Ctrl+C** clears the composer or the queued message, and quits once there',
  '  is nothing left to clear. These are the same on macOS, Linux, and Windows.',
  '- **While the agent is working**, Enter queues your message and locks the',
  '  composer. Press **Enter** again to send it into the running turn: the agent',
  '  picks it up at its next step instead of waiting for the turn to finish, and',
  '  the Your messages panel tracks it from queued to delivered. **↑** brings it',
  '  back for editing and **Esc**/**Ctrl+C** discards it; both unlock the',
  '  composer for the next message. **Ctrl+V** pastes a screenshot onto the',
  '  queued message, and it is delivered into the running turn with the text.',
  `- **Paste** into the composer with your terminal's paste shortcut (\`${PASTE_SHORTCUT}\``,
  '  on this system) or by right-clicking the composer.',
  '- **Copy** from the transcript by dragging to select; double-click copies a',
  '  word and triple-click copies a row. Left-click opens rendered links.',
  ...(process.platform === 'darwin'
    ? ['- On Mac laptops without dedicated keys, **Home/End** are `Fn+←` / `Fn+→`.']
    : []),
  '',
  '## Chat commands',
  '',
  '- `/help` — show this help',
  '- `/about` — show version and platform info',
  '- `/usage` — show account usage percentage and reset times',
  '- `/model` — list supported models and pick one',
  '- `/model <id>` — switch the active model without clearing history',
  '- `/resume` — resume a saved session for this repo',
  '- `/jobs` — manage long-running commands like dev servers and watchers:',
  '  browse them, press Enter to expand one and read its output, k to stop it',
  '- `/jobs output <id>` — print one job\'s full captured output',
  '- `/jobs kill <id>` — stop one background job',
  '- `/new` — start a new conversation; this session remains saved',
  '- `/logout` — sign out and quit',
  '- `/exit` — quit the session',
  '',
  '## Safety & approvals',
  '',
  '- In Default mode TheGitAI asks before it creates a file, edits an existing',
  '  file, deletes a file, or runs a command. These are four separate',
  '  permissions: allowing edits does not allow deletions, and allowing file',
  '  changes does not allow commands.',
  '- At each prompt: **↑/↓** moves between choices, **Enter** confirms the',
  '  highlighted one, and **Esc** denies. Deny is selected by default.',
  '  Single-letter shortcuts were removed on purpose: a prompt can appear',
  '  while you are typing, and a stray letter must never approve anything.',
  '- Every prompt offers Approve once, an "Always allow" for that kind of',
  '  action, and Deny. A command also offers to remember just its prefix — for',
  '  example approving `npm test -- --watch=false` can allow `npm test`.',
  '- A prefix is only offered when the command shows a plain verb, as in',
  '  `npm test` or `git status`. Commands with no verb (`ls -la`), interpreters',
  '  and wrappers (`bash -c`, `python -c`, `env`, `timeout`, `make`), and',
  '  destructive or network binaries (`rm`, `sudo`, `curl`) are never offered',
  '  one — a bare binary grant would mean "anything this program can do".',
  '  `npm run` must name its script, so the grant is `npm run build`.',
  '- A remembered prefix never covers a command that chains, pipes, redirects,',
  '  or substitutes, so allowing `npm test` can never green-light',
  '  `npm test && rm -rf build`.',
  '- Everything you allow lasts for the current session only and is forgotten',
  '  when it ends. `/new` clears it immediately.',
  '- If an approved `sudo` command needs a password, the TUI shows the exact',
  '  command and keeps the password masked and local.',
  '- `-y` / `--yes` at startup auto-approves every shell command and file',
  '  edit for the whole session — use with care.',
  '- Long-running commands (e.g. dev servers) can run as managed background',
  '  jobs after the same approval as any other command. Background output',
  '  stays quiet once the model has responded; the footer shows only a compact',
  '  shell-running indicator, `/jobs` lists, inspects, and kills jobs, and',
  '  killed jobs disappear immediately. Every job is killed when the session',
  '  ends.',
  '- File and shell operations are confined to the target repo root.',
  '- Sensitive directories (`.git`, `node_modules`, build output) are',
  '  excluded from search and listing.',
  '',
  '## Troubleshooting',
  '',
  '- Auth or permission errors → run `ai whoami` to confirm the signed-in',
  '  account.',
  '- Usage or quota errors → run `ai --usage`.',
  '- Signed in with the wrong account → `/logout` (or `ai logout`), then run',
  '  `ai` and sign in as the account you intended to use.',
  '- The browser did not open, or opened on the wrong machine → open the URL',
  '  printed on the sign-in screen anywhere you like, choose "On another',
  '  computer" on that page, and paste the code back into the terminal.',
  '- A local session was used with a different sign-in → sign in with the',
  '  account you used for that session or start a new session.',
  '- For anything else, re-run the command and report the printed error',
  '  message — there is no client-side debug mode by design.',
].join('\n');

export function formatAboutCard(): string {
  // Fenced so the column alignment survives terminal markdown rendering.
  return [
    '```',
    'TheGitAI',
    `  Version   ${getCliVersion()}`,
    `  Platform  ${getPlatformTag()}`,
    `  Node      ${process.version}`,
    '```',
  ].join('\n');
}

export function formatHelpMarkdown(): string {
  return HELP_MARKDOWN;
}

export function formatInteractiveHelpText(): string {
  return HELP_MARKDOWN;
}

export function formatCliHelpText({ color = false }: HelpTextOptions = {}): string {
  if (!color) {
    return HELP_MARKDOWN.split('\n')
      .map((line) =>
        line
          .replace(/^#{1,6}\s+/, '')
          .replace(/^-\s+/, '  ')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1'),
      )
      .join('\n');
  }
  return HELP_MARKDOWN.split('\n')
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1]!.length;
        const text = heading[2] ?? '';
        return level === 1 ? chalk.bold.cyan(text) : chalk.bold(text);
      }
      let styled = line.replace(/`([^`]+)`/g, (_match, code) => chalk.cyan(code));
      styled = styled.replace(/\*\*([^*]+)\*\*/g, (_match, bold) => chalk.bold(bold));
      return styled;
    })
    .join('\n');
}
