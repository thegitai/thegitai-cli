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





  filePath?: string;






  cachePath?: string;






  analyzedFromPath?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'model';
  parts: any[];
  name?: string;
  tool_call_id?: string;
  kind?: 'turnStart' | 'userInterjection';

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
