import fs from 'node:fs';
import path from 'node:path';
import { normalizeProjectRelativePath } from '../artifact-policy.js';
import { BrowserBridgeError } from '../browser/bridge.js';
import { chromeProfileLabel } from '../browser/chrome-profiles.js';
import { isSupportedImageMimeType } from '../core/image-limits.js';
import { storeSessionImageBytes } from '../core/session-image-store.js';
import {
  browserAvailability,
  drainBrowserEvents,
  ensureBrowserBridge,
  resyncBrowserBridge,
  type BrowserAvailability,
} from '../browser/session-bridge.js';
import { getClientStateDir } from '../client-state.js';
import { ensurePermission, originForUrl } from '../permissions.js';
import type { ToolContext, ToolResponse } from './types.js';











const READ_TIMEOUT_MS = 20000;
const NAVIGATE_TIMEOUT_MS = 45000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;


const DISCOVERY_TIMEOUT_MS = 2500;


export const READ_ONLY_BROWSER_TOOLS = new Set([
  'browser',
  'browser_tabs',
  'browser_read_page',
  'browser_get_page_text',
  'browser_find',
  'browser_console',
  'browser_network',
  'browser_screenshot',
]);

function missing(argument: string, tool: string): ToolResponse {
  return {
    ok: false,
    error: `${argument} is required.`,
    failureCategory: 'missing_required_argument',
    failureDetails: {
      category: 'missing_required_argument',
      tool,
      missing: [argument],
      action: `Call ${tool} again with ${argument}.`,
    },
  };
}

async function waitForBrowser(
  options: { cwd: string; env?: NodeJS.ProcessEnv },
  timeoutMs: number,
): Promise<BrowserAvailability> {
  const deadline = Date.now() + timeoutMs;
  const bridge = ensureBrowserBridge(options);
  while (!bridge.status().connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return browserAvailability(options);
}

async function notConnected(
  context: ToolContext,
  { allowUnchosen = false, tabId }: { allowUnchosen?: boolean; tabId?: unknown } = {},
): Promise<ToolResponse> {
  const options = { cwd: context.rootDir, env: context.env };
  const status = ensureBrowserBridge(options).status();
  if (!status.connected) {
    if (status.everConnected) resyncBrowserBridge(options);



    const availability = await waitForBrowser(options, DISCOVERY_TIMEOUT_MS);
    if (!availability.connected) {
      return {
        ok: false,
        connected: false,
        browserErrorCode: 'not_connected',
        error: `TheGitAI is not connected to a browser. ${availability.hint ?? ''}`.trim(),
        failureCategory: 'external_service',
      };
    }
  }
  return allowUnchosen ? { ok: true } : profileChosen(context, Number(tabId));
}

const resolvedProfileNames = new Map<string, string>();

function profileLabel(profile: string): string {
  const unnamed = /^profile ([0-9a-f]{6})$/.exec(profile);
  if (!unnamed) return profile;
  if (!resolvedProfileNames.has(unnamed[1])) {
    resolvedProfileNames.set(unnamed[1], chromeProfileLabel(unnamed[1]) || profile);
  }
  return resolvedProfileNames.get(unnamed[1])!;
}

function describeBrowsers(availability: BrowserAvailability) {
  const latest = Math.max(0, ...availability.browsers.map((browser) => browser.lastFocusedAt ?? 0));
  return [...availability.browsers]
    .sort((a, b) => (b.lastFocusedAt ?? 0) - (a.lastFocusedAt ?? 0))
    .map((browser) => ({
      key: browser.key,
      name: `${browser.browser} - ${profileLabel(browser.profile)}`,
      extensionVersion: browser.extensionVersion,
      ...(latest > 0 && browser.lastFocusedAt === latest ? { lastUsed: true } : {}),
    }));
}

const BROWSER_CHOICES_FILE = 'browser-choices.json';
const BROWSER_CHOICES_KEPT = 200;

type ListedBrowser = ReturnType<typeof describeBrowsers>[number];
type ProfileChoice = { key: string; name: string; at: number };

const sessionProfiles = new Map<string, ProfileChoice>();

function readBrowserChoices(env?: NodeJS.ProcessEnv): Record<string, ProfileChoice> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(getClientStateDir(env), BROWSER_CHOICES_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function profileChoiceFor(context: ToolContext): ProfileChoice | null {
  const session = context.sessionId ?? '';
  const remembered = sessionProfiles.get(session);
  if (remembered) return remembered;
  const saved = session ? readBrowserChoices(context.env)[session] : undefined;
  if (!saved?.key) return null;
  const choice = { key: String(saved.key), name: String(saved.name ?? saved.key), at: Number(saved.at) || 0 };
  sessionProfiles.set(session, choice);
  return choice;
}

function recordProfileChoice(context: ToolContext, browser: ListedBrowser): void {
  const session = context.sessionId ?? '';
  const choice = { key: browser.key, name: browser.name, at: Date.now() };
  sessionProfiles.set(session, choice);
  if (!session) return;
  try {
    const choices = readBrowserChoices(context.env);
    choices[session] = choice;
    const kept = Object.fromEntries(
      Object.entries(choices)
        .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))
        .slice(0, BROWSER_CHOICES_KEPT),
    );
    const dir = getClientStateDir(context.env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BROWSER_CHOICES_FILE), JSON.stringify(kept), { mode: 0o600 });
  } catch {

  }
}

