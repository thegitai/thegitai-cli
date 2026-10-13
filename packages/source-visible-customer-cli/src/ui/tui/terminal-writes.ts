











const MAX_CAPTURED_CHARS = 1_000_000;

type Restore = () => void;

let restore: Restore | null = null;
let captured: string[] = [];
let capturedChars = 0;

function chunkToString(chunk: unknown, encoding?: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(
      typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8',
    );
  }
  return String(chunk ?? '');
}

export function captureTerminalWrites(): void {
  if (restore) return;
  const streams: NodeJS.WriteStream[] = [process.stdout, process.stderr];
  const originals = streams.map((stream) => stream.write.bind(stream));

  for (const stream of streams) {
    (stream as unknown as { write: unknown }).write = (
      chunk: unknown,
      encoding?: unknown,
      callback?: unknown,
    ): boolean => {
      if (capturedChars < MAX_CAPTURED_CHARS) {
        const text = chunkToString(chunk, encoding);
        captured.push(text);
        capturedChars += text.length;
      }
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') (done as () => void)();
      return true;
    };
  }

  restore = () => {
    streams.forEach((stream, index) => {
      (stream as unknown as { write: unknown }).write = originals[index]!;
    });
  };
}

export function releaseTerminalWrites(): void {
  if (!restore) return;
  restore();
  restore = null;
  if (captured.length > 0) {
    const text = captured.join('');
    captured = [];
    capturedChars = 0;
    process.stderr.write(text);
  }
}
