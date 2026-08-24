export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

export interface TodoListSnapshot {
  items: TodoItem[];
  completedCount: number;
  totalCount: number;
}

export const MAX_TODO_ITEMS = 20;

export const MAX_TODO_TEXT_CHARS = 160;

// Session-local agent progress list. One list per active session, replaced
// wholesale by each update_todos call and cleared on session switch or /new.
let items: TodoItem[] = [];
let activeSessionId: string | null = null;

const STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: 'pending',
  todo: 'pending',
  not_started: 'pending',
  in_progress: 'in_progress',
  active: 'in_progress',
  doing: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
};

function normalizeStatus(raw: unknown): TodoStatus | null {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return STATUS_ALIASES[key] ?? null;
}

export function isCompletedStatus(raw: unknown): boolean {
  return normalizeStatus(raw) === 'completed';
}

// Models occasionally send the list under a differently-named key; every
// entry point that reads the raw tool-call args (the tool itself, and status
// text formatted before dispatch/normalization) should recognize the same
// aliases so behavior doesn't depend on which path handled the call.
const TODOS_ARG_ALIASES = ['items', 'todo_list', 'todoList', 'list', 'tasks'];

export function extractTodosArg(args: unknown): unknown {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  if (record.todos !== undefined) return record.todos;
  for (const key of TODOS_ARG_ALIASES) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

export function setTodoSession(sessionId: string | null): void {
  const next = String(sessionId ?? '').trim() || null;
  if (activeSessionId !== next) {
    items = [];
  }
  activeSessionId = next;
}

export function listTodos(): TodoItem[] {
  return items.map((item) => ({ ...item }));
}

export function getTodoSnapshot(): TodoListSnapshot {
  return {
    items: listTodos(),
    completedCount: items.filter((item) => item.status === 'completed').length,
    totalCount: items.length,
  };
}

export function clearTodos(): void {
  items = [];
}

export type ReplaceTodosResult =
  | { ok: true; snapshot: TodoListSnapshot; normalizations: string[] }
  | { ok: false; error: string };

// Validate and apply a whole-list replacement from the update_todos tool.
// Repairs the recoverable shapes models actually produce (status aliases,
// overlong text, several in_progress items) and reports each repair so the
// model sees what was kept; only structurally unusable input is rejected.
export function replaceTodos(raw: unknown): ReplaceTodosResult {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'todos must be an array of { text, status } items.' };
  }
  const normalizations: string[] = [];
  if (raw.length > MAX_TODO_ITEMS) {
    return {
      ok: false,
      error: `todos supports at most ${MAX_TODO_ITEMS} items; got ${raw.length}. Use fewer, broader steps.`,
    };
  }
  const next: TodoItem[] = [];
  let sawInProgress = false;
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `todos[${index}] must be an object with text and status.` };
    }
    // Collapse embedded newlines/tabs to spaces: the renderer budgets one
    // physical row per item, so multiline text would silently break that.
    const text = String((entry as { text?: unknown }).text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) {
      return { ok: false, error: `todos[${index}].text must be a non-empty string.` };
    }
    const status = normalizeStatus((entry as { status?: unknown }).status);
    if (!status) {
      return {
        ok: false,
        error: `todos[${index}].status must be one of: pending, in_progress, completed.`,
      };
    }
    let boundedText = text;
    if (boundedText.length > MAX_TODO_TEXT_CHARS) {
      boundedText = `${boundedText.slice(0, MAX_TODO_TEXT_CHARS - 1)}…`;
      normalizations.push(`todos[${index}].text truncated to ${MAX_TODO_TEXT_CHARS} chars`);
    }
    let finalStatus = status;
    if (status === 'in_progress') {
      if (sawInProgress) {
        finalStatus = 'pending';
        normalizations.push(
          `todos[${index}] demoted to pending: only one item can be in_progress`,
        );
      }
      sawInProgress = true;
    }
    next.push({ text: boundedText, status: finalStatus });
  }
  items = next;
  return { ok: true, snapshot: getTodoSnapshot(), normalizations };
}
