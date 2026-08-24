export function getCommandExitCode(error: any): number | null {
  if (typeof error?.status === 'number') return error.status;
  if (typeof error?.code === 'number') return error.code;
  return null;
}

export function getCommandErrorText(error: any): string {
  return [
    error?.message,
    error?.stderr,
    error?.stdout,
  ]
    .filter(Boolean)
    .map(String)
    .join('\n');
}