async function askForProfile(
  context: ToolContext,
  listed: ListedBrowser[],
  suggested: ListedBrowser | undefined,
): Promise<ListedBrowser | 'cancelled' | { text: string } | null> {
  if (!context.requestUserInput) return null;
  const recommended = suggested ?? listed.find((browser) => browser.lastUsed) ?? listed[0]!;
  const ordered = [recommended, ...listed.filter((browser) => browser.key !== recommended.key)];
  const result = await context.requestUserInput({
    questions: [
      {
        id: 'chrome_profile',
        header: 'Chrome profile',
        question: 'Which Chrome profile should TheGitAI use for this conversation?',
        options: ordered.map((browser, index) => ({
          id: `profile_${index}`,
          label: browser.name,
          description: browser.lastUsed ? 'The profile you used last' : 'Connected',
        })),
        multiSelect: false,
        recommendedOptionId: 'profile_0',
      },
    ],
  });
  if (result?.status !== 'submitted') return 'cancelled';
  const answer = result.answers?.chrome_profile;
  const option = /^profile_(\d+)$/.exec(answer?.selectedOptionIds?.[0] ?? '');
  if (option && ordered[Number(option[1])]) return ordered[Number(option[1])]!;
  const text = String(answer?.customText ?? '').trim();
  return text ? { text } : 'cancelled';
}

async function useProfile(
  context: ToolContext,
  listed: ListedBrowser[],
  suggested?: ListedBrowser,
): Promise<ToolResponse> {
  const bridge = ensureBrowserBridge({ cwd: context.rootDir, env: context.env });
  const choice =
    listed.length === 1 ? listed[0] : await askForProfile(context, listed, suggested);
  if (choice === 'cancelled') {
    return {
      ok: false,
      browserErrorCode: 'profile_question_cancelled',
      error: 'The user closed the question about which Chrome profile to use, so nothing was done.',
      failureCategory: 'user_declined',
      browsers: listed,
    };
  }
  if (choice && typeof choice === 'object' && 'text' in choice) {
    return {
      ok: false,
      browserErrorCode: 'profile_answered_in_text',
      error: `Asked which Chrome profile to use, the user answered in their own words instead of picking one: "${choice.text.slice(0, 300)}". Nothing was done.`,
      failureCategory: 'user_declined',
      browsers: listed,
    };
  }
  const picked = choice ?? suggested;
  if (!picked) {
    return {
      ok: false,
      browserErrorCode: 'browser_not_chosen',
      error: `${listed.length} Chrome profiles are connected and none has been chosen for this conversation.`,
      failureCategory: 'invalid_argument',
      browsers: listed,
    };
  }
  recordProfileChoice(context, picked);
  if (!bridge.selectBrowser(picked.key)) {
    return {
      ok: false,
      browserErrorCode: 'chosen_profile_missing',
      error: `The Chrome profile chosen for this conversation, ${picked.name}, is not connected.`,
      failureCategory: 'external_service',
      browsers: describeBrowsers(browserAvailability({ cwd: context.rootDir, env: context.env })),
    };
  }
  return { ok: true };
}

async function profilesHoldingTab(
  context: ToolContext,
  listed: ListedBrowser[],
  tabId: number,
): Promise<ListedBrowser[]> {
  const bridge = ensureBrowserBridge({ cwd: context.rootDir, env: context.env });
  const holders = await Promise.all(
    listed.map(async (browser) => {
      try {
        const result = await bridge.request('context', { includeAll: true }, { timeoutMs: READ_TIMEOUT_MS, browser: browser.key });
        const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
        return tabs.some((tab: any) => Number(tab?.tabId) === tabId) ? browser : null;
      } catch {
        return null;
      }
    }),
  );
  return holders.filter((browser): browser is ListedBrowser => browser !== null);
}

