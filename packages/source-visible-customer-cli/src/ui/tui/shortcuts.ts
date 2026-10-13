import { agentModeCycleSequence } from '../../agent-mode.js';





export interface ShortcutsAvailability {
  approvalPrompt?: unknown;
  cursor?: number;
  exiting?: boolean;
  input?: string;
  pastedChunks?: unknown[];
  promptHistoryCursor?: number | null;
  queuedMessage?: unknown;
  sudoPrompt?: unknown;
  userInputPrompt?: unknown;
}







export function shortcutsPanelAvailable(state: ShortcutsAvailability): boolean {
  return (
    !state.exiting &&
    !state.approvalPrompt &&
    !state.sudoPrompt &&
    !state.userInputPrompt &&
    !state.queuedMessage &&
    !state.input &&
    (state.cursor ?? 0) === 0 &&
    (state.pastedChunks?.length ?? 0) === 0 &&
    state.promptHistoryCursor == null
  );
}

export interface ShortcutRow {
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}


export function buildShortcutGroups(
  platform: NodeJS.Platform = process.platform,
): ShortcutGroup[] {
  const imagePaste = platform === 'win32' ? 'Alt+V' : 'Ctrl+V';
  const textPaste = platform === 'darwin' ? 'Cmd+V' : 'Ctrl+Shift+V';
  return [
    {
      title: 'Composer',
      rows: [
        { keys: 'Enter', description: 'Send your message' },
        {
          keys: 'Shift+Tab',
          description: `Cycle ${agentModeCycleSequence()} (between turns)`,
        },
        { keys: '/', description: 'Slash commands — /help lists them all' },
        { keys: '↑ / ↓', description: 'Earlier prompts' },
        { keys: 'Esc', description: 'Clear the composer' },
        { keys: 'Ctrl+C', description: 'Clear the composer, or quit when empty' },
        { keys: 'Ctrl+G', description: 'Desktop notifications — toggle on or off' },
      ],
    },
    {
      title: 'While the agent is working',
      rows: [
        { keys: 'Enter', description: 'Queue a message; Enter again sends it into the turn' },
        { keys: '↑', description: 'Bring a queued message back to edit it' },
        { keys: 'Esc', description: 'Discard the queued message, or cancel the turn' },
        { keys: 'Ctrl+C', description: 'Cancel the turn' },
        { keys: 'Ctrl+B', description: 'Background jobs' },
      ],
    },
    {
      title: 'Clipboard & images',
      rows: [
        { keys: imagePaste, description: 'Paste a screenshot into the message' },
        { keys: textPaste, description: 'Paste text (your terminal’s own shortcut)' },
        { keys: 'Right-click', description: 'Paste, or copy the link under the cursor' },
      ],
    },
    {
      title: 'Transcript',
      rows: [
        { keys: 'PageUp / PageDown', description: 'Scroll — the mouse wheel works too' },
        { keys: 'Drag', description: 'Select and copy' },
        { keys: 'Double-click', description: 'Copy a word' },
        { keys: 'Triple-click', description: 'Copy a whole row' },
        { keys: 'Left-click', description: 'Open a link' },
      ],
    },
  ];
}
