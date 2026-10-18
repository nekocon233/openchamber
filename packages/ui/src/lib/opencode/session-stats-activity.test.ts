import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from './client';
import { fetchUsageStats } from './session-stats';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../runtime-url';

const previous = getRuntimeUrlResolver();
const tokenUsage = (input: number) => ({ input, output: 2, reasoning: 1, cache: { read: 3, write: 4 } });
const wire = (from: number, to: number, activity = [{ date: '2026-10-13', steps: 2 }, { date: '2026-10-15', steps: 1 }]) => ({
  range: { from, to }, sessions: 1, subagents: 0, prompts: 1, steps: 3,
  tokens: { input: 30, output: 4, reasoning: 2, cache: { read: 6, write: 8 } }, cost: 1,
  tools: { mode: 'none' }, activeDays: activity.length, streak: 1, activity, models: [],
});
const from = Date.parse('2026-10-13T00:00:00+08:00');
const to = Date.parse('2026-10-16T00:00:00+08:00');

beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://daily-stats.test' });
  opencodeClient.reconnectToRuntimeBaseUrl();
});
afterEach(() => {
  setRuntimeUrlResolver(previous);
  opencodeClient.reconnectToRuntimeBaseUrl();
});

test('reads only active days, includes every token bucket and keeps query scope', async () => {
  const requests: URL[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    const start = Number(url.searchParams.get('from'));
    const end = Number(url.searchParams.get('to'));
    const report = wire(start, end);
    if (end - start < 86_400_001) report.tokens = tokenUsage(start === from + 2_000 ? 10 : 20);
    return Response.json({ data: report });
  });
  try {
    const report = await fetchUsageStats({ from: from + 2_000, to: to - 4_000, projectID: 'project-one', timezone: 'Asia/Taipei' });
    expect(requests).toHaveLength(3);
    expect(report.tokens.total).toBe(50);
    expect(report.activity.map((day) => [day.date, day.tokens, day.tokensComplete])).toEqual([
      ['2026-10-13', 20, true], ['2026-10-15', 30, true],
    ]);
    expect(requests.slice(1).map((url) => [Number(url.searchParams.get('from')), Number(url.searchParams.get('to'))])).toEqual([
      [from + 2_000, from + 86_400_000], [to - 86_400_000, to - 4_000],
    ]);
    expect(requests.every((url) => url.searchParams.get('project') === 'project-one' && url.searchParams.get('timezone') === 'Asia/Taipei' && url.searchParams.get('tools') === 'none')).toBe(true);
  } finally { fetch.mockRestore(); }
});

test('uses local calendar boundaries across 23-hour and 25-hour days', async () => {
  for (const [date, start, end] of [
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
  ]) {
    const dailyStart = Date.parse(start);
    const dailyEnd = Date.parse(end);
    const requests: URL[] = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url);
      return Response.json({ data: wire(dailyStart - 86_400_000, dailyEnd + 86_400_000, [{ date, steps: 1 }]) });
    });
    try {
      await fetchUsageStats({ from: dailyStart - 86_400_000, to: dailyEnd + 86_400_000, timezone: 'America/New_York' });
      expect(requests).toHaveLength(2);
      expect([Number(requests[1].searchParams.get('from')), Number(requests[1].searchParams.get('to'))]).toEqual([dailyStart, dailyEnd]);
    } finally { fetch.mockRestore(); }
  }
});

test('one failed day stays unknown without discarding summary or other days', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const start = Number(url.searchParams.get('from'));
    const end = Number(url.searchParams.get('to'));
    if (start === to - 86_400_000) return Response.json({ error: 'unavailable' }, { status: 503 });
    return Response.json({ data: { ...wire(start, end), tokens: end === to ? wire(from, to).tokens : tokenUsage(10) } });
  });
  try {
    const report = await fetchUsageStats({ from, to, timezone: 'Asia/Taipei' });
    expect(report.tokens.total).toBe(50);
    expect(report.activity.map((day) => [day.tokens, day.tokensComplete])).toEqual([[20, true], [null, false]]);
  } finally { fetch.mockRestore(); }
});

test('an empty report does not issue daily requests', async () => {
  let calls = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => { calls += 1; return Response.json({ data: wire(from, to, []) }); });
  try {
    await fetchUsageStats({ from, to, timezone: 'UTC' });
    expect(calls).toBe(1);
  } finally { fetch.mockRestore(); }
});

test('concurrent reports share a maximum of four daily reads', async () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const end = Date.parse('2026-10-10T00:00:00Z');
  const activity = Array.from({ length: 8 }, (_, index) => ({ date: `2026-10-0${index + 1}`, steps: 1 }));
  let active = 0;
  let peak = 0;
  let calls = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (Number(url.searchParams.get('to')) - Number(url.searchParams.get('from')) > 86_400_000) return Response.json({ data: wire(start, end, activity) });
    active += 1; calls += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return Response.json({ data: wire(start, end, activity) });
  });
  try {
    await Promise.all([fetchUsageStats({ from: start, to: end, timezone: 'UTC' }), fetchUsageStats({ from: start, to: end, timezone: 'UTC' })]);
    expect(peak).toBe(4);
    expect(calls).toBe(16);
  } finally { fetch.mockRestore(); }
});

test('the shared daily deadline returns unknown days while retaining the summary', async () => {
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 25_000 ? deadline.signal : originalTimeout(ms));
  let started = () => {};
  const allStarted = new Promise<void>((resolve) => { started = resolve; });
  let dailyCalls = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (Number(url.searchParams.get('to')) - Number(url.searchParams.get('from')) > 86_400_000) return Response.json({ data: wire(from, to) });
    dailyCalls += 1;
    if (dailyCalls === 2) started();
    const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  });
  try {
    const pending = fetchUsageStats({ from, to, timezone: 'Asia/Taipei' });
    await allStarted;
    deadline.abort();
    const report = await pending;
    expect(report.tokens.total).toBe(50);
    expect(report.activity.map((day) => day.tokens)).toEqual([null, null]);
  } finally { fetch.mockRestore(); timeout.mockRestore(); }
});

test('caller cancellation discards the report and removes queued daily reads', async () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const end = Date.parse('2026-10-10T00:00:00Z');
  const activity = Array.from({ length: 8 }, (_, index) => ({ date: `2026-10-0${index + 1}`, steps: 1 }));
  const controller = new AbortController();
  let started = () => {};
  const fourStarted = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (Number(url.searchParams.get('to')) - Number(url.searchParams.get('from')) > 86_400_000) return Response.json({ data: wire(start, end, activity) });
    calls += 1;
    if (calls === 4) started();
    const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  });
  try {
    const pending = Promise.all([
      fetchUsageStats({ from: start, to: end, timezone: 'UTC' }, controller.signal),
      fetchUsageStats({ from: start, to: end, timezone: 'UTC' }, controller.signal),
    ]);
    await fourStarted;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DOMException);
    expect(calls).toBe(4);
  } finally { fetch.mockRestore(); }
});
