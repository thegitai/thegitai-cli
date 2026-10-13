#!/usr/bin/env node
import { runMcpCommand } from '../src/mcp-command.js';
import chalk from '../src/colors.js';
import { ServerApi } from '../src/api/index.js';
import { DEFAULT_THEGITAI_HOST } from '../src/api/default-host.js';
import { isSignInCancelled } from '../src/api/browser-login.js';
import { runSignIn } from '../src/signin.js';
import {
  ServerApiError,
  authenticationErrorMessage,
  isAuthenticationError,
  isTransientNetworkError,
} from '../src/api/http.js';
import { loadStartupHandshake } from '../src/api/startup-handshake.js';
import {
  TURN_RECOVERY_DELAY_MS,
  TURN_RECOVERY_RETRIES,
} from '../src/api/turn-recovery.js';
import type { WhoAmIResponse } from '../src/api/contracts.js';
import type { ServerModelsResponse } from '../src/api/models.js';
import { formatCliHelpText } from '../src/help-text.js';
import { createSession, disposeSession, type SessionState } from '../src/session.js';
import {
  applySessionSnapshot,
  listSessionMetadata,
  loadSessionSnapshot,
  saveSessionState,
  sessionHasUserMessage,
} from '../src/session-store.js';
import { runClientInteractive } from '../src/ui/repl.js';
import { startBrowserDiscoveryInBackground } from '../src/browser/session-bridge.js';
import { appendPromptToFile } from '../src/ui/prompt-history-store.js';
import { formatSessionExitNotice } from '../src/session-exit.js';
import { formatUsageText } from '../src/usage.js';
import { getCliVersion, formatVersionLine } from '../src/version.js';
import { offerUpdateAtStartup } from '../src/update-check.js';
import { parseArgs } from '../src/cli-args.js';

const { auth, chat, models, sessions } = ServerApi;

function printUsage(): void {
  console.log(formatCliHelpText({ color: process.stdout.isTTY === true }));
}






function unreachableReason(error: unknown): string {
  const err = error as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = err?.code ?? err?.cause?.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'network timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection reset';
  return err?.message ? String(err.message) : 'network error';
}

function appendPromptHistory(prompt: string, env: NodeJS.ProcessEnv = process.env): void {
  appendPromptToFile(prompt, env);
}

async function runAuthCommand(command: string): Promise<void> {
  const config = auth.readCliAuthConfig();
  if (!config) {




    if (command === 'logout') {
      console.log(chalk.green('Already signed out.'));
      return;
    }
    throw new Error('Not signed in. Run `ai` to sign in.');
  }

  if (command === 'whoami') {
    const customer = await auth.fetchWhoami({ config });
    console.log(chalk.green(customer.email));
    return;
  }

  if (command === 'logout') {



    try {
      await auth.logoutFromServer({ config });
    } catch {

    }
    auth.clearCliAuthConfig();
    console.log(chalk.green('Logged out.'));
    return;
  }

  throw new Error(`Unknown auth command: ${command}`);
}











async function ensureCliAuthConfig() {
  const config = auth.readCliAuthConfig();
  if (config) return config;
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error('Not signed in. Run `ai login` on a terminal to sign in.');
  }
  return await runSignIn();
}

function formatSessionName(name: string | null): string {
  return name ? `"${name}"` : '(unnamed)';
}

function printSessionList(
  rootDir: string,
  sessions: ReturnType<typeof listSessionMetadata>,
  serverModels: ServerModelsResponse | null,
): void {
  console.log(chalk.bold(`Saved sessions for ${rootDir}`));
  if (!sessions.length) {
    console.log(chalk.dim('  No saved sessions for this repo.'));
    return;
  }
  for (const session of sessions) {
    const updated = new Date(session.updatedAt).toLocaleString();
    const label = `${formatSessionName(session.name)} ${chalk.dim(session.id)}`;
    const detail = [
      modelLabel(serverModels, session.modelId),
      `${session.messageCount} messages`,
      `updated ${updated}`,
    ].join(' · ');
    console.log(`  ${label}`);
    console.log(chalk.dim(`    ${detail}`));
    if (session.lastUserMessage) {
      console.log(chalk.dim(`    ${session.lastUserMessage}`));
    }
  }
}

