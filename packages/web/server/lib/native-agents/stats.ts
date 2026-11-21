import path from 'node:path';
import { z } from 'zod';
import { NativeAgentError } from './errors.js';

const count = z.number().finite().nonnegative();
const tokensSchema = z.object({ input: count, output: count, reasoning: count, cache: z.object({ read: count, write: count }) });
const messageBase = { id: z.string(), time: z.object({ created: z.number().finite() }) };
const recordSchema = z.object({
  info: z.discriminatedUnion('role', [
    z.object({ ...messageBase, role: z.literal('user') }),
    z.object({ ...messageBase, role: z.literal('compaction') }),
    z.object({
      ...messageBase,
      role: z.literal('assistant'),
      summary: z.boolean().optional(),
      providerID: z.string().optional(),
      modelID: z.string().optional(),
      reasoningKnown: z.boolean().optional(),
      tokens: tokensSchema.optional(),
      cost: count.optional(),
    }),
  ]),
  parts: z.array(z.object({
    type: z.string(),
    synthetic: z.boolean().optional(),
    tool: z.string().optional(),
    callID: z.string().optional(),
    state: z.object({ status: z.string(), time: z.object({ start: z.number(), end: z.number().optional() }) }).optional(),
  })),
});

export const statisticsQuery = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive(),
  timezone: z.string().min(1),
  directory: z.string().min(1).optional(),
  tools: z.enum(['none', 'detail']).default('none'),
}).refine((query) => query.from === undefined || query.from < query.to, 'Invalid statistics range')
  .refine((query) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: query.timezone });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid time zone');

export type NativeStatisticsQuery = z.infer<typeof statisticsQuery>;

export type NativeStatsTokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type NativeStatsMetricCoverage = {
  known: number;
  missing: number;
};

export type NativeStatsCoverage = {
  tokens: NativeStatsMetricCoverage;
  cost: NativeStatsMetricCoverage;
  reasoning: NativeStatsMetricCoverage;
  undated: number;
  failedSessions: number;
};

export type NativeStatsToolTotals = {
  calls: number;
  succeeded: number;
  failed: number;
  unfinished: number;
};

export type NativeStatsToolUsage = NativeStatsToolTotals & {
  name: string;
  durationP50: number | null;
};

export type NativeStatsDayActivity = {
  date: string;
  steps: number;
  tokens: number | null;
  tokensComplete: boolean;
};

export type NativeStatsModelBreakdown = {
  providerID: string;
  modelID: string;
  steps: number;
  tokens: NativeStatsTokens;
  cost: number;
  coverage: NativeStatsCoverage;
};

export type NativeStatsToolsResult =
  | { mode: 'detail'; totals: NativeStatsToolTotals; usage: NativeStatsToolUsage[] }
  | { mode: 'none' };

export type NativeStatisticsSummary = {
  range: { from: number; to: number };
  sessions: number;
  subagents: number;
  prompts: number;
  steps: number;
  tokens: NativeStatsTokens;
  cost: number;
  coverage: NativeStatsCoverage;
  tools: NativeStatsToolsResult;
  activity: NativeStatsDayActivity[];
  activeDays: number;
  streak: number;
  models: NativeStatsModelBreakdown[];
};

export type NativeStatisticsSessionDescriptor = {
  id: string;
  directory: string;
  parentID?: string | undefined;
  nativeId?: string | undefined;
};

export type NativeStatisticsSnapshot = {
  records: readonly unknown[];
  childSessions?: ReadonlyArray<NativeStatisticsSessionDescriptor> | undefined;
  complete?: boolean | undefined;
  tokensComplete?: boolean | undefined;
  reasoningKnown?: boolean | undefined;
};

export type NativeStatisticsListing =
  | ReadonlyArray<NativeStatisticsSessionDescriptor>
  | { sessions: ReadonlyArray<NativeStatisticsSessionDescriptor>; failedSessions: number };

