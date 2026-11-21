import { randomUUID } from 'node:crypto';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

import { createFollowUpQueueCore } from './core.js';
import type { FollowUpQueueCoreOptions, FollowUpQueueMutationResult, FollowUpQueueSnapshot } from './core.js';
import {
  FollowUpQueueReadError,
  FollowUpQueueValidationError,
  FollowUpQueueWriteError,
} from './errors.js';

export interface FollowUpQueueChangedEvent {
  type: 'openchamber:follow-up-queue.changed';
  properties: {
    scopeToken: string;
    revision: number;
    reset?: true;
  };
}

export interface FollowUpQueueServerRuntimeOptions extends FollowUpQueueCoreOptions {
  broadcastGlobalUiEvent: (event: FollowUpQueueChangedEvent) => void;
  waitForTerminalRetry?: (delayMs: number) => Promise<void>;
}

const INITIAL_TERMINAL_RETRY_MS = 250;
const MAX_TERMINAL_RETRY_MS = 30_000;

const isString = (value: unknown): value is string => typeof value === 'string';
const isCallable = (value: unknown): value is CallableFunction => typeof value === 'function';
const isJsonRecord = (value: unknown): value is JsonObject => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

const defaultWaitForTerminalRetry = (delayMs: number): Promise<void> => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

export const createFollowUpQueueServerRuntime = (dependencies: FollowUpQueueServerRuntimeOptions) => {
  const options = dependencies;
  if (!options || !isCallable(options.broadcastGlobalUiEvent)) {
    throw new FollowUpQueueValidationError('broadcastGlobalUiEvent is required');
  }

  const core = createFollowUpQueueCore(options);
  const waitForTerminalRetry = options.waitForTerminalRetry ?? defaultWaitForTerminalRetry;
  if (!isCallable(waitForTerminalRetry)) {
    throw new FollowUpQueueValidationError('waitForTerminalRetry must be a function');
  }
  const pendingTerminalizations = new Map<string, Promise<FollowUpQueueMutationResult>>();

  const broadcastMutationRevision = (result: FollowUpQueueMutationResult) => {
    if (!result.applied && !(result.deduplicated && result.mutationRevision !== null)) return;
    options.broadcastGlobalUiEvent({
      type: 'openchamber:follow-up-queue.changed',
      properties: {
        scopeToken: result.snapshot.scopeToken,
        revision: result.snapshot.revision,
      },
    });
  };

  const load = async (sessionId: JsonValue | undefined): Promise<FollowUpQueueSnapshot> => {
    const terminalization = isString(sessionId) ? pendingTerminalizations.get(sessionId) : undefined;
    if (terminalization) await terminalization;
    return core.load(sessionId);
  };

  const applyMutation = async (mutation: JsonValue | undefined): Promise<FollowUpQueueMutationResult> => {
    const mutationSessionId = isJsonRecord(mutation) && isString(mutation.sessionId) ? mutation.sessionId : undefined;
    const terminalization = mutationSessionId ? pendingTerminalizations.get(mutationSessionId) : undefined;
    if (terminalization) await terminalization;
    const result = await core.applyMutation(mutation);
    broadcastMutationRevision(result);
    return result;
  };

  const applyTerminalMutation = async (
    sessionId: string,
    clientMutationId: string,
  ): Promise<FollowUpQueueMutationResult> => {
    const result = await core.terminalizeSession(sessionId, clientMutationId);
    if (result.snapshot.revision > 0) {
      options.broadcastGlobalUiEvent({
        type: 'openchamber:follow-up-queue.changed',
        properties: {
          scopeToken: result.snapshot.scopeToken,
          revision: result.snapshot.revision,
          reset: true,
        },
      });
    }
    return result;
  };

  const terminalizeSession = (sessionId: string): Promise<FollowUpQueueMutationResult> => (
    applyTerminalMutation(sessionId, `host-delete-${randomUUID()}`)
  );

  const terminalizeSessionFromEvent = (payload: JsonValue | undefined): Promise<FollowUpQueueMutationResult> | null => {
    if (!isJsonRecord(payload) || payload.type !== 'session.deleted') return null;
    const properties = isJsonRecord(payload.properties) ? payload.properties : {};
    const info = isJsonRecord(properties.info) ? properties.info : null;
    const sessionId = isString(properties.sessionID)
      ? properties.sessionID
      : (info && isString(info.id) ? info.id : null);
    if (!sessionId) return null;

    const existing = pendingTerminalizations.get(sessionId);
    if (existing) return existing;
    const clientMutationId = `host-delete-${randomUUID()}`;
    const terminalization = (async () => {
      let delayMs = INITIAL_TERMINAL_RETRY_MS;
      while (true) {
        try {
          return await applyTerminalMutation(sessionId, clientMutationId);
        } catch (error) {
          if (!(error instanceof FollowUpQueueReadError) && !(error instanceof FollowUpQueueWriteError)) {
            throw error;
          }
          await waitForTerminalRetry(delayMs);
          delayMs = Math.min(delayMs * 2, MAX_TERMINAL_RETRY_MS);
        }
      }
    })();
    pendingTerminalizations.set(sessionId, terminalization);
    void terminalization.finally(() => {
      if (pendingTerminalizations.get(sessionId) === terminalization) {
        pendingTerminalizations.delete(sessionId);
      }
    }).catch(() => undefined);
    return terminalization;
  };

  const reconcileStoredSessions = async (
    checkSessionExists: (sessionId: string) => Promise<boolean>,
  ): Promise<{ checked: number; terminalized: number; failed: number }> => {
    if (!isCallable(checkSessionExists)) {
      throw new FollowUpQueueValidationError('checkSessionExists is required');
    }
    const stored = await core.listStoredSessions();
    let checked = 0;
    let terminalized = 0;
    let failed = stored.unreadable;
    for (const entry of stored.sessions) {
      if (entry.terminal) continue;
      if (entry.terminalPending) {
        try {
          await applyTerminalMutation(entry.sessionId, `host-reconcile-${randomUUID()}`);
          terminalized += 1;
        } catch {
          terminalizeSessionFromEvent({
            type: 'session.deleted',
            properties: { sessionID: entry.sessionId },
          });
          failed += 1;
        }
        continue;
      }
      checked += 1;
      try {
        if (await checkSessionExists(entry.sessionId)) continue;
        try {
          await applyTerminalMutation(entry.sessionId, `host-reconcile-${randomUUID()}`);
          terminalized += 1;
        } catch {
          terminalizeSessionFromEvent({
            type: 'session.deleted',
            properties: { sessionID: entry.sessionId },
          });
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return { checked, terminalized, failed };
  };

  const recoverTerminalFences = async (): Promise<{ recovered: number; failed: number }> => {
    const stored = await core.listStoredSessions();
    let recovered = 0;
    let failed = stored.unreadable;
    for (const entry of stored.sessions) {
      if (!entry.terminalPending) continue;
      try {
        await applyTerminalMutation(entry.sessionId, `host-recover-${randomUUID()}`);
        recovered += 1;
      } catch {
        terminalizeSessionFromEvent({
          type: 'session.deleted',
          properties: { sessionID: entry.sessionId },
        });
        failed += 1;
      }
    }
    return { recovered, failed };
  };

  return {
    load,
    applyMutation,
    terminalizeSession,
    terminalizeSessionFromEvent,
    reconcileStoredSessions,
    recoverTerminalFences,
  };
};

export type FollowUpQueueServerRuntime = ReturnType<typeof createFollowUpQueueServerRuntime>;
