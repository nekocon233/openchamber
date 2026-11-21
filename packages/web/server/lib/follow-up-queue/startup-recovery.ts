import path from 'node:path';
import { isRecord, isString } from '../shared/object-guards.js';
import { isNativeSessionId } from '../native-agents/ids.js';
import type { GlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type {
  MessageQueueOptions,
  MessageQueueSessionSnapshot,
  createMessageQueueRuntime,
} from '../message-queue/runtime.js';
import type { FollowUpQueueServerRuntime } from './server-runtime.js';
import { importOpenCodeFollowUps } from './import-open-code.js';

interface FollowUpQueueRecoveryOptions extends Pick<MessageQueueOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> {
  followUpQueueRuntime: Pick<FollowUpQueueServerRuntime, 'load' | 'applyMutation' | 'reconcileStoredSessions' | 'recoverTerminalFences'>;
  getMessageQueue: () => Pick<ReturnType<typeof createMessageQueueRuntime>, 'enqueue'>;
  globalMessageStreamHub: Pick<GlobalMessageStreamHub, 'isConnected' | 'subscribeStatus'>;
  sessionExists: (sessionId: string) => Promise<boolean>;
  isOpenCodeReady: () => boolean;
  ensureGlobalWatcherStarted: () => Promise<void>;
}

export function createFollowUpQueueRecovery({
  followUpQueueRuntime, getMessageQueue, globalMessageStreamHub, buildOpenCodeUrl,
  getOpenCodeAuthHeaders, sessionExists, isOpenCodeReady, ensureGlobalWatcherStarted,
}: FollowUpQueueRecoveryOptions) {
  const deferredOpenCodeQueueImports = new Map<string, string>();
  let queueImportRetry: Promise<void> | null = null;

  function retryDeferredQueueImports() {
    if (queueImportRetry || deferredOpenCodeQueueImports.size === 0) return;
    queueImportRetry = Promise.resolve().then(async () => {
      for (const [sessionId, directory] of deferredOpenCodeQueueImports) {
        if (await importOpenCodeFollowUps(followUpQueueRuntime, getMessageQueue(), sessionId, directory).catch(() => false)) {
          deferredOpenCodeQueueImports.delete(sessionId);
        }
      }
    }).finally(() => { queueImportRetry = null; });
  }

  const checkFollowUpQueueSessionExists = async (sessionId: string) => {
    if (isNativeSessionId(sessionId)) return sessionExists(sessionId);
    const response = await fetch(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, ''), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`OpenCode session lookup failed (${response.status})`);
    const body = await response.json().catch(() => null);
    const session = isRecord(body) ? body.data : null;
    if (!isRecord(session) || session.id !== sessionId) {
      throw new Error('OpenCode returned an invalid session lookup response');
    }
    const locationDirectory = isRecord(session.location) ? session.location.directory : undefined;
    const directory = isString(locationDirectory) && path.isAbsolute(locationDirectory) ? locationDirectory : session.directory;
    if (isString(directory) && path.isAbsolute(directory)) {
      const completed = await importOpenCodeFollowUps(followUpQueueRuntime, getMessageQueue(), sessionId, directory).catch(() => false);
      if (!completed) deferredOpenCodeQueueImports.set(sessionId, directory);
    }
    return true;
  };
  const waitForGlobalWatcherConnection = async (timeoutMs = 10_000) => {
    if (globalMessageStreamHub.isConnected()) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(connected);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      unsubscribe = globalMessageStreamHub.subscribeStatus((status) => {
        if (status?.type === 'connect') finish(true);
      });
      if (globalMessageStreamHub.isConnected()) finish(true);
    });
  };
  let followUpQueueReconciliationPromise: Promise<boolean> | null = null;
  let unsubscribeFollowUpQueueConnectRetry: (() => void) | null = null;
  const reconcileFollowUpQueuesWhenReady = () => {
    if (!isOpenCodeReady() || !globalMessageStreamHub.isConnected()) {
      return Promise.resolve(false);
    }
    if (followUpQueueReconciliationPromise) return followUpQueueReconciliationPromise;
    const reconciliation = (async () => {
      try {
        const result = await followUpQueueRuntime.reconcileStoredSessions(checkFollowUpQueueSessionExists);
        if (result.terminalized > 0 || result.failed > 0) {
          console.log(
            `[follow-up-queue] startup reconciliation checked ${result.checked}, terminalized ${result.terminalized}, failed ${result.failed}`,
          );
        }
        return true;
      } catch (error) {
        console.warn(`[follow-up-queue] startup reconciliation failed: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    })();
    followUpQueueReconciliationPromise = reconciliation;
    void reconciliation.finally(() => {
      if (followUpQueueReconciliationPromise === reconciliation) {
        followUpQueueReconciliationPromise = null;
      }
    });
    return reconciliation;
  };
  const scheduleFollowUpQueueReconciliationOnConnect = () => {
    if (unsubscribeFollowUpQueueConnectRetry) return;
    unsubscribeFollowUpQueueConnectRetry = globalMessageStreamHub.subscribeStatus((status) => {
      if (status?.type !== 'connect') return;
      unsubscribeFollowUpQueueConnectRetry?.();
      unsubscribeFollowUpQueueConnectRetry = null;
      void reconcileFollowUpQueuesWhenReady().then((reconciled) => {
        if (!reconciled) scheduleFollowUpQueueReconciliationOnConnect();
      });
    });
  };

  const onQueueUpdated = ({ sessionId, directory }: Pick<MessageQueueSessionSnapshot, 'sessionId' | 'directory'>) => {
    if (directory && deferredOpenCodeQueueImports.has(sessionId)) {
      deferredOpenCodeQueueImports.set(sessionId, directory);
    }
    retryDeferredQueueImports();
  };

  const afterOpenCodeStartup = async () => {
    try {
      const recovery = await followUpQueueRuntime.recoverTerminalFences();
      if (recovery.recovered > 0 || recovery.failed > 0) {
        console.log(
          `[follow-up-queue] terminal fence recovery recovered ${recovery.recovered}, failed ${recovery.failed}`,
        );
      }
    } catch (error) {
      console.warn(`[follow-up-queue] terminal fence recovery failed: ${error instanceof Error ? error.message : error}`);
    }
    let watcherConnected = false;
    try {
      await ensureGlobalWatcherStarted();
      watcherConnected = await waitForGlobalWatcherConnection();
    } catch (error) {
      console.warn('Global event watcher startup failed:', error instanceof Error ? error.message : error);
    }
    if (isOpenCodeReady() && watcherConnected) {
      if (!await reconcileFollowUpQueuesWhenReady()) {
        scheduleFollowUpQueueReconciliationOnConnect();
      }
    } else {
      if (isOpenCodeReady()) {
        console.warn('[follow-up-queue] startup reconciliation skipped until the global watcher connects');
      }
      scheduleFollowUpQueueReconciliationOnConnect();
    }
  };

  return { onQueueUpdated, afterOpenCodeStartup };
}
