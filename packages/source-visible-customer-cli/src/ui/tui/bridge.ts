import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { TuiChildMessage, TuiFrame } from './types.js';

const requireFromHere = createRequire(import.meta.url);

function normalizeChildMessage(
  raw: Record<string, unknown>,
): TuiChildMessage | null {
  if (raw.op === 'ready') {
    return {
      op: 'ready',
      cols: Number(raw.cols ?? 80),
      rows: Number(raw.rows ?? 24),
    };
  }
  if (raw.op === 'closed') {
    return { op: 'closed' };
  }
  if (raw.op !== 'event') {
    return null;
  }
  if (raw.kind === 'paste') {
    return { op: 'event', kind: 'paste', text: String(raw.text ?? '') };
  }
  if (raw.kind === 'resize') {
    return {
      op: 'event',
      kind: 'resize',
      cols: Number(raw.cols ?? 80),
      rows: Number(raw.rows ?? 24),
    };
  }
  if (raw.kind === 'selectionCopy') {
    return {
      op: 'event',
      kind: 'selectionCopy',
      text: String(raw.text ?? ''),
    };
  }
  if (raw.kind === 'linkCopy') {
    return {
      op: 'event',
      kind: 'linkCopy',
      url: String(raw.url ?? ''),
    };
  }
  if (raw.kind === 'linkOpen') {
    return {
      op: 'event',
      kind: 'linkOpen',
      url: String(raw.url ?? ''),
    };
  }
  if (raw.kind === 'contextMenu') {
    return { op: 'event', kind: 'contextMenu' };
  }
  if (raw.kind === 'transcriptScroll') {
    return {
      op: 'event',
      kind: 'transcriptScroll',
      deltaLines: Number(raw.deltaLines ?? raw.delta_lines ?? 0),
    };
  }
  if (raw.kind === 'transcriptScrollTo') {
    return {
      op: 'event',
      kind: 'transcriptScrollTo',
      offset: Number(raw.offset ?? 0),
    };
  }
  if (raw.kind !== 'key') {
    return null;
  }
  const bool = (value: unknown) => value === true;
  return {
    op: 'event',
    kind: 'key',
    input: String(raw.input ?? ''),
    ctrl: bool(raw.ctrl),
    meta: bool(raw.meta),
    shift: bool(raw.shift),
    escape: bool(raw.escape),
    returnKey: bool(raw.returnKey ?? raw.return_key),
    tab: bool(raw.tab),
    backspace: bool(raw.backspace),
    delete: bool(raw.delete),
    upArrow: bool(raw.upArrow ?? raw.up_arrow),
    downArrow: bool(raw.downArrow ?? raw.down_arrow),
    leftArrow: bool(raw.leftArrow ?? raw.left_arrow),
    rightArrow: bool(raw.rightArrow ?? raw.right_arrow),
    home: bool(raw.home),
    end: bool(raw.end),
    paste: bool(raw.paste),
    pageUp: bool(raw.pageUp ?? raw.page_up),
    pageDown: bool(raw.pageDown ?? raw.page_down),
  };
}

export function resolveTuiBinaryPath(): string {
  const binaryName =
    process.platform === 'win32' ? 'thegitai-tui.exe' : 'thegitai-tui';
  const platformPackage = `@thegitai/tui-${process.platform}-${process.arch}`;

  // 1) Published per-platform optional dependency (the installed-from-npm path).
  try {
    return requireFromHere.resolve(`${platformPackage}/${binaryName}`);
  } catch {
    // Not installed (unsupported platform yet, or local dev) — fall through.
  }

  // 2) Local dev build: `npm run build:tui` populates the workspace bin/.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const devCandidates = [
    path.join(moduleDir, '../../../bin', binaryName),
    path.join(moduleDir, '../../../../bin', binaryName),
  ];
  const devBinary = devCandidates.find((candidate) => existsSync(candidate));
  if (devBinary) {
    return devBinary;
  }

  throw new Error(
    `Missing thegitai-tui binary. Expected the optional dependency "${platformPackage}" (your platform may not be supported yet), ` +
      `or a local build at one of: ${devCandidates.join(', ')} (run "npm run build:tui").`,
  );
}

export function spawnTuiProcess(options: { env?: NodeJS.ProcessEnv } = {}) {
  const binaryPath = resolveTuiBinaryPath();
  return spawn(binaryPath, [], {
    stdio: ['pipe', 'inherit', 'pipe'],
    env: { ...process.env, ...options.env },
  });
}

export interface RatatuiBridge {
  clear(): void;
  close(): Promise<void>;
  onEvent(handler: (message: TuiChildMessage) => void): void;
  render(frame: TuiFrame): void;
  setTitle(title: string): void;
}

export function createRatatuiBridge(): RatatuiBridge {
  const child = spawnTuiProcess() as ChildProcess & {
    stdin: NodeJS.WritableStream;
    stderr: NodeJS.ReadableStream;
  };
  const rl = createInterface({ input: child.stderr });
  let eventHandler: ((message: TuiChildMessage) => void) | null = null;
  let closed = false;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const message = normalizeChildMessage(
        JSON.parse(trimmed) as Record<string, unknown>,
      );
      if (!message) return;
      eventHandler?.(message);
      if (message.op === 'closed') {
        closed = true;
      }
    } catch {
      // ignore malformed protocol lines
    }
  });

  child.on('exit', () => {
    closed = true;
    eventHandler?.({ op: 'closed' });
  });

  const writeParent = (payload: Record<string, unknown>) => {
    if (closed) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    onEvent(handler) {
      eventHandler = handler;
    },
    render(frame) {
      writeParent({ op: 'frame', ...frame });
    },
    clear() {
      writeParent({ op: 'clear' });
    },
    // The TUI process owns the terminal, so it must be the one to write the title
    // escape. When the parent wrote it directly, its escape could land inside a
    // frame flush and split one of ratatui's sequences, printing the orphaned
    // tail ("0m", "34;7H") over the status rows.
    setTitle(title: string) {
      writeParent({ op: 'title', text: title });
    },
    async close() {
      if (closed) return;
      writeParent({ op: 'quit' });
      closed = true;
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 500);
      });
      rl.close();
    },
  };
}
