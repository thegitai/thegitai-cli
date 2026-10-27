import { spawn } from 'node:child_process';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';


import { emitKeypressEvents } from 'node:readline';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import chalk from './colors.js';
import { isAbortError } from './utils.js';
import { compareCliVersions, UNKNOWN_CLI_VERSION } from './version.js';

const PACKAGE_NAME = '@thegitai/cli';


export type UpdateChoice = 'update' | 'skip';


export type UpdateAnswer = UpdateChoice | 'cancel';


export type UpdateOutcome =
  | 'none'
  | 'updated'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface UpdateOffer {
  currentVersion: string;
  latestVersion: string;

  program: string;
  args: string[];

  display: string;
}











export function resolveInstallCommand(
  version: string,
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): { program: string; args: string[] } {
  const spec = `${PACKAGE_NAME}@${version}`;


  const location = moduleDir.replace(/\\/g, '/').toLowerCase();




  if (location.includes('/pnpm/global/')) {
    return { program: 'pnpm', args: ['add', '-g', spec] };
  }
  if (location.includes('/.bun/install/global/')) {
    return { program: 'bun', args: ['add', '-g', spec] };
  }
  return { program: 'npm', args: ['install', '-g', spec] };
}








export function buildUpdateOffer({
  currentVersion,
  latestVersion,
  moduleDir,
}: {
  currentVersion: string;
  latestVersion: string | null | undefined;
  moduleDir?: string;
}): UpdateOffer | null {
  if (!latestVersion) return null;
  if (currentVersion === UNKNOWN_CLI_VERSION) return null;
  const ordering = compareCliVersions(currentVersion, latestVersion);
  if (ordering === null || ordering >= 0) return null;
  const { program, args } = resolveInstallCommand(latestVersion, moduleDir);
  return {
    currentVersion,
    latestVersion,
    program,
    args,
    display: [program, ...args].join(' '),
  };
}


export const UPDATE_OPTIONS: readonly UpdateChoice[] = ['update', 'skip'];

const UPDATE_KEY_HINT = '↑/↓ choose  •  Enter accepts  •  Ctrl+C quits';


function formatUpdateHeader(offer: UpdateOffer): string {
  return [
    '',
    `  ${chalk.yellow('✨ Update available')} - ${chalk.dim(
      offer.currentVersion,
    )} → ${chalk.bold(offer.latestVersion)}`,
    '',
    '  TheGitAI works best with the latest version. TheGitAI may not work',
    '  optimally if not updated.',
    '',
  ].join('\n');
}









export function formatUpdateOptions(offer: UpdateOffer, selectedIndex = 0): string {
  const rows = [
    { note: `(runs \`${offer.display}\`)`, text: 'Update now' },
    { note: '(Agent may not work optimally)', text: 'Skip' },
  ];
  return [
    ...rows.map(({ note, text }, index) =>
      index === selectedIndex
        ? `  ${chalk.cyan(`› ${index + 1}. ${text}`)} ${chalk.dim(note)}`
        : `    ${chalk.dim(`${index + 1}.`)} ${text} ${chalk.dim(note)}`,
    ),
    '',
    `  ${chalk.dim(UPDATE_KEY_HINT)}`,
    '',
  ].join('\n');
}





export function formatUpdateScreen(offer: UpdateOffer, selectedIndex = 0): string {
  return `${formatUpdateHeader(offer)}\n${formatUpdateOptions(offer, selectedIndex)}`;
}


export type UpdateKeyAction =
  | { kind: 'answer'; answer: UpdateAnswer }
  | { kind: 'ignore' }
  | { kind: 'select'; index: number };

interface UpdateKey {
  ctrl?: boolean;
  name?: string;
  sequence?: string;
}








export function readUpdateKey(key: UpdateKey, selectedIndex: number): UpdateKeyAction {
  const name = key.name ?? '';


  if (key.ctrl && (name === 'c' || name === 'd')) {
    return { kind: 'answer', answer: 'cancel' };
  }
  if (name === 'return' || name === 'enter') {
    return { kind: 'answer', answer: UPDATE_OPTIONS[selectedIndex] ?? 'update' };
  }
  if (name === 'up' || (name === 'tab' && key.sequence === '\u001b[Z')) {
    return { kind: 'select', index: Math.max(selectedIndex - 1, 0) };
  }
  if (name === 'down' || name === 'tab') {
    return { kind: 'select', index: Math.min(selectedIndex + 1, UPDATE_OPTIONS.length - 1) };
  }
  const digit = Number.parseInt(key.sequence ?? '', 10);
  if (Number.isInteger(digit) && digit >= 1 && digit <= UPDATE_OPTIONS.length) {
    return { kind: 'answer', answer: UPDATE_OPTIONS[digit - 1]! };
  }
  return { kind: 'ignore' };
}


