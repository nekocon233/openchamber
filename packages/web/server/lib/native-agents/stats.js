// Statistics consume the CLI's retained history, never the bounded send registry.
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
    z.object({ ...messageBase, role: z.literal('assistant'), summary: z.boolean().optional(),
      providerID: z.string().optional(), modelID: z.string().optional(), variant: z.string().nullish(),
      tokens: tokensSchema.optional(), cost: count.optional(),
    }),
  ]),
  parts: z.array(z.object({
    type: z.string(), synthetic: z.boolean().optional(), tool: z.string().optional(), callID: z.string().optional(),
    state: z.object({ status: z.string(), time: z.object({ start: z.number(), end: z.number().optional() }) }).optional(),
  })),
});

export const statisticsQuery = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive(), timezone: z.string().min(1),
  directory: z.string().min(1).optional(), tools: z.enum(['none', 'detail']).default('none'),
}).refine((query) => query.from === undefined || query.from < query.to, 'Invalid statistics range')
  .refine((query) => { try { new Intl.DateTimeFormat('en', { timeZone: query.timezone }); return true; } catch { return false; } }, 'Invalid time zone');

const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const metricCoverage = () => ({ known: 0, missing: 0 });
const emptyCoverage = () => ({ tokens: metricCoverage(), cost: metricCoverage(), reasoning: metricCoverage(), undated: 0, failedSessions: 0 });
const emptyTools = () => ({ calls: 0, succeeded: 0, failed: 0, unfinished: 0 });
const addTokens = (target, tokens) => {
  for (const key of Object.keys(target)) target[key] += tokens[key];
};
const median = (values) => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};

const untilAborted = (work, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

/** No more than four histories are resident, including across backends. */
export const createStatisticsLimiter = (limit = 4) => {
  let active = 0;
  const waiting = [];
  return async (work, signal) => {
    signal?.throwIfAborted();
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try { signal?.throwIfAborted(); return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else active -= 1; }
  };
};

/** One source's additive counters and exact per-source tool duration samples. */
export const createStatisticsAccumulator = (query) => {
  const tokens = emptyTokens();
  const coverage = emptyCoverage();
  const activity = new Map();
  const models = new Map();
  const tools = new Map();
  const sessions = new Set();
  const children = new Set();
  const seen = new Set();
  const seenTools = new Set();
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: query.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  let first = query.to - 1;
  let prompts = 0;
  let steps = 0;
  let cost = 0;
  return {
    failed() { coverage.failedSessions += 1; },
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
        let day = null;
        if (at > 0) {
          const date = dayFormat.format(new Date(at));
          day = activity.get(date);
          if (!day) { day = { date, steps: 0, tokens: null, tokensComplete: true }; activity.set(date, day); }
          day.steps += 1;
          if (!info.tokens || snapshot.tokensComplete === false) day.tokensComplete = false;
        }
        const modelKey = JSON.stringify([info.providerID ?? '', info.modelID ?? '', info.variant ?? null]);
        let model = models.get(modelKey);
        if (!model) {
          model = { providerID: info.providerID ?? '', modelID: info.modelID ?? '', variant: info.variant ?? null, steps: 0, tokens: emptyTokens(), cost: 0, coverage: emptyCoverage() };
          models.set(modelKey, model);
        }
        model.steps += 1;
        for (const target of [coverage, model.coverage]) {
          target.tokens[info.tokens ? 'known' : 'missing'] += 1;
          if (info.tokens && snapshot.tokensComplete === false) target.tokens.missing += 1;
          target.cost[info.cost !== undefined ? 'known' : 'missing'] += 1;
          target.reasoning[info.tokens && snapshot.reasoningKnown !== false ? 'known' : 'missing'] += 1;
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
      let previous = null;
      for (const day of days) {
        const at = Date.parse(`${day.date}T00:00:00Z`);
        run = previous !== null && at - previous === 86_400_000 ? run + 1 : 1;
        streak = Math.max(streak, run);
        previous = at;
      }
      const usage = Array.from(tools.values(), ({ durations, ...tool }) => ({ ...tool, durationP50: median(durations) })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
      const totals = emptyTools();
      for (const tool of usage) for (const key of Object.keys(totals)) totals[key] += tool[key];
      return {
        range: { from: query.from ?? first, to: query.to }, sessions: sessions.size, subagents: children.size, prompts, steps,
        tokens, cost, coverage, tools: query.tools === 'detail' ? { mode: 'detail', totals, usage } : { mode: 'none' },
        activity: days, activeDays: days.length, streak, models: Array.from(models.values()).sort((a, b) => b.tokens.total - a.tokens.total),
      };
    },
  };
};

/** Independent sources and independent sessions retain their successful results. */
export const readNativeStatistics = async ({ query, backends, signal, scopeDirectories = [], sourceTimeoutMs = 25_000 }) => {
  const limit = createStatisticsLimiter();
  const withinScope = (directory) => !query.directory || scopeDirectories.some((root) => {
    const relative = path.relative(root, directory);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  const results = await Promise.all(Object.entries(backends).map(async ([backend, store]) => {
    const sourceSignal = AbortSignal.any([AbortSignal.timeout(sourceTimeoutMs), ...(signal ? [signal] : [])]);
    try {
      signal?.throwIfAborted();
      const roots = await untilAborted(store.listStatisticsSessions(sourceSignal), sourceSignal);
      const accumulator = createStatisticsAccumulator(query);
      const visited = new Set();
      const visit = async (session) => {
        signal?.throwIfAborted();
        if (visited.has(session.id)) return;
        visited.add(session.id);
        let snapshot;
        try {
          snapshot = await untilAborted(limit(() => store.loadStatistics(session.id, session.directory, { signal: sourceSignal, tools: query.tools, nativeId: session.nativeId }), sourceSignal), sourceSignal);
          if (!snapshot) throw new Error('Session history is unavailable');
          accumulator.add(session, snapshot);
        } catch (error) {
          signal?.throwIfAborted();
          accumulator.failed();
          return;
        }
        await Promise.all([...(snapshot.childSessions ?? []), ...roots.filter((child) => child.parentID === session.id)].map(visit));
      };
      // A child's activity may be newer than its parent's transcript metadata.
      // Date filtering therefore happens on messages, never on root mtimes.
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
