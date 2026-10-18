import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { fetchUsageStats, fetchUsageTools, resolveUsageProjectID, type UsageSourceState, type UsageStats, type UsageTools } from '@/lib/opencode/session-stats';
import type { NativeStatistics, NativeStatisticsQuery } from '@/lib/native-agents/stats-schemas';
import { mergeUsageStats, mergeUsageTools } from './usageStatsMerge';

type Query = Omit<NativeStatisticsQuery, 'tools'>;
type Result<T> = { reports: T[]; sources: UsageSourceState[] };
const BACKENDS = ['claude', 'codex', 'deepseek'] as const;

// Both requests capture the runtime at invocation; reset aborts every answer
// before it can enter another runtime's report cache.
const readSources = async <T>(query: Query, signal: AbortSignal, tools: 'none' | 'detail', readOpenCode: (projectID?: string) => Promise<T>, fromNative: (stats: UsageStats) => T): Promise<Result<T>> => {
  const api = getRegisteredRuntimeAPIs()?.nativeAgents;
  const readOfficial = async () => {
    const projectID = query.directory ? await resolveUsageProjectID(query.directory) : undefined;
    signal.throwIfAborted();
    return readOpenCode(projectID);
  };
  const [official, native] = await Promise.allSettled([
    readOfficial(),
    api?.supported ? api.stats({ ...query, tools }, { signal }) : Promise.resolve<NativeStatistics | null>(null),
  ]);
  signal.throwIfAborted();
  const reports: T[] = [];
  const sources: UsageSourceState[] = [];
  if (official.status === 'fulfilled') { reports.push(official.value); sources.push({ source: 'opencode', status: 'ok' }); }
  else sources.push({ source: 'opencode', status: 'error', message: official.reason instanceof Error ? official.reason.message : 'OpenCode statistics could not be read' });
  if (native.status === 'fulfilled' && native.value) {
    for (const backend of BACKENDS) {
      const source = native.value.backends[backend];
      if (source.status === 'ok' || source.status === 'partial') {
        reports.push(fromNative(source.stats));
        sources.push({ source: backend, status: source.status });
      } else sources.push({ source: backend, status: source.status, message: source.message });
    }
  } else if (native.status === 'rejected') {
    for (const backend of BACKENDS) sources.push({ source: backend, status: 'error' });
  }
  if (!reports.length) throw new Error(sources.find((source) => source.message)?.message ?? 'Statistics could not be read');
  return { reports, sources };
};

export const fetchCombinedUsageStats = async (query: Query, signal: AbortSignal): Promise<UsageStats> => {
  const { reports, sources } = await readSources(query, signal, 'none',
    (projectID) => fetchUsageStats({ ...query, projectID }, signal), (stats) => stats);
  return mergeUsageStats(reports, sources, query);
};

export const fetchCombinedUsageTools = async (query: Query, signal: AbortSignal): Promise<UsageTools> => {
  const { reports, sources } = await readSources(query, signal, 'detail',
    (projectID) => fetchUsageTools({ ...query, projectID }, signal), (stats) => stats.tools);
  return mergeUsageTools(reports, sources);
};
