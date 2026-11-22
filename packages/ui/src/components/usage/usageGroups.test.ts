import { expect, test } from 'bun:test';
import { isWorkStatusQuotaWindow } from './usageGroups';

test('Work Status hides five-hour quota windows across providers and Magpie pools', () => {
  expect(isWorkStatusQuotaWindow('session', { windowSeconds: 5 * 3600 })).toBe(false);
  expect(isWorkStatusQuotaWindow('5h', { windowSeconds: null })).toBe(false);
  expect(isWorkStatusQuotaWindow('Gemini · 5 hours', { windowSeconds: null })).toBe(false);
  expect(isWorkStatusQuotaWindow('Claude & GPT · 5 hours · 2', { windowSeconds: null })).toBe(false);
  expect(isWorkStatusQuotaWindow('Gemini · 7 days', { windowSeconds: null })).toBe(true);
  expect(isWorkStatusQuotaWindow('7d', { windowSeconds: 7 * 24 * 3600 })).toBe(true);
  expect(isWorkStatusQuotaWindow('credits_balance', { windowSeconds: null })).toBe(true);
});

test('a matched Magpie cycle identifies a five-hour window with a custom name', () => {
  const magpieTrend = {
    cycle: { start: 1_000, reset: 1_000 + 5 * 3_600_000 },
    points: [{ at: 1_000, left: 100 }],
    matchesSnapshot: true,
  };
  expect(isWorkStatusQuotaWindow('Session limit', { windowSeconds: null, magpieTrend })).toBe(false);
  expect(isWorkStatusQuotaWindow('Session limit', {
    windowSeconds: null, magpieTrend: { ...magpieTrend, matchesSnapshot: false },
  })).toBe(true);
});
