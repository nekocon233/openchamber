import * as React from 'react';
import { create } from 'zustand';

import type { IconName } from '@/components/icon/icons';
import { useGitHubReadContext } from '@/components/references/referenceSources';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
  CiJobLogResult,
  CiRunStatusFilter,
  CiWorkflowRun,
  CiWorkflowRunDetail,
  SourceControlAPI,
  SourceControlReadContext,
} from '@/lib/api/types';
import type { I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';
import { isFailedConclusion } from './checkRunState';

const CI_LIST_TTL_MS = 30_000;
const CI_DETAIL_TTL_MS = 15_000;
const BRANCH_ACTIVE_POLL_MS = 25_000;
const MAX_LIST_ENTRIES = 30;
const MAX_DETAIL_ENTRIES = 30;
const MAX_LOG_ENTRIES = 20;

const ACTIVE_RUN_STATUSES = new Set(['in_progress', 'queued', 'waiting', 'requested', 'pending']);

export const isActiveCiRunStatus = (status: string | undefined | null): boolean => (
  status !== undefined && status !== null && status.length > 0 && ACTIVE_RUN_STATUSES.has(status.toLowerCase())
);

interface CiRunVisualLook {
  kind: 'running' | 'queued' | 'failed' | 'passed' | 'cancelled' | 'skipped';
  icon: IconName;
  color: string;
  labelKey: I18nKey;
}

export const ciRunLookOf = (status: string | undefined | null, conclusion: string | undefined | null): CiRunVisualLook => {
  const normalizedStatus = (status ?? '').toLowerCase();
  const normalizedConclusion = (conclusion ?? '').toLowerCase();
  if (normalizedStatus === 'in_progress') {
    return { kind: 'running', icon: 'time', color: 'var(--status-warning)', labelKey: 'ciRuns.state.running' };
  }
  if (isActiveCiRunStatus(normalizedStatus)) {
    return { kind: 'queued', icon: 'time', color: 'var(--status-warning)', labelKey: 'ciRuns.state.queued' };
  }
  if (normalizedConclusion === 'cancelled' || normalizedConclusion === 'canceled') {
    return { kind: 'cancelled', icon: 'subtract', color: 'var(--surface-muted-foreground)', labelKey: 'ciRuns.state.cancelled' };
  }
  if (normalizedConclusion === 'skipped' || normalizedConclusion === 'neutral') {
    return { kind: 'skipped', icon: 'subtract', color: 'var(--surface-muted-foreground)', labelKey: 'ciRuns.state.skipped' };
  }
  if (isFailedConclusion(normalizedConclusion)) {
    return { kind: 'failed', icon: 'close-circle', color: 'var(--status-error)', labelKey: 'ciRuns.state.failed' };
  }
  return { kind: 'passed', icon: 'checkbox-circle', color: 'var(--status-success)', labelKey: 'ciRuns.state.passed' };
};

export interface CiListFilterInput {
  status: CiRunStatusFilter;
  branch?: string;
  query?: string;
}

interface CiListEntry {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: CiWorkflowRun[];
  firstPageCount: number;
  page: number;
  hasMore: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  fetchedAt: number;
}

interface CiDetailEntry {
  status: 'idle' | 'loading' | 'ready' | 'error';
  detail: CiWorkflowRunDetail | null;
  refreshing: boolean;
  error: string | null;
  fetchedAt: number;
}

export interface CiJobLogEntry {
  status: 'idle' | 'loading' | 'ready' | 'error';
  result: CiJobLogResult | null;
  error: string | null;
  fetchedAt: number;
}

export const IDLE_CI_LIST_ENTRY: CiListEntry = {
  status: 'idle',
  items: [],
  firstPageCount: 0,
  page: 0,
  hasMore: false,
  refreshing: false,
  loadingMore: false,
  error: null,
  fetchedAt: 0,
};

export const IDLE_CI_DETAIL_ENTRY: CiDetailEntry = {
  status: 'idle',
  detail: null,
  refreshing: false,
  error: null,
  fetchedAt: 0,
};

export const IDLE_CI_JOB_LOG_ENTRY: CiJobLogEntry = {
  status: 'idle',
  result: null,
  error: null,
  fetchedAt: 0,
};

export const getCiRunsListKey = (
  context: SourceControlReadContext,
  filter: CiListFilterInput,
): string => JSON.stringify([
  getRuntimeKey(),
  ...sourceControlReadContextParts(context),
  filter.status,
  filter.branch?.trim() ?? '',
  filter.query?.trim() ?? '',
]);

export const getCiRunDetailKey = (
  context: SourceControlReadContext,
  runId: string,
): string => JSON.stringify([
  getRuntimeKey(),
  ...sourceControlReadContextParts(context),
  runId.trim(),
]);

export const getCiJobLogKey = (
  context: SourceControlReadContext,
  jobId: string,
): string => JSON.stringify([
  getRuntimeKey(),
  ...sourceControlReadContextParts(context),
  jobId.trim(),
]);

interface InFlightEntry {
  promise: Promise<void>;
  token: symbol;
}

const pinnedCounts = new Map<string, number>();
const inFlightLists = new Map<string, InFlightEntry>();
const inFlightDetails = new Map<string, InFlightEntry>();
const inFlightLogs = new Map<string, InFlightEntry>();
const latestListTokens = new Map<string, symbol>();
const latestDetailTokens = new Map<string, symbol>();
const latestLogTokens = new Map<string, symbol>();
let generation = 0;
let cleanupScheduled = false;

export const pinCiCacheKey = (key: string): (() => void) => {
  pinnedCounts.set(key, (pinnedCounts.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (pinnedCounts.get(key) ?? 1) - 1;
    if (next <= 0) {
      pinnedCounts.delete(key);
      scheduleIdleCleanup();
    } else {
      pinnedCounts.set(key, next);
    }
  };
};

const evictBounded = <T extends { fetchedAt: number }>(
  records: Record<string, T>,
  maxEntries: number,
  isBusy: (entry: T) => boolean,
): Record<string, T> => {
  const entries = Object.entries(records);
  if (entries.length <= maxEntries) return records;
  const keep: Array<[string, T]> = [];
  const candidates: Array<[string, T]> = [];
  for (const pair of entries) {
    if ((pinnedCounts.get(pair[0]) ?? 0) > 0 || isBusy(pair[1])) {
      keep.push(pair);
    } else {
      candidates.push(pair);
    }
  }
  const slots = Math.max(0, maxEntries - keep.length);
  candidates.sort((left, right) => right[1].fetchedAt - left[1].fetchedAt);
  return Object.fromEntries([...keep, ...candidates.slice(0, slots)]);
};

interface CiRunsStoreState {
  lists: Record<string, CiListEntry>;
  details: Record<string, CiDetailEntry>;
  logs: Record<string, CiJobLogEntry>;
  ensureList: (
    sourceControl: Pick<SourceControlAPI, 'ciRunsList'>,
    context: SourceControlReadContext,
    filter: CiListFilterInput,
    force?: boolean,
  ) => Promise<void>;
  loadMoreList: (
    sourceControl: Pick<SourceControlAPI, 'ciRunsList'>,
    context: SourceControlReadContext,
    filter: CiListFilterInput,
  ) => Promise<void>;
  ensureDetail: (
    sourceControl: Pick<SourceControlAPI, 'ciRunDetail'>,
    context: SourceControlReadContext,
    runId: string,
    force?: boolean,
  ) => Promise<void>;
  loadJobLog: (
    sourceControl: Pick<SourceControlAPI, 'ciJobLog'>,
    context: SourceControlReadContext,
    jobId: string,
    force?: boolean,
  ) => Promise<void>;
  pruneIdle: () => void;
  resetForRuntimeSwitch: () => void;
}

function scheduleIdleCleanup(): void {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  queueMicrotask(() => {
    cleanupScheduled = false;
    useCiRunsStore.getState().pruneIdle();
  });
}

export const useCiRunsStore = create<CiRunsStoreState>()((set, get) => ({
  lists: {},
  details: {},
  logs: {},

  ensureList: async (sourceControl, context, filter, force = false) => {
    const key = getCiRunsListKey(context, filter);
    const existing = get().lists[key];
    if (!force && existing?.status === 'ready' && Date.now() - existing.fetchedAt < CI_LIST_TTL_MS) {
      return;
    }
    const pending = inFlightLists.get(key);
    if (pending && !force) return pending.promise;

    const capturedGeneration = generation;
    const token = Symbol(key);
    latestListTokens.set(key, token);

    const task = (async () => {
      set((state) => {
        const prev = state.lists[key] ?? IDLE_CI_LIST_ENTRY;
        const hasData = prev.status === 'ready' || prev.items.length > 0;
        return {
          lists: {
            ...state.lists,
            [key]: {
              ...prev,
              status: hasData ? 'ready' : 'loading',
              refreshing: hasData,
              error: null,
            },
          },
        };
      });

      try {
        const page = await sourceControl.ciRunsList(context, {
          page: 1,
          status: filter.status,
          branch: filter.branch?.trim() || undefined,
          query: filter.query?.trim() || undefined,
        });
        if (capturedGeneration !== generation || latestListTokens.get(key) !== token) return;
        set((state) => {
          const prev = state.lists[key];
          if (prev && prev.page > 1 && page.items.length > 0) {
            const freshIds = new Set(page.items.map((item) => item.id));
            const olderPages = prev.items.slice(prev.firstPageCount).filter((item) => !freshIds.has(item.id));
            return {
              lists: {
                ...state.lists,
                [key]: {
                  status: 'ready',
                  items: [...page.items, ...olderPages],
                  firstPageCount: page.items.length,
                  page: prev.page,
                  hasMore: prev.hasMore,
                  refreshing: false,
                  loadingMore: false,
                  error: null,
                  fetchedAt: Date.now(),
                },
              },
            };
          }
          return {
            lists: {
              ...state.lists,
              [key]: {
                status: 'ready',
                items: page.items,
                firstPageCount: page.items.length,
                page: 1,
                hasMore: page.hasMore,
                refreshing: false,
                loadingMore: false,
                error: null,
                fetchedAt: Date.now(),
              },
            },
          };
        });
      } catch (error) {
        if (capturedGeneration !== generation || latestListTokens.get(key) !== token) return;
        const message = error instanceof Error ? error.message : 'Failed to load CI runs';
        set((state) => {
          const prev = state.lists[key] ?? IDLE_CI_LIST_ENTRY;
          const retain = prev.items.length > 0 || prev.status === 'ready';
          return {
            lists: {
              ...state.lists,
              [key]: {
                ...prev,
                status: retain ? 'ready' : 'error',
                refreshing: false,
                loadingMore: false,
                error: message,
              },
            },
          };
        });
      } finally {
        if (inFlightLists.get(key)?.token === token) inFlightLists.delete(key);
        scheduleIdleCleanup();
      }
    })();

    inFlightLists.set(key, { promise: task, token });
    return task;
  },

  loadMoreList: async (sourceControl, context, filter) => {
    const key = getCiRunsListKey(context, filter);
    const current = get().lists[key];
    if (!current || current.status !== 'ready' || !current.hasMore || current.loadingMore || current.refreshing) {
      return;
    }
    const nextPage = current.page + 1;
    const capturedGeneration = generation;
    const baselineToken = latestListTokens.get(key);

    set((state) => {
      const prev = state.lists[key];
      if (!prev) return state;
      return {
        lists: {
          ...state.lists,
          [key]: { ...prev, loadingMore: true, error: null },
        },
      };
    });

    try {
      const result = await sourceControl.ciRunsList(context, {
        page: nextPage,
        status: filter.status,
        branch: filter.branch?.trim() || undefined,
        query: filter.query?.trim() || undefined,
      });
      if (capturedGeneration !== generation || latestListTokens.get(key) !== baselineToken) return;
      set((state) => {
        const prev = state.lists[key];
        if (!prev) return state;
        const seen = new Set(prev.items.map((item) => item.id));
        const merged = [...prev.items, ...result.items.filter((item) => !seen.has(item.id))];
        return {
          lists: {
            ...state.lists,
            [key]: {
              ...prev,
              items: merged,
              page: nextPage,
              hasMore: result.hasMore,
              loadingMore: false,
              error: null,
              fetchedAt: Date.now(),
            },
          },
        };
      });
    } catch (error) {
      if (capturedGeneration !== generation || latestListTokens.get(key) !== baselineToken) return;
      const message = error instanceof Error ? error.message : 'Failed to load more CI runs';
      set((state) => {
        const prev = state.lists[key];
        if (!prev) return state;
        return {
          lists: {
            ...state.lists,
            [key]: { ...prev, loadingMore: false, error: message },
          },
        };
      });
    }
  },

  ensureDetail: async (sourceControl, context, runId, force = false) => {
    const key = getCiRunDetailKey(context, runId);
    const existing = get().details[key];
    if (!force && existing?.status === 'ready' && Date.now() - existing.fetchedAt < CI_DETAIL_TTL_MS) {
      return;
    }
    const pending = inFlightDetails.get(key);
    if (pending && !force) return pending.promise;

    const capturedGeneration = generation;
    const token = Symbol(key);
    latestDetailTokens.set(key, token);

    const task = (async () => {
      set((state) => {
        const prev = state.details[key] ?? IDLE_CI_DETAIL_ENTRY;
        const hasDetail = prev.detail !== null;
        return {
          details: {
            ...state.details,
            [key]: {
              ...prev,
              status: hasDetail ? 'ready' : 'loading',
              refreshing: hasDetail,
              error: null,
            },
          },
        };
      });

      try {
        const detail = await sourceControl.ciRunDetail(context, runId);
        if (capturedGeneration !== generation || latestDetailTokens.get(key) !== token) return;
        set((state) => ({
          details: {
            ...state.details,
            [key]: {
              status: 'ready',
              detail,
              refreshing: false,
              error: null,
              fetchedAt: Date.now(),
            },
          },
        }));
      } catch (error) {
        if (capturedGeneration !== generation || latestDetailTokens.get(key) !== token) return;
        const message = error instanceof Error ? error.message : 'Failed to load CI run detail';
        set((state) => {
          const prev = state.details[key] ?? IDLE_CI_DETAIL_ENTRY;
          return {
            details: {
              ...state.details,
              [key]: {
                ...prev,
                status: prev.detail ? 'ready' : 'error',
                refreshing: false,
                error: message,
              },
            },
          };
        });
      } finally {
        if (inFlightDetails.get(key)?.token === token) inFlightDetails.delete(key);
        scheduleIdleCleanup();
      }
    })();

    inFlightDetails.set(key, { promise: task, token });
    return task;
  },

  loadJobLog: async (sourceControl, context, jobId, force = false) => {
    const key = getCiJobLogKey(context, jobId);
    const existing = get().logs[key];
    if (!force && existing?.status === 'ready') {
      return;
    }
    const pending = inFlightLogs.get(key);
    if (pending && !force) return pending.promise;

    const capturedGeneration = generation;
    const token = Symbol(key);
    latestLogTokens.set(key, token);

    const task = (async () => {
      set((state) => ({
        logs: {
          ...state.logs,
          [key]: {
            ...(state.logs[key] ?? IDLE_CI_JOB_LOG_ENTRY),
            status: 'loading',
            error: null,
          },
        },
      }));
      try {
        const result = await sourceControl.ciJobLog(context, jobId);
        if (capturedGeneration !== generation || latestLogTokens.get(key) !== token) return;
        set((state) => ({
          logs: {
            ...state.logs,
            [key]: {
              status: 'ready',
              result,
              error: null,
              fetchedAt: Date.now(),
            },
          },
        }));
      } catch (error) {
        if (capturedGeneration !== generation || latestLogTokens.get(key) !== token) return;
        const message = error instanceof Error ? error.message : 'Failed to load job log';
        set((state) => ({
          logs: {
            ...state.logs,
            [key]: {
              ...(state.logs[key] ?? IDLE_CI_JOB_LOG_ENTRY),
              status: 'error',
              error: message,
            },
          },
        }));
      } finally {
        if (inFlightLogs.get(key)?.token === token) inFlightLogs.delete(key);
        scheduleIdleCleanup();
      }
    })();

    inFlightLogs.set(key, { promise: task, token });
    return task;
  },

  pruneIdle: () => set((state) => ({
    lists: evictBounded(state.lists, MAX_LIST_ENTRIES, (entry) => entry.status === 'loading' || entry.refreshing || entry.loadingMore),
    details: evictBounded(state.details, MAX_DETAIL_ENTRIES, (entry) => entry.status === 'loading' || entry.refreshing),
    logs: evictBounded(state.logs, MAX_LOG_ENTRIES, (entry) => entry.status === 'loading'),
  })),

  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlightLists.clear();
    inFlightDetails.clear();
    inFlightLogs.clear();
    latestListTokens.clear();
    latestDetailTokens.clear();
    latestLogTokens.clear();
    pinnedCounts.clear();
    set({ lists: {}, details: {}, logs: {} });
  },
}));

interface BranchLatestCiRunState {
  context: SourceControlReadContext | null;
  run: CiWorkflowRun | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Visible-only subscription to the latest GitHub Actions run for `branch`.
 * Shares the same keyed cache as the CI tab so switching between Work Status,
 * Current branch, and CI makes no duplicate request.
 */
export const useBranchLatestCiRun = (
  directory: string | null,
  branch: string | null,
  enabled: boolean,
): BranchLatestCiRunState => {
  const { sourceControl } = useRuntimeAPIs();
  const rawContext = useGitHubReadContext(enabled ? directory : null);
  const context = rawContext && rawContext !== 'missing' && rawContext.provider === 'github' ? rawContext : null;
  const trimmedBranch = branch?.trim() ?? '';
  const active = Boolean(enabled && context && trimmedBranch);
  const filter = React.useMemo<CiListFilterInput>(() => ({ status: 'all', branch: trimmedBranch }), [trimmedBranch]);
  const key = active && context ? getCiRunsListKey(context, filter) : null;
  const entry = useCiRunsStore((state) => (key ? state.lists[key] : undefined)) ?? IDLE_CI_LIST_ENTRY;
  const latestRun = entry.items[0] ?? null;
  const isRunning = isActiveCiRunStatus(latestRun?.status);

  React.useEffect(() => {
    if (!key) return undefined;
    return pinCiCacheKey(key);
  }, [key]);

  React.useEffect(() => {
    if (!active || !context) return undefined;
    void useCiRunsStore.getState().ensureList(sourceControl, context, filter, false);
    if (!isRunning) return undefined;
    const timer = window.setInterval(() => {
      void useCiRunsStore.getState().ensureList(sourceControl, context, filter, true);
    }, BRANCH_ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, context, filter, isRunning, sourceControl]);

  const refresh = React.useCallback(async () => {
    if (!context || !trimmedBranch) return;
    await useCiRunsStore.getState().ensureList(sourceControl, context, filter, true);
  }, [context, filter, sourceControl, trimmedBranch]);

  return {
    context,
    run: active ? latestRun : null,
    loading: active && entry.status === 'loading',
    error: active ? entry.error : null,
    refresh,
  };
};
