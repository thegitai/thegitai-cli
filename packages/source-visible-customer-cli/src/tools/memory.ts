import { addMemoryEntry, isMemoryEnabled, searchMemoryTopics } from '../memory/store.js';
import type { ToolContext, ToolResponse } from './types.js';

const RECALL_BODY_CHARS = 4_000;

function memoryOff(): ToolResponse {
  return { ok: false, error: 'Memory is turned off.', failureCategory: 'permission_denied' };
}

export function rememberNote(context: ToolContext, args: any): ToolResponse {
  if (!isMemoryEnabled(context.env)) return memoryOff();
  const saved = addMemoryEntry({
    rootDir: context.rootDir,
    env: context.env,
    scope: args?.scope,
    topic: args?.topic,
    text: args?.text,
    description: args?.description,
    type: args?.kind,
    body: args?.body,
    basedOn: args?.basedOn,
  });
  if (!saved.ok) {
    return { ok: false, error: saved.error, failureCategory: 'invalid_argument' };
  }
  const { topic, entry } = saved;
  return {
    ok: true,
    topic: topic.name,
    scope: topic.scope,
    description: topic.description,
    type: topic.type,
    created: topic.created,
    updated: topic.updated,
    at: entry.at,
    text: entry.text,
    newTopic: saved.created,
    output: 'Saved to memory.',
  };
}

function entriesFor(body: string, query: string): { body: string; omittedEntries: number } {
  const blocks = body.split(/\n\s*\n/).filter((block) => block.trim());
  if (body.length <= RECALL_BODY_CHARS) return { body, omittedEntries: 0 };
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
  const matching = blocks.map((block, index) => ({ index, hit: terms.some((term) => block.toLowerCase().includes(term)) }));
  const order = [
    ...matching.filter((item) => item.hit).map((item) => item.index),
    ...matching.filter((item) => !item.hit).map((item) => item.index).reverse(),
  ];
  const kept = new Set<number>();
  let used = 0;
  for (const index of order) {
    const size = blocks[index]!.length + 2;
    if (used + size > RECALL_BODY_CHARS && kept.size > 0) continue;
    kept.add(index);
    used += size;
  }
  return {
    body: blocks.filter((_, index) => kept.has(index)).join('\n\n'),
    omittedEntries: blocks.length - kept.size,
  };
}

export function recallNotes(context: ToolContext, args: any): ToolResponse {
  if (!isMemoryEnabled(context.env)) return memoryOff();
  const matches = searchMemoryTopics(
    context.rootDir,
    context.env ?? process.env,
    String(args?.query ?? ''),
  ).map((topic) => {
    const { body, omittedEntries } = entriesFor(topic.body ?? '', String(args?.query ?? ''));
    return {
      topic: topic.name,
      scope: topic.scope,
      description: topic.description,
      type: topic.type,
      created: topic.created,
      updated: topic.updated,
      body,
      ...(omittedEntries ? { omittedEntries } : {}),
    };
  });
  return { ok: true, query: String(args?.query ?? ''), matches };
}