async function profileChosen(context: ToolContext, tabId = NaN): Promise<ToolResponse> {
  const options = { cwd: context.rootDir, env: context.env };
  const listed = describeBrowsers(browserAvailability(options));
  const choice = profileChoiceFor(context);
  if (choice) {
    if (ensureBrowserBridge(options).selectBrowser(choice.key)) return { ok: true };
    return {
      ok: false,
      browserErrorCode: 'chosen_profile_missing',
      error: `The Chrome profile chosen for this conversation, ${choice.name}, is not connected.`,
      failureCategory: 'external_service',
      browsers: listed,
    };
  }
  if (!listed.length) return { ok: true };
  if (listed.length > 1 && Number.isInteger(tabId)) {
    const holders = await profilesHoldingTab(context, listed, tabId);
    if (holders.length === 1) {
      ensureBrowserBridge(options).selectBrowser(holders[0]!.key);
      recordProfileChoice(context, holders[0]!);
      return { ok: true };
    }
  }
  return useProfile(context, listed);
}

function bridgeFailure(error: unknown): ToolResponse {
  const code = error instanceof BrowserBridgeError ? error.code : 'browser_error';
  const message = String((error as any)?.message ?? error);
  return {
    ok: false,
    error: message,
    failureCategory: code === 'not_connected' ? 'external_service' : 'tool_exception',
    browserErrorCode: code,
  };
}

async function call(
  context: ToolContext,
  op: string,
  args: Record<string, unknown> = {},
  timeoutMs = READ_TIMEOUT_MS,
): Promise<any> {
  const bridge = ensureBrowserBridge({ cwd: context.rootDir, env: context.env });
  return bridge.request(op, args, { timeoutMs, browser: profileChoiceFor(context)?.key });
}









async function currentTab(
  context: ToolContext,
  tabId: number,
): Promise<{ tabId: number; url: string; title: string } | null> {




  const result = await call(context, 'context', { includeAll: true });
  const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
  const tab = tabs.find((entry: any) => Number(entry.tabId) === tabId);
  if (!tab) return null;
  return { ...tab, url: String(tab.url ?? '').replace(/…+$/, '') };
}








async function ensureSiteAllowed(
  context: ToolContext,
  {
    url,
    tool,
    summary,
  }: { url: string | null | undefined; tool: string; summary: string },
): Promise<ToolResponse | null> {
  const origin = originForUrl(String(url ?? ''));
  if (!origin) {


    return null;
  }
  return ensurePermission(
    {
      autoYes: context.autoYes,
      grants: context.grants,
      requestPermission: context.requestPermission,
    },
    {
      bucket: 'browse',
      origin,
      title: `TheGitAI wants to use ${origin}`,
      body: summary,
    },
    tool,
  );
}

function attachEvents(result: ToolResponse): ToolResponse {
  const events = drainBrowserEvents();
  if (!events.length) return result;
  const notable = events.filter(
    (entry) => entry.event === 'detached' || entry.event === 'stopped' || entry.event === 'group_removed',
  );
  if (!notable.length) return result;
  return {
    ...result,
    browserNotices: notable.map((entry) =>
      String(entry.data?.message ?? `Browser ${entry.event}.`),
    ),
  };
}







export async function browserGateway(
  context: ToolContext,
  args: Record<string, unknown> = {},
): Promise<ToolResponse> {
  const guard = await notConnected(context, { allowUnchosen: true });
  if (guard.ok === false) return guard;
  const options = { cwd: context.rootDir, env: context.env };
  const requested = String(args.browser ?? '').trim();
  const listed = describeBrowsers(browserAvailability(options));
  if (requested) {
    const wanted = requested.toLowerCase();
    const partial = listed.filter((browser) => browser.name.toLowerCase().includes(wanted));
    const match =
      listed.find((browser) => browser.key === requested) ??
      listed.find((browser) => browser.name.toLowerCase() === wanted) ??
      listed.find((browser) => browser.name.toLowerCase().endsWith(`(${wanted})`)) ??
      (partial.length === 1 ? partial[0] : undefined);
    if (!match) {
      return {
        ok: false,
        error: partial.length > 1
          ? `"${requested}" matches more than one connected browser. Use a key from browsers.`
          : `No connected browser matches "${requested}". Use a key from browsers.`,
        failureCategory: 'invalid_argument',
        browsers: listed,
      };
    }
    if (profileChoiceFor(context)?.key !== match.key) {
      const chosen = await useProfile(context, listed, match);
      if (chosen.ok === false) return chosen;
    }
  } else if (listed.length === 1 && !profileChoiceFor(context)) {
    await useProfile(context, listed);
  }
  const availability = browserAvailability(options);
  const platform = availability.browsers[0]?.platform ?? process.platform;
  const choice = profileChoiceFor(context);
  const connectedChoice = choice && availability.browsers.some((browser) => browser.key === choice.key) ? choice : null;
  return {
    ok: true,
    connected: true,
    browsers: describeBrowsers(availability),
    selected: connectedChoice?.key ?? null,
    choiceNeeded: !connectedChoice,



    shortcutModifier: platform === 'darwin' ? 'cmd' : 'ctrl',
    platform,
  };
}

