import type { MemoryTopic } from '../api/contracts.js';
import {
  deleteMemoryTopic,
  isMemoryEnabled,
  listMemoryTopics,
  memoryFolders,
  readMemoryTopicFile,
  setMemoryEnabled,
} from './store.js';

const USAGE =
  'Usage: /memory, /memory show <number>, /memory delete <number>, /memory off, /memory on';

const shownListings = new Map<string, Array<Pick<MemoryTopic, 'scope' | 'name'>>>();

function when(timestamp: string): string {
  return timestamp.slice(0, 16).replace('T', ' ');
}

function listing(rootDir: string, env: NodeJS.ProcessEnv): string {
  const topics = listMemoryTopics(rootDir, env);
  const folders = memoryFolders(rootDir, env);
  shownListings.set(folders.project, topics.map(({ scope, name }) => ({ scope, name })));
  const status = isMemoryEnabled(env)
    ? 'Memory is on. Notes stay on this computer.'
    : 'Memory is off. Saved notes are kept but not used.';
  if (topics.length === 0) return `${status}\n\nNothing saved yet.`;
  const section = (title: string, scope: MemoryTopic['scope']) => {
    const lines = topics.flatMap((topic, index) =>
      topic.scope === scope
        ? [`${index + 1}. ${topic.name} - ${topic.description} (updated ${when(topic.updated)})`]
        : [],
    );
    return lines.length ? [`${title}: ${folders[scope]}`, ...lines, ''] : [];
  };
  return [
    status,
    '',
    ...section('This project', 'project'),
    ...section('Everywhere', 'personal'),
    'Each topic is a Markdown file in the folder above, and can be edited in any text editor.',
    USAGE,
  ].join('\n');
}

export function runMemoryCommand(
  args: string,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'list') return listing(rootDir, env);
  if (trimmed === 'off' || trimmed === 'on') {
    setMemoryEnabled(trimmed === 'on', env);
    return listing(rootDir, env);
  }
  const match = trimmed.match(/^(show|delete)\s+(\d+)$/);
  if (!match) return USAGE;
  const shown = shownListings.get(memoryFolders(rootDir, env).project);
  if (!shown) return 'Run /memory first to see the topic numbers.';
  const target = shown[Number(match[2]) - 1];
  if (!target) return `There is no memory topic number ${match[2]}.`;
  try {
    if (match[1] === 'show') return readMemoryTopicFile({ rootDir, env, ...target }).content.trimEnd();
    return deleteMemoryTopic({ rootDir, env, ...target })
      ? `Deleted: ${target.name}`
      : 'That topic no longer exists. Run /memory to see the current list.';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
