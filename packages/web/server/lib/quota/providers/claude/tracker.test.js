import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeQuotaTracker } from './tracker.js';

const INTERVAL = 5 * 60 * 1000;
const START = Date.parse('2026-10-19T08:00:00Z');
const PAYLOAD = { limits: [{ kind: 'session', percent: 12, resets_at: '2026-10-19T12:00:00Z' }] };
const CREDENTIAL = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', planLabel: 'max' };
let directory;
let file;
let credential;
let network;
let tracker;
const createTracker = () => createClaudeQuotaTracker({
  cacheScope: 'fixture',
  cacheFile: () => file,
  loadCredential: () => credential,
  fetchImpl: (...args) => network(...args),
});
const limited = (headers = {}) => new Response('{}', { status: 429, headers });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-claude-usage-'));
  file = path.join(directory, 'usage.json');
  credential = { ...CREDENTIAL };
  network = vi.fn(async () => Response.json(PAYLOAD));
  tracker = createTracker();
});
afterEach(() => {
  tracker.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('Claude usage request budget', () => {
  it('serves ten staggered refreshes within five minutes with one upstream request', async () => {
    const first = await tracker.fetchQuota();
    for (let i = 1; i < 10; i++) {
      vi.setSystemTime(START + i * 20_000);
      const cached = await tracker.fetchQuota();
      expect(cached.refresh.state).toBe('cached');
      expect(cached.refresh.sampledAt).toBe(first.refresh.sampledAt);
      expect(cached.usage).toEqual(first.usage);
    }
    expect(network).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + INTERVAL);
    await Promise.all(Array.from({ length: 20 }, () => tracker.fetchQuota()));
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('backs off for 5, 10, 20, 40 and 60 minutes and resets after success', async () => {
    network.mockImplementation(async () => limited());
    for (const minutes of [5, 10, 20, 40, 60, 60]) {
      const time = Date.now();
      const result = await tracker.fetchQuota();
      expect(result.ok).toBe(false);
      expect(result.refresh.nextAttemptAt - time).toBe(minutes * 60_000);
      const count = network.mock.calls.length;
      vi.setSystemTime(result.refresh.nextAttemptAt - 1);
      await tracker.fetchQuota();
      expect(network).toHaveBeenCalledTimes(count);
      vi.setSystemTime(result.refresh.nextAttemptAt);
    }
    network.mockImplementation(async () => Response.json(PAYLOAD));
    const good = await tracker.fetchQuota();
    vi.setSystemTime(good.refresh.nextAttemptAt);
    network.mockImplementation(async () => limited());
    const again = await tracker.fetchQuota();
    expect(again.refresh.nextAttemptAt - Date.now()).toBe(INTERVAL);
  });

  it.each(['7200', new Date(START + 7_200_000).toUTCString()])('does not shorten Retry-After %s', async value => {
    network.mockResolvedValue(limited({ 'retry-after': value }));
    const result = await tracker.fetchQuota();
    expect(result.refresh.nextAttemptAt).toBe(START + 7_200_000);
    vi.setSystemTime(START + 3_600_001);
    await tracker.fetchQuota();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'invalid', '-1', '0'])('uses the normal backoff for an unusable Retry-After %s', async value => {
    network.mockResolvedValue(limited({ 'retry-after': value }));
    expect((await tracker.fetchQuota()).refresh.nextAttemptAt).toBe(START + INTERVAL);
  });

  it('retains an old sample while reporting that the refresh was rate limited', async () => {
    const first = await tracker.fetchQuota();
    vi.setSystemTime(START + INTERVAL);
    network.mockResolvedValue(limited());
    const result = await tracker.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.usage).toEqual(first.usage);
    expect(result.refresh).toEqual({ state: 'rate-limited', sampledAt: START, nextAttemptAt: START + 2 * INTERVAL });
  });

  it('also bounds repeated requests after transport and malformed-response failures', async () => {
    network.mockRejectedValueOnce(new Error('fixture failure'));
    const failure = await tracker.fetchQuota();
    expect(failure.refresh.state).toBe('error');
    expect(failure.usage).toBeNull();
    await tracker.fetchQuota();
    expect(network).toHaveBeenCalledTimes(1);
    vi.setSystemTime(failure.refresh.nextAttemptAt);
    network.mockResolvedValue(Response.json({}));
    const malformed = await tracker.fetchQuota();
    expect(malformed.ok).toBe(false);
    expect(malformed.refresh.sampledAt).toBeNull();
  });

  it('bounds a stalled request including a stalled JSON body', async () => {
    network.mockImplementationOnce(() => new Promise(() => {}));
    const stalled = tracker.fetchQuota();
    await vi.advanceTimersByTimeAsync(15_000);
    const failure = await stalled;
    expect(failure.ok).toBe(false);
    expect(network.mock.calls[0][1].signal.aborted).toBe(true);
    vi.setSystemTime(failure.refresh.nextAttemptAt);
    network.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const body = tracker.fetchQuota();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await body).ok).toBe(false);
  });
});

