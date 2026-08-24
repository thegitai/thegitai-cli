#!/usr/bin/env node
import chalk from '../src/colors.js';
import { ServerApi } from '../src/api/index.js';
import { DEFAULT_THEGITAI_HOST } from '../src/api/default-host.js';
import { isSignInCancelled } from '../src/api/browser-login.js';
import { runSignIn } from '../src/signin.js';
import {
  STARTUP_RETRY_BUDGET,
  authenticationErrorMessage,
  isAuthenticationError,
  isTransientNetworkError,
} from '../src/api/http.js';
import type { WhoAmIResponse } from '../src/api/contracts.js';
import type { ServerModelsResponse } from '../src/api/models.js';
import { formatCliHelpText } from '../src/help-text.js';
import { createSession, type SessionState } from '../src/session.js';
import {
  applySessionSnapshot,
  listSessionMetadata,
  loadSessionSnapshot,
  saveSessionState,
  sessionHasUserMessage,
} from '../src/session-store.js';
import { runClientInteractive } from '../src/ui/repl.js';
import { appendPromptToFile } from '../src/ui/prompt-history-store.js';
import { formatSessionExitNotice } from '../src/session-exit.js';
import { formatUsageText } from '../src/usage.js';
import { formatVersionLine } from '../src/version.js';
import { parseArgs } from '../src/cli-args.js';

const { auth, chat, models, sessions } = ServerApi;

function printUsage(): void {
  console.log(formatCliHelpText({ color: process.stdout.isTTY === true }));
}

/**
 * Describe why the server could not be reached, in the terms a user can act on.
 * Node reports an aborted request as "The operation was aborted due to timeout",
 * which names the mechanism that gave up rather than the thing that went wrong.
 */
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
    // `logout` while signed out is a request that is already satisfied, so it
    // succeeds rather than failing. `whoami` is a query and deliberately does
    // NOT sign anyone in — asking who you are should not change who you are —
    // but it still names the way forward, which is the whole point of this PR.
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
    // Revoking server-side is best effort, matching `/logout` in-session: if it
    // fails (offline, token already expired) the local credential still has to
    // go, or someone who asked to be signed out is left holding one.
    try {
      await auth.logoutFromServer({ config });
    } catch {
      // Intentionally ignored; clearing locally is the part that matters.
    }
    auth.clearCliAuthConfig();
    console.log(chalk.green('Logged out.'));
    return;
  }

  throw new Error(`Unknown auth command: ${command}`);
}

/**
 * Returns the stored credential, signing the user in first if there isn't one.
 * Being signed in is a state the CLI resolves on the user's behalf, not a
 * command they are expected to know: bouncing someone who typed `ai` with
 * "run `ai login` first" asks them to guess the next move, and a good number
 * of them simply don't.
 *
 * Without a terminal there is nobody to prompt, so a script or CI job still
 * gets a plain error naming the command a human would run.
 */
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
  // `login` is not a separate destination any more — it signs you in if you
  // aren't, and then does exactly what bare `ai` does. Somebody who types it
  // out of habit while already signed in gets their session, not a detour to
  // the website.
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
  // The model cache is a single global file but records the server it was
  // written for. Ignore it when the active auth config points at a different
  // server, so a transient /v1/models failure can't seed this session with
  // another server's model IDs (which would then be rejected on the next turn).
  const cachedModels = models.selectCacheForServer(
    models.readCachedServerModels(),
    authConfig.serverUrl,
  );

  // A transient network blip on startup must never lock the user out. The API
  // layer already retries transport failures; if it still can't reach the
  // server we degrade to cached settings so the shell opens and reconnects on
  // the next turn. Real errors (bad auth, HTTP 4xx/5xx) still surface.
  //
  // The two requests are independent, so they go out together: run in sequence
  // each one pays its own retry ladder, and a network bad enough to stall both
  // costs the user the sum of the two before anything appears on screen.
  const [modelsOutcome, whoamiOutcome] = await Promise.allSettled([
    models.fetchServerModels({
      config: authConfig,
      budget: STARTUP_RETRY_BUDGET,
    }),
    auth.fetchWhoamiResponse({
      config: authConfig,
      budget: STARTUP_RETRY_BUDGET,
    }),
  ]);

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
    // Nothing cached to fall back on, so the shell genuinely cannot open: we do
    // not know which models this account may use. Say that in words the user
    // can act on — the raw abort reason ("The operation was aborted due to
    // timeout") names a mechanism, not a problem, and reads like a crash.
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


  const initialPrompt = prompt || undefined;

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
    // The token this client was saving with has just been revoked, so the
    // server-side save would only produce a 401 warning on the way out.
    if (sessionHasUserMessage(session)) {
      saveSessionState(session);
    }
    console.log(chalk.green('\n✓ Logged out.\n'));
    return;
  }
  await saveSessionBoth({ session, serverSessionClient });
  printSessionExit(session);
}

main().catch((error) => {
  // Ctrl+C at the sign-in prompt is the documented way out of that screen, and
  // it is what the long loopback timeout assumes people will reach for. Node
  // surfaces it as an AbortError on the pending question rather than as
  // SIGINT, so without this it would print like a crash and leave the user
  // wondering whether anything was written. 130 is the usual SIGINT status.
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
