import type { UsageActivityDay, UsageCoverage, UsageModel, UsageSourceState, UsageStats, UsageTools } from '@/lib/opencode/session-stats';

const TOKEN_KEYS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'] as const;
const COVERAGE_KEYS = ['tokens', 'cost', 'reasoning'] as const;
const TOOL_KEYS = ['calls', 'succeeded', 'failed', 'unfinished'] as const;

export const coverageOf = (stats: Pick<UsageStats, 'steps' | 'coverage'>): UsageCoverage => stats.coverage ?? {
  tokens: { known: stats.steps, missing: 0 }, cost: { known: stats.steps, missing: 0 },
  reasoning: { known: stats.steps, missing: 0 }, undated: 0, failedSessions: 0,
};

const addCoverage = (target: UsageCoverage, next: UsageCoverage) => {
  for (const key of COVERAGE_KEYS) {
    target[key].known += next[key].known;
    target[key].missing += next[key].missing;
  }
  target.undated += next.undated;
  target.failedSessions += next.failedSessions;
};

/** Medians cannot be combined from the medians of independent populations. */
export const mergeUsageTools = (reports: UsageTools[], sources: UsageSourceState[]): UsageTools => {
  const totals = { calls: 0, succeeded: 0, failed: 0, unfinished: 0 };
  const rows = new Map<string, { row: Extract<UsageTools, { mode: 'detail' }>['usage'][number]; populations: number }>();
  for (const report of reports) {
    if (report.mode === 'none') continue;
    for (const key of TOOL_KEYS) totals[key] += report.totals[key];
    if (report.mode !== 'detail') continue;
    for (const tool of report.usage) {
      const previous = rows.get(tool.name);
      if (!previous) { rows.set(tool.name, { row: { ...tool }, populations: tool.calls > 0 ? 1 : 0 }); continue; }
      for (const key of TOOL_KEYS) previous.row[key] += tool[key];
      if (tool.calls > 0) {
        if (previous.populations > 0) previous.row.durationP50 = null;
        else previous.row.durationP50 = tool.durationP50;
        previous.populations += 1;
      }
    }
  }
  return { mode: 'detail', totals, usage: Array.from(rows.values(), ({ row }) => row).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)), sources };
};

/** Every source shares one query window. Activity days form a union. */
export const mergeUsageStats = (reports: UsageStats[], sources: UsageSourceState[], window: { from?: number; to: number }): UsageStats => {
  const first = reports.filter((report) => report.prompts > 0 || report.steps > 0).map((report) => report.range.from);
  const result: UsageStats = {
    range: { from: window.from ?? Math.min(window.to - 1, ...first), to: window.to },
    sessions: 0, subagents: 0, prompts: 0, steps: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0, tools: { mode: 'none' }, activeDays: 0, streak: 0, activity: [], models: [], sources,
  };
  const coverage = coverageOf(result);
  const activity = new Map<string, UsageActivityDay>();
  const models = new Map<string, UsageModel>();
  for (const report of reports) {
    result.sessions += report.sessions;
    result.subagents += report.subagents;
    result.prompts += report.prompts;
    result.steps += report.steps;
    result.cost += report.cost;
    for (const key of TOKEN_KEYS) result.tokens[key] += report.tokens[key];
    addCoverage(coverage, coverageOf(report));
    for (const day of report.activity) {
      const previous = activity.get(day.date);
      if (!previous) { activity.set(day.date, { ...day }); continue; }
      previous.steps += day.steps;
      if (day.tokens !== null) previous.tokens = (previous.tokens ?? 0) + day.tokens;
      previous.tokensComplete = previous.tokensComplete && day.tokensComplete;
    }
    for (const model of report.models) {
      const key = JSON.stringify([model.providerID, model.modelID, model.variant]);
      const previous = models.get(key);
      if (!previous) {
        const covered = coverageOf(model);
        models.set(key, { ...model, tokens: { ...model.tokens }, coverage: {
          ...covered, tokens: { ...covered.tokens }, cost: { ...covered.cost }, reasoning: { ...covered.reasoning },
        } });
      } else {
        previous.steps += model.steps;
        previous.cost += model.cost;
        for (const token of TOKEN_KEYS) previous.tokens[token] += model.tokens[token];
        const previousCoverage = coverageOf(previous);
        addCoverage(previousCoverage, coverageOf(model));
        previous.coverage = previousCoverage;
      }
    }
  }
  result.coverage = coverage;
  const historyComplete = sources.every((source) => source.status === 'ok') && coverage.failedSessions === 0 && coverage.undated === 0;
  result.activity = Array.from(activity.values(), (day) => ({ ...day, tokensComplete: day.tokensComplete && historyComplete })).sort((a, b) => a.date.localeCompare(b.date));
  result.activeDays = result.activity.length;
  let run = 0;
  let previous: number | null = null;
  for (const day of result.activity) {
    const at = Date.parse(`${day.date}T00:00:00Z`);
    run = previous !== null && at - previous === 86_400_000 ? run + 1 : 1;
    result.streak = Math.max(result.streak, run);
    previous = at;
  }
  result.models = Array.from(models.values()).sort((a, b) => b.tokens.total - a.tokens.total);
  return result;
};
