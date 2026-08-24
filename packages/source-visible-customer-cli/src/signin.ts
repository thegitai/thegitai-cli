import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import chalk from './colors.js';
import { auth } from './api/index.js';
import type { CliAuthConfig } from './api/auth.js';
import { DEFAULT_THEGITAI_HOST } from './api/default-host.js';
import { loginViaBrowser } from './api/browser-login.js';

/**
 * OSC 8 hyperlink. Terminals that don't implement it print the label and drop
 * the escape, so this degrades to plain text rather than to line noise — but
 * the raw URL is always printed above it regardless, because a label alone is
 * useless to anyone copying the link to another machine.
 */
function hyperlink(url: string, label: string): string {
  if (process.stdout.isTTY !== true) return label;
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

/**
 * The whole sign-in screen, in one frame. Every route the user might need is
 * on it at once — the browser we are about to open, the URL to carry to
 * another device, and the code box below — because the CLI cannot tell which
 * of them will work from here, and asking the user to pick a mode up front
 * (the old `--no-browser`) only works if they already know the answer.
 */
export function formatSignInScreen({ url }: { url: string }): string {
  return [
    '',
    `  ${chalk.bold.cyan('TheGitAI')}`,
    '',
    `  ${chalk.bold('Sign in to continue.')}`,
    '  Your browser should open automatically. If not, copy this URL:',
    '',
    `  ${chalk.cyan(url)}`,
    '',
    `  ${hyperlink(url, chalk.cyan('→ Click here to authenticate'))}`,
    '',
    // Not dimmed. Half of everyone who reaches this screen needs this sentence,
    // and the same instruction rendered in the website's faintest grey is what
    // made the remote path unfindable in the first place.
    '  If this terminal is not on the computer where that page opened, choose',
    `  ${chalk.bold('"On another computer"')} there and paste the code it gives you below.`,
    '',
  ].join('\n');
}

/**
 * Reads a pasted authorization code, abandoning the prompt the moment the
 * browser redirect wins the race. The readline interface is torn down in both
 * outcomes so the terminal is never left in a half-raw state.
 */
async function promptForCode(signal: AbortSignal): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(`  ${chalk.bold('Authorization code:')} `, { signal });
  } finally {
    rl.close();
  }
}

export interface SignInOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  login?: typeof loginViaBrowser;
  write?: typeof auth.writeCliAuthConfig;
  log?: (line: string) => void;
}

/**
 * Runs the interactive sign-in and persists the credential. Returns the config
 * so the caller can carry straight on into a session rather than making the
 * user re-run the command they already ran.
 */
export async function runSignIn({
  env = process.env,
  login = loginViaBrowser,
  write = auth.writeCliAuthConfig,
  log = (line: string) => console.log(line),
}: SignInOptions = {}): Promise<CliAuthConfig> {
  const result = await login({
    // The public CLI always authenticates against the official TheGitAI host.
    // There is intentionally no server/website override here — internal dev
    // uses private tooling, not a customer-visible runtime override path.
    serverUrl: DEFAULT_THEGITAI_HOST,
    deviceName: env.THEGITAI_DEVICE_NAME?.trim() || undefined,
    onUrl: (url) => log(formatSignInScreen({ url })),
    onBrowserOpen: (opened) => {
      if (!opened) {
        log(chalk.dim('  (no browser opened — use the URL or the code box above)'));
      }
    },
    promptCode: promptForCode,
    onPasteRejected: (message) =>
      log(
        `  ${chalk.red('✖')} ${message}\n` +
          '    Codes last 10 minutes. If that page has been open a while, run `ai`\n' +
          '    again for a fresh one.',
      ),
  });
  write(result, env);
  log('');
  log(chalk.green(`  ✓ Signed in as ${result.customer.email}`));
  log('');
  return result;
}