export async function browserTabs(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const includeAll = args.include_all === true || args.includeAll === true;
  const guard = await notConnected(context, { allowUnchosen: includeAll });
  if (guard.ok === false) return guard;
  const options = { cwd: context.rootDir, env: context.env };
  const availability = browserAvailability(options);
  if (includeAll && availability.browsers.length > 1) {
    const bridge = ensureBrowserBridge(options);
    const profiles = await Promise.all(
      describeBrowsers(availability).map(async (browser) => {
        try {
          const result = await bridge.request(
            'context',
            { includeAll: true },
            { timeoutMs: READ_TIMEOUT_MS, browser: browser.key },
          );
          return { ...browser, selected: browser.key === profileChoiceFor(context)?.key, ...result };
        } catch (error) {
          return { ...browser, selected: browser.key === profileChoiceFor(context)?.key, error: String((error as any)?.message ?? error) };
        }
      }),
    );
    const choice = profileChoiceFor(context);
    return attachEvents({
      ok: true,
      choiceNeeded: !choice || !availability.browsers.some((browser) => browser.key === choice.key),
      profiles,
    });
  }
  try {
    const result = await call(context, 'context', { includeAll });
    return attachEvents({ ok: true, ...result });
  } catch (error) {
    return bridgeFailure(error);
  }
}

export async function browserTabNew(
  context: ToolContext,
  args: Record<string, unknown> = {},
): Promise<ToolResponse> {
  const guard = await notConnected(context);
  if (guard.ok === false) return guard;
  const url = String(args.url ?? '').trim();
  try {


    if (url) {
      const denied = await ensureSiteAllowed(context, {
        url,
        tool: 'browser_tab_new',
        summary: `Open ${url} in a new tab in TheGitAI's tab group.`,
      });
      if (denied) return denied;
    }
    const created = await call(context, 'tab.create', {});
    if (!url) return attachEvents({ ok: true, ...created });
    const result = await call(
      context,
      'navigate',
      { tabId: Number(created.tabId), url },
      NAVIGATE_TIMEOUT_MS,
    );
    return attachEvents({ ok: true, ...result });
  } catch (error) {
    return bridgeFailure(error);
  }
}

export async function browserTabClose(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const guard = await notConnected(context, { tabId: args.tabId ?? args.tab_id });
  if (guard.ok === false) return guard;
  const tabId = Number(args.tabId ?? args.tab_id);
  if (!Number.isInteger(tabId)) return missing('tabId', 'browser_tab_close');
  try {
    const result = await call(context, 'tab.close', { tabId });
    return attachEvents({ ok: true, ...result });
  } catch (error) {
    return bridgeFailure(error);
  }
}

export async function browserNavigate(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const guard = await notConnected(context, { tabId: args.tabId ?? args.tab_id });
  if (guard.ok === false) return guard;
  const url = String(args.url ?? '').trim();
  if (!url) return missing('url', 'browser_navigate');
  let tabId = Number(args.tabId ?? args.tab_id);
  try {



    if (url !== 'back' && url !== 'forward') {
      const denied = await ensureSiteAllowed(context, {
        url,
        tool: 'browser_navigate',
        summary: `Open ${url} in TheGitAI's tab group.`,
      });
      if (denied) return denied;
    }
    if (!Number.isInteger(tabId)) {



      const context_ = await call(context, 'context');
      tabId = Number(context_?.tabs?.find((tab: any) => tab.inSession && tab.available)?.tabId);
      if (!Number.isInteger(tabId)) {
        const created = await call(context, 'tab.create', {});
        tabId = Number(created.tabId);
      }
    }
    const result = await call(context, 'navigate', { tabId, url }, NAVIGATE_TIMEOUT_MS);
    return attachEvents({ ok: true, ...result });
  } catch (error) {
    return bridgeFailure(error);
  }
}


