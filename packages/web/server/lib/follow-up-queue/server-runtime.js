import { randomUUID } from 'node:crypto';

import { createFollowUpQueueCore } from './core.js';
import {
  FollowUpQueueReadError,
  FollowUpQueueValidationError,
  FollowUpQueueWriteError,
} from './errors.js';

const INITIAL_TERMINAL_RETRY_MS = 250;
const MAX_TERMINAL_RETRY_MS = 30_000;

const defaultWaitForTerminalRetry = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

export const createFollowUpQueueServerRuntime = (dependencies) => {
  const options = dependencies && typeof dependencies === 'object' ? dependencies : {};
  if (typeof options.broadcastGlobalUiEvent !== 'function') {
    throw new FollowUpQueueValidationError('broadcastGlobalUiEvent is required');
  }

  const core = createFollowUpQueueCore(options);
  const waitForTerminalRetry = options.waitForTerminalRetry ?? defaultWaitForTerminalRetry;
  if (typeof waitForTerminalRetry !== 'function') {
    throw new FollowUpQueueValidationError('waitForTerminalRetry must be a function');
  }
  const pendingTerminalizations = new Map();

  const broadcastMutationRevision = (result) => {
    if (!result.applied && !(result.deduplicated && result.mutationRevision !== null)) return;
    options.broadcastGlobalUiEvent({
      type: 'openchamber:follow-up-queue.changed',
      properties: {
        scopeToken: result.snapshot.scopeToken,
        revision: result.snapshot.revision,
      },
    });
  };

  const load = async (sessionId) => {
    const terminalization = pendingTerminalizations.get(sessionId);
    if (terminalization) await terminalization;
    return core.load(sessionId);
  };

  const applyMutation = async (mutation) => {
    const terminalization = pendingTerminalizations.get(mutation?.sessionId);
    if (terminalization) await terminalization;
    const result = await core.applyMutation(mutation);
    broadcastMutationRevision(result);
    return result;
  };

  const applyTerminalMutation = async (sessionId, clientMutationId) => {
    const result = await core.terminalizeSession(sessionId, clientMutationId);
    // Terminal state is authoritative even when a post-rename retry outlives
    // the bounded dedupe ledger. Duplicate revision hints are harmless.
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

  const terminalizeSession = (sessionId) => (
    applyTerminalMutation(sessionId, `host-delete-${randomUUID()}`)
  );

  const terminalizeSessionFromEvent = (payload) => {
    if (payload?.type !== 'session.deleted') return null;
    const properties = payload.properties && typeof payload.properties === 'object'
      ? payload.properties
      : {};
    const sessionId = typeof properties.sessionID === 'string'
      ? properties.sessionID
      : (properties.info && typeof properties.info === 'object' && typeof properties.info.id === 'string'
        ? properties.info.id
        : null);
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
    }).catch(() => {});
    return terminalization;
  };

  const reconcileStoredSessions = async (checkSessionExists) => {
    if (typeof checkSessionExists !== 'function') {
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
        // A failed or ambiguous check must never masquerade as a missing session.
        failed += 1;
      }
    }
    return { checked, terminalized, failed };
  };

  const recoverTerminalFences = async () => {
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