function printSessionExit(session: SessionState): void {
  console.log(chalk.dim(`\n${formatSessionExitNotice(session.sessionId)}\n`));
}

function modelLabel(
  serverModels: ServerModelsResponse | null,
  modelId: number,
): string {
  return (
    serverModels?.models.find((model) => model.id === modelId)?.label ??
    `Model ${modelId}`
  );
}

async function saveSessionBoth({
  session,
  serverSessionClient,
}: {
  session: SessionState;
  serverSessionClient: ReturnType<typeof sessions.createServerSessionClient>;
}): Promise<void> {
  if (!sessionHasUserMessage(session)) return;
  saveSessionState(session);
  try {
    await serverSessionClient.save(session);
  } catch (error: any) {
    console.error(chalk.yellow(`Warning: session save failed: ${error.message}`));
  }
}

function requireInteractiveTerminal(): boolean {
  if (process.stdin.isTTY !== true) {
    console.error('Error: stdin is not a terminal');
    process.exitCode = 1;
    return false;
  }
  if (process.stdout.isTTY !== true) {
    console.error('Error: stdout is not a terminal');
    process.exitCode = 1;
    return false;
  }
  return true;
}
export async function main(): Promise<void> {
  if (process.argv[2] === 'mcp') {
    console.log(runMcpCommand(process.argv.slice(3)));
    return;
  }
  const {
    autoYes,
    help,
    version,
    usage,
    command,
    session: sessionIdentifier,
    listSessions,
    unknownOption,
    prompt,
  } = parseArgs(process.argv);

  if (version) {
    console.log(formatVersionLine());
    return;
  }
  if (help) {
    printUsage();
    return;
  }
  if (unknownOption) {
    console.error(`Unknown option: ${unknownOption}`);
    console.error("Run 'ai --help' to see available commands and options.");
    process.exitCode = 2;
    return;
  }




  if (command && command !== 'login') {
    await runAuthCommand(command);
    return;
  }
  if (usage) {
    const authConfig = await ensureCliAuthConfig();
    console.log(
      formatUsageText(await auth.fetchWhoamiResponse({ config: authConfig })),
    );
    return;
  }

  const rootDir = process.cwd();
  if (listSessions) {
    const activeServerUrl = auth.readCliAuthConfig()?.serverUrl ?? DEFAULT_THEGITAI_HOST;
    printSessionList(
      rootDir,
      listSessionMetadata(rootDir),
      models.selectCacheForServer(
        models.readCachedServerModels(),
        activeServerUrl,
      ),
    );
    return;
  }
  const sourceSnapshot = sessionIdentifier
    ? loadSessionSnapshot(rootDir, sessionIdentifier)
    : null;
  if (sessionIdentifier && !sourceSnapshot) {
    console.error(
      `Error: No saved session named or identified by "${sessionIdentifier}" is available for this repo. Run \`ai --list-sessions\`.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!requireInteractiveTerminal()) {
    return;
  }
  const authConfig = await ensureCliAuthConfig();
  const serverSessionClient = sessions.createServerSessionClient({ config: authConfig });




  const cachedModels = models.selectCacheForServer(
    models.readCachedServerModels(),
    authConfig.serverUrl,
  );






  const { models: modelsOutcome, whoami: whoamiOutcome } = await loadStartupHandshake({
    config: authConfig,
    canStartOffline: Boolean(cachedModels?.models.length),
    onStatus: (status, lastFailure) => {
      if (status.phase === 'waiting') {
        const reason =
          lastFailure instanceof ServerApiError
            ? `HTTP ${lastFailure.status}`
            : unreachableReason(lastFailure);
        console.error(
          chalk.yellow(
            `⚠ Couldn't reach TheGitAI (${reason}) · retrying in ${TURN_RECOVERY_DELAY_MS / 1000}s · retry ${status.retry}/${TURN_RECOVERY_RETRIES}`,
          ),
        );
      } else if (status.phase === 'reconnecting') {
        console.error(chalk.dim(`  Reconnecting · retry ${status.retry}/${TURN_RECOVERY_RETRIES}`));
      } else if (status.phase === 'restored') {
        console.error(chalk.green('✓ Reconnected to TheGitAI'));
      }
    },
  });

  let offlineNotice: string | null = null;
  let serverModels: ServerModelsResponse;
  if (modelsOutcome.status === 'fulfilled') {
    serverModels = modelsOutcome.value;
  } else if (
    isTransientNetworkError(modelsOutcome.reason) &&
    cachedModels?.models.length
  ) {
    serverModels = { models: cachedModels.models };
    offlineNotice = unreachableReason(modelsOutcome.reason);
  } else if (isTransientNetworkError(modelsOutcome.reason)) {




    throw new Error(
      `Couldn't reach TheGitAI to load your models (${unreachableReason(
        modelsOutcome.reason,
      )}).\nCheck your internet connection and run \`ai\` again.`,
    );
  } else {
    throw modelsOutcome.reason;
  }

  let whoami: WhoAmIResponse;
  if (whoamiOutcome.status === 'fulfilled') {
    whoami = whoamiOutcome.value;
  } else if (isTransientNetworkError(whoamiOutcome.reason)) {
    whoami = {
      customer: {
        id: '',
        uuid: '',
        email: authConfig.email,
        customer_type: authConfig.customerType ?? 'USER',
        scopes: [],
      },
      debugUi: { showSessionId: false },
    };
    offlineNotice ??= unreachableReason(whoamiOutcome.reason);
  } else {
    throw whoamiOutcome.reason;
  }

  if (offlineNotice) {
    console.error(
      chalk.yellow(
        `⚠ Couldn't reach TheGitAI (${offlineNotice}). Starting with cached settings — it will reconnect on your next message.`,
      ),
    );
  }







  const updateOutcome = await offerUpdateAtStartup({
    currentVersion: getCliVersion(),
    latestVersion: whoami.release?.latestVersion ?? null,
  });
  if (updateOutcome === 'updated') {
    return;
  }
  if (updateOutcome === 'cancelled') {
    process.exitCode = 130;
    return;
  }

  const selectedModelId = models.selectServerModel({
    requestedModelId: sourceSnapshot?.modelId ?? null,
    cached: cachedModels,
    serverModels,
  });
  models.updateSelectedModelCache({
    config: authConfig,
    selectedModelId,
    serverModels,
  });

  const session = createSession({
    rootDir,
    autoYes,
    modelId: selectedModelId,
  });
  if (sourceSnapshot) {
    applySessionSnapshot(session, sourceSnapshot);
  }






  startBrowserDiscoveryInBackground({ cwd: rootDir, env: session.env });

  const initialPrompt = prompt || undefined;








  try {
    const outcome = await runClientInteractive({
      appendPromptHistory: (value) => appendPromptHistory(value, session.env),
      authConfig,
      debugUi: whoami.debugUi,
      serverModels,
      serverSessionClient,
      session,
      initialPrompt,
      usageText: async () =>
        formatUsageText(await auth.fetchWhoamiResponse({ config: authConfig })),
    });
    if (outcome.signedOut) {


      if (sessionHasUserMessage(session)) {
        saveSessionState(session);
      }
      console.log(chalk.green('\n✓ Logged out.\n'));
      return;
    }
    await saveSessionBoth({ session, serverSessionClient });
    printSessionExit(session);
  } finally {
    await disposeSession(session);
  }
}

main().catch((error) => {





  if (isSignInCancelled(error)) {
    console.error(chalk.dim('\nSign-in cancelled. Nothing was saved.\n'));
    process.exit(130);
  }
  if (isAuthenticationError(error)) {
    auth.clearCliAuthConfig();
    console.error(chalk.red(`\n✖ Error: ${authenticationErrorMessage(error)}\n`));
  } else {
    console.error(chalk.red(`\n✖ Error: ${error.message}\n`));
  }
  process.exit(1);
});
