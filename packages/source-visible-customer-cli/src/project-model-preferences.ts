import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from './client-state.js';
import { getSessionProjectKey } from './project-key.js';
import { isReasoningEffort, type ReasoningEffort } from './reasoning-effort.js';

export type ProjectModelEfforts = Record<string, ReasoningEffort>;

function preferencesPath(rootDir: string, env: NodeJS.ProcessEnv): string {
  return path.join(getClientStateDir(env), 'projects', getSessionProjectKey(rootDir), 'model-efforts.json');
}

function parseScopes(contents: string): Record<string, ProjectModelEfforts> {
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Project model preferences must be an object.');
  }
  return Object.fromEntries(Object.entries(parsed).map(([scope, models]) => {
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      throw new Error('Project model preferences contain an invalid model selection.');
    }
    const entries = Object.entries(models).map(([id, effort]) => {
      if (!/^[1-9]\d*$/.test(id) || !isReasoningEffort(effort)) {
        throw new Error('Project model preferences contain an invalid effort selection.');
      }
      return [id, effort] as const;
    });
    return [scope, Object.fromEntries(entries)];
  }));
}

function readScopes(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  onInvalid: 'default' | 'throw',
): Record<string, ProjectModelEfforts> {
  const file = preferencesPath(rootDir, env);
  if (!existsSync(file)) return {};
  const contents = readFileSync(file, 'utf8');
  try {
    return parseScopes(contents);
  } catch (error) {
    if (onInvalid === 'throw') throw error;
    return {};
  }
}

function scopeKey(scope: string): string {
  return scope.trim().replace(/\/+$/, '') || 'local';
}

export function readProjectModelEfforts(
  rootDir: string,
  scope = '',
  env: NodeJS.ProcessEnv = process.env,
): ProjectModelEfforts {
  return readScopes(rootDir, env, 'default')[scopeKey(scope)] ?? {};
}

export function projectModelEffort(
  efforts: ProjectModelEfforts,
  modelId: number,
): ReasoningEffort {
  return efforts[String(modelId)] ?? 'default';
}

export function saveProjectModelEffort(
  rootDir: string,
  modelId: number,
  effort: ReasoningEffort,
  scope = '',
  env: NodeJS.ProcessEnv = process.env,
): ProjectModelEfforts {
  if (!Number.isInteger(modelId) || modelId <= 0 || !isReasoningEffort(effort)) {
    throw new Error('Invalid project model preference.');
  }
  const scopes = readScopes(rootDir, env, 'throw');
  const key = scopeKey(scope);
  const models = { ...scopes[key] };
  if (effort === 'default') delete models[String(modelId)];
  else models[String(modelId)] = effort;
  const file = preferencesPath(rootDir, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ ...scopes, [key]: models }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return models;
}
