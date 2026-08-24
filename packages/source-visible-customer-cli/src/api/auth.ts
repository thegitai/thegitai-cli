import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getClientStateDir } from '../client-state.js';
import type {
  AuthCustomer,
  LogoutResponse,
  WhoAmIResponse,
} from './contracts.js';
import {
  ServerApiError,
  authorizedJson,
  createTraceContext,
  failureCode,
  failureMessage,
  normalizeServerUrl,
  readJsonResponse,
  retryTransient,
  type AuthorizedServerConfig,
  type RetryBudget,
} from './http.js';

export interface CliAuthConfig extends AuthorizedServerConfig {
  email: string;
  customerType?: 'ADMIN' | 'USER';
}

export function getAuthConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = String(env.THEGITAI_AUTH_CONFIG ?? '').trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(getClientStateDir(env), 'auth.json');
}

export function readCliAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): CliAuthConfig | null {
  const filePath = getAuthConfigPath(env);
  if (!existsSync(filePath)) return null;
  const parsed = JSON.parse(
    readFileSync(filePath, 'utf8'),
  ) as Partial<CliAuthConfig>;
  const serverUrl = String(parsed.serverUrl ?? '').trim();
  const token = String(parsed.token ?? '').trim();
  const email = String(parsed.email ?? '').trim();
  const customerType =
    parsed.customerType === 'ADMIN' || parsed.customerType === 'USER'
      ? parsed.customerType
      : undefined;
  if (!serverUrl || !token || !email) {
    return null;
  }
  return {
    serverUrl,
    token,
    email,
    ...(customerType ? { customerType } : {}),
  };
}

export function writeCliAuthConfig(
  config: CliAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = getAuthConfigPath(env);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        serverUrl: normalizeServerUrl(config.serverUrl),
        token: config.token,
        email: config.email,
        ...(config.customerType ? { customerType: config.customerType } : {}),
      },
      null,
      2,
    )}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}

export function clearCliAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(getAuthConfigPath(env), { force: true });
}

export async function fetchWhoami({
  config,
  fetchImpl = globalThis.fetch,
}: {
  config: CliAuthConfig;
  fetchImpl?: typeof fetch;
}): Promise<AuthCustomer> {
  const data = await fetchWhoamiResponse({ config, fetchImpl });
  return data.customer;
}

export async function fetchWhoamiResponse({
  config,
  fetchImpl = globalThis.fetch,
  budget = {},
}: {
  config: CliAuthConfig;
  fetchImpl?: typeof fetch;
  budget?: RetryBudget;
}): Promise<WhoAmIResponse> {
  const { timeoutMs, ...ladder } = budget;
  const data = (await retryTransient(
    () =>
      authorizedJson({
        config,
        path: '/v1/auth/whoami',
        fetchImpl,
        ...(timeoutMs == null ? {} : { timeoutMs }),
      }),
    ladder,
  )) as WhoAmIResponse;
  if (!data?.customer?.email) {
    throw new Error('Server returned an invalid whoami response.');
  }
  return {
    customer: data.customer,
    debugUi: {
      showSessionId: data.debugUi?.showSessionId === true,
    },
    ...(data.usage ? { usage: data.usage } : {}),
  };
}

export async function logoutFromServer({
  config,
  fetchImpl = globalThis.fetch,
}: {
  config: CliAuthConfig;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const trace = createTraceContext();
  const response = await fetchImpl(
    `${normalizeServerUrl(config.serverUrl)}/v1/auth/logout`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        ...trace.headers,
      },
    },
  );
  if (!response.ok && response.status !== 401) {
    const data = (await readJsonResponse(response)) as LogoutResponse | any;
    throw new ServerApiError(
      failureMessage(data, response.status),
      response.status,
      trace.traceId,
      failureCode(data),
    );
  }
}
