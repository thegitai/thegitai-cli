import { spawn } from 'node:child_process';

export interface OpenUrlCommand {
  command: string;
  args: string[];
}

export function resolveOpenUrlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): OpenUrlCommand {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// links can be opened.');
  }

  const href = parsed.href;
  if (platform === 'darwin') {
    return { command: 'open', args: [href] };
  }
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', href] };
  }
  return { command: 'xdg-open', args: [href] };
}

export async function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const { command, args } = resolveOpenUrlCommand(url, platform);
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}
