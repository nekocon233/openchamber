import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerNativeAgentRoutes } from './routes.js';
import { createStatisticsAccumulator, createStatisticsLimiter, readNativeStatistics, statisticsQuery } from './stats.js';

const at = (day) => Date.parse(`2026-10-${day}T12:00:00Z`);
const query = { from: at('12'), to: at('20'), timezone: 'Asia/Taipei', tools: 'none' };
const session = (id, parentID) => ({ id, parentID, directory: '/work/project', time: { updated: 1 } });
const user = (id, time = at('18'), synthetic = false) => ({ info: { id, role: 'user', time: { created: time } }, parts: [{ type: 'text', synthetic }] });
const assistant = (id, time = at('18'), extra = {}, parts = []) => ({ info: { id, role: 'assistant', time: { created: time }, providerID: 'codex-native', modelID: 'model', ...extra }, parts });
const usage = { total: 1, input: 10, output: 3, reasoning: 2, cache: { read: 20, write: 5 } };

describe('native statistics accounting', () => {
  it('counts retained messages once, separates children and preserves unknown metrics', () => {
    const aggregate = createStatisticsAccumulator(query);
    const root = session('root');
    const records = [user('u'), user('context', at('18'), true), assistant('a', at('18'), { tokens: usage }), assistant('a', at('18'), { tokens: usage }), assistant('summary', at('18'), { summary: true }),
      { info: { id: 'compaction', role: 'compaction', time: { created: at('18') }, summary: 'retained context' }, parts: [] }];
    aggregate.add(root, { records, reasoningKnown: false });
    aggregate.add(session('child', 'root'), { records: [assistant('b')] });
    const result = aggregate.result();
    expect(result).toMatchObject({ sessions: 1, subagents: 1, prompts: 1, steps: 2, tokens: { total: 40 }, cost: 0,
      coverage: { tokens: { known: 1, missing: 1 }, cost: { known: 0, missing: 2 }, reasoning: { known: 0, missing: 2 }, failedSessions: 0 } });
    expect(result.activity).toEqual([{ date: '2026-10-18', steps: 2, tokens: 40, tokensComplete: false }]);
  });

  it('uses inclusive start, exclusive end and the viewer timezone', () => {
    const start = Date.parse('2026-10-18T16:00:00Z');
    const aggregate = createStatisticsAccumulator({ ...query, from: start, to: start + 86_400_000 });
    aggregate.add(session('root'), { records: [assistant('before', start - 1), assistant('in', start), assistant('after', start + 86_400_000)] });
    expect(aggregate.result()).toMatchObject({ steps: 1, activity: [{ date: '2026-10-19', steps: 1 }] });
  });

  it('buckets complete, zero and unknown token usage without changing activity counts', () => {
    const aggregate = createStatisticsAccumulator(query);
    aggregate.add(session('root'), { records: [
      assistant('known', at('17'), { tokens: usage }),
      assistant('zero', at('18'), { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      assistant('missing', at('19')),
    ] });
    const result = aggregate.result();
    expect(result.activity).toEqual([
      { date: '2026-10-17', steps: 1, tokens: 40, tokensComplete: true },
      { date: '2026-10-18', steps: 1, tokens: 0, tokensComplete: true },
      { date: '2026-10-19', steps: 1, tokens: null, tokensComplete: false },
    ]);
    expect(result.tokens.total).toBe(40);
    expect(result.activeDays).toBe(3);
    expect(result.streak).toBe(3);
  });

  it('does not invent dates for undated history', () => {
    const bounded = createStatisticsAccumulator(query);
    bounded.add(session('root'), { records: [assistant('a', 0)] });
    expect(bounded.result()).toMatchObject({ steps: 0, coverage: { undated: 1 }, activity: [] });
    const all = createStatisticsAccumulator({ ...query, from: undefined });
    all.add(session('root'), { records: [assistant('a', 0)] });
    expect(all.result()).toMatchObject({ steps: 1, coverage: { undated: 1 }, activity: [] });
  });

  it('counts tool calls only on request, deduplicates calls and computes a source median', () => {
    const tool = (id, end) => ({ type: 'tool', callID: id, tool: 'bash', state: { status: 'completed', time: { start: 10, end } } });
    const snapshot = { records: [assistant('a', at('18'), {}, [tool('one', 20), tool('one', 20), tool('two', 40)])] };
    const summary = createStatisticsAccumulator(query);
    summary.add(session('root'), snapshot);
    expect(summary.result().tools).toEqual({ mode: 'none' });
    const detail = createStatisticsAccumulator({ ...query, tools: 'detail' });
    detail.add(session('root'), snapshot);
    expect(detail.result().tools).toMatchObject({ mode: 'detail', totals: { calls: 2, succeeded: 2 }, usage: [{ name: 'bash', durationP50: 20 }] });
  });

  it('retains other sessions and backends when one history or source fails', async () => {
    const child = session('child', 'root');
    const result = await readNativeStatistics({ query, backends: {
      claude: { listStatisticsSessions: async () => [session('root'), session('bad')], loadStatistics: async (id) => {
        if (id === 'bad') throw new Error('unreadable');
        return { records: [assistant(id)], childSessions: id === 'root' ? [child, child] : [] };
      } },
      codex: { listStatisticsSessions: async () => { throw new Error('offline'); } },
    } });
    expect(result.backends.claude).toMatchObject({ status: 'partial', stats: { sessions: 1, subagents: 1, steps: 2, coverage: { failedSessions: 1 } } });
    expect(result.backends.codex.status).toBe('error');
  });

  it('uses exact project boundaries and includes its supplied worktrees', async () => {
    const result = await readNativeStatistics({ query: { ...query, directory: '/work/project' }, scopeDirectories: ['/work/project', '/trees/feature'], backends: {
      claude: { listStatisticsSessions: async () => [
        session('root'), { ...session('sub'), directory: '/work/project/src' },
        { ...session('other'), directory: '/work/project-other' }, { ...session('tree'), directory: '/trees/feature' },
      ], loadStatistics: async (id) => ({ records: [assistant(id)] }) },
    } });
    expect(result.backends.claude.stats.steps).toBe(3);
  });

  it('returns completed histories when another history times out', async () => {
    const result = await readNativeStatistics({ query, sourceTimeoutMs: 20, backends: {
      claude: { listStatisticsSessions: async () => [session('good'), session('stalled')],
        loadStatistics: async (id) => id === 'good' ? { records: [assistant('a')] } : new Promise(() => {}),
      },
      codex: { listStatisticsSessions: async () => [], loadStatistics: async () => ({ records: [] }) },
    } });
    expect(result.backends.claude).toMatchObject({ status: 'partial', stats: { steps: 1, coverage: { failedSessions: 1 } } });
    expect(result.backends.codex.status).toBe('ok');
  });

  it('limits all source reads to four and cancels queued work', async () => {
    const limit = createStatisticsLimiter();
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 20 }, () => limit(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1;
    })));
    expect(peak).toBe(4);
    const controller = new AbortController(); controller.abort();
    await expect(limit(() => { throw new Error('must not run'); }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects invalid ranges and timezones at the route boundary', async () => {
    expect(statisticsQuery.safeParse({ ...query, from: query.to }).success).toBe(false);
    expect(statisticsQuery.safeParse({ ...query, timezone: 'invalid' }).success).toBe(false);
    const app = express();
    registerNativeAgentRoutes(app, { runtime: { statistics: async (parsed) => ({ requested: parsed }) } });
    expect((await request(app).get('/api/native/stats').query({ ...query, timezone: 'invalid' })).status).toBe(400);
    const response = await request(app).get('/api/native/stats').query(query);
    expect(response.status).toBe(200);
    expect(response.body.requested).toEqual(query);
  });
});
