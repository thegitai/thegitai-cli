











export const MAX_FRAME_BYTES = 900 * 1024;


export const FRAGMENT_BYTES = 512 * 1024;

export interface FragmentFrame {
  t: 'fragment';
  id: string;
  part: number;
  total: number;
  data: string;
}


export function encodeFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}







export function fragmentPayload(payload: Buffer, id: string): FragmentFrame[] {
  const total = Math.ceil(payload.length / FRAGMENT_BYTES);
  const frames: FragmentFrame[] = [];
  for (let part = 0; part < total; part += 1) {
    frames.push({
      t: 'fragment',
      id,
      part,
      total,
      data: payload.subarray(part * FRAGMENT_BYTES, (part + 1) * FRAGMENT_BYTES).toString('base64'),
    });
  }
  return frames;
}

export interface DecodeResult {

  frames: unknown[];

  rest: Buffer;

  unparseable: number;
}








export function decodeFrames(inbound: Buffer): DecodeResult {
  const frames: unknown[] = [];
  let rest = inbound;
  let unparseable = 0;
  for (;;) {
    if (rest.length < 4) break;
    const length = rest.readUInt32LE(0);
    if (rest.length < 4 + length) break;
    const body = rest.subarray(4, 4 + length);
    rest = rest.subarray(4 + length);
    try {
      frames.push(JSON.parse(body.toString('utf8')));
    } catch {
      unparseable += 1;
    }
  }
  return { frames, rest, unparseable };
}
