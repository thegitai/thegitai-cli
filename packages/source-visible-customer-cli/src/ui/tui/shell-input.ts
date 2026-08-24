import type { TuiChildMessage } from './types.js';
import { readClipboardImage, readClipboardText } from '../../core/clipboard.js';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES_PER_MESSAGE,
  approximateBase64DecodedBytes,
  totalAttachmentBytes,
} from '../../core/image-limits.js';
import { tryCacheAttachmentBytes } from '../../core/session-image-store.js';
import type { ImageAttachment } from '../../types.js';
import {
  applySlashCommandSuggestion,
  buildModelPickerOptions,
  deleteAtCursor,
  deleteBeforeCursor,
  getInputCommandToken,
  getNextApprovalCursor,
  getNextModelPickerIndex,
  getSlashCommandSuggestions,
  insertAtCursor,
  isExactSlashCommandToken,
  navigatePromptHistory,
  shouldRemountLiveFrameForComposerInputChange,
} from '../repl.js';
import {
  buildPastePlaceholder,
  shouldCollapsePaste,
} from '../paste-collapse.js';
import type { UserInputResult } from '../../api/contracts.js';
import {
  handleUserInputPromptEvent,
  type UserInputPromptEvent,
  type UserInputViewport,
} from './user-input.js';

// Deliberately less than the smallest preview window (4 rows), so a page always
// leaves context from the previous screen rather than jumping past it.
const APPROVAL_PREVIEW_PAGE_ROWS = 3;

function isClipboardImagePasteKey(key: {
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  input: string;
}): boolean {
  if (process.platform === 'win32') {
    return (
      (key.ctrl || key.meta) &&
      key.input.toLowerCase() === 'v' &&
      !key.shift
    );
  }
  return key.ctrl && key.input === 'v' && !key.shift && !key.meta;
}
type SudoPasswordInput =
  | { kind: 'backspace' }
  | { kind: 'cancel' }
  | { kind: 'char'; char: string }
  | { kind: 'submit' };

interface ShellStoreLike {
  appendEntry: (entry: {
    body: string;
    kind: 'error' | 'system';
    title: string;
  }) => number;
  getState: () => any;
  update: (updater: (state: any) => any) => void;
}

export interface ShellInputHandlers {
  getApprovalScrollLimit?: () => number;
  getTranscriptScrollLimit?: () => number;
  getUserInputViewport?: () => UserInputViewport;
  onCancelTurn: () => void;
  onCycleAgentMode: () => void;
  onCtrlC?: () => void;
  onLiveFrameShapeChange: () => void;
  onLinkCopy?: (url: string) => void | Promise<void>;
  onLinkOpen?: (url: string) => void | Promise<void>;
  readClipboardText?: () => string;
  onSelectionCopy?: (text: string) => void | Promise<void>;
  onRequestExit: () => void;
  /** Index into the prompt's option list; out of range denies. */
  onResolveApproval: (optionIndex: number) => Promise<void>;
  onResolveUserInput?: (result: UserInputResult) => Promise<void>;
  onResumeSession: () => Promise<void>;
  onSelectModel: () => Promise<void>;
  onJobsPickerOutput: () => Promise<void>;
  onJobsPickerKill: () => Promise<void>;
  onSudoPasswordInput: (event: SudoPasswordInput) => void;
  onSubmit: (input: string) => Promise<void>;
  // Sends the already-queued message into the turn that is still running.
  // Optional so hosts without a server-backed turn (which have no running turn
  // to send into) simply leave Enter falling through to the queue.
  onFireQueuedMessage?: () => Promise<void>;
}

// A prompt that opens while the user is mid-keystroke must not be answered by
// the keys they had already committed to the composer. 500ms is the same order
// browsers use to protect permission dialogs from click-jacking: long enough to
// swallow a burst of in-flight typing, short enough that a user who is actually
// looking at the prompt never notices it.
export const APPROVAL_INPUT_GUARD_MS = 500;

