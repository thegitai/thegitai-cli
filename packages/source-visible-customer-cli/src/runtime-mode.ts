export function isTuiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.THEGITAI_TUI === '1';
}

type CommandOutputHook = (chunk: string) => void;
let _commandOutputHook: CommandOutputHook | null = null;

export function setCommandOutputHook(hook: CommandOutputHook | null): void {
  _commandOutputHook = hook;
}

export function emitCommandOutput(chunk: string): void {
  _commandOutputHook?.(chunk);
}

type TuiEnvStack = { depth: number; original: string | undefined };

const tuiEnvStacks = new WeakMap<NodeJS.ProcessEnv, TuiEnvStack>();

export async function withTuiMode<T>(
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  let stack = tuiEnvStacks.get(env);
  if (!stack) {
    stack = { depth: 0, original: env.THEGITAI_TUI };
    tuiEnvStacks.set(env, stack);
  }
  stack.depth += 1;
  env.THEGITAI_TUI = '1';
  try {
    return await run();
  } finally {
    stack.depth -= 1;
    if (stack.depth <= 0) {
      tuiEnvStacks.delete(env);
      if (stack.original === undefined) {
        delete env.THEGITAI_TUI;
      } else {
        env.THEGITAI_TUI = stack.original;
      }
    }
  }
}
