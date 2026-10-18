import { describe, expect, test } from 'bun:test';

import {
  averagePer,
  buildActivitySeries,
  cacheHitRate,
  costPerMillionTokens,
  isEmptyReport,
  isSameLocalDay,
  projectDisplayName,
  rangeStart,
  reasoningShare,
  tokenSegments,
  toolSuccessRate,
} from './usageStatsModel';

const local = (year: number, month: number, day: number, hour = 0) => new Date(year, month - 1, day, hour).getTime();

describe('rangeStart', () => {
  test('starts at local midnight and counts today as the first day', () => {
    const now = new Date(2026, 8, 23, 15, 30);
    expect(rangeStart('7d', now)).toBe(local(2026, 9, 17));
    expect(rangeStart('30d', now)).toBe(local(2026, 8, 25));
    expect(rangeStart('all', now)).toBeUndefined();
  });
});

describe('buildActivitySeries', () => {
  test('fills inactive days with zero bars across the whole range', () => {
    const series = buildActivitySeries({
      range: { from: local(2026, 9, 1), to: local(2026, 9, 4, 12) },
      activity: [{ date: '2026-09-02', steps: 5, tokens: 50, tokensComplete: true }, { date: '2026-09-04', steps: 2, tokens: 20, tokensComplete: true }],
    });
    expect(series.unit).toBe('day');
    expect(series.bars.map((bar) => [bar.start, bar.tokens])).toEqual([
      ['2026-09-01', 0],
      ['2026-09-02', 50],
      ['2026-09-03', 0],
      ['2026-09-04', 20],
    ]);
    expect(series.max).toBe(50);
  });

  test('treats the range end as exclusive', () => {
    const series = buildActivitySeries({ range: { from: local(2026, 9, 1), to: local(2026, 9, 3) }, activity: [] });
    expect(series.bars.map((bar) => bar.start)).toEqual(['2026-09-01', '2026-09-02']);
  });

  test('groups long ranges into weeks without losing token usage', () => {
    const series = buildActivitySeries({
      range: { from: local(2026, 1, 1), to: local(2026, 9, 1) },
      activity: [{ date: '2026-01-01', steps: 3, tokens: 30, tokensComplete: true }, { date: '2026-01-07', steps: 4, tokens: 40, tokensComplete: true }, { date: '2026-08-31', steps: 1, tokens: 10, tokensComplete: true }],
    });
    expect(series.unit).toBe('week');
    expect(series.bars[0]).toEqual({ start: '2026-01-01', end: '2026-01-07', steps: 7, tokens: 70, tokensComplete: true });
    expect(series.bars.reduce((sum, bar) => sum + (bar.tokens ?? 0), 0)).toBe(80);
    expect(series.bars[series.bars.length - 1].end).toBe('2026-08-31');
  });

  test('keeps unknown and partially known days distinct from inactive days', () => {
    const series = buildActivitySeries({
      range: { from: local(2026, 9, 1), to: local(2026, 9, 4) },
      activity: [
        { date: '2026-09-01', steps: 1, tokens: null, tokensComplete: false },
        { date: '2026-09-02', steps: 2, tokens: 40, tokensComplete: false },
      ],
    });
    expect(series.bars.map((bar) => [bar.tokens, bar.tokensComplete])).toEqual([[null, false], [40, false], [0, true]]);
    expect(series.partial).toBe(true);
  });

  test('does not fill source failures with authoritative zeros', () => {
    const series = buildActivitySeries({ range: { from: local(2026, 9, 1), to: local(2026, 9, 3) }, activity: [], sources: [{ source: 'codex', status: 'error' }] });
    expect(series.bars.map((bar) => bar.tokens)).toEqual([null, null]);
  });

  test('a week with only unknown activity stays unknown even with inactive days', () => {
    const series = buildActivitySeries({
      range: { from: local(2026, 1, 1), to: local(2026, 6, 1) },
      activity: [{ date: '2026-01-01', steps: 1, tokens: null, tokensComplete: false }],
    });
    expect(series.bars[0].tokens).toBeNull();
    expect(series.bars[1].tokens).toBe(0);
  });
});

test('a report with no prompts and no steps is empty', () => {
  expect(isEmptyReport({ prompts: 0, steps: 0 })).toBe(true);
  expect(isEmptyReport({ prompts: 1, steps: 0 })).toBe(false);
});

test('a project reads as its label, else its folder name', () => {
  expect(projectDisplayName({ label: ' Chamber ', path: '/code/openchamber' })).toBe('Chamber');
  expect(projectDisplayName({ path: '/code/openchamber/' })).toBe('openchamber');
  expect(projectDisplayName({ label: '', path: 'C:\\code\\app' })).toBe('app');
});

test('same local day compares calendar dates, not 24 hours', () => {
  expect(isSameLocalDay(local(2026, 9, 23, 0), local(2026, 9, 23, 23))).toBe(true);
  expect(isSameLocalDay(local(2026, 9, 22, 23), local(2026, 9, 23, 0))).toBe(false);
});

describe('cacheHitRate', () => {
  test('reads over everything that could have been a miss', () => {
    expect(cacheHitRate({ input: 10, cacheRead: 30, cacheWrite: 10 })).toEqual(0.6);
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitRate({ input: 5, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });
});

describe('averagePer', () => {
  test('divides only when there is something to divide by', () => {
    expect(averagePer(10, 4)).toEqual(2.5);
    expect(averagePer(10, 0)).toBeNull();
  });
});

describe('toolSuccessRate', () => {
  test('succeeded over completed calls, unfinished excluded', () => {
    expect(toolSuccessRate({ succeeded: 3, failed: 1 })).toEqual(0.75);
    expect(toolSuccessRate({ succeeded: 0, failed: 0 })).toBeNull();
  });
});

describe('costPerMillionTokens', () => {
  test('scales spend to a million tokens', () => {
    expect(costPerMillionTokens(2, 1_000_000)).toEqual(2);
    expect(costPerMillionTokens(1, 250_000)).toEqual(4);
    expect(costPerMillionTokens(3, 0)).toBeNull();
  });
});

describe('reasoningShare', () => {
  test('reasoning over everything the model produced', () => {
    expect(reasoningShare({ output: 30, reasoning: 10 })).toEqual(0.25);
    expect(reasoningShare({ output: 0, reasoning: 5 })).toEqual(1);
    expect(reasoningShare({ output: 0, reasoning: 0 })).toBeNull();
  });
});

describe('tokenSegments', () => {
  test('fixed order with reasoning folded into output, zeros kept for the legend', () => {
    const segments = tokenSegments({ input: 10, output: 2, reasoning: 3, cacheRead: 30, cacheWrite: 5, total: 50 });
    expect(segments).toEqual([
      { key: 'input', value: 10 },
      { key: 'output', value: 5 },
      { key: 'cacheRead', value: 30 },
      { key: 'cacheWrite', value: 5 },
    ]);
    expect(tokenSegments({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }).map((segment) => segment.key)).toEqual([
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
    ]);
  });
});
