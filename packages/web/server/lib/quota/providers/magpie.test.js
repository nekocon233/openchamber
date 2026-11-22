import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMagpieQuotaReader } from './magpie.js';

const directories = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const setup = async (cards = [], port = 3425, history = []) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-quota-'));
  directories.push(configDir);
  await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ port }));
  const fetchImpl = vi.fn(async url => Response.json({
    object: 'list',
    data: new URL(url).pathname.endsWith('/history') ? history : cards,
  }));
  return { configDir, fetchImpl, read: createMagpieQuotaReader({ configDir, fetchImpl }) };
};
const card = (extra = {}) => ({ provider: 'custom', name: 'Custom vendor', kind: 'plan', windows: [], ...extra });

describe('Magpie allowance boundary', () => {
  it('reads saved allowance and history data through the configured loopback gateway', async () => {
    const { read, fetchImpl } = await setup([
      card({ user: 'one', windows: [{ name: '5 hours', used: 20, remaining: 80 }, { name: '7 days', used: 75, remaining: 25, resetsAt: '2026-12-01T00:00:00Z' }] }),
      card({ user: 'two', windows: [{ name: 'credits', amount: 5, limit: 25, unit: 'credits', used: 20 }] }),
      card({ provider: 'wallet', kind: 'balance', balance: '¥0.00' }),
    ], 4444);
    const result = await read();
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['http://127.0.0.1:4444/v1/magpie/quotas?kept=1', 'GET'],
      ['http://127.0.0.1:4444/v1/magpie/quotas/history?days=45', 'GET'],
    ]);
    expect(result).toMatchObject({ providerId: 'magpie', ok: true, configured: true });
    const accounts = result.usage.accounts;
    expect(accounts).toHaveLength(3);
    expect(new Set(accounts.map(a => a.id)).size).toBe(3);
    expect(accounts[0].windows['5 hours'].remainingPercent).toBe(80);
    expect(accounts[0].windows['7 days'].resetAt).toBe(Date.parse('2026-12-01T00:00:00Z'));
    expect(accounts[1].windows.credits.value).toEqual({ kind: 'remaining', amount: 20, used: 5, unit: 'credits' });
    expect(accounts[2].windows.credits_balance.valueLabel).toBe('¥0.00');
  });

  it('joins each pool to its own recorded cycle and keeps both ends when limiting the points', async () => {
    const start = '2026-11-21T10:00:00Z';
    const resetsAt = '2026-11-21T15:00:00Z';
    const readAt = '2026-11-21T13:00:00.126Z';
    const firstAt = Date.parse('2026-11-21T11:00:00Z');
    const points = Array.from({ length: 121 }, (_, index) => ({
      at: new Date(firstAt + index * 60_000).toISOString(), start, resetsAt, left: 100 - index * 0.5,
    }));
    const { read } = await setup([card({ user: 'SAMPLE', readAt, windows: [
      { name: '5 hours', pool: 'Gemini', remaining: 40, resetsAt: '2026-11-21T15:00:00.054Z' },
      { name: '5 hours', pool: 'Claude & GPT', remaining: 98, resetsAt },
    ] })], 3425, [{
      provider: 'custom', user: 'sample', lines: [
        { name: 'Gemini · 5 hours', points: [
          { at: '2026-11-21T09:59:00Z', start: '2026-11-21T05:00:00Z', resetsAt: start, left: 1 },
          ...points,
          { at: '2026-11-21T13:10:00Z', start, resetsAt, left: 38 },
        ] },
        { name: 'Claude & GPT · 5 hours', points: [{ at: '2026-11-21T12:00:00Z', start, resetsAt, left: 98 }] },
      ],
    }]);
    const { windows } = (await read()).usage.accounts[0];
    const gemini = windows['Gemini · 5 hours'].magpieTrend;
    expect(gemini).toMatchObject({ matchesSnapshot: true, cycle: { start: Date.parse(start), reset: Date.parse(resetsAt) } });
    expect(gemini.points).toHaveLength(96);
    expect(gemini.points[0]).toEqual({ at: firstAt, left: 100 });
    expect(gemini.points.at(-1)).toEqual({ at: Date.parse('2026-11-21T13:00:00Z'), left: 40 });
    expect(windows['Claude & GPT · 5 hours'].magpieTrend).toMatchObject({ matchesSnapshot: false, points: [{ left: 98 }] });
  });

  it('shows the readings after a refill with an unchanged deadline and omits the uncertain baseline', async () => {
    const start = '2026-11-21T10:00:00Z';
    const resetsAt = '2026-11-21T15:00:00Z';
    const readAt = '2026-11-21T13:15:00Z';
    const { read } = await setup([card({ user: 'sample', readAt, windows: [
      { name: '5 hours', remaining: 98, resetsAt },
    ] })], 3425, [{
      provider: 'custom', user: 'sample', lines: [{ name: '5 hours', points: [
        { at: '2026-11-21T12:59:00Z', start, resetsAt, left: 10 },
        { at: '2026-11-21T13:00:00Z', start, resetsAt, left: 100 },
        { at: readAt, start, resetsAt, left: 98 },
      ] }],
    }]);
    const trend = (await read()).usage.accounts[0].windows['5 hours'].magpieTrend;
    expect(trend.cycle).toBeUndefined();
    expect(trend.points.map(point => point.left)).toEqual([100, 98]);
  });

  it('keeps the allowance when its history stalls and omits history from snapshot-only reads', async () => {
    const { configDir } = await setup();
    let historySignal;
    const cards = [card({ windows: [{ name: '5 hours', used: 15 }] })];
    const fetchImpl = vi.fn(async (url, init) => {
      if (new URL(url).pathname.endsWith('/history')) {
        historySignal = init.signal;
        return new Response(new ReadableStream({ start() {} }));
      }
      return Response.json({ object: 'list', data: cards });
    });
    const read = createMagpieQuotaReader({ configDir, fetchImpl, timeoutMs: 5_000 });
    vi.useFakeTimers();
    const result = read();
    await vi.waitFor(() => expect(historySignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(750);
    expect(await result).toMatchObject({ ok: true, usage: { accounts: [{ windows: {
      '5 hours': { remainingPercent: 85, magpieTrend: null },
    } }] } });
    expect(historySignal.aborted).toBe(true);

    fetchImpl.mockClear();
    const snapshotOnly = await read({ history: false });
    expect(snapshotOnly.usage.accounts[0].windows['5 hours'].magpieTrend).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps unlimited, text and wallet windows distinct from percentages and shared balances', async () => {
    const { read } = await setup([card({ sharedBalance: 'other key', balance: '$12', windows: [
      { name: 'Unlimited', unlimited: true, used: 0, remaining: 100 },
      { name: 'Text', text: true, display: 'pending', used: 0 },
      { name: 'Wallet', balance: 0, unit: 'points', used: 0 },
      { name: 'Unknown' },
    ] })]);
    const account = (await read()).usage.accounts[0];
    expect(account.sharedBalance).toBe('other key');
    expect(account.windows.credits_balance).toBeUndefined();
    expect(Object.values(account.windows).every(w => w.remainingPercent === null)).toBe(true);
    expect(account.windows.Unlimited.value).toEqual({ kind: 'unlimited' });
    expect(account.windows.Text.valueLabel).toBe('pending');
    expect(account.windows.Wallet.value).toEqual({ kind: 'remaining', amount: 0, unit: 'points' });
  });

  it('preserves good accounts and good windows when another vendor returns an error or invalid data', async () => {
    const { read } = await setup([card({ windows: [{ name: 'weekly', used: 100 }, null] }), card({ provider: 'offline', error: 'vendor unavailable' }), null]);
    const result = await read();
    expect(result.ok).toBe(true);
    expect(result.usage.accounts[0].windows.weekly.remainingPercent).toBe(0);
    expect(result.usage.accounts.map(a => a.error)).toEqual(['MAGPIE_INVALID_RESPONSE', 'vendor unavailable', 'MAGPIE_INVALID_RESPONSE']);
  });

  it('keeps the representative shared wallet balance once even when it also carries sharedBalance', async () => {
    const { read } = await setup([
      card({ user: 'first key', sharedBalance: 'first key', balance: '$12.00' }),
      card({ user: 'other key', sharedBalance: 'first key', balance: '$12.00' }),
    ]);
    const [first, second] = (await read()).usage.accounts;
    expect(first.windows.credits_balance.valueLabel).toBe('$12.00');
    expect(first.sharedBalance).toBeUndefined();
    expect(second.windows.credits_balance).toBeUndefined();
    expect(second.sharedBalance).toBe('first key');
  });

  it('coalesces manual refreshes and cache reads made while a refresh is pending', async () => {
    const { configDir } = await setup();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init.method === 'POST') await pending;
      return Response.json({ object: 'list', data: [card()] });
    });
    const read = createMagpieQuotaReader({ configDir, fetchImpl });
    const first = read({ refresh: true });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const second = read({ refresh: true });
    const cached = read();
    finish();
    const results = await Promise.all([first, second, cached]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(fetchImpl.mock.calls.map(([url, init]) => [new URL(url).pathname, init.method])).toEqual([
      ['/v1/magpie/quotas/refresh', 'POST'], ['/v1/magpie/quotas', 'GET'], ['/v1/magpie/quotas/history', 'GET'],
    ]);
  });

  it.each([401, 403, 500])('reports HTTP %s as a failure, never an empty snapshot', async status => {
    const { configDir } = await setup();
    const read = createMagpieQuotaReader({ configDir, fetchImpl: async () => new Response('', { status }) });
    expect(await read()).toMatchObject({ ok: false, configured: true, usage: null,
      error: status === 500 ? 'MAGPIE_REQUEST_FAILED' : 'MAGPIE_FORBIDDEN' });
  });

  it('distinguishes empty cache, malformed payload, no installation, invalid settings and offline service', async () => {
    const { configDir, fetchImpl, read } = await setup();
    expect((await read()).usage.accounts).toEqual([]);
    fetchImpl.mockImplementation(async () => Response.json({ data: [] }));
    expect((await read()).error).toBe('MAGPIE_INVALID_RESPONSE');
    fetchImpl.mockImplementation(async () => { throw new Error('connect failed'); });
    expect((await read()).error).toBe('MAGPIE_UNAVAILABLE');
    await fs.writeFile(path.join(configDir, 'settings.json'), '{');
    expect((await read()).error).toBe('MAGPIE_SETTINGS_INVALID');
    await fs.rm(path.join(configDir, 'settings.json'));
    expect(await read()).toMatchObject({ configured: false, usage: null, error: 'MAGPIE_NOT_CONFIGURED' });
  });

  it('bounds a stuck response body and aborts its transport', async () => {
    const { configDir } = await setup();
    let signal;
    const read = createMagpieQuotaReader({ configDir, timeoutMs: 20, fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start() {} }));
    } });
    vi.useFakeTimers();
    const result = read();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ ok: false, error: 'MAGPIE_TIMEOUT', usage: null });
    expect(signal.aborted).toBe(true);
  });
});