export interface NativeStatisticsBackendStore {
  listStatisticsSessions: (signal: AbortSignal) => Promise<NativeStatisticsListing>;
  loadStatistics: (
    sessionId: string,
    directory: string,
    options: { signal: AbortSignal; tools: 'none' | 'detail'; nativeId?: string | undefined },
  ) => Promise<NativeStatisticsSnapshot | null>;
}

export type NativeStatisticsBackendResult =
  | { status: 'ok' | 'partial'; stats: NativeStatisticsSummary }
  | { status: 'unavailable' | 'error'; message: string; code: string };

export interface ReadNativeStatisticsOptions {
  query: NativeStatisticsQuery;
  backends: Record<string, NativeStatisticsBackendStore>;
  signal?: AbortSignal | undefined;
  scopeDirectories?: ReadonlyArray<string> | undefined;
  sourceTimeoutMs?: number | undefined;
}

export type StatisticsLimiter = <Result>(work: () => Promise<Result>, signal?: AbortSignal, backend?: string) => Promise<Result>;

export interface StatisticsAccumulator {
  failed: (count?: number) => void;
  add: (session: NativeStatisticsSessionDescriptor, snapshot: NativeStatisticsSnapshot) => void;
  result: () => NativeStatisticsSummary;
}

const TOKEN_KEYS: ReadonlyArray<keyof NativeStatsTokens> = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'];
const TOOL_KEYS: ReadonlyArray<keyof NativeStatsToolTotals> = ['calls', 'succeeded', 'failed', 'unfinished'];

const emptyTokens = (): NativeStatsTokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const metricCoverage = (): NativeStatsMetricCoverage => ({ known: 0, missing: 0 });
const emptyCoverage = (): NativeStatsCoverage => ({ tokens: metricCoverage(), cost: metricCoverage(), reasoning: metricCoverage(), undated: 0, failedSessions: 0 });
const emptyTools = (): NativeStatsToolTotals => ({ calls: 0, succeeded: 0, failed: 0, unfinished: 0 });
const addTokens = (target: NativeStatsTokens, tokens: NativeStatsTokens): void => {
  for (const key of TOKEN_KEYS) target[key] += tokens[key];
};
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const current = values[middle];
  if (current === undefined) return null;
  if (values.length % 2) return current;
  const previous = values[middle - 1];
  return previous === undefined ? current : (previous + current) / 2;
};

const untilAborted = <Result>(work: Promise<Result>, signal: AbortSignal): Promise<Result> => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

