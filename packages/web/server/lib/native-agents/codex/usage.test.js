import { describe, expect, it } from 'vitest';
import { codexUsageNotification, createCodexUsage, observeCodexUsage } from './usage.js';

const counts = (input, cache, output, reasoning = 0) => ({
  inputTokens: input, cachedInputTokens: cache, cacheWriteInputTokens: 0,
  outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output,
});

describe('Codex response accounting', () => {
  it('accumulates cost buckets while retaining the last request window and separating reasoning', () => {
    const state = createCodexUsage();
    observeCodexUsage(state, 'turn', { total: counts(1000, 800, 100, 40), last: counts(1000, 800, 100, 40), modelContextWindow: 828400 });
    observeCodexUsage(state, 'turn', { total: counts(2200, 1800, 150, 60), last: counts(1200, 1000, 50, 20), modelContextWindow: 828400 });
    expect(state.segments.get('turn')).toEqual({
      tokens: { total: 1250, input: 400, output: 90, reasoning: 60, cache: { read: 1800, write: 0 } },
      contextWindow: 828400,
    });
  });

  it('ignores duplicated, stale and inconsistent usage and keeps steered segments separate', () => {
    const state = createCodexUsage();
    const first = { total: counts(1000, 800, 100), last: counts(1000, 800, 100) };
    expect(observeCodexUsage(state, 'turn', first)).toBe(true);
    expect(observeCodexUsage(state, 'turn', first)).toBe(false);
    expect(observeCodexUsage(state, 'turn', { total: counts(900, 700, 100), last: counts(900, 700, 100) })).toBe(false);
    observeCodexUsage(state, 'steer', { total: counts(2200, 1800, 150), last: counts(1200, 1000, 50) });
    expect(state.segments.get('turn').tokens.cache.read).toBe(800);
    expect(state.segments.get('steer').tokens).toEqual({ total: 1250, input: 200, output: 50, reasoning: 0, cache: { read: 1000, write: 0 } });
  });

  it('rejects malformed wire counters before they can mutate live state', () => {
    const frame = { threadId: 'thread', turnId: 'turn', tokenUsage: { total: counts(5, 8, 2), last: counts(5, 8, 2) } };
    expect(codexUsageNotification.safeParse(frame).success).toBe(false);
    frame.tokenUsage.total = counts(10, 8, 2, 3);
    expect(codexUsageNotification.safeParse(frame).success).toBe(false);
  });
});
