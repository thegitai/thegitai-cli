import { isTuiMode } from '../../runtime-mode.js';
const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴'] as const;
const TITLE_BRAND = 'TheGitAI';
const TITLE_MARK_PREFIX = '❯_';

export const TERMINAL_TITLE_SPINNER_MS = 500;

export type TerminalTitleState = 'clean' | 'wip' | 'review';

export function resolveTerminalTitleState(input: {
  awaitingReview: boolean;
  busy: boolean;
}): TerminalTitleState {
  if (input.awaitingReview) return 'review';
  if (input.busy) return 'wip';
  return 'clean';
}

export function formatTerminalTitle(
  state: TerminalTitleState,
  spinnerFrame = 0,
): string {
  if (state === 'review') return `${TITLE_MARK_PREFIX}▸ ${TITLE_BRAND}`;
  if (state === 'wip') {
    const frame =
      BRAILLE_SPINNER_FRAMES[spinnerFrame % BRAILLE_SPINNER_FRAMES.length]!;
    return `${TITLE_MARK_PREFIX}${frame} ${TITLE_BRAND}`;
  }
  return `${TITLE_MARK_PREFIX}● ${TITLE_BRAND}`;
}

// Only for the non-TUI code paths. While the ratatui process is running it owns
// the terminal, and a second writer's escape can be interleaved into the middle
// of one of its frame flushes — splitting a sequence and printing the orphaned
// tail ("0m", "34;7H") over the status rows. In TUI mode the title is sent to
// that process over the protocol instead (RatatuiBridge.setTitle).
export function writeTerminalTitle(
  title: string,
  stream: NodeJS.WritableStream = process.stdout,
): void {
  if (isTuiMode()) return;
  if (!('isTTY' in stream) || !stream.isTTY) return;
  stream.write(`\x1b]0;${title}\x07`);
}

export function createTerminalTitleController(options?: {
  write?: (title: string) => void;
}): {
  sync: (input: { awaitingReview: boolean; busy: boolean }) => void;
  dispose: () => void;
} {
  const write = options?.write ?? writeTerminalTitle;
  let currentState: TerminalTitleState = 'clean';
  let spinnerFrame = 0;
  let lastTitle = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = () => {
    const title = formatTerminalTitle(currentState, spinnerFrame);
    if (title === lastTitle) return;
    lastTitle = title;
    write(title);
  };

  const stopTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const startTimer = () => {
    if (timer) return;
    timer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      paint();
    }, TERMINAL_TITLE_SPINNER_MS);
  };

  return {
    sync(input) {
      const next = resolveTerminalTitleState(input);
      if (next !== currentState) {
        currentState = next;
        if (next === 'wip') {
          spinnerFrame = 0;
          startTimer();
        } else {
          stopTimer();
        }
      } else if (next === 'wip') {
        startTimer();
      } else {
        stopTimer();
      }
      paint();
    },
    dispose() {
      stopTimer();
      currentState = 'clean';
      spinnerFrame = 0;
      paint();
    },
  };
}
