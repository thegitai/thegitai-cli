import { projectModelEffort } from '../../project-model-preferences.js';
import { cycleReasoningEffort } from '../../reasoning-effort.js';
import type { TuiChildMessage } from './types.js';
import { shortcutsPanelAvailable } from './shortcuts.js';
import { moveComposerCursorVertically } from './composer-layout.js';
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
  navigatePromptHistory,
  shouldRemountLiveFrameForComposerInputChange,
  slashCommandMatchesToken,
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
  getComposerInputWidth?: () => number;
  getTranscriptScrollLimit?: () => number;
  getUserInputViewport?: () => UserInputViewport;
  onCancelTurn: () => void;
  onCycleAgentMode: () => void;

  onAgentModeChangeBlocked?: () => void;
  onCtrlC?: () => void;
  onLiveFrameShapeChange: () => void;
  onLinkCopy?: (url: string) => void | Promise<void>;
  onLinkOpen?: (url: string) => void | Promise<void>;
  readClipboardText?: () => string;
  onSelectionCopy?: (text: string) => void | Promise<void>;
  onRequestExit: () => void;

  onResolveApproval: (optionIndex: number) => Promise<void>;
  onResolveUserInput?: (result: UserInputResult) => Promise<void>;
  onResumeSession: () => Promise<void>;
  onSelectModel: () => Promise<void>;
  onOpenJobsPicker: () => void;
  onToggleNotifications?: () => void;
  onJobsPickerOutput: () => Promise<void>;
  onJobsPickerKill: () => Promise<void>;
  onSudoPasswordInput: (event: SudoPasswordInput) => void;
  onSubmit: (input: string) => Promise<void>;



  onFireQueuedMessage?: () => Promise<void>;
}






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


  return !state.busy && state.imageAttachments.length > 0;
}

function shouldShowCommandPalette(state: {
  busy: boolean;
  exiting: boolean;
  input: string;
  jobsPickerOpen: boolean;
  modelPickerOpen: boolean;
  resumePickerOpen: boolean;
  skillsPickerOpen?: boolean;
}): boolean {
  if (
    state.busy ||
    state.exiting ||
    state.jobsPickerOpen ||
    state.modelPickerOpen ||
    state.resumePickerOpen ||
    state.skillsPickerOpen
  ) {
    return false;
  }
  const token = getInputCommandToken(state.input);
  if (!token.startsWith('/') || state.input.includes(' ')) return false;
  return getSlashCommandSuggestions(state.input).length > 0;
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
    current.skillsPickerOpen ||
    current.sudoPrompt
  ) {
    return;
  }
  const text = (handlers.readClipboardText ?? readClipboardText)();
  if (!text) {
    store.update((state) => ({
      ...state,
      transientStatus: 'Clipboard has no text to paste',
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



    if (key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -APPROVAL_PREVIEW_PAGE_ROWS : APPROVAL_PREVIEW_PAGE_ROWS;
      if (key.shift) {
        scrollTranscript(store, handlers, key.pageUp ? 8 : -8);
      } else {
        scrollApprovalPreview(store, handlers, delta);
      }
      return;
    }


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





    if (approvalIsGuarded(state)) {
      return;
    }
    if (key.escape) {


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



    if (key.escape || (key.ctrl && key.input === 'b' && !key.meta && !key.shift)) {
      handlers.onLiveFrameShapeChange();
      store.update((current) => ({
        ...current,
        jobsPickerExpandedId: null,
        jobsPickerOpen: false,
        jobsPickerReturnStatus: null,
        status: current.jobsPickerReturnStatus ?? 'Ready',
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
    if (key.leftArrow || key.rightArrow) {
      store.update((current) => {
        const options = buildModelPickerOptions(Number(current.currentModelId ?? 0), current.serverModels ?? []);
        const model = options[current.modelPickerIndex];
        if (!model || model.disabled || model.group === 'auto') return current;
        const efforts = current.modelPickerEfforts ?? {};
        return {
          ...current,
          modelPickerEfforts: {
            ...efforts,
            [String(model.publicId)]: cycleReasoningEffort(
              projectModelEffort(efforts, model.publicId),
              key.leftArrow ? -1 : 1,
            ),
          },
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


  if (state.skillsPickerOpen) {
    if (key.escape) {
      handlers.onLiveFrameShapeChange();
      store.update((current) => ({ ...current, skillsPickerOpen: false }));
      return;
    }
    if (key.upArrow || key.downArrow) {
      store.update((current) => {
        const count = (current.skillsPickerItems ?? []).length;
        const next = (current.skillsPickerIndex ?? 0) + (key.upArrow ? -1 : 1);
        return { ...current, skillsPickerIndex: Math.max(0, Math.min(next, count - 1)) };
      });
      return;
    }
    if (key.returnKey) {
      const item = (state.skillsPickerItems ?? [])[state.skillsPickerIndex ?? 0];
      if (!item?.usable) return;
      const input = `/${item.name} `;
      handlers.onLiveFrameShapeChange();
      store.update((current) => ({
        ...current,
        commandCursor: 0,
        cursor: input.length,
        input,
        skillsPickerOpen: false,
      }));
    }
    return;
  }

  if (state.shortcutsOpen) {
    if (key.escape || key.returnKey || key.input === '?' || key.input === 'q') {
      handlers.onLiveFrameShapeChange();
      store.update((current) => ({ ...current, shortcutsOpen: false }));
    }
    return;
  }






  if (key.ctrl && key.input === 'b' && !key.meta && !key.shift) {
    if ((state.backgroundJobs ?? []).length > 0) {
      handlers.onOpenJobsPicker();
    }
    return;
  }




  if (key.ctrl && key.input === 'g' && !key.meta && !key.shift) {
    handlers.onToggleNotifications?.();
    return;
  }



  if (key.input === '?' && !key.ctrl && !key.meta && shortcutsPanelAvailable(state)) {
    handlers.onLiveFrameShapeChange();
    store.update((current) => ({ ...current, shortcutsOpen: true }));
    return;
  }

  if (key.escape) {
    if (state.busy) {


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


    if (state.busy) {
      handlers.onAgentModeChangeBlocked?.();
      return;
    }
    handlers.onCycleAgentMode();
    return;
  }










  if (state.busy && state.queuedMessage) {
    if (key.returnKey) {
      void handlers.onFireQueuedMessage?.();
      return;
    }





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
    const nextCursor = moveComposerCursorVertically(
      state.input,
      state.cursor,
      handlers.getComposerInputWidth?.() ?? Number.POSITIVE_INFINITY,
      -1,
    );



    if (nextCursor === null && state.busy) return;
    store.update((current) => {
      if (nextCursor !== null) {
        return { ...current, commandCursor: 0, cursor: nextCursor };
      }
      const next = navigatePromptHistory(current as any, 'previous');
      prepareForComposerInputChange(current, next.input);
      return next;
    });
    return;
  }

  if (key.downArrow) {
    const nextCursor = moveComposerCursorVertically(
      state.input,
      state.cursor,
      handlers.getComposerInputWidth?.() ?? Number.POSITIVE_INFINITY,
      1,
    );



    if (nextCursor === null && state.busy) return;
    store.update((current) => {
      if (nextCursor !== null) {
        return { ...current, commandCursor: 0, cursor: nextCursor };
      }
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
    const suggestion =
      commandSuggestions[Math.min(state.commandCursor, commandSuggestions.length - 1)];




    if (
      commandPaletteActive &&
      suggestion &&
      !slashCommandMatchesToken(suggestion, token)
    ) {
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
