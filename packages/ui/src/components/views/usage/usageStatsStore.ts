import React from 'react';
import { create } from 'zustand';

import type { UsageStats, UsageTools } from '@/lib/opencode/session-stats';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

import { isSameLocalDay, rangeStart, type UsageRange } from './usageStatsModel';
import { fetchCombinedUsageStats, fetchCombinedUsageTools } from './usageStatsFetch';

/**
 * In-memory cache of Stats page reports for the app session, one entry per
 * (runtime, range, project). Reopening the page or going back to a filter
 * shows the cached report without refetching; only a key with nothing cached
 * loads on its own, and the refresh button forces a new read. A runtime
 * switch drops every entry and ignores answers still in flight.
 *
 * `7d`/`30d` are relative to now: an entry reports the range it was fetched
 * for (`stats.range`) and when (`fetchedAt`), which the page shows.
 */

export type UsageStatsRequest = { range: UsageRange; projectDirectory: string | null };

export type UsageStatsEntry = {
  stats: UsageStats | null;
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
};

export type UsageStatsFetcher = (request: UsageStatsRequest, signal: AbortSignal) => Promise<UsageStats>;

/**
 * Tool calls for a loaded report, fetched only on request: counting them makes
 * each source read tool history in the range. `range` is the loaded report's
 * window, so the tool numbers match the rest of the page.
 */
export type UsageToolsEntry = {
  tools: UsageTools | null;
  loading: boolean;
  error: string | null;
};

export type UsageToolsFetcher = (
  request: UsageStatsRequest,
  range: UsageStats['range'],
  signal: AbortSignal,
) => Promise<UsageTools>;

export const usageStatsKey = (runtimeKey: string, request: UsageStatsRequest): string =>
  `${runtimeKey}::${request.range}::${request.projectDirectory ?? '__all__'}`;

type UsageStatsStore = {
  entries: Record<string, UsageStatsEntry>;
  load: (request: UsageStatsRequest, options?: { force?: boolean }) => Promise<void>;
  toolEntries: Record<string, UsageToolsEntry>;
  toolsRequested: boolean;
  loadTools: (request: UsageStatsRequest, options?: { force?: boolean }) => Promise<void>;
  reset: () => void;
};

const viewerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const fetchReport: UsageStatsFetcher = async ({ range, projectDirectory }, signal) => {
  const now = new Date();
  return fetchCombinedUsageStats({ from: rangeStart(range, now), to: now.getTime(), directory: projectDirectory ?? undefined, timezone: viewerTimeZone() }, signal);
};

const fetchToolsFromOpencode: UsageToolsFetcher = async ({ projectDirectory }, window, signal) => {
  return fetchCombinedUsageTools({ from: window.from, to: window.to, directory: projectDirectory ?? undefined, timezone: viewerTimeZone() }, signal);
};

const isExpiredToday = (request: UsageStatsRequest, entry: UsageStatsEntry | undefined, at: number): boolean =>
  request.range === '1d' && entry?.fetchedAt != null && !isSameLocalDay(entry.fetchedAt, at);

export function createUsageStatsStore(
  fetcher: UsageStatsFetcher,
  runtimeKey: () => string,
  now: () => number = Date.now,
  toolsFetcher: UsageToolsFetcher = fetchToolsFromOpencode,
) {
  let controller = new AbortController();
  const currentToolReads = new Map<string, symbol>();

  return create<UsageStatsStore>()((set, get) => {
    const patch = (key: string, next: Partial<UsageStatsEntry>) =>
      set((state) => {
        const previous = state.entries[key] ?? { stats: null, fetchedAt: null, loading: false, error: null };
        return { entries: { ...state.entries, [key]: { ...previous, ...next } } };
      });

    const patchTools = (key: string, next: Partial<UsageToolsEntry>) =>
      set((state) => {
        const previous = state.toolEntries[key] ?? { tools: null, loading: false, error: null };
        return { toolEntries: { ...state.toolEntries, [key]: { ...previous, ...next } } };
      });

    return {
      entries: {},
      toolEntries: {},
      toolsRequested: false,

      load: async (request, options) => {
        const key = usageStatsKey(runtimeKey(), request);
        const entry = get().entries[key];
        if (entry?.loading) return;
        const startedAt = now();
        const expired = isExpiredToday(request, entry, startedAt);
        if (!options?.force && !expired && (entry?.stats || entry?.error)) return;

        const { signal } = controller;
        if (expired) {
          patch(key, { stats: null, fetchedAt: null, loading: true, error: null });
          currentToolReads.delete(key);
          set((state) => {
            const { [key]: _expiredTools, ...toolEntries } = state.toolEntries;
            return { toolEntries };
          });
        } else {
          patch(key, { loading: true });
        }
        try {
          const stats = await fetcher(request, signal);
          if (signal.aborted) return;
          // Written under the key the read started for: switching filters
          // while it runs never lets it land on another filter.
          patch(key, { stats, fetchedAt: startedAt, loading: false, error: null });
          // A refreshed report moves the window, so tools already shown follow it.
          if (get().toolsRequested) {
            currentToolReads.delete(key);
            patchTools(key, { tools: null, loading: false, error: null });
            void get().loadTools(request, { force: true });
          }
        } catch (error) {
          if (signal.aborted) return;
          patch(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      },

      loadTools: async (request, options) => {
        const key = usageStatsKey(runtimeKey(), request);
        const report = get().entries[key]?.stats;
        if (!report) return;
        const window = report.range;
        set({ toolsRequested: true });
        const entry = get().toolEntries[key];
        if (entry?.loading) return;
        if (!options?.force && (entry?.tools || entry?.error)) return;

        const { signal } = controller;
        const read = Symbol('usage tools read');
        currentToolReads.set(key, read);
        const isDropped = () => signal.aborted || currentToolReads.get(key) !== read;
        patchTools(key, { loading: true });
        try {
          const tools = await toolsFetcher(request, window, signal);
          if (isDropped()) return;
          patchTools(key, { tools, loading: false, error: null });
        } catch (error) {
          if (isDropped()) return;
          patchTools(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      },

      reset: () => {
        currentToolReads.clear();
        controller.abort();
        controller = new AbortController();
        set({ entries: {}, toolEntries: {} });
      },
    };
  });
}

export const useUsageStatsStore = createUsageStatsStore(fetchReport, getRuntimeKey);

const TODAY_CHECK_INTERVAL_MS = 60_000;

export function useTodayRollover(enabled: boolean, load: () => void): void {
  React.useEffect(() => {
    if (!enabled) return undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') load();
    };
    const interval = window.setInterval(load, TODAY_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, load]);
}

export const selectUsageToolsEntry = (
  state: Pick<UsageStatsStore, 'toolEntries'>,
  request: UsageStatsRequest,
): UsageToolsEntry | undefined => state.toolEntries[usageStatsKey(getRuntimeKey(), request)];

export const selectUsageStatsEntry = (
  state: Pick<UsageStatsStore, 'entries'>,
  request: UsageStatsRequest,
): UsageStatsEntry | undefined => state.entries[usageStatsKey(getRuntimeKey(), request)];

subscribeRuntimeEndpointChanged(() => useUsageStatsStore.getState().reset());
