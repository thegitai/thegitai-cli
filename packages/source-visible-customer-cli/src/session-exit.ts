export function formatSessionResumeCommand(
  sessionId: string,
  executableName: string = 'ai',
): string {
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (!normalizedSessionId) {
    throw new Error('Session id is required.');
  }
  return `${executableName} --resume ${normalizedSessionId}`;
}

export function formatSessionExitNotice(
  sessionId: string,
  executableName: string = 'ai',
): string {
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (!normalizedSessionId) {
    throw new Error('Session id is required.');
  }
  return [
    `Session ID: ${normalizedSessionId}`,
    `To resume this session, run ${formatSessionResumeCommand(normalizedSessionId, executableName)}`,
  ].join('\n');
}