function approvalIsGuarded(state: { approvalOpenedAt?: number | null }): boolean {
  const openedAt = state.approvalOpenedAt;
  if (typeof openedAt !== 'number') return false;
  return Date.now() - openedAt < APPROVAL_INPUT_GUARD_MS;
}

function applyUserInputPromptEvent(
  store: ShellStoreLike,
  handlers: ShellInputHandlers,
  event: UserInputPromptEvent,
): boolean {
  const current = store.getState();
  if (!current.userInputPrompt) return false;
  const outcome = handleUserInputPromptEvent(
    current.userInputPrompt,
    event,
    handlers.getUserInputViewport?.(),
  );
  store.update((state) => ({
    ...state,
    userInputPrompt: outcome.state,
  }));
  if (outcome.result) {
    void handlers.onResolveUserInput?.(outcome.result);
  }
  return true;
}

function composerIsEmpty(state: {
  cursor: number;
  input: string;
  pastedChunks: unknown[];
  promptHistoryCursor: number | null;
}): boolean {
  return (
    !state.input &&
    state.cursor === 0 &&
    state.pastedChunks.length === 0 &&
    state.promptHistoryCursor === null
  );
}

function composerHasDiscardableDraft(state: {
  busy: boolean;
  cursor: number;
  imageAttachments: unknown[];
  input: string;
  pastedChunks: unknown[];
  promptHistoryCursor: number | null;
}): boolean {
  if (!composerIsEmpty(state)) return true;
  // A submitted turn's attachments stay in the store until the send resolves,
  // so while busy they are not a draft and must not swallow the cancel.
  return !state.busy && state.imageAttachments.length > 0;
}

function shouldShowCommandPalette(state: {
  busy: boolean;
  exiting: boolean;
  input: string;
  jobsPickerOpen: boolean;
  modelPickerOpen: boolean;
  resumePickerOpen: boolean;
}): boolean {
  if (
    state.busy ||
    state.exiting ||
    state.jobsPickerOpen ||
    state.modelPickerOpen ||
    state.resumePickerOpen
  ) {
    return false;
  }
  const token = getInputCommandToken(state.input);
  return token.startsWith('/') && !token.includes(' ');
}

function insertPastedText(
  store: ShellStoreLike,
  handlers: ShellInputHandlers,
  text: string,
): void {
  const current = store.getState();
  if (current.exiting || !text) return;
  if (shouldCollapsePaste(text)) {
    store.update((state) => {
      const id = state.pastedChunks.length + 1;
      const placeholder = buildPastePlaceholder(text, id);
      const chunk = { placeholder, text };
      const nextInput = insertAtCursor(state as any, placeholder);
      if (shouldRemountLiveFrameForComposerInputChange(state as any, nextInput.input)) {
        handlers.onLiveFrameShapeChange();
      }
      return {
        ...state,
        commandCursor: 0,
        pastedChunks: [...state.pastedChunks, chunk],
        ...nextInput,
      };
    });
    return;
  }
  store.update((state) => {
    const nextInput = insertAtCursor(state as any, text);
    if (shouldRemountLiveFrameForComposerInputChange(state as any, nextInput.input)) {
      handlers.onLiveFrameShapeChange();
    }
    return {
      ...state,
      commandCursor: 0,
      ...nextInput,
    };
  });
}

function pasteTextFromClipboard(
  store: ShellStoreLike,
  handlers: ShellInputHandlers,
): void {
  const current = store.getState();
  if (
    current.exiting ||
    current.approvalPrompt ||
    current.jobsPickerOpen ||
    current.modelPickerOpen ||
    current.resumePickerOpen ||
    current.sudoPrompt
  ) {
    return;
  }
  const text = (handlers.readClipboardText ?? readClipboardText)();
  if (!text) {
    store.update((state) => ({
      ...state,
      status: 'Clipboard has no text to paste',
    }));
    return;
  }
  insertPastedText(store, handlers, text);
}

