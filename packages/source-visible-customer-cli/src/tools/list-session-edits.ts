import { listSessionEditSummaries } from '../session-safety.js';
import { ToolContext, ToolResponse } from './types.js';

export async function listSessionEdits(context: ToolContext): Promise<ToolResponse> {
  const edits = context.safety ? listSessionEditSummaries(context.safety) : [];
  return {
    ok: true,
    edits,
    total: edits.length,
  };
}