async function gatedTabCall(
  context: ToolContext,
  {
    tool,
    op,
    args,
    summary,
    timeoutMs = READ_TIMEOUT_MS,
  }: {
    tool: string;
    op: string;
    args: Record<string, unknown>;
    summary: (url: string) => string;
    timeoutMs?: number;
  },
): Promise<ToolResponse> {
  const guard = await notConnected(context, { tabId: args.tabId ?? args.tab_id });
  if (guard.ok === false) return guard;
  const tabId = Number(args.tabId ?? args.tab_id);
  if (!Number.isInteger(tabId)) return missing('tabId', tool);
  try {
    const tab = await currentTab(context, tabId);
    if (!tab) {
      return {
        ok: false,
        error: `Tab ${tabId} is no longer available. Call browser_tabs for the current list.`,
        failureCategory: 'not_found',
        failureDetails: {
          category: 'not_found',
          tool,
          action: 'List the session tabs and use an id from that list.',
        },
      };
    }
    const denied = await ensureSiteAllowed(context, {
      url: tab.url,
      tool,
      summary: summary(tab.url),
    });
    if (denied) return denied;
    const result = await call(context, op, {
      ...args, tabId, expectedOrigin: new URL(tab.url || 'about:blank').origin,
    }, timeoutMs);
    return attachEvents({ ok: true, tabId, url: tab.url, ...result });
  } catch (error) {
    return bridgeFailure(error);
  }
}

export function browserReadPage(context: ToolContext, args: Record<string, unknown>) {
  return gatedTabCall(context, {
    tool: 'browser_read_page',
    op: 'read_page',
    args: {
      tabId: args.tabId ?? args.tab_id,
      filter: args.filter === 'interactive' ? 'interactive' : 'all',
      depth: Number(args.depth ?? 15),
      maxChars: Number(args.max_chars ?? args.maxChars ?? 50000),
    },
    summary: (url) => `Read the accessibility tree of ${url}.`,
  });
}

export function browserGetPageText(context: ToolContext, args: Record<string, unknown>) {
  return gatedTabCall(context, {
    tool: 'browser_get_page_text',
    op: 'page_text',
    args: { tabId: args.tabId ?? args.tab_id },
    summary: (url) => `Read the text of ${url}.`,
  });
}








export function browserFind(context: ToolContext, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) return Promise.resolve(missing('query', 'browser_find'));
  return gatedTabCall(context, {
    tool: 'browser_find',
    op: 'find_candidates',
    args: { tabId: args.tabId ?? args.tab_id },
    summary: (url) => `Look for "${query}" on ${url}.`,
  }).then((result) => (result.ok ? { ...result, query } : result));
}

export async function browserComputer(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const action = String(args.action ?? '').trim();
  if (!action) return missing('action', 'browser_computer');
  const result = await gatedTabCall(context, {
    tool: 'browser_computer',
    op: 'computer',
    args: { ...args, tabId: args.tabId ?? args.tab_id, action },
    summary: (url) => `${describeComputerAction(action, args)} on ${url}.`,
    timeoutMs: action === 'wait' ? 30000 : READ_TIMEOUT_MS,
  });
  if (!result.ok || typeof result.base64Data !== 'string') return result;
  return reshapeScreenshot(context, result, args);
}










function reshapeScreenshot(
  context: ToolContext,
  result: ToolResponse,
  args: Record<string, unknown>,
): ToolResponse {
  const { base64Data, mimeType, geometry, ...rest } = result;
  const imageMimeType = isSupportedImageMimeType(String(mimeType)) ? mimeType : 'image/png';
  const payload: ToolResponse = {
    ...rest,




    viewport: geometry,
    coordinateSpace:
      geometry?.scale === 1 && !geometry?.offsetX && !geometry?.offsetY
        ? 'Image pixels are viewport CSS pixels. Use coordinates directly.'
        : 'Convert image pixels to viewport CSS coordinates: x = imageX / viewport.scale + viewport.offsetX; y = imageY / viewport.scale + viewport.offsetY.',
    imageBytes: { base64Data, mimeType: imageMimeType },
  };
  const wantsFile = args.save_to_disk === true || args.saveToDisk === true;
  const sessionId = context.sessionId;
  if (sessionId) {
    try {
      const stored = storeSessionImageBytes({
        sessionId,
        base64Data,
        mimeType: imageMimeType,
        env: context.env,
      });
      if (wantsFile) payload.savedPath = stored.cachePath;
      payload.imageBytes.cachePath = stored.cachePath;
      payload.imageBytes.index = stored.index;
    } catch (error: any) {
      if (wantsFile) payload.saveError = String(error?.message ?? error);
    }
  }
  return payload;
}