function scrollTranscript(
  store: ShellStoreLike,
  handlers: ShellInputHandlers,
  delta: number,
): void {
  if (delta === 0) return;
  store.update((current) => {
    const limit = handlers.getTranscriptScrollLimit?.() ??
      current.transcript.reduce(
        (total: number, entry: { body?: string }) =>
          total + 2 + (entry.body ? entry.body.split('\n').length : 0),
        0,
      );
    const next = current.transcriptScrollOffset + delta;
    return {
      ...current,
      transcriptScrollOffset: Math.max(0, Math.min(next, limit)),
    };
  });
}

function scrollTranscriptTo(
  store: ShellStoreLike,
  handlers: ShellInputHandlers,
  offset: number,
): void {
  store.update((current) => {
    const limit = handlers.getTranscriptScrollLimit?.() ??
      current.transcript.reduce(
        (total: number, entry: { body?: string }) =>
          total + 2 + (entry.body ? entry.body.split('\n').length : 0),
        0,
      );
    return {
      ...current,
      transcriptScrollOffset: Math.max(0, Math.min(Math.trunc(offset), limit)),
    };
  });
}

// Offset 0 is the first row of the command, so paging down increases it — the
// opposite of the transcript, which counts backwards from the newest line.
function scrollApprovalPreview(
  store: ShellStoreLike,
  handlers: ShellInputHandlers,
  delta: number,
): void {
  if (delta === 0) return;
  store.update((current) => {
    const limit = handlers.getApprovalScrollLimit?.() ?? 0;
    const next = (current.approvalScrollOffset ?? 0) + delta;
    return {
      ...current,
      approvalScrollOffset: Math.max(0, Math.min(next, limit)),
    };
  });
}

function filterResumeSessionsLocal(
  sessions: Array<{
    branch?: string | null;
    lastUserMessage: string;
    modelId: number;
  }>,
  filter: string,
  serverModels: Array<{ id: number; label: string }>,
) {
  const q = filter.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((session) => {
    const branch = (session.branch ?? '').toLowerCase();
    const model =
      serverModels.find((entry) => entry.id === session.modelId)?.label.toLowerCase() ??
      '';
    const conv = session.lastUserMessage.toLowerCase();
    return branch.includes(q) || model.includes(q) || conv.includes(q);
  });
}

