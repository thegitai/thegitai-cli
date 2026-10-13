import type { SessionState } from '../session.js';
import { createSessionSafetyState } from '../session-safety.js';
import {
  getSessionProjectKey,
  snapshotFromSession,
  type SessionMetadata,
  type ClientSessionSnapshot,
} from '../session-store.js';
import type { CliAuthConfig } from './auth.js';
import type {
  ListSessionsResponse,
  LoadSessionResponse,
  SaveSessionRequest,
} from './contracts.js';
import { authorizedJson } from './http.js';

function sessionListPath(rootDir: string): string {
  const query = new URLSearchParams({
    projectKey: getSessionProjectKey(rootDir),
  });
  return `/v1/sessions?${query}`;
}

function sessionPath(rootDir: string, identifier: string): string {
  const query = new URLSearchParams({
    projectKey: getSessionProjectKey(rootDir),
  });
  return `/v1/sessions/${encodeURIComponent(identifier)}?${query}`;
}

function metadataOnlySnapshot(
  snapshot: ClientSessionSnapshot,
): ClientSessionSnapshot {
  const providerSelection =
    snapshot.serverState?.providerSelection &&
    typeof snapshot.serverState.providerSelection === 'object' &&
    !Array.isArray(snapshot.serverState.providerSelection)
      ? { providerSelection: snapshot.serverState.providerSelection }
      : {};
  return {
    ...snapshot,
    history: [],
    clientState: {
      editCounter: 0,
      editJournal: [],
      stickyFilePaths: [],
      safety: createSessionSafetyState(),
    },
    serverState: providerSelection,
  };
}

export interface ServerSessionClient {
  list: (rootDir: string) => Promise<SessionMetadata[]>;
  load: (rootDir: string, identifier: string) => Promise<ClientSessionSnapshot>;
  save: (session: SessionState) => Promise<ClientSessionSnapshot>;
}

export function createServerSessionClient({
  config,
  fetchImpl = globalThis.fetch,
}: {
  config: CliAuthConfig;
  fetchImpl?: typeof fetch;
}): ServerSessionClient {
  return {
    async list(rootDir) {
      const data = (await authorizedJson({
        config,
        path: sessionListPath(rootDir),
        fetchImpl,
      })) as ListSessionsResponse;
      return Array.isArray(data?.sessions) ? data.sessions : [];
    },
    async load(rootDir, identifier) {
      const data = (await authorizedJson({
        config,
        path: sessionPath(rootDir, identifier),
        fetchImpl,
      })) as LoadSessionResponse;
      const snapshot = data?.session;
      if (!snapshot?.id) {
        throw new Error('Server returned an invalid session.');
      }
      return snapshot;
    },
    async save(session) {
      const snapshot = snapshotFromSession(session);
      const body: SaveSessionRequest = {
        messageCount: snapshot.history.length,
        session: metadataOnlySnapshot(snapshot),
      };
      await authorizedJson({
        config,
        path: sessionPath(snapshot.rootDir, snapshot.id),
        method: 'PUT',
        body,
        fetchImpl,
      });
      return snapshot;
    },
  };
}