export function readUpdateChoice(answer: string): UpdateChoice {
  const value = answer.trim().toLowerCase();
  if (value === '' || value === '1' || value === 'y' || value === 'yes') {
    return 'update';
  }
  return 'skip';
}










export async function resolveUpdateAnswer(
  question: () => Promise<string>,
): Promise<UpdateAnswer> {
  try {
    return readUpdateChoice(await question());
  } catch (error) {
    if (isAbortError(error)) return 'cancel';
    throw error;
  }
}







export function renderedRowCount(text: string, columns: number): number {
  const width = Math.max(1, columns);
  const lines = text.split('\n');


  if (lines[lines.length - 1] === '') lines.pop();
  return lines.reduce((rows, line) => {

    const visible = [...line.replace(/\x1b\[[0-9;]*m/g, '')].length;
    return rows + Math.max(1, Math.ceil(visible / width));
  }, 0);
}





async function askUpdateChoiceWithKeys(offer: UpdateOffer): Promise<UpdateAnswer> {
  let selected = 0;
  const show = (index: number) => {
    const rows = renderedRowCount(
      `${formatUpdateOptions(offer, selected)}\n`,
      output.columns ?? 80,
    );
    selected = index;
    output.write(`\u001b[${rows}A\u001b[0J${formatUpdateOptions(offer, selected)}\n`);
  };
  emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<UpdateAnswer>((resolve) => {
      const onKeypress = (_text: string, key: UpdateKey | undefined) => {
        const action = readUpdateKey(key ?? {}, selected);
        if (action.kind === 'ignore') return;
        if (action.kind === 'select') {
          if (action.index !== selected) show(action.index);
          return;
        }



        const chosen = UPDATE_OPTIONS.indexOf(action.answer as UpdateChoice);
        if (chosen >= 0 && chosen !== selected) show(chosen);
        input.off('keypress', onKeypress);
        resolve(action.answer);
      };
      input.on('keypress', onKeypress);
    });
  } finally {
    if (!wasRaw) input.setRawMode(false);
    input.pause();
  }
}

async function askUpdateChoice(offer: UpdateOffer): Promise<UpdateAnswer> {



  if (input.isTTY && output.isTTY) return await askUpdateChoiceWithKeys(offer);
  const rl = readline.createInterface({ input, output });
  try {
    return await resolveUpdateAnswer(() => rl.question('  ▸ '));
  } finally {
    rl.close();
  }
}







export async function runUpdate(offer: UpdateOffer): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(offer.program, offer.args, {
      stdio: 'inherit',


      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}









export async function offerUpdateAtStartup({
  currentVersion,
  latestVersion,
  ask = askUpdateChoice,
  install = runUpdate,
  write = (text: string) => {
    process.stdout.write(text);
  },
}: {
  currentVersion: string;
  latestVersion: string | null | undefined;
  ask?: (offer: UpdateOffer) => Promise<UpdateAnswer>;
  install?: (offer: UpdateOffer) => Promise<boolean>;
  write?: (text: string) => void;
}): Promise<UpdateOutcome> {
  const offer = buildUpdateOffer({ currentVersion, latestVersion });
  if (!offer) return 'none';
  write(`${formatUpdateScreen(offer)}\n`);
  const answer = await ask(offer);
  if (answer === 'cancel') {
    write(`\n  ${chalk.dim('Cancelled. Nothing was installed.')}\n\n`);
    return 'cancelled';
  }
  if (answer === 'skip') {
    write(
      `\n  ${chalk.yellow(
        `Continuing on ${offer.currentVersion} - you'll be asked again next time.`,
      )}\n\n`,
    );
    return 'skipped';
  }
  write(`\n  ${chalk.dim(`$ ${offer.display}`)}\n\n`);
  if (await install(offer)) {
    write(
      `\n  ${chalk.green(`✓ Updated to ${offer.latestVersion}.`)} Run ${chalk.bold(
        'ai',
      )} again to start.\n\n`,
    );
    return 'updated';
  }



  write(
    [
      '',
      `  ${chalk.red('✖ The update did not complete.')} Run this yourself, then start ${chalk.bold(
        'ai',
      )} again:`,
      '',
      `    ${chalk.bold(offer.display)}`,
      '',
      `  ${chalk.dim(`Starting on ${offer.currentVersion} for now.`)}`,
      '',
      '',
    ].join('\n'),
  );
  return 'failed';
}
