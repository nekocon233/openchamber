import { describe, expect, test } from 'bun:test';
import type { UsageStats, UsageTools } from '@/lib/opencode/session-stats';
import { coverageOf, mergeUsageStats, mergeUsageTools } from './usageStatsMerge';

const report = (date: string, steps = 1): UsageStats => ({
  range: { from: 1, to: 1000 }, sessions: 1, subagents: 0, prompts: 1, steps,
  tokens: { input: 10, output: 3, reasoning: 2, cacheRead: 20, cacheWrite: 5, total: 40 }, cost: 0,
  tools: { mode: 'none' }, activeDays: 1, streak: 1, activity: [{ date, steps, tokens: 40, tokensComplete: true }],
  models: [{ providerID: 'provider', modelID: 'model', variant: null, steps, tokens: { input: 10, output: 3, reasoning: 2, cacheRead: 20, cacheWrite: 5, total: 40 }, cost: 0 }],
});

describe('usage statistics across sources', () => {
  test('unions active days and recomputes the streak instead of adding them', () => {
    const result = mergeUsageStats([report('2026-10-17'), report('2026-10-17', 2), report('2026-10-18')], [], { to: 1000 });
    expect(result).toMatchObject({ sessions: 3, steps: 4, tokens: { total: 120 }, activeDays: 2, streak: 2,
      activity: [{ date: '2026-10-17', steps: 3, tokens: 80, tokensComplete: true }, { date: '2026-10-18', steps: 1, tokens: 40, tokensComplete: true }] });
    expect(result.activity.reduce((sum, day) => sum + (day.tokens ?? 0), 0)).toBe(result.tokens.total);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ steps: 4, tokens: { total: 120 } });
  });

  test('retains known values and missing coverage without mutating the sources', () => {
    const official = report('2026-10-18');
    const native = report('2026-10-18');
    native.coverage = { tokens: { known: 1, missing: 0 }, cost: { known: 0, missing: 1 }, reasoning: { known: 0, missing: 1 }, failedSessions: 0, undated: 0 };
    const before = JSON.stringify([official, native]);
    const result = mergeUsageStats([official, native], [{ source: 'deepseek', status: 'error' }], { to: 1000 });
    expect(coverageOf(result)).toMatchObject({ tokens: { known: 2, missing: 0 }, cost: { known: 1, missing: 1 } });
    expect(result.sources).toEqual([{ source: 'deepseek', status: 'error' }]);
    expect(result.activity[0]).toMatchObject({ tokens: 80, tokensComplete: false });
    expect(JSON.stringify([official, native])).toBe(before);
  });

  test('keeps partial daily totals and distinguishes unknown usage from recorded zero', () => {
    const known = report('2026-10-18');
    const unknown = report('2026-10-18');
    unknown.activity = [{ date: '2026-10-18', steps: 1, tokens: null, tokensComplete: false }];
    const zero = report('2026-10-19');
    zero.activity = [{ date: '2026-10-19', steps: 1, tokens: 0, tokensComplete: true }];
    const before = JSON.stringify([known, unknown, zero]);
    expect(mergeUsageStats([known, unknown, zero], [], { to: 1000 }).activity).toEqual([
      { date: '2026-10-18', steps: 2, tokens: 40, tokensComplete: false },
      { date: '2026-10-19', steps: 1, tokens: 0, tokensComplete: true },
    ]);
    expect(mergeUsageStats([unknown, known], [], { to: 1000 }).activity[0]).toMatchObject({ tokens: 40, tokensComplete: false });
    expect(mergeUsageStats([unknown, unknown], [], { to: 1000 }).activity[0]).toMatchObject({ tokens: null, tokensComplete: false });
    expect(JSON.stringify([known, unknown, zero])).toBe(before);
  });

  test('uses the requested window and handles a successful empty report', () => {
    const result = mergeUsageStats([], [], { from: 100, to: 200 });
    expect(result.range).toEqual({ from: 100, to: 200 });
    expect(result.tokens.total).toBe(0);
    expect(result.streak).toBe(0);
  });
});

const tools = (durationP50: number): UsageTools => ({ mode: 'detail', totals: { calls: 2, succeeded: 2, failed: 0, unfinished: 0 },
  usage: [{ name: 'bash', calls: 2, succeeded: 2, failed: 0, unfinished: 0, durationP50 }] });

test('tool totals are additive but source medians are not averaged', () => {
  expect(mergeUsageTools([tools(10)], [])).toMatchObject({ usage: [{ durationP50: 10 }] });
  expect(mergeUsageTools([tools(10), tools(100)], [])).toMatchObject({ totals: { calls: 4 }, usage: [{ calls: 4, durationP50: null }] });
});
