import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import chalk from './colors.js';
import { auth } from './api/index.js';
import type { CliAuthConfig } from './api/auth.js';
import { DEFAULT_THEGITAI_HOST } from './api/default-host.js';
import { loginViaBrowser } from './api/browser-login.js';







function hyperlink(url: string, label: string): string {
  if (process.stdout.isTTY !== true) return label;
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}








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



    '  If this terminal is not on the computer where that page opened, choose',
    `  ${chalk.bold('"On another computer"')} there and paste the code it gives you below.`,
    '',
  ].join('\n');
}






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

  login?: typeof loginViaBrowser;
  write?: typeof auth.writeCliAuthConfig;
  log?: (line: string) => void;
}






export async function runSignIn({
  env = process.env,
  login = loginViaBrowser,
  write = auth.writeCliAuthConfig,
  log = (line: string) => console.log(line),
}: SignInOptions = {}): Promise<CliAuthConfig> {
  const result = await login({



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
