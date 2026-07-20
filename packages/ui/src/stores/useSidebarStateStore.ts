import { create } from 'zustand';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type {
  SidebarStateAPI,
  SidebarStateOperation,
  SidebarStateSnapshot,
} from '@/lib/api/types';
import {
  SidebarStateConflictError,
  applySidebarStateOperation,
  parseSidebarStateSnapshot,
} from '@/lib/sidebarState';
import { getRuntimeKey } from '@/lib/runtime-switch';

type SidebarStateStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

type PendingSidebarOperation = {
  clientMutationId: string;
  operation: SidebarStateOperation;
};

export type SidebarStateRuntimeContext = {
  runtimeKey: string;
  generation: number;
};

type SidebarStateStore = {
  runtimeKey: string;
  generation: number;
  supported: boolean | null;
  status: SidebarStateStatus;
  baseSnapshot: SidebarStateSnapshot | null;
  snapshot: SidebarStateSnapshot | null;
  pendingOperations: PendingSidebarOperation[];
  error: string | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  mutate: (operation: SidebarStateOperation, options?: { clientMutationId?: string }) => Promise<SidebarStateSnapshot>;
  installAuthoritativeSnapshot: (snapshot: unknown, context?: SidebarStateRuntimeContext) => boolean;
  handleRevisionHint: (revision: number, context?: SidebarStateRuntimeContext) => void;
  handleTransportReady: (context?: SidebarStateRuntimeContext) => void;
  switchRuntime: (runtimeKey: string) => void;
};

type InternalPendingOperation = PendingSidebarOperation & {
  runtimeKey: string;
  generation: number;
  resolve: (snapshot: SidebarStateSnapshot) => void;
  reject: (error: Error) => void;
};

type SidebarStateStoreDependencies = {
  getRuntimeKey: () => string;
  getAPI: () => SidebarStateAPI | null;
  createMutationId: () => string;
  schedule: (callback: () => void) => void;
  scheduleRetry: (callback: () => void, delayMs: number) => () => void;
};

const INITIAL_HINT_RETRY_MS = 50;
const MAX_HINT_RETRY_MS = 2_000;
const INITIAL_BOOTSTRAP_RETRY_MS = 250;
const MAX_BOOTSTRAP_RETRY_MS = 2_000;
const MAX_BOOTSTRAP_RETRIES = 5;

