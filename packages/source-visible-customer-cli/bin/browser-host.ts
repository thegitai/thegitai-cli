#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { decodeFrames, encodeFrame, fragmentPayload, MAX_FRAME_BYTES } from '../src/browser/framing.js';
import {
  BROWSER_PROTOCOL_VERSION,
  browserRuntimeDir,
  sessionKeyFromRecordFile,
  sessionSocketPath,
  socketIsFile,
  type SessionAnnouncement,
} from '../src/browser/protocol.js';















const SCAN_INTERVAL_MS = 1000;
const NUL = String.fromCharCode(0);

interface SessionLink {
  key: string;
  socket: net.Socket;
  record: SessionAnnouncement;
}

const sessions = new Map<string, SessionLink>();
const runtimeDir = browserRuntimeDir(process.env);
let extensionVersion = '';
let extensionProfileId = '';
let extensionPlatform = '';

function log(message: string): void {
  process.stderr.write(`[thegitai-browser-host] ${message}\n`);
}



function writeToExtension(frame: unknown): void {
  const payload = Buffer.from(JSON.stringify(frame), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    for (const fragment of fragmentPayload(payload, crypto.randomUUID())) {
      writeToExtension(fragment);
    }
    return;
  }
  process.stdout.write(encodeFrame(payload));
}




let inbound: Buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer | string) => {
  inbound = Buffer.concat([inbound, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
  const { frames, rest, unparseable } = decodeFrames(inbound);
  inbound = rest;
  for (let i = 0; i < unparseable; i += 1) {
    log('discarded an unparseable frame from the extension');
  }
  for (const frame of frames) handleExtensionFrame(frame);
});

process.stdin.on('end', () => {


  for (const link of sessions.values()) link.socket.destroy();
  process.exit(0);
});












function describeParentBrowser(): { browser: string; profile: string } {
  const cmdline =
    process.platform === 'win32' ? windowsParentCommandLine() : unixParentCommandLine();
  return describeFromCommandLine(cmdline);
}




















function windowsParentCommandLine(): string[] {
  const PASS_THROUGH = /^(cmd|conhost|powershell|pwsh|node)\.exe$/i;
  try {
    const rows = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',


        'Get-CimInstance Win32_Process | ForEach-Object {' +
          ' "{0}`t{1}`t{2}`t{3}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine }',
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const byPid = new Map<number, { parent: number; name: string; command: string }>();
    for (const line of rows.split(/\r?\n/)) {
      const [pid, parent, name, ...rest] = line.split('\t');
      const id = Number(pid);
      if (!Number.isInteger(id)) continue;
      byPid.set(id, {
        parent: Number(parent),
        name: String(name ?? ''),
        command: rest.join('\t'),
      });
    }
    let current = byPid.get(process.ppid);
    for (let hop = 0; hop < 4 && current && PASS_THROUGH.test(current.name); hop += 1) {
      current = byPid.get(current.parent);
    }
    if (!current?.command) return [];



    return (current.command.match(/"[^"]*"|\S+/g) ?? []).map((token) =>
      token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
    );
  } catch {
    return [];
  }
}

function unixParentCommandLine(): string[] {
  try {
    return fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split(NUL);
  } catch {
    return [];
  }
}

function describeFromCommandLine(cmdline: string[]): { browser: string; profile: string } {
  try {
    if (cmdline.length === 0) throw new Error('no command line');



    const brand = path
      .basename(cmdline[0] ?? '')
      .replace(/\.exe$/i, '')
      .replace(/[-_](browser|stable|beta|dev|unstable|bin)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
      .trim() || 'Chrome';
    const profileArg = cmdline.find((part) => part.startsWith('--profile-directory='));
    const userDataArg = cmdline.find((part) => part.startsWith('--user-data-dir='));
    const profile = profileArg ? profileArg.slice('--profile-directory='.length) : 'Default';
    const suffix = userDataArg
      ? ` (${path.basename(userDataArg.slice('--user-data-dir='.length))})`
      : '';
    return { browser: brand, profile: `${profile}${suffix}` };
  } catch {
    return { browser: 'Chrome', profile: 'Default' };
  }
}

const parent = describeParentBrowser();















function browserKey(): string {
  const seed = extensionProfileId || `${parent.browser} ${parent.profile}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function identity() {
  return {
    key: browserKey(),
    browser: parent.browser,



    profile:
      parent.profile !== 'Default' || !extensionProfileId
        ? parent.profile
        : `profile ${extensionProfileId.slice(0, 6)}`,
    platform: extensionPlatform || process.platform,
    extensionVersion,
  };
}



function handleExtensionFrame(frame: any): void {
  if (frame?.t === 'hello') {
    extensionVersion = String(frame.extensionVersion ?? '');
    extensionProfileId = String(frame.profileId ?? '');
    extensionPlatform = String(frame.platform ?? '');
    writeToExtension({ t: 'hello', protocol: BROWSER_PROTOCOL_VERSION });
    publishSessions();

    for (const link of sessions.values()) sendHello(link);
    return;
  }
  if (frame?.t === 'res' || frame?.t === 'event') {
    const target = frame.session ? sessions.get(frame.session) : null;
    const { session: _routed, ...rest } = frame;
    if (target) {
      writeToSession(target, rest);
      return;
    }
    if (frame.t === 'event') {
      for (const link of sessions.values()) writeToSession(link, rest);
    }
  }
}

function writeToSession(link: SessionLink, frame: unknown): void {
  try {
    link.socket.write(`${JSON.stringify(frame)}\n`);
  } catch {

  }
}

function sendHello(link: SessionLink): void {
  writeToSession(link, { t: 'hello', protocol: BROWSER_PROTOCOL_VERSION, browser: identity() });
}

function publishSessions(): void {
  writeToExtension({
    t: 'sessions',
    sessions: [...sessions.values()].map((link) => ({
      session: link.key,
      label: link.record.label,
      cwd: link.record.cwd,
    })),
  });
}



function connectToSession(record: SessionAnnouncement, socketPath: string): void {
  if (sessions.has(record.session)) return;
  const socket = net.createConnection(socketPath);
  socket.setNoDelay(true);
  const link: SessionLink = { key: record.session, socket, record };

  socket.on('connect', () => {
    sessions.set(record.session, link);
    sendHello(link);
    publishSessions();
    log(`attached to session ${record.session} (${record.cwd})`);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.trim()) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }


      writeToExtension({ ...frame, session: record.session });
    }
  });

  const drop = () => {
    if (sessions.get(record.session) === link) {
      sessions.delete(record.session);
      publishSessions();
    }
    socket.destroy();
  };
  socket.on('close', drop);
  socket.on('error', () => {


    drop();
  });
}

function scanForSessions(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(runtimeDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const sessionKey = sessionKeyFromRecordFile(entry);
    if (!sessionKey) continue;
    const recordPath = path.join(runtimeDir, entry);
    let record: SessionAnnouncement;
    try {
      record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    } catch {
      continue;
    }
    if (record.protocol !== BROWSER_PROTOCOL_VERSION) continue;
    try {
      process.kill(record.pid, 0);
    } catch (error: any) {
      if (error?.code !== 'EPERM') {
        try {
          fs.unlinkSync(recordPath);

          if (socketIsFile()) fs.unlinkSync(sessionSocketPath(runtimeDir, sessionKey));
        } catch {

        }
        continue;
      }
    }
    connectToSession(record, sessionSocketPath(runtimeDir, sessionKey));
  }
}





setInterval(scanForSessions, SCAN_INTERVAL_MS);
scanForSessions();
log(`started for ${parent.browser} / ${parent.profile}`);