export const createStatisticsLimiter = (limit = 4): StatisticsLimiter => {
  let active = 0;
  const waiting = new Map<string, Array<() => void>>();
  const release = (): void => {
    const first = waiting.entries().next();
    if (first.done) { active -= 1; return; }
    const [backend, queue] = first.value;
    const next = queue.shift();
    waiting.delete(backend);
    if (queue.length) waiting.set(backend, queue);
    next?.();
  };
  return async <Result>(work: () => Promise<Result>, signal?: AbortSignal, backend = 'default'): Promise<Result> => {
    signal?.throwIfAborted();
    if (active >= limit) await new Promise<void>((resolve, reject) => {
      const queue = waiting.get(backend) ?? [];
      const start = () => { signal?.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => {
        const idx = queue.indexOf(start);
        if (idx !== -1) queue.splice(idx, 1);
        if (!queue.length) waiting.delete(backend);
        reject(signal?.reason);
      };
      queue.push(start);
      waiting.set(backend, queue);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    else active += 1;
    try { signal?.throwIfAborted(); return await work(); }
    finally { release(); }
  };
};

export const createStatisticsAccumulator = (query: NativeStatisticsQuery): StatisticsAccumulator => {
  const tokens = emptyTokens();
  const coverage = emptyCoverage();
  const activity = new Map<string, NativeStatsDayActivity>();
  const models = new Map<string, NativeStatsModelBreakdown>();
  const tools = new Map<string, NativeStatsToolTotals & { name: string; durations: number[] }>();
  const sessions = new Set<string>();
  const children = new Set<string>();
  const seen = new Set<string>();
  const seenTools = new Set<string>();
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: query.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  let first = query.to - 1;
  let prompts = 0;
  let steps = 0;
  let cost = 0;
  return {
    failed(failedCount = 1) { coverage.failedSessions += failedCount; },
    add(session, snapshot) {
      let incomplete = snapshot.complete === false;
      for (const raw of snapshot.records) {
        const parsed = recordSchema.safeParse(raw);
        if (!parsed.success) { incomplete = true; continue; }
        const { info, parts } = parsed.data;
        if (info.role === 'compaction' || info.role === 'assistant' && info.summary) continue;
        if (info.role === 'user' && !parts.some((part) => !part.synthetic && (part.type === 'text' || part.type === 'file'))) continue;
        const key = `${session.id}:${info.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const at = info.time.created;
        if (at <= 0) { coverage.undated += 1; if (query.from !== undefined) continue; }
        else if (at < (query.from ?? 0) || at >= query.to) continue;
        if (at > 0) first = Math.min(first, at);
        (session.parentID ? children : sessions).add(session.id);
        if (info.role === 'user') { prompts += 1; continue; }
        steps += 1;
        let day: NativeStatsDayActivity | null = null;
        if (at > 0) {
          const date = dayFormat.format(new Date(at));
          let existingDay = activity.get(date);
          if (!existingDay) { existingDay = { date, steps: 0, tokens: null, tokensComplete: true }; activity.set(date, existingDay); }
          day = existingDay;
          day.steps += 1;
          if (!info.tokens || snapshot.tokensComplete === false) day.tokensComplete = false;
        }
        const modelKey = JSON.stringify([info.providerID ?? '', info.modelID ?? '']);
        let model = models.get(modelKey);
        if (!model) {
          model = { providerID: info.providerID ?? '', modelID: info.modelID ?? '', steps: 0, tokens: emptyTokens(), cost: 0, coverage: emptyCoverage() };
          models.set(modelKey, model);
        }
        model.steps += 1;
        for (const target of [coverage, model.coverage]) {
          target.tokens[info.tokens ? 'known' : 'missing'] += 1;
          if (info.tokens && snapshot.tokensComplete === false) target.tokens.missing += 1;
          target.cost[info.cost !== undefined ? 'known' : 'missing'] += 1;
          target.reasoning[info.tokens && (info.reasoningKnown ?? snapshot.reasoningKnown) !== false ? 'known' : 'missing'] += 1;
        }
        if (info.tokens) {
          const value = { input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning, cacheRead: info.tokens.cache.read, cacheWrite: info.tokens.cache.write };
          const total = Object.values(value).reduce((sum, n) => sum + n, 0);
          addTokens(tokens, { ...value, total });
          addTokens(model.tokens, { ...value, total });
          if (day) day.tokens = (day.tokens ?? 0) + total;
        }
        if (info.cost !== undefined) { cost += info.cost; model.cost += info.cost; }
        if (query.tools !== 'detail') continue;
        for (const part of parts) {
          if (part.type !== 'tool' || !part.tool || !part.state || !part.callID) continue;
          const call = `${session.id}:${part.callID}`;
          if (seenTools.has(call)) continue;
          seenTools.add(call);
          let tool = tools.get(part.tool);
          if (!tool) { tool = { name: part.tool, ...emptyTools(), durations: [] }; tools.set(part.tool, tool); }
          tool.calls += 1;
          if (part.state.status === 'completed') tool.succeeded += 1;
          else if (part.state.status === 'error') tool.failed += 1;
          else tool.unfinished += 1;
          if (part.state.status === 'completed' && part.state.time.end !== undefined && part.state.time.end >= part.state.time.start) tool.durations.push(part.state.time.end - part.state.time.start);
        }
      }
      if (incomplete) coverage.failedSessions += 1;
    },
    result() {
      const historyComplete = coverage.failedSessions === 0 && coverage.undated === 0;
      const days = Array.from(activity.values(), (day) => ({ ...day, tokensComplete: day.tokensComplete && historyComplete })).sort((a, b) => a.date.localeCompare(b.date));
      let streak = 0;
      let run = 0;
      let previous: number | null = null;
      for (const day of days) {
        const at = Date.parse(`${day.date}T00:00:00Z`);
        run = previous !== null && at - previous === 86_400_000 ? run + 1 : 1;
        streak = Math.max(streak, run);
        previous = at;
      }
      const usage: NativeStatsToolUsage[] = Array.from(tools.values(), ({ durations, ...tool }) => ({ ...tool, durationP50: median(durations) })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
      const totals = emptyTools();
      for (const tool of usage) for (const key of TOOL_KEYS) totals[key] += tool[key];
      return {
        range: { from: query.from ?? first, to: query.to },
        sessions: sessions.size,
        subagents: children.size,
        prompts,
        steps,
        tokens,
        cost,
        coverage,
        tools: query.tools === 'detail' ? { mode: 'detail', totals, usage } : { mode: 'none' },
        activity: days,
        activeDays: days.length,
        streak,
        models: Array.from(models.values()).sort((a, b) => b.tokens.total - a.tokens.total),
      };
    },
  };
};

const isStatisticsListingArray = (
  listing: NativeStatisticsListing,
): listing is ReadonlyArray<NativeStatisticsSessionDescriptor> => Array.isArray(listing);

export const readNativeStatistics = async ({
  query,
  backends,
  signal,
  scopeDirectories = [],
  sourceTimeoutMs,
}: ReadNativeStatisticsOptions): Promise<{ backends: Record<string, NativeStatisticsBackendResult> }> => {
  const limit = createStatisticsLimiter();
  const withinScope = (directory: string): boolean => !query.directory || scopeDirectories.some((root) => {
    const relative = path.relative(root, directory);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  const results = await Promise.all(Object.entries(backends).map(async ([backend, store]): Promise<[string, NativeStatisticsBackendResult]> => {
    const timeoutMs = sourceTimeoutMs ?? (backend === 'codex' ? 60_000 : 25_000);
    const signals = signal ? [AbortSignal.timeout(timeoutMs), signal] : [AbortSignal.timeout(timeoutMs)];
    const sourceSignal = AbortSignal.any(signals);
    try {
      signal?.throwIfAborted();
      const listing = await untilAborted(store.listStatisticsSessions(sourceSignal), sourceSignal);
      const roots = isStatisticsListingArray(listing) ? listing : listing.sessions;
      const accumulator = createStatisticsAccumulator(query);
      if (!isStatisticsListingArray(listing)) accumulator.failed(listing.failedSessions);
      const visited = new Set<string>();
      const visit = async (session: NativeStatisticsSessionDescriptor): Promise<void> => {
        signal?.throwIfAborted();
        if (visited.has(session.id)) return;
        visited.add(session.id);
        let snapshot: NativeStatisticsSnapshot | null;
        try {
          snapshot = await untilAborted(
            limit(() => store.loadStatistics(session.id, session.directory, { signal: sourceSignal, tools: query.tools, nativeId: session.nativeId }), sourceSignal, backend),
            sourceSignal,
          );
          if (!snapshot) throw new Error('Session history is unavailable');
          accumulator.add(session, snapshot);
        } catch {
          signal?.throwIfAborted();
          accumulator.failed();
          return;
        }
        await Promise.all([...(snapshot.childSessions ?? []), ...roots.filter((child) => child.parentID === session.id)].map(visit));
      };
      await Promise.all(roots.filter((session) => !session.parentID && withinScope(session.directory)).map(visit));
      const stats = accumulator.result();
      return [backend, { status: stats.coverage.failedSessions || stats.coverage.undated ? 'partial' : 'ok', stats }];
    } catch (error) {
      signal?.throwIfAborted();
      const code = error instanceof NativeAgentError ? error.code : sourceSignal.aborted ? 'NATIVE_STATS_TIMEOUT' : 'NATIVE_STATS_FAILED';
      return [backend, { status: code === 'NATIVE_CLI_MISSING' ? 'unavailable' : 'error', message: 'Could not read native session statistics', code }];
    }
  }));
  return { backends: Object.fromEntries(results) };
};
