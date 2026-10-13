import { fetchWhoamiResponse, type CliAuthConfig } from './auth.js';
import type { WhoAmIResponse } from './contracts.js';
import {
  STARTUP_RETRY_BUDGET,
  isTransientNetworkError,
  type RetryBudget,
} from './http.js';
import { fetchServerModels, type ServerModelsResponse } from './models.js';
import {
  abortableDelay,
  createTurnRecovery,
  isRetryableTurnFailure,
  isTurnRecoveryExhausted,
  type TurnRecoveryStatus,
} from './turn-recovery.js';

export interface StartupHandshake {
  models: PromiseSettledResult<ServerModelsResponse>;
  whoami: PromiseSettledResult<WhoAmIResponse>;
}









export async function loadStartupHandshake({
  config,
  canStartOffline,
  fetchImpl,
  budget = STARTUP_RETRY_BUDGET,
  sleep = abortableDelay,
  onStatus = () => {},
}: {
  config: CliAuthConfig;

  canStartOffline: boolean;
  fetchImpl?: typeof fetch;
  budget?: RetryBudget;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onStatus?: (status: TurnRecoveryStatus, lastFailure: unknown) => void;
}): Promise<StartupHandshake> {
  let lastFailure: unknown;
  const recovery = createTurnRecovery({
    signal: new AbortController().signal,
    sleep,
    onStatus: (status) => onStatus(status, lastFailure),
  });
  const attempt = async (): Promise<StartupHandshake> => {
    const [models, whoami] = await Promise.allSettled([
      fetchServerModels({ config, fetchImpl, budget }),
      fetchWhoamiResponse({ config, fetchImpl, budget }),
    ]);
    const unreachable =
      models.status === 'rejected' &&
      isRetryableTurnFailure(models.reason) &&
      !(canStartOffline && isTransientNetworkError(models.reason));
    if (unreachable) {
      lastFailure = models.reason;
      throw models.reason;
    }
    return { models, whoami };
  };
  try {
    return await recovery.run('loading your models', attempt);
  } catch (error) {
    const reason = isTurnRecoveryExhausted(error) ? (error as Error).cause : error;
    return {
      models: { status: 'rejected', reason },
      whoami: { status: 'rejected', reason },
    };
  }
}