function describeComputerAction(action: string, args: Record<string, unknown>): string {
  if (action === 'type') return `Type ${JSON.stringify(String(args.text ?? '').slice(0, 60))}`;
  if (action === 'key') return `Press ${String(args.text ?? '')}`;
  if (action === 'screenshot') return 'Take a screenshot';
  if (action === 'zoom') return 'Take a close-up screenshot';
  if (action === 'scroll') return `Scroll ${String(args.scroll_direction ?? '')}`;
  if (action === 'hover') return 'Hover';
  return `${action.replace(/_/g, ' ')}`;
}

export function browserFormInput(context: ToolContext, args: Record<string, unknown>) {
  const ref = String(args.ref ?? '').trim();
  if (!ref) return Promise.resolve(missing('ref', 'browser_form_input'));
  if (args.value === undefined) {
    return Promise.resolve(missing('value', 'browser_form_input'));
  }
  return gatedTabCall(context, {
    tool: 'browser_form_input',
    op: 'form_input',
    args: { tabId: args.tabId ?? args.tab_id, ref, value: args.value },
    summary: (url) => `Set ${ref} on ${url}.`,
  });
}

export function browserEvaluate(context: ToolContext, args: Record<string, unknown>) {
  const text = String(args.text ?? args.code ?? '').trim();
  if (!text) return Promise.resolve(missing('text', 'browser_evaluate'));
  return gatedTabCall(context, {
    tool: 'browser_evaluate',
    op: 'evaluate',
    args: { tabId: args.tabId ?? args.tab_id, text },
    summary: (url) => `Run JavaScript on ${url}.`,
  });
}

export function browserConsole(context: ToolContext, args: Record<string, unknown>) {
  return gatedTabCall(context, {
    tool: 'browser_console',
    op: 'console',
    args: {
      tabId: args.tabId ?? args.tab_id,
      pattern: args.pattern,
      onlyErrors: args.onlyErrors === true || args.only_errors === true,
      limit: Number(args.limit ?? 100),
      clear: args.clear === true,
    },
    summary: (url) => `Read console output from ${url}.`,
  });
}

export function browserNetwork(context: ToolContext, args: Record<string, unknown>) {
  return gatedTabCall(context, {
    tool: 'browser_network',
    op: 'network',
    args: {
      tabId: args.tabId ?? args.tab_id,
      urlPattern: args.urlPattern ?? args.url_pattern,
      limit: Number(args.limit ?? 100),
      clear: args.clear === true,
    },
    summary: (url) => `Read network requests from ${url}.`,
  });
}









export async function browserDownloads(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const action = String(args.action ?? 'list').trim();








  if (context.agentMode === 'plan' && action !== 'list') {
    return {
      ok: false,
      failureCategory: 'policy_blocked',
      error: `Plan mode blocked browser_downloads ${action}. Listing downloads is allowed; saving or cancelling one changes the user's disk. Switch to Default mode to decide on a download.`,
    };
  }

  const guard = await notConnected(context);
  if (guard.ok === false) return guard;

  if (action === 'list') {
    const result = await call(context, 'downloads');
    const downloads = Array.isArray(result?.downloads) ? result.downloads : [];
    return {
      ok: true,
      downloads,
      ...(downloads.length
        ? {
            instructions:
              'Each of these is paused and nothing is on disk yet. Tell the user the filename, the size and the site it came from, and only call accept after they say yes.',
          }
        : {}),
    };
  }

  if (action !== 'accept' && action !== 'cancel') {
    return {
      ok: false,
      error: 'browser_downloads action must be "list", "accept" or "cancel".',
      failureCategory: 'invalid_argument',
    };
  }

  const downloadId = Number(args.downloadId ?? args.download_id);
  if (!Number.isInteger(downloadId)) return missing('downloadId', 'browser_downloads');

  if (action === 'accept') {




    const listed = await call(context, 'downloads');
    const record = (Array.isArray(listed?.downloads) ? listed.downloads : []).find(
      (entry: any) => Number(entry?.downloadId) === downloadId,
    );
    const size = record?.bytes ? `${(record.bytes / (1024 * 1024)).toFixed(1)} MB` : 'unknown size';






    if (!context.autoYes && context.requestPermission) {
      const decision = await context.requestPermission({
        bucket: 'browse',
        title: 'TheGitAI wants to save a file to this machine',
        body: `"${record?.filename ?? downloadId}" (${size}) from ${record?.url ?? 'an unknown source'}.`,
        options: [
          { label: 'Save this file', decision: { kind: 'once' } },
          { label: 'No, cancel the download', decision: { kind: 'deny' } },
        ],
      });
      if (decision?.kind !== 'once' && decision?.kind !== 'always-bucket') {
        await call(context, 'download.decide', { downloadId, accept: false });
        return {
          ok: false,
          error: 'The user declined the download. It was cancelled and nothing was saved.',
          failureCategory: 'user_declined',
        };
      }
    }
  }

  const result = await call(context, 'download.decide', {
    downloadId,
    accept: action === 'accept',
  });
  return { ok: true, ...result };
}

