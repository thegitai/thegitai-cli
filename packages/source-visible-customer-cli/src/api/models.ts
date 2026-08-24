import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from '../client-state.js';
import type { CliAuthConfig } from './auth.js';
import type {
  ListModelsResponse as ServerModelsResponse,
  ServerModelInfo,
} from './contracts.js';
import {
  REQUEST_TIMEOUT_MS,
  ServerApiError,
  createTraceContext,
  failureCode,
  failureMessage,
  normalizeServerUrl,
  readJsonResponse,
  retryTransient,
  type RetryBudget,
} from './http.js';

export type { ServerModelInfo, ServerModelsResponse };

export interface CachedServerModels extends ServerModelsResponse {
  serverUrl: string;
  selectedModelId: number;
  updatedAt: string;
}

function sanitizeModelInfo(raw: unknown): ServerModelInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = Number(value.id);
  const label = String(value.label ?? '').trim();
  const costRating = Number(value.costRating);
  const description = String(value.description ?? '').trim();
  if (!Number.isInteger(id) || id <= 0 || !label || !isCostRating(costRating)) {
    return null;
  }
  return { id, label, costRating, description };
}

function isCostRating(value: number): value is 1 | 2 | 3 {
  return Number.isInteger(value) && value >= 1 && value <= 3;
}

export function getModelsCachePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getClientStateDir(env), 'models.json');
}

export function readCachedServerModels(
  env: NodeJS.ProcessEnv = process.env,
): CachedServerModels | null {
  const filePath = getModelsCachePath(env);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<CachedServerModels>;
    const serverUrl = String(parsed.serverUrl ?? '').trim();
    const selectedModelId = Number(parsed.selectedModelId);
    const models = Array.isArray(parsed.models)
      ? (parsed.models.map(sanitizeModelInfo).filter(Boolean) as ServerModelInfo[])
      : [];
    if (
      !serverUrl ||
      !Number.isInteger(selectedModelId) ||
      selectedModelId <= 0 ||
      models.length === 0
    ) {
      return null;
    }
    return {
      serverUrl,
      selectedModelId,
      models,
      updatedAt: String(parsed.updatedAt ?? ''),
    };
  } catch {
    return null;
  }
}

// The model cache is a single global file for the state dir but stamps the
// server it was written for. Return it only when it belongs to the active
// server, so a cache from a different serverUrl (e.g. after switching
// THEGITAI_AUTH_CONFIG) never seeds this session with another server's models.
export function selectCacheForServer(
  cached: CachedServerModels | null,
  serverUrl: string,
): CachedServerModels | null {
  if (!cached) return null;
  return cached.serverUrl === normalizeServerUrl(serverUrl) ? cached : null;
}

export function writeCachedServerModels(
  cache: CachedServerModels,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = getModelsCachePath(env);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // Write to a sibling and rename, so the cache is only ever replaced whole.
  // A truncated models.json parses as garbage and `readCachedServerModels`
  // answers null for it, which silently disables the offline fallback — the one
  // thing standing between a network blip and `ai` refusing to start. Ctrl-C
  // during startup is enough to leave that file half-written.
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export async function fetchServerModels({
  config,
  fetchImpl = globalThis.fetch,
  budget = {},
}: {
  config: CliAuthConfig;
  fetchImpl?: typeof fetch;
  budget?: RetryBudget;
}): Promise<ServerModelsResponse> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...ladder } = budget;
  return retryTransient(async () => {
    const trace = createTraceContext();
    const response = await fetchImpl(
      `${normalizeServerUrl(config.serverUrl)}/v1/models`,
      {
        headers: {
          authorization: `Bearer ${config.token}`,
          ...trace.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const data = (await readJsonResponse(response)) as ServerModelsResponse | any;
    if (!response.ok) {
      throw new ServerApiError(
        failureMessage(data, response.status),
        response.status,
        trace.traceId,
        failureCode(data),
      );
    }
    const models = Array.isArray(data?.models)
      ? (data.models.map(sanitizeModelInfo).filter(Boolean) as ServerModelInfo[])
      : [];
    if (models.length === 0) {
      throw new Error('Server returned an invalid model list.');
    }
    return { models };
  }, ladder);
}

export function selectServerModel({
  requestedModelId,
  cached,
  serverModels,
}: {
  requestedModelId?: number | null;
  cached?: CachedServerModels | null;
  serverModels: ServerModelsResponse;
}): number {
  const supportedIds = new Set(serverModels.models.map((model) => model.id));
  const requested = requestedModelId == null ? null : Number(requestedModelId);
  if (requested != null) {
    if (supportedIds.has(requested)) {
      return requested;
    }
    throw new Error(`Server does not support model "${requested}".`);
  }
  for (const candidate of [cached?.selectedModelId, serverModels.models[0]?.id]) {
    const id = Number(candidate);
    if (Number.isInteger(id) && supportedIds.has(id)) {
      return id;
    }
  }
  throw new Error('Server did not advertise a usable model.');
}

export function validateServerModel(
  modelId: string | number,
  serverModels: ServerModelsResponse,
): number {
  const requested = Number(modelId);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error('Model id is required.');
  }
  if (!serverModels.models.some((model) => model.id === requested)) {
    throw new Error(`Server does not support model "${requested}".`);
  }
  return requested;
}

export function updateSelectedModelCache({
  config,
  selectedModelId,
  serverModels,
  env = process.env,
}: {
  config: CliAuthConfig;
  selectedModelId: number;
  serverModels: ServerModelsResponse;
  env?: NodeJS.ProcessEnv;
}): void {
  writeCachedServerModels(
    {
      serverUrl: normalizeServerUrl(config.serverUrl),
      selectedModelId,
      models: serverModels.models,
      updatedAt: new Date().toISOString(),
    },
    env,
  );
}