const createMutationId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `client-${crypto.randomUUID()}`;
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const defaultDependencies: SidebarStateStoreDependencies = {
  getRuntimeKey,
  getAPI: () => getRegisteredRuntimeAPIs()?.sidebarState ?? null,
  createMutationId,
  schedule: (callback) => queueMicrotask(callback),
  scheduleRetry: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

const deriveSnapshot = (
  baseSnapshot: SidebarStateSnapshot | null,
  pendingOperations: InternalPendingOperation[],
): SidebarStateSnapshot | null => {
  if (!baseSnapshot) return null;
  let snapshot = baseSnapshot;
  for (const pending of pendingOperations) {
    try {
      snapshot = applySidebarStateOperation(snapshot, pending.operation);
    } catch {
      // The server decides whether an intent that became invalid after a
      // conflict is rejected. Keep unrelated pending intents visible.
    }
  }
  return snapshot;
};

const isAbortError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
  || (Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')
);

export const createSidebarStateClientStore = (
  overrides: Partial<SidebarStateStoreDependencies> = {},
) => {
  const dependencies = { ...defaultDependencies, ...overrides };
  let pending: InternalPendingOperation[] = [];
  let activeController = new AbortController();
  let processing = false;
  let loadInFlight: Promise<void> | null = null;
  let refreshScheduled = false;
  let hintedRevision = -1;
  let cancelHintRetry: (() => void) | null = null;
  let hintRetryDelayMs = INITIAL_HINT_RETRY_MS;
  let cancelBootstrapRetry: (() => void) | null = null;
  let bootstrapRetryAttempt = 0;
  let bootstrapRetryToken = 0;

  const useStore = create<SidebarStateStore>((set, get) => {
    const normalizeRuntimeKey = (runtimeKey: string): string => runtimeKey.trim() || 'default';
    const captureRuntimeContext = (): SidebarStateRuntimeContext => ({
      runtimeKey: get().runtimeKey,
      generation: get().generation,
    });
    const isRuntimeContextCurrent = (context: SidebarStateRuntimeContext): boolean => {
      const state = get();
      return state.runtimeKey === context.runtimeKey
        && state.generation === context.generation
        && normalizeRuntimeKey(dependencies.getRuntimeKey()) === context.runtimeKey;
    };
    const runtimeChangedError = () => new Error('Sidebar operation cancelled because the runtime changed');

    const cancelScheduledHintRetry = () => {
      cancelHintRetry?.();
      cancelHintRetry = null;
    };

    const resetBootstrapRetry = () => {
      bootstrapRetryToken += 1;
      cancelBootstrapRetry?.();
      cancelBootstrapRetry = null;
      bootstrapRetryAttempt = 0;
    };

    const scheduleBootstrapRetry = (context: SidebarStateRuntimeContext) => {
      if (cancelBootstrapRetry || bootstrapRetryAttempt >= MAX_BOOTSTRAP_RETRIES) return;
      const delayMs = Math.min(
        INITIAL_BOOTSTRAP_RETRY_MS * (2 ** bootstrapRetryAttempt),
        MAX_BOOTSTRAP_RETRY_MS,
      );
      bootstrapRetryAttempt += 1;
      const token = ++bootstrapRetryToken;
      cancelBootstrapRetry = dependencies.scheduleRetry(() => {
        if (token !== bootstrapRetryToken) return;
        bootstrapRetryToken += 1;
        cancelBootstrapRetry = null;
        if (!isRuntimeContextCurrent(context) || get().baseSnapshot) return;
        void get().refresh();
      }, delayMs);
    };

    const needsRefreshRetry = (): boolean => {
      const baseRevision = get().baseSnapshot?.revision ?? -1;
      return baseRevision < hintedRevision || (!get().baseSnapshot && pending.length > 0);
    };

    const scheduleHintRetry = (context = captureRuntimeContext()) => {
      if (refreshScheduled || cancelHintRetry) return;
      resetBootstrapRetry();
      const delayMs = hintRetryDelayMs;
      hintRetryDelayMs = Math.min(hintRetryDelayMs * 2, MAX_HINT_RETRY_MS);
      cancelHintRetry = dependencies.scheduleRetry(() => {
        if (!isRuntimeContextCurrent(context)) return;
        cancelHintRetry = null;
        if (!needsRefreshRetry()) {
          hintRetryDelayMs = INITIAL_HINT_RETRY_MS;
          return;
        }
        void get().refresh();
      }, delayMs);
    };

    const publishPending = (patch: Partial<SidebarStateStore> = {}) => {
      const baseSnapshot = patch.baseSnapshot === undefined ? get().baseSnapshot : patch.baseSnapshot;
      set({
        ...patch,
        pendingOperations: pending.map(({ clientMutationId, operation }) => ({ clientMutationId, operation })),
        snapshot: deriveSnapshot(baseSnapshot, pending),
      });
    };

    const installSnapshot = (
      snapshot: SidebarStateSnapshot,
      context?: SidebarStateRuntimeContext,
    ): boolean => {
      if (context && !isRuntimeContextCurrent(context)) return false;
      const current = get().baseSnapshot;
      if (current && snapshot.revision < current.revision) return false;
      resetBootstrapRetry();
      publishPending({
        baseSnapshot: snapshot,
        status: 'ready',
        supported: true,
        error: null,
      });
      if (snapshot.revision >= hintedRevision) {
        cancelScheduledHintRetry();
        hintRetryDelayMs = INITIAL_HINT_RETRY_MS;
      }
      return true;
    };

    const refresh = async (): Promise<void> => {
      if (loadInFlight) return loadInFlight;
      const context = captureRuntimeContext();
      if (!isRuntimeContextCurrent(context)) return;
      const api = dependencies.getAPI();
      if (!api) return;
      if (!api.supported) {
        resetBootstrapRetry();
        set({ supported: false, status: 'unsupported', error: null });
        return;
      }

      const signal = activeController.signal;
      if (!get().baseSnapshot) set({ supported: true, status: 'loading', error: null });
      let loadFailed = false;
      const request = (async () => {
        try {
          const snapshot = await api.load({ signal });
          if (!isRuntimeContextCurrent(context)) return;
          if (!snapshot) {
            resetBootstrapRetry();
            set({ supported: false, status: 'unsupported', error: null });
            return;
          }
          installSnapshot(snapshot, context);
        } catch (error) {
          if (!isRuntimeContextCurrent(context) || isAbortError(error)) return;
          loadFailed = true;
          set({
            status: 'error',
            supported: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      loadInFlight = request;
      await request.finally(() => {
        if (loadInFlight !== request) return;
        loadInFlight = null;
        if (!isRuntimeContextCurrent(context)) return;
        if (needsRefreshRetry()) {
          scheduleHintRetry(context);
        } else if (loadFailed && !get().baseSnapshot) {
          scheduleBootstrapRetry(context);
        } else if (pending.length > 0 && get().baseSnapshot) {
          void drain();
        }
      });
    };

    const removePending = (entry: InternalPendingOperation): boolean => {
      const index = pending.indexOf(entry);
      if (index < 0) return false;
      pending.splice(index, 1);
      publishPending();
      return true;
    };

    const drain = async (): Promise<void> => {
      if (processing) return;
      processing = true;
      try {
        while (pending.length > 0) {
          const entry = pending[0];
          let conflictAttempts = 0;

          while (pending.includes(entry)) {
            const context = { runtimeKey: entry.runtimeKey, generation: entry.generation };
            if (!isRuntimeContextCurrent(context)) {
              if (removePending(entry)) entry.reject(runtimeChangedError());
              break;
            }
            const api = dependencies.getAPI();
            if (!api?.supported) {
              removePending(entry);
              entry.reject(new Error('Authoritative sidebar state is unsupported in this runtime'));
              break;
            }
            if (!get().baseSnapshot) await refresh();
            if (!pending.includes(entry)) break;
            if (!isRuntimeContextCurrent(context)) {
              if (removePending(entry)) entry.reject(runtimeChangedError());
              break;
            }
            const baseSnapshot = get().baseSnapshot;
            if (!baseSnapshot) {
              return;
            }

            try {
              const result = await api.mutate({
                baseRevision: baseSnapshot.revision,
                clientMutationId: entry.clientMutationId,
                operation: entry.operation,
              }, { signal: activeController.signal });

              if (!pending.includes(entry) || !isRuntimeContextCurrent(context)) break;
              if (!result) throw new Error('Authoritative sidebar state is unsupported in this runtime');
              if (!installSnapshot(result.snapshot, context)) break;
              removePending(entry);
              entry.resolve(get().snapshot ?? result.snapshot);
            } catch (error) {
              if (!pending.includes(entry)) break;
              if (!isRuntimeContextCurrent(context) || isAbortError(error)) {
                if (removePending(entry)) entry.reject(runtimeChangedError());
                break;
              }
              if (error instanceof SidebarStateConflictError && conflictAttempts < 8) {
                conflictAttempts += 1;
                installSnapshot(error.latestSnapshot, context);
                continue;
              }
              removePending(entry);
              entry.reject(error instanceof Error ? error : new Error(String(error)));
            }
          }
        }
      } finally {
        processing = false;
        if (pending.length > 0 && get().baseSnapshot) void drain();
      }
    };

    const switchRuntime = (runtimeKey: string) => {
      const normalizedRuntimeKey = normalizeRuntimeKey(runtimeKey);
      const current = get();
      activeController.abort();
      activeController = new AbortController();
      loadInFlight = null;
      refreshScheduled = false;
      cancelScheduledHintRetry();
      resetBootstrapRetry();
      hintRetryDelayMs = INITIAL_HINT_RETRY_MS;
      hintedRevision = -1;
      const generation = current.generation + 1;

      const obsolete = pending;
      pending = [];
      const error = runtimeChangedError();
      obsolete.forEach((entry) => entry.reject(error));

      if (current.runtimeKey === normalizedRuntimeKey) {
        set({
          generation,
          status: current.baseSnapshot ? 'ready' : 'idle',
          snapshot: current.baseSnapshot,
          pendingOperations: [],
          error: null,
        });
        void refresh();
        return;
      }

      set({
        runtimeKey: normalizedRuntimeKey,
        generation,
        supported: null,
        status: 'idle',
        baseSnapshot: null,
        snapshot: null,
        pendingOperations: [],
        error: null,
      });
      void get().initialize();
    };

    return {
      runtimeKey: normalizeRuntimeKey(dependencies.getRuntimeKey()),
      generation: 0,
      supported: null,
      status: 'idle',
      baseSnapshot: null,
      snapshot: null,
      pendingOperations: [],
      error: null,

      initialize: async () => {
        const runtimeKey = normalizeRuntimeKey(dependencies.getRuntimeKey());
        if (runtimeKey !== get().runtimeKey) {
          switchRuntime(runtimeKey);
          return;
        }
        resetBootstrapRetry();
        const api = dependencies.getAPI();
        if (!api) return;
        if (!api.supported) {
          resetBootstrapRetry();
          set({ supported: false, status: 'unsupported', error: null });
          return;
        }
        set({ supported: true });
        await refresh();
        if (pending.length > 0) void drain();
      },

      refresh,

      mutate: (operation, options) => new Promise<SidebarStateSnapshot>((resolve, reject) => {
        const api = dependencies.getAPI();
        if (!api?.supported) {
          reject(new Error('Authoritative sidebar state is unsupported in this runtime'));
          return;
        }
        resetBootstrapRetry();
        const entry: InternalPendingOperation = {
          clientMutationId: options?.clientMutationId ?? dependencies.createMutationId(),
          operation,
          runtimeKey: get().runtimeKey,
          generation: get().generation,
          resolve,
          reject,
        };
        pending.push(entry);
        publishPending({ supported: true });
        void drain();
      }),

      installAuthoritativeSnapshot: (snapshot, context) => {
        if (context && !isRuntimeContextCurrent(context)) return false;
        return installSnapshot(parseSidebarStateSnapshot(snapshot), context);
      },

      handleRevisionHint: (revision, expectedContext) => {
        if (expectedContext && !isRuntimeContextCurrent(expectedContext)) return;
        if (!Number.isSafeInteger(revision) || revision < 0 || get().supported === false) return;
        if ((get().baseSnapshot?.revision ?? -1) >= revision) return;
        resetBootstrapRetry();
        hintedRevision = Math.max(hintedRevision, revision);
        if (refreshScheduled || cancelHintRetry) return;
        const context = expectedContext ?? captureRuntimeContext();
        refreshScheduled = true;
        dependencies.schedule(() => {
          if (!isRuntimeContextCurrent(context)) return;
          refreshScheduled = false;
          if ((get().baseSnapshot?.revision ?? -1) >= hintedRevision) return;
          void refresh();
        });
      },

      handleTransportReady: (expectedContext) => {
        if (expectedContext && !isRuntimeContextCurrent(expectedContext)) return;
        resetBootstrapRetry();
        if (get().supported === false) return;
        cancelScheduledHintRetry();
        hintRetryDelayMs = INITIAL_HINT_RETRY_MS;
        if (refreshScheduled) return;
        const context = expectedContext ?? captureRuntimeContext();
        refreshScheduled = true;
        dependencies.schedule(() => {
          if (!isRuntimeContextCurrent(context)) return;
          refreshScheduled = false;
          void get().initialize();
        });
      },

      switchRuntime,
    };
  });

  return useStore;
};

export const useSidebarStateStore = createSidebarStateClientStore();

export const initializeSidebarStateSync = (): Promise<void> => useSidebarStateStore.getState().initialize();

export const handleSidebarStateGlobalEvent = (
  value: unknown,
  context?: SidebarStateRuntimeContext,
): void => {
  if (!value || typeof value !== 'object') return;
  const event = value as { type?: unknown; properties?: { revision?: unknown } };
  if (event.type === 'openchamber:notification-stream-ready') {
    useSidebarStateStore.getState().handleTransportReady(context);
    return;
  }
  if (event.type !== 'openchamber:sidebar-state.changed') return;
  if (typeof event.properties?.revision === 'number') {
    useSidebarStateStore.getState().handleRevisionHint(event.properties.revision, context);
  }
};

export const notifySidebarStateTransportReady = (context?: SidebarStateRuntimeContext): void => {
  useSidebarStateStore.getState().handleTransportReady(context);
};