describe('Claude usage restart and account isolation', () => {
  it('restores a successful sample and its original timestamp after restart', async () => {
    await tracker.fetchQuota();
    vi.setSystemTime(START + 60_000);
    tracker = createTracker();
    const restored = await tracker.fetchQuota();
    expect(network).toHaveBeenCalledTimes(1);
    expect(restored.refresh.sampledAt).toBe(START);
    expect(restored.refresh.state).toBe('cached');
    const serialized = fs.readFileSync(file, 'utf8');
    expect(serialized).not.toContain(CREDENTIAL.accessToken);
    expect(serialized).not.toContain(CREDENTIAL.refreshToken);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('restores a cooldown and its backoff level without any successful sample', async () => {
    network.mockImplementation(async () => limited());
    const first = await tracker.fetchQuota();
    tracker = createTracker();
    expect((await tracker.fetchQuota()).refresh).toEqual(first.refresh);
    expect(network).toHaveBeenCalledTimes(1);
    vi.setSystemTime(first.refresh.nextAttemptAt);
    const second = await tracker.fetchQuota();
    expect(second.refresh.nextAttemptAt - Date.now()).toBe(2 * INTERVAL);
  });

  it('persists the request interval before a request completes', async () => {
    let complete;
    network.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = tracker.fetchQuota();
    await Promise.resolve();
    const restarted = createTracker();
    expect((await restarted.fetchQuota()).refresh.nextAttemptAt).toBe(START + INTERVAL);
    expect(network).toHaveBeenCalledTimes(1);
    complete(Response.json(PAYLOAD));
    await pending;
  });

  it('does not transfer a cold-start cooldown to a different credential', async () => {
    network.mockResolvedValueOnce(limited());
    await tracker.fetchQuota();
    credential = { ...CREDENTIAL, accessToken: 'other-fixture', planLabel: 'pro' };
    const other = await tracker.fetchQuota();
    expect(other.ok).toBe(true);
    expect(other.planLabel).toBe('pro');
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('an older account request cannot overwrite the new account or its persisted sample', async () => {
    let complete;
    network.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const old = tracker.fetchQuota();
    await Promise.resolve();
    credential = { ...CREDENTIAL, accessToken: 'other-fixture', planLabel: 'pro' };
    const current = await tracker.fetchQuota();
    complete(Response.json({ limits: [{ kind: 'session', percent: 99 }] }));
    expect((await old).ok).toBe(false);
    tracker = createTracker();
    expect((await tracker.fetchQuota()).usage).toEqual(current.usage);
  });

  it.each([401, 403])('drops the cached usage on HTTP %i', async status => {
    await tracker.fetchQuota();
    vi.setSystemTime(START + INTERVAL);
    network.mockResolvedValue(new Response('{}', { status }));
    const result = await tracker.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).usage).toBeNull();
  });

  it('removes the persisted sample when the credential disappears', async () => {
    await tracker.fetchQuota();
    credential = null;
    expect((await tracker.fetchQuota()).configured).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('retains the last successful sample past 24 hours and keeps the server cooldown', async () => {
    await tracker.fetchQuota();
    vi.setSystemTime(START + INTERVAL);
    network.mockResolvedValue(limited({ 'retry-after': '172800' }));
    await tracker.fetchQuota();
    vi.setSystemTime(START + 86_400_001);
    tracker = createTracker();
    const result = await tracker.fetchQuota();
    expect(result.usage.windows['5h'].usedPercent).toBe(12);
    expect(result.refresh.sampledAt).toBe(START);
    expect(result.refresh.state).toBe('rate-limited');
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).usage).not.toBeNull();
  });

  it('ignores malformed cache data and reports a successful fresh read honestly', async () => {
    fs.writeFileSync(file, '{broken');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await tracker.fetchQuota()).ok).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('keeps its in-memory request budget when writing the cache fails', async () => {
    fs.writeFileSync(path.join(directory, 'blocked'), 'fixture');
    file = path.join(directory, 'blocked', 'usage.json');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tracker.fetchQuota();
    await tracker.fetchQuota();
    expect(network).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe('Claude cache-only reads', () => {
  it('reports a local cache read failure without falling back to Anthropic', async () => {
    fs.writeFileSync(path.join(directory, 'blocked'), 'fixture');
    file = path.join(directory, 'blocked', 'usage.json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(tracker.readCachedQuota()).rejects.toThrow('Could not read saved Claude usage');
    expect(network).not.toHaveBeenCalled();
  });

  it('returns a cache miss without querying Anthropic or creating a snapshot', async () => {
    expect(await tracker.readCachedQuota()).toBeNull();
    expect(network).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('restores the last successful sample after restart even when the query interval expired days ago', async () => {
    const first = await tracker.fetchQuota();
    vi.setSystemTime(START + 3 * 86_400_000);
    tracker = createTracker();
    const saved = await tracker.readCachedQuota();
    expect(saved.usage).toEqual(first.usage);
    expect(saved.refresh.sampledAt).toBe(START);
    expect(saved.refresh.state).toBe('cached');
    expect(saved.ok).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('reads the successful sample without presenting an old error or resetting its cooldown', async () => {
    const first = await tracker.fetchQuota();
    vi.setSystemTime(START + INTERVAL);
    network.mockResolvedValue(limited());
    const failure = await tracker.fetchQuota();
    tracker = createTracker();
    const saved = await tracker.readCachedQuota();
    expect(saved.ok).toBe(true);
    expect(saved.error).toBeUndefined();
    expect(saved.usage).toEqual(first.usage);
    expect(saved.refresh.nextAttemptAt).toBe(failure.refresh.nextAttemptAt);
    expect((await tracker.fetchQuota()).ok).toBe(false);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('does not show a previous credential or query for the new one', async () => {
    await tracker.fetchQuota();
    credential = { ...CREDENTIAL, accessToken: 'changed-fixture-credential' };
    expect(await tracker.readCachedQuota()).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('serves the previous sample while a manual upstream refresh is still pending', async () => {
    await tracker.fetchQuota();
    vi.setSystemTime(START + INTERVAL);
    let complete;
    network.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = tracker.fetchQuota();
    const saved = await tracker.readCachedQuota();
    expect(saved.usage.windows['5h'].usedPercent).toBe(12);
    expect(network).toHaveBeenCalledTimes(2);
    complete(Response.json({ limits: [{ kind: 'session', percent: 25 }] }));
    expect((await pending).usage.windows['5h'].usedPercent).toBe(25);
  });
});
