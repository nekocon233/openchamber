import { expect, test } from 'bun:test';
import { magpieQuotaPace } from './magpie';

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
