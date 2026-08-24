import { extractTodosArg, replaceTodos } from '../todo-list.js';
import { ToolContext, ToolResponse } from './types.js';

export function updateTodos(
  _context: ToolContext,
  args: {
    todos?: Array<{ text?: string; status?: string }>;
  },
): ToolResponse {
  const rawTodos = extractTodosArg(args);
  if (rawTodos === undefined) {
    return {
      ok: false,
      error: 'todos is required (pass [] to clear the list).',
      failureCategory: 'missing_required_argument',
    };
  }
  const result = replaceTodos(rawTodos);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      failureCategory: 'invalid_argument',
    };
  }
  const { snapshot, normalizations } = result;
  return {
    ok: true,
    todos: snapshot.items,
    completedCount: snapshot.completedCount,
    totalCount: snapshot.totalCount,
    ...(normalizations.length ? { normalizations } : {}),
  };
}
