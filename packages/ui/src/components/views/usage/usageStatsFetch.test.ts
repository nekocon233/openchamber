import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { getRegisteredRuntimeAPIs, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { nativeStatisticsSchema } from '@/lib/native-agents/stats-schemas';
import { opencodeClient } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { fetchCombinedUsageStats } from './usageStatsFetch';

const previousResolver = getRuntimeUrlResolver();
const previousAPIs = getRegisteredRuntimeAPIs();
const originalFetch = globalThis.fetch;
const query = { from: 1791820800000, to: 1792425600000, timezone: 'Asia/Taipei' };
const native = () => nativeStatisticsSchema.parse({ backends: Object.fromEntries(['claude', 'codex', 'deepseek'].map((backend) => [backend, {
  status: 'ok', stats: {
    range: { from: query.from, to: query.to }, sessions: 1, subagents: 0, prompts: 1, steps: 2,
    tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 }, cost: 0,
    coverage: { tokens: { known: 2, missing: 0 }, cost: { known: 0, missing: 2 }, reasoning: { known: 0, missing: 2 }, failedSessions: 0, undated: 0 },
    tools: { mode: 'none' }, activeDays: 1, streak: 1, activity: [{ date: '2026-10-18', steps: 2 }], models: [],
  },
}])) });
const official = { range: { from: query.from, to: query.to }, sessions: 0, subagents: 0, prompts: 0, steps: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
  tools: { mode: 'none' }, activeDays: 0, streak: 0, activity: [], models: [],
};

beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://stats.test' });
  opencodeClient.reconnectToRuntimeBaseUrl();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  registerRuntimeAPIs(previousAPIs);
  setRuntimeUrlResolver(previousResolver);
  opencodeClient.reconnectToRuntimeBaseUrl();
});

test('recent native activity appears when OpenCode has no activity, in one fixed window', async () => {
  const urls: URL[] = [];
  spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(new URL(input instanceof Request ? input.url : String(input)));
    return Response.json({ data: official });
  });
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ stats: async (request, options) => {
    expect(request).toEqual({ ...query, tools: 'none' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return native();
  } })));
  const result = await fetchCombinedUsageStats(query, new AbortController().signal);
  expect(result).toMatchObject({ sessions: 3, prompts: 3, steps: 6, activeDays: 1, coverage: { cost: { known: 0, missing: 6 } } });
  expect(urls).toHaveLength(1);
  expect(urls[0].searchParams.get('to')).toBe(String(query.to));
});

test('failed OpenCode project lookup preserves the native project result without an unfiltered read', async () => {
  const urls: URL[] = [];
  spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(new URL(input instanceof Request ? input.url : String(input)));
    return Response.json({ error: 'unavailable' }, { status: 502 });
  });
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ stats: async (request) => {
    expect(request.directory).toBe('/work/project');
    return native();
  } })));
  const result = await fetchCombinedUsageStats({ ...query, directory: '/work/project' }, new AbortController().signal);
  expect(result.steps).toBe(6);
  expect(result.sources?.find((source) => source.source === 'opencode')?.status).toBe('error');
  expect(urls.some((url) => url.pathname.endsWith('/experimental/session/stats'))).toBe(false);
});

test('a failed native endpoint preserves the official report and names missing sources', async () => {
  spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: { ...official, sessions: 2, prompts: 3, steps: 4 } }));
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ stats: async () => { throw new Error('offline'); } })));
  const result = await fetchCombinedUsageStats(query, new AbortController().signal);
  expect(result).toMatchObject({ sessions: 2, prompts: 3, steps: 4 });
  expect(result.sources?.filter((source) => source.status === 'error').map((source) => source.source)).toEqual(['claude', 'codex', 'deepseek']);
});

test('runtimes without native support do not request or fabricate native statistics', async () => {
  spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: official }));
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ supported: false, stats: async () => { throw new Error('must not run'); } })));
  const result = await fetchCombinedUsageStats(query, new AbortController().signal);
  expect(result.sources).toEqual([{ source: 'opencode', status: 'ok' }]);
});

test('an older native endpoint without daily tokens is readable and stays unknown', () => {
  expect(native().backends.claude).toMatchObject({ status: 'ok', stats: {
    tokens: { total: 12 }, activity: [{ date: '2026-10-18', steps: 2, tokens: null, tokensComplete: false }],
  } });
});
