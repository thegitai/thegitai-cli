export interface ToolCall {
  id: string;
  name: string;
  args: any;
}

export type ImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

export interface ImageAttachment {
  index: number;
  mimeType: ImageMimeType;
  base64Data: string;
  source: 'clipboard' | 'file';
  /**
   * Where the user's copy of this image lives, on this machine. For a file
   * attachment this is the path they named; for a clipboard paste it is absent
   * (a paste has no origin on disk).
   */
  filePath?: string;
  /**
   * The session image store's copy, on this machine. Stable for the life of the
   * session, so the model can re-read the image after its bytes have left the
   * prompt, and a later turn can re-analyze it. Absent for attachments that
   * predate the store (older session files) or when writing it failed.
   */
  cachePath?: string;
  /**
   * Set when this image entered the turn because the model analyzed a path or a
   * number, rather than the user attaching it. Transient per-turn state, never
   * persisted and never sent: it only marks which images the turn may drop when
   * it is over budget.
   */
  analyzedFromPath?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'model';
  parts: any[];
  name?: string;
  tool_call_id?: string;
  kind?: 'turnStart' | 'userInterjection';
  /** The user's own text for this turn, verbatim. */
  userInput?: string;
}

export interface Chunk {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score?: number;
  label?: string;
  kind?: string;
}

export interface ScoredChunk extends Chunk {
  score: number;
}