export function handleShellKeyEvent(
  store: ShellStoreLike,
  handlers: ShellInputHandlers,
  event: Extract<TuiChildMessage, { op: 'event' }>,
): void {
  if (event.kind === 'paste') {
    if (
      applyUserInputPromptEvent(store, handlers, {
        kind: 'paste',
        text: event.text,
      })
    ) {
      return;
    }
    insertPastedText(store, handlers, event.text);
    return;
  }

  if (event.kind === 'selectionCopy') {
    if (event.text.trim()) {
      void handlers.onSelectionCopy?.(event.text);
    }
    return;
  }

  if (event.kind === 'linkCopy') {
    if (event.url.trim()) {
      void handlers.onLinkCopy?.(event.url);
    }
    return;
  }

  if (event.kind === 'linkOpen') {
    if (event.url.trim()) {
      void handlers.onLinkOpen?.(event.url);
    }
    return;
  }

  if (event.kind === 'contextMenu') {
    if (store.getState().userInputPrompt) {
      const text = (handlers.readClipboardText ?? readClipboardText)();
      if (text) {
        applyUserInputPromptEvent(store, handlers, { kind: 'paste', text });
      }
      return;
    }
    pasteTextFromClipboard(store, handlers);
    return;
  }

  if (event.kind === 'transcriptScroll') {
    // The wheel always means the conversation, prompt open or not. It is the
    // only way to reach the transcript while an approval is up on terminals
    // that swallow Shift+PgUp for their own scrollback.
    scrollTranscript(store, handlers, Math.trunc(event.deltaLines));
    return;
  }

  if (event.kind === 'transcriptScrollTo') {
    scrollTranscriptTo(store, handlers, Number(event.offset ?? 0));
    return;
  }

  if (event.kind !== 'key') return;

  const key = event;
  const state = store.getState();
  const commandPaletteActive = shouldShowCommandPalette(state);
  const commandSuggestions = commandPaletteActive
    ? getSlashCommandSuggestions(state.input)
    : [];

  const prepareForComposerInputChange = (current: any, nextInput: string) => {
    if (shouldRemountLiveFrameForComposerInputChange(current as any, nextInput)) {
      handlers.onLiveFrameShapeChange();
    }
  };

  if (key.ctrl && key.input === 'c') {
    if (state.userInputPrompt) {
      handlers.onCtrlC?.();
      return;
    }
    if (state.sudoPrompt) {
      handlers.onSudoPasswordInput({ kind: 'cancel' });
      return;
    }
    if (state.queuedMessage) {
      handlers.onLiveFrameShapeChange();
      store.update((current) => ({ ...current, queuedMessage: null }));
      return;
    }
    if (composerHasDiscardableDraft(state)) {
      store.update((current) => {
        prepareForComposerInputChange(current, '');
        return {
          ...current,
          commandCursor: 0,
          cursor: 0,
          imageAttachments: current.busy ? current.imageAttachments : [],
          input: '',
          pastedChunks: [],
          promptHistoryCursor: null,
          promptHistoryDraft: '',
        };
      });
      return;
    }
    if (handlers.onCtrlC) {
      handlers.onCtrlC();
      return;
    }
    handlers.onRequestExit();
    return;
  }

  if (
    state.userInputPrompt &&
    applyUserInputPromptEvent(store, handlers, key)
  ) {
    return;
  }

  if (state.sudoPrompt) {
    if (key.escape) {
      handlers.onSudoPasswordInput({ kind: 'cancel' });
      return;
    }
    if (key.returnKey) {
      handlers.onSudoPasswordInput({ kind: 'submit' });
      return;
    }
    if (key.backspace || key.delete) {
      handlers.onSudoPasswordInput({ kind: 'backspace' });
      return;
    }
    if (
      !key.ctrl &&
      !key.meta &&
      key.input &&
      key.input.length === 1 &&
      key.input >= ' '
    ) {
      handlers.onSudoPasswordInput({ kind: 'char', char: key.input });
    }
    return;
  }

  if (state.approvalPrompt) {
    // The prompt has focus, so the page keys act on it. Shift reaches the
    // transcript behind it — best effort, since some terminals intercept
    // Shift+PgUp for their own scrollback; the wheel always works.
    if (key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -APPROVAL_PREVIEW_PAGE_ROWS : APPROVAL_PREVIEW_PAGE_ROWS;
      if (key.shift) {
        scrollTranscript(store, handlers, key.pageUp ? 8 : -8);
      } else {
        scrollApprovalPreview(store, handlers, delta);
      }
      return;
    }
    // Navigation stays live from the first frame — reading and moving around
    // the prompt is always safe. Only the keys that COMMIT are held back.
    if (key.upArrow || key.downArrow) {
      store.update((current) => ({
        ...current,
        approvalCursor: getNextApprovalCursor(
          current.approvalCursor,
          key.upArrow ? -1 : 1,
          current.approvalPrompt?.options?.length ?? 0,
        ),
      }));
      return;
    }
    // A prompt appears while the agent works, which means it can appear in the
    // middle of the user typing. Keystrokes already in flight were aimed at the
    // composer, not at this prompt, so for a moment after it opens nothing may
    // resolve it. Without this, hitting Enter to queue a message the instant a
    // prompt arrives silently answers the prompt instead.
    if (approvalIsGuarded(state)) {
      return;
    }
    if (key.escape) {
      // -1 is out of range for any option list, and the resolver denies on
      // anything it cannot map, so Esc stays a deny however the list is built.
      void handlers.onResolveApproval(-1);
      return;
    }
    if (key.returnKey) {
      void handlers.onResolveApproval(state.approvalCursor);
    }
    return;
  }

  if (state.exiting) {
    return;
  }

  if (key.pageUp || key.pageDown) {
    scrollTranscript(store, handlers, key.pageUp ? 8 : -8);
    return;
  }

  if (state.jobsPickerOpen) {
    if (key.escape) {
      store.update((current) => ({
        ...current,
        jobsPickerExpandedId: null,
        jobsPickerOpen: false,
        status: 'Ready',
      }));
      return;
    }
    if (key.upArrow || key.downArrow) {
      store.update((current) => {
        const count = (current.backgroundJobs ?? []).length;
        const next = current.jobsPickerIndex + (key.upArrow ? -1 : 1);
        return {
          ...current,
          jobsPickerExpandedId: null,
          jobsPickerIndex: Math.max(0, Math.min(next, Math.max(count - 1, 0))),
        };
      });
      return;
    }
    if (key.returnKey) {
      void handlers.onJobsPickerOutput();
      return;
    }
    if (key.input === 'k' && !key.ctrl && !key.meta && !key.shift) {
      void handlers.onJobsPickerKill();
    }
    return;
  }

  if (state.modelPickerOpen) {
    if (key.escape) {
      store.update((current) => ({ ...current, modelPickerOpen: false }));
      return;
    }
    if (key.upArrow || key.downArrow) {
      store.update((current) => {
        const options = buildModelPickerOptions(
          Number(current.currentModelId ?? 0),
          (current.serverModels as Parameters<typeof buildModelPickerOptions>[1]) ?? [],
        );
        return {
          ...current,
          modelPickerIndex: getNextModelPickerIndex(
            options,
            current.modelPickerIndex,
            key.upArrow ? -1 : 1,
          ),
        };
      });
      return;
    }
    if (key.returnKey) {
      void handlers.onSelectModel();
    }
    return;
  }

  if (state.resumePickerOpen) {
    if (key.escape) {
      store.update((current) => ({
        ...current,
        resumePickerFilter: '',
        resumePickerIndex: 0,
        resumePickerOpen: false,
        status: 'Ready',
      }));
      return;
    }
    if (key.upArrow || key.downArrow) {
      store.update((current) => {
        const count = filterResumeSessionsLocal(
          current.resumePickerSessions,
          current.resumePickerFilter,
          current.serverModels ?? [],
        ).length;
        const next = current.resumePickerIndex + (key.upArrow ? -1 : 1);
        return {
          ...current,
          resumePickerIndex: Math.max(0, Math.min(next, count - 1)),
        };
      });
      return;
    }
    if (key.returnKey) {
      void handlers.onResumeSession();
      return;
    }
    if (key.backspace || key.delete) {
      store.update((current) => ({
        ...current,
        resumePickerFilter: current.resumePickerFilter.slice(0, -1),
        resumePickerIndex: 0,
      }));
      return;
    }
    if (!key.ctrl && !key.meta && key.input && key.input.length === 1 && key.input >= ' ') {
      store.update((current) => ({
        ...current,
        resumePickerFilter: current.resumePickerFilter + key.input,
        resumePickerIndex: 0,
      }));
    }
    return;
  }

  if (key.escape) {
    if (state.busy) {
      // With a queued message, Esc clears the queue only (turn keeps running).
      // With nothing queued, Esc cancels the turn (Ctrl+C also cancels).
      if (state.queuedMessage) {
        handlers.onLiveFrameShapeChange();
        store.update((current) => ({ ...current, queuedMessage: null }));
        return;
      }
      handlers.onCancelTurn();
      return;
    }
    store.update((current) => {
      if (composerIsEmpty(current)) {
        return current;
      }
      prepareForComposerInputChange(current, '');
      return {
        ...current,
        commandCursor: 0,
        cursor: 0,
        input: '',
        pastedChunks: [],
        promptHistoryCursor: null,
        promptHistoryDraft: '',
      };
    });
    return;
  }

  if (key.tab && key.shift) {
    handlers.onCycleAgentMode();
    return;
  }

  // Composer lock. A queued message means the composer has nothing left to
  // edit, so only three keys mean anything: Enter sends it, Up brings it back
  // for editing, Esc/Ctrl+C discard it (both already handled above, as are
  // transcript scrolling and Shift+Tab).
  //
  // Swallowing the rest is the whole point. Text used to keep flowing into a
  // composer the frame had replaced with a chip, so a user typing a second
  // message saw nothing, and Enter — whose meaning depended on that invisible
  // box being empty — silently overwrote the first message instead of sending.
  if (state.busy && state.queuedMessage) {
    if (key.returnKey) {
      void handlers.onFireQueuedMessage?.();
      return;
    }
    // Pasting an image is the one edit that still makes sense against a queued
    // message: it attaches to the queued message itself rather than to the
    // invisible composer, so nothing is silently overwritten. Swallowing it
    // here is what forced users to wait out the turn before adding a
    // screenshot.
    if (!key.upArrow && !isClipboardImagePasteKey(key)) {
      return;
    }
  }

  if (commandPaletteActive && (key.upArrow || key.downArrow)) {
    store.update((current) => ({
      ...current,
      commandCursor: Math.min(
        Math.max(current.commandCursor + (key.upArrow ? -1 : 1), 0),
        Math.max(commandSuggestions.length - 1, 0),
      ),
    }));
    return;
  }

  if (key.upArrow) {
    // Under the composer lock, Up brings the queued message back for editing
    // (which unlocks); otherwise it walks prompt history as usual.
    if (state.busy && state.queuedMessage) {
      handlers.onLiveFrameShapeChange();
      store.update((current) => {
        const queued = current.queuedMessage;
        if (!queued) return current;
        return {
          ...current,
          cursor: queued.body.length,
          imageAttachments: queued.imageAttachments,
          input: queued.body,
          pastedChunks: queued.pastedChunks,
          promptHistoryCursor: null,
          promptHistoryDraft: '',
          queuedMessage: null,
        };
      });
      return;
    }
    if (state.busy) return;
    store.update((current) => {
      const next = navigatePromptHistory(current as any, 'previous');
      prepareForComposerInputChange(current, next.input);
      return next;
    });
    return;
  }

  if (key.downArrow) {
    if (state.busy) return;
    store.update((current) => {
      const next = navigatePromptHistory(current as any, 'next');
      prepareForComposerInputChange(current, next.input);
      return next;
    });
    return;
  }

  if (commandPaletteActive && key.tab) {
    const suggestion =
      commandSuggestions[Math.min(state.commandCursor, commandSuggestions.length - 1)];
    if (!suggestion) return;
    store.update((current) => {
      const nextInput = applySlashCommandSuggestion(current.input, suggestion);
      prepareForComposerInputChange(current, nextInput.input);
      return { ...current, commandCursor: 0, ...nextInput };
    });
    return;
  }

  if (key.returnKey) {
    const token = getInputCommandToken(state.input);
    if (commandPaletteActive && !isExactSlashCommandToken(token)) {
      const suggestion =
        commandSuggestions[Math.min(state.commandCursor, commandSuggestions.length - 1)];
      if (!suggestion) return;
      store.update((current) => {
        const nextInput = applySlashCommandSuggestion(current.input, suggestion);
        prepareForComposerInputChange(current, nextInput.input);
        return { ...current, commandCursor: 0, ...nextInput };
      });
      return;
    }
    void handlers.onSubmit(state.input);
    return;
  }

  if (key.leftArrow) {
    store.update((current) => ({
      ...current,
      cursor: Math.max(current.cursor - 1, 0),
    }));
    return;
  }

  if (key.rightArrow) {
    store.update((current) => ({
      ...current,
      cursor: Math.min(current.cursor + 1, current.input.length),
    }));
    return;
  }

  if (key.home) {
    store.update((current) => ({ ...current, commandCursor: 0, cursor: 0 }));
    return;
  }

  if (key.end) {
    store.update((current) => ({
      ...current,
      commandCursor: 0,
      cursor: current.input.length,
    }));
    return;
  }

  if (key.backspace) {
    store.update((current) => {
      const next = deleteBeforeCursor(current as any);
      if (next) prepareForComposerInputChange(current, next.input);
      return next ? { ...current, commandCursor: 0, ...next } : current;
    });
    return;
  }

  if (key.delete) {
    store.update((current) => {
      const next = deleteAtCursor(current as any);
      if (next) prepareForComposerInputChange(current, next.input);
      return next ? { ...current, commandCursor: 0, ...next } : current;
    });
    return;
  }

  if (key.tab) {
    store.update((current) => {
      const nextInput = insertAtCursor(current as any, '  ');
      prepareForComposerInputChange(current, nextInput.input);
      return { ...current, commandCursor: 0, ...nextInput };
    });
    return;
  }

  if (isClipboardImagePasteKey(key)) {
    const current = store.getState();
    // A queued message owns the composer, so a paste belongs to IT: the user is
    // assembling the message that goes next, and telling them to wait for the
    // turn to end is the whole complaint. With nothing queued the paste lands
    // in the composer as before — including mid-turn, which used to be refused
    // outright for no reason other than the turn being busy.
    const target = current.queuedMessage
      ? {
          body: current.queuedMessage.body,
          attachments: current.queuedMessage.imageAttachments as ImageAttachment[],
        }
      : { body: current.input, attachments: current.imageAttachments as ImageAttachment[] };
    const liveAttachments = target.attachments.filter((attachment) =>
      target.body.includes(`[Image #${attachment.index}]`),
    );
    if (liveAttachments.length >= MAX_IMAGES_PER_MESSAGE) {
      store.appendEntry({
        body: `Maximum of ${MAX_IMAGES_PER_MESSAGE} images per message. Send the current message first.`,
        kind: 'error',
        title: 'Image',
      });
      return;
    }
    try {
      const clipResult = readClipboardImage();
      if (
        totalAttachmentBytes(liveAttachments) +
          approximateBase64DecodedBytes(clipResult.base64Data) >
        MAX_TOTAL_IMAGE_BYTES_PER_MESSAGE
      ) {
        store.appendEntry({
          body: `This image would put the message over the ${Math.round(MAX_TOTAL_IMAGE_BYTES_PER_MESSAGE / 1024 / 1024)}MB combined image limit. Send the current message first.`,
          kind: 'error',
          title: 'Image',
        });
        return;
      }
      const idx =
        liveAttachments.length === 0
          ? 1
          : Math.max(...liveAttachments.map((attachment) => attachment.index)) + 1;
      // A paste has no file of its own, so the session copy is the only path
      // this image will ever have — it is what lets the model re-read it later,
      // and it assigns the marker number so [Image #N] is unique for the whole
      // session rather than restarting at 1 on every message.
      const cached = tryCacheAttachmentBytes({
        base64Data: clipResult.base64Data,
        mimeType: clipResult.mimeType,
      });
      const attachment: ImageAttachment = {
        index: cached?.index ?? idx,
        mimeType: clipResult.mimeType,
        base64Data: clipResult.base64Data,
        source: 'clipboard' as const,
        ...(cached ? { cachePath: cached.cachePath } : {}),
      };
      const marker = attachment.index;
      store.update((shellState) => {
        const nextAttachments = [...liveAttachments, attachment];
        if (shellState.queuedMessage) {
          return {
            ...shellState,
            queuedMessage: {
              ...shellState.queuedMessage,
              body: `${shellState.queuedMessage.body} [Image #${marker}]`.trim(),
              imageAttachments: nextAttachments,
            },
          };
        }
        return {
          ...shellState,
          imageAttachments: nextAttachments,
          ...insertAtCursor(shellState as any, `[Image #${marker}] `),
        };
      });
    } catch (error: any) {
      if (error?.code === 'NO_IMAGE') {
        store.appendEntry({
          body: 'No image found on clipboard. Use Ctrl+Shift+V to paste text.',
          kind: 'error',
          title: 'Image',
        });
      } else if (error?.code === 'NO_TOOL' || error?.code === 'READ_FAILED') {
        store.appendEntry({
          body: error.message,
          kind: 'error',
          title: 'Image Error',
        });
      }
    }
    return;
  }

  if (!key.ctrl && !key.meta && key.input) {
    store.update((current) => {
      const nextInput = insertAtCursor(current as any, key.input);
      prepareForComposerInputChange(current, nextInput.input);
      return { ...current, commandCursor: 0, ...nextInput };
    });
  }
}
