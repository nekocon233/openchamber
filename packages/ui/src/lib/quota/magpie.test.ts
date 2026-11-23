import { expect, test } from 'bun:test';
import { magpieDisplayPercent, magpieQuotaPace, magpieReferenceLeft, magpieWorkStatusTrend } from './magpie';

test('preserves small signed pace differences and exact equality', () => {
  const start = Date.parse('2026-11-21T10:00:00Z');
  const reset = start + 5 * 60 * 60_000;
  const at = start + (78 * 60 + 27) * 1_000;
  const pace = (left: number) => magpieQuotaPace({
    points: [{ at, left }], cycle: { start, reset }, matchesSnapshot: true,
  }, at);
  expect(pace(73.84)).toBe(0.01);
  expect(pace(73.85)).toBe(0);
  expect(pace(73.86)).toBe(-0.01);
});

test('five-hour windows have no Work Status trend', () => {
  const magpieTrend = {
    points: [{ at: 7_000, left: 92 }],
    matchesSnapshot: false,
  };
  expect(magpieWorkStatusTrend('session', { windowSeconds: 18_000, magpieTrend })).toBeUndefined();
  expect(magpieWorkStatusTrend('Gemini · 5 hours', { windowSeconds: null, magpieTrend })).toBeUndefined();
  expect(magpieWorkStatusTrend('Claude & GPT · 5 hours · 2', { windowSeconds: null, magpieTrend: null })).toBeUndefined();
  expect(magpieWorkStatusTrend('Gemini · 7 days', { windowSeconds: null, magpieTrend })).toBe(magpieTrend);
  expect(magpieWorkStatusTrend('7d', { windowSeconds: 604_800, magpieTrend: null })).toBeNull();
});

test('the recorded cycle identifies a five-hour chart with a custom name', () => {
  const magpieTrend = {
    cycle: { start: 1_000, reset: 1_000 + 18_000_000 },
    points: [{ at: 1_000, left: 100 }],
    matchesSnapshot: true,
  };
  expect(magpieWorkStatusTrend('Session limit', { windowSeconds: null, magpieTrend })).toBeUndefined();
  const historicalTrend = { ...magpieTrend, matchesSnapshot: false };
  expect(magpieWorkStatusTrend('Session limit', {
    windowSeconds: null,
    magpieTrend: historicalTrend,
  })).toBeUndefined();
  const weeklyTrend = { ...historicalTrend, cycle: { start: 1_000, reset: 1_000 + 604_800_000 } };
  expect(magpieWorkStatusTrend('Session limit', {
    windowSeconds: null,
    magpieTrend: weeklyTrend,
  })).toBe(weeklyTrend);
});

test('the displayed reference and sample share the selected quota mode', () => {
  const cycle = { start: 0, reset: 1_000 };
  const reference = magpieReferenceLeft(cycle, 300);
  expect([79, reference].map(left => magpieDisplayPercent(left, true))).toEqual([79, 70]);
  expect([79, reference].map(left => magpieDisplayPercent(left, false))).toEqual([21, 30]);
  expect([100, 0].map(left => magpieDisplayPercent(left, true))).toEqual([100, 0]);
  expect([100, 0].map(left => magpieDisplayPercent(left, false))).toEqual([0, 100]);
});
