import { describe, expect, test } from 'bun:test';
import { startClaudeQuotaRefresh } from './claudeAutoRefresh';

type RefreshState = ReturnType<Parameters<typeof startClaudeQuotaRefresh>[0]['read']>;

const fixture = () => {
  let clock = 1_000;
  let nextId = 0;
  let listener: (() => void) | null = null;
  let count = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const state: RefreshState = {
    generation: 0, enabled: true, fetching: false,
    refresh: { state: 'cached', sampledAt: 1_000, nextAttemptAt: 301_000 },
  };
  let request = async () => {
    count++;
    state.refresh = { state: 'fresh', sampledAt: clock, nextAttemptAt: clock + 300_000 };
    listener?.();
    return true;
  };
  const stop = startClaudeQuotaRefresh({
    read: () => state,
    subscribe: next => { listener = next; return () => { listener = null; }; },
    refresh: () => request(),
    now: () => clock,
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimer: id => { timers.delete(id); },
  });
  return {
    state, timers, stop,
    emit: () => listener?.(),
    count: () => count,
    request: (next: () => Promise<boolean>) => { request = next; },
    advance: async (milliseconds: number) => {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) { timers.delete(id); timer.callback(); }
      }
      for (let index = 0; index < 5; index++) await Promise.resolve();
    },
  };
};

describe('Claude quota deadline scheduling', () => {
  test('one deadline serves repeated subscriptions and only fetches when due', async () => {
    const app = fixture();
    for (let index = 0; index < 20; index++) app.emit();
    expect(app.timers.size).toBe(1);
    await app.advance(299_999);
    expect(app.count()).toBe(0);
    await app.advance(1);
    expect(app.count()).toBe(1);
    expect(app.timers.size).toBe(1);
    app.stop();
  });

  test('the last consumer leaving cancels the deadline and subscription', async () => {
    const app = fixture();
    app.stop();
    app.emit();
    await app.advance(300_000);
    expect(app.timers.size).toBe(0);
    expect(app.count()).toBe(0);
  });

  test('an unknown or disabled provider never schedules a request', () => {
    const app = fixture();
    app.state.refresh = undefined;
    app.emit();
    expect(app.timers.size).toBe(0);
    app.state.enabled = false;
    app.state.refresh = { state: 'cached', sampledAt: 1_000, nextAttemptAt: 301_000 };
    app.emit();
    expect(app.timers.size).toBe(0);
    app.stop();
  });

  test('transport failures wait three minutes instead of spinning on an expired deadline', async () => {
    const app = fixture();
    let count = 0;
    app.request(async () => { count++; return false; });
    await app.advance(300_000);
    expect(count).toBe(1);
    await app.advance(179_999);
    expect(count).toBe(1);
    await app.advance(1);
    expect(count).toBe(2);
    app.stop();
  });

  test('an old runtime request completion does not replace the new runtime deadline', async () => {
    const app = fixture();
    let complete: ((value: boolean) => void) | undefined;
    app.request(() => new Promise(resolve => { complete = resolve; }));
    await app.advance(300_000);
    app.state.generation++;
    app.state.refresh = undefined;
    app.emit();
    complete?.(true);
    await app.advance(1);
    expect(app.timers.size).toBe(0);
    app.state.refresh = { state: 'rate-limited', sampledAt: null, nextAttemptAt: 999_000 };
    app.emit();
    expect([...app.timers.values()][0].at).toBe(999_000);
    app.stop();
  });

  test('long cooldowns recheck the clock without overflowing setTimeout', async () => {
    const app = fixture();
    app.state.refresh = { state: 'rate-limited', sampledAt: null, nextAttemptAt: 4_294_969_000 };
    app.emit();
    expect([...app.timers.values()][0].at).toBe(2_147_484_647);
    await app.advance(2_147_483_647);
    expect(app.count()).toBe(0);
    expect(app.timers.size).toBe(1);
    app.stop();
  });
});