const RESTORE_MIN_EXTENSION_VERSION = [0, 1, 7];

export function extensionPredates(version: string | undefined, minimum: number[]): boolean {
  if (!version) return false;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < minimum.length; index += 1) {
    const have = parts[index] ?? 0;
    if (have !== minimum[index]) return have < minimum[index]!;
  }
  return false;
}

function connectedExtensionVersion(context: ToolContext): string | undefined {
  const availability = browserAvailability({ cwd: context.rootDir, env: context.env });
  const key = profileChoiceFor(context)?.key ?? availability.selected;
  return availability.browsers.find((browser) => browser.key === key)?.extensionVersion;
}

export function browserResize(context: ToolContext, args: Record<string, unknown>) {
  if (args.restore === true) {
    const version = connectedExtensionVersion(context);
    if (extensionPredates(version, RESTORE_MIN_EXTENSION_VERSION)) {
      return Promise.resolve({
        ok: false,
        error: `Restoring the window needs the TheGitAI Chrome extension ${RESTORE_MIN_EXTENSION_VERSION.join('.')} or later; this browser has ${version}. Resize it back with the width and height it had before, and tell the user the extension has an update.`,
        failureCategory: 'invalid_argument' as const,
      });
    }
    return gatedTabCall(context, {
      tool: 'browser_resize',
      op: 'resize',
      args: { tabId: args.tabId ?? args.tab_id, restore: true },
      summary: () => 'Put the browser window back to its size before resizing.',
    });
  }
  const width = Number(args.width);
  const height = Number(args.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return Promise.resolve(missing('width and height', 'browser_resize'));
  }
  return gatedTabCall(context, {
    tool: 'browser_resize',
    op: 'resize',
    args: { tabId: args.tabId ?? args.tab_id, width, height },
    summary: () => `Resize the browser window to ${width}x${height}.`,
  }).then((result) => withResizeWarning(result, width, height));
}

const RESIZE_TOLERANCE_PX = 24;

export function withResizeWarning(result: ToolResponse, width: number, height: number): ToolResponse {
  const viewport = (result as { viewport?: { cssWidth?: unknown; cssHeight?: unknown } }).viewport;
  if (result.ok === false || !viewport) return result;
  const actualWidth = Number(viewport.cssWidth);
  const actualHeight = Number(viewport.cssHeight);
  if (!Number.isFinite(actualWidth) || !Number.isFinite(actualHeight)) return result;
  if (
    Math.abs(actualWidth - width) <= RESIZE_TOLERANCE_PX &&
    Math.abs(actualHeight - height) <= RESIZE_TOLERANCE_PX
  ) {
    return result;
  }
  return {
    ...result,
    warning:
      `The page is ${Math.round(actualWidth)}x${Math.round(actualHeight)} CSS pixels, not the ${width}x${height} you asked for. ` +
      'The window may be maximized, tiled or full screen in a way this system does not let a program change, or the size may be outside what the screen and Chrome allow. ' +
      'Do not assume the layout changed. If the user needs this size, ask them to un-maximize the window; otherwise check the page at the size it has.',
  };
}










