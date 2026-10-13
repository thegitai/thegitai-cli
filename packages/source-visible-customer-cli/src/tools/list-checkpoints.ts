import { listCheckpointSummaries } from '../session-safety.js';
import { ToolContext, ToolResponse } from './types.js';

export async function listCheckpoints(context: ToolContext): Promise<ToolResponse> {
  const checkpoints = context.safety
    ? listCheckpointSummaries(context.safety)
    : [];
  return {
    ok: true,
    checkpoints,
    total: checkpoints.length,
  };
}
