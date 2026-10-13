import { spawn } from 'node:child_process';












export interface NotificationRequest {
  body: string;
  title: string;
}


export type NotificationHandle = string | null;

export interface NotifierBackend {

  canWithdraw: boolean;
  post: (
    request: NotificationRequest,
    previous: NotificationHandle,
  ) => Promise<NotificationHandle>;
  withdraw: (handle: NotificationHandle) => void;
}

function run(
  command: string,
  args: string[],
  { capture = false }: { capture?: boolean } = {},
): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
      });
    } catch {
      resolve('');
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
  });
}






const linuxBackend: NotifierBackend = {
  canWithdraw: true,
  async post(request, previous) {
    const args = [
      '--print-id',
      '--app-name=TheGitAI',
      '--icon=utilities-terminal',
      '--urgency=normal',
    ];
    if (previous) args.push(`--replace-id=${previous}`);
    args.push(request.title, request.body);
    const id = await run('notify-send', args, { capture: true });
    return /^\d+$/.test(id) ? id : null;
  },
  withdraw(handle) {
    if (!handle) return;
    void run('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.Notifications',
      '--object-path',
      '/org/freedesktop/Notifications',
      '--method',
      'org.freedesktop.Notifications.CloseNotification',
      handle,
    ]);
  },
};


function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}





const macBackend: NotifierBackend = {
  canWithdraw: false,
  async post(request) {
    await run('osascript', [
      '-e',
      `display notification "${appleScriptString(request.body)}" with title "${appleScriptString(
        request.title,
      )}"`,
    ]);
    return null;
  },
  withdraw() {

  },
};


function powerShellString(value: string): string {
  return value.replace(/'/g, "''");
}





const WINDOWS_AUMID = 'TheGitAI';
const WINDOWS_TAG = 'thegitai-attention';
const WINDOWS_GROUP = 'thegitai';


const windowsBackend: NotifierBackend = {
  canWithdraw: true,
  async post(request) {
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$n = $t.GetElementsByTagName("text")',
      `$n.Item(0).AppendChild($t.CreateTextNode('${powerShellString(request.title)}')) > $null`,
      `$n.Item(1).AppendChild($t.CreateTextNode('${powerShellString(request.body)}')) > $null`,
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($t)',
      `$toast.Tag = '${WINDOWS_TAG}'`,
      `$toast.Group = '${WINDOWS_GROUP}'`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_AUMID}').Show($toast)`,
    ].join('; ');
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return WINDOWS_TAG;
  },
  withdraw(handle) {
    if (!handle) return;
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
      `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove('${powerShellString(handle)}', '${WINDOWS_GROUP}', '${WINDOWS_AUMID}')`,
    ].join('; ');
    void run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  },
};










export function createNotificationQueue(): {

  idle: () => Promise<void>;
  run: (step: () => Promise<void>) => void;
} {
  let tail: Promise<void> = Promise.resolve();
  return {
    idle: () => tail,
    run(step) {
      tail = tail.then(step).catch(() => {


      });
    },
  };
}

export function backendFor(platform: NodeJS.Platform = process.platform): NotifierBackend {
  if (platform === 'darwin') return macBackend;
  if (platform === 'win32') return windowsBackend;
  return linuxBackend;
}
