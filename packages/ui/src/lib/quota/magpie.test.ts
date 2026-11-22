import { expect, test } from 'bun:test';
import { magpieQuotaPace } from './magpie';

test('keeps the 10-point pace boundary inclusive in both directions', () => {
  const start = Date.parse('2026-11-21T10:00:00Z');
  const reset = start + 5 * 60 * 60_000;
  const at = start + (78 * 60 + 27) * 1_000;
  const pace = (left: number) => magpieQuotaPace({
    points: [{ at, left }], cycle: { start, reset }, matchesSnapshot: true,
  }, at);
  expect(pace(63.85)).toBe(10);
  expect(pace(83.85)).toBe(-10);
  expect(pace(63.86)).toBe(9.99);
  expect(pace(83.84)).toBe(-9.99);
});