export async function browserFileUpload(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const guard = await notConnected(context, { tabId: args.tabId ?? args.tab_id });
  if (guard.ok === false) return guard;
  const ref = String(args.ref ?? '').trim();
  if (!ref) return missing('ref', 'browser_file_upload');
  const rawPaths = Array.isArray(args.paths)
    ? args.paths
    : args.path
      ? [args.path]
      : [];
  if (!rawPaths.length) return missing('paths', 'browser_file_upload');

  const files: { name: string; mimeType: string; base64: string }[] = [];
  let total = 0;
  for (const raw of rawPaths) {
    const candidate = String(raw ?? '').trim();
    if (!candidate) continue;
    let resolved: string;
    if (path.isAbsolute(candidate)) {
      resolved = candidate;
    } else if (normalizeProjectRelativePath(context.rootDir, candidate)) {
      resolved = path.resolve(context.rootDir, candidate);
    } else {
      return {
        ok: false,
        error: `Refusing to upload a path outside the project root: ${candidate}`,
        failureCategory: 'permission_denied',
      };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return {
        ok: false,
        error: `No such file: ${resolved}`,
        failureCategory: 'not_found',
      };
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        error: `Not a file: ${resolved}`,
        failureCategory: 'invalid_argument',
      };
    }
    total += stat.size;
    if (total > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Uploads are capped at ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB in total; these files exceed it.`,
        failureCategory: 'budget_exceeded',
      };
    }
    files.push({
      name: path.basename(resolved),
      mimeType: guessMimeType(resolved),
      base64: fs.readFileSync(resolved).toString('base64'),
    });
  }

  const tabId = Number(args.tabId ?? args.tab_id);
  if (!Number.isInteger(tabId)) return missing('tabId', 'browser_file_upload');
  try {
    const tab = await currentTab(context, tabId);
    const denied = await ensureSiteAllowed(context, {
      url: tab?.url,
      tool: 'browser_file_upload',
      summary: `Upload ${files.map((file) => file.name).join(', ')} to ${tab?.url ?? 'the page'}.`,
    });
    if (denied) return denied;
    const result = await call(context, 'upload', { tabId, ref, files }, NAVIGATE_TIMEOUT_MS);
    return attachEvents({ ok: true, ...result, files: files.map((file) => file.name) });
  } catch (error) {
    return bridgeFailure(error);
  }
}

function guessMimeType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  const table: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.zip': 'application/zip',
  };
  return table[extension] ?? 'application/octet-stream';
}

const BATCH_TOOLS: Record<
  string,
  (context: ToolContext, args: Record<string, unknown>) => Promise<ToolResponse>
> = {
  browser_tabs: browserTabs,
  browser_tab_new: (context) => browserTabNew(context),
  browser_tab_close: browserTabClose,
  browser_navigate: browserNavigate,
  browser_read_page: browserReadPage,
  browser_get_page_text: browserGetPageText,



  browser_computer: browserComputer,
  browser_form_input: browserFormInput,
  browser_evaluate: browserEvaluate,
  browser_console: browserConsole,
  browser_network: browserNetwork,
  browser_screenshot: (context, args) =>
    browserComputer(context, { ...args, action: 'screenshot' }),
  browser_resize: browserResize,
  browser_file_upload: browserFileUpload,
  browser_downloads: browserDownloads,
};














export async function browserBatch(
  context: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const guard = await notConnected(context, { tabId: (Array.isArray(args.actions) ? (args.actions[0] as any)?.input?.tabId : undefined) });
  if (guard.ok === false) return guard;
  const actions = Array.isArray(args.actions) ? args.actions : [];
  if (!actions.length) return missing('actions', 'browser_batch');
  if (actions.length > 20) {
    return {
      ok: false,
      error: 'A batch may hold at most 20 actions.',
      failureCategory: 'invalid_argument',
    };
  }

  const results: any[] = [];
  for (const [index, entry] of actions.entries()) {
    const name = String((entry as any)?.name ?? '').trim();
    const input = ((entry as any)?.input ?? {}) as Record<string, unknown>;
    const handler = BATCH_TOOLS[name];
    if (!handler) {
      results.push({ step: index + 1, name, ok: false, error: `Unknown browser tool: ${name}` });
      return { ok: false, stoppedAt: index + 1, results, error: `Unknown browser tool: ${name}` };
    }
    if (context.agentMode === 'plan' && !READ_ONLY_BROWSER_TOOLS.has(name)) {
      results.push({ step: index + 1, name, ok: false, error: 'Plan mode blocks this action.' });
      return {
        ok: false,
        stoppedAt: index + 1,
        results,
        error: `Plan mode allows only read-only browser actions; ${name} changes the page.`,
        failureCategory: 'policy_blocked',
      };
    }
    const result = await handler(context, input);
    results.push({ step: index + 1, name, ...result });
    if (result.ok === false) {
      return {
        ok: false,
        stoppedAt: index + 1,
        results,
        error: `Batch stopped at step ${index + 1} (${name}): ${result.error ?? 'failed'}`,
        failureCategory: result.failureCategory,
      };
    }
  }
  return { ok: true, results };
}
