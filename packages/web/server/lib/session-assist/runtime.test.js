import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionAssistRuntime } from './runtime.js';

const resources = [];
const message = (id, role, text, extra = {}) => ({
  info: { id, role, parentID: 'user', finish: 'stop', time: { completed: 1 }, providerID: 'test-provider', modelID: 'test-model', ...extra },
  parts: [{ type: 'text', text }],
});
const output = (recap = 'Зміни готові', suggestion = '') => ({ text: JSON.stringify({ recap, suggestion }), providerID: 'test-provider', modelID: 'test-model' });
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

async function fixture(generate = async () => output()) {
  const state = {
    messages: [message('user', 'user', 'Виправ помилку'), message('answer', 'assistant', 'Виправлено')],
    session: { id: 'session', directory: '/project', time: {}, metadata: { external: 'keep', openchamber: { note: 'keep' } } },
    targets: { recap: true, suggestion: true },
    gets: 0, failFresh: false, patches: [], requests: [], calls: [],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    state.requests.push({ method: request.method, directory: url.searchParams.get('directory'), limit: url.searchParams.get('limit'), auth: request.headers['x-test-auth'] });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'PATCH') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      state.patches.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end(JSON.stringify(state.session));
    } else if (url.pathname.endsWith('/message')) {
      response.end(JSON.stringify(url.searchParams.get('limit') === '1' ? state.messages.slice(-1) : state.messages));
    } else {
      state.gets++;
      response.statusCode = state.failFresh && state.gets > 1 ? 500 : 200;
      response.end(JSON.stringify(state.session));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  state.base = base;
  const runtime = createSessionAssistRuntime({
    buildOpenCodeUrl: (route) => state.base + route,
    getOpenCodeAuthHeaders: () => ({ 'x-test-auth': 'fixture' }),
    getTargets: () => state.targets,
    getSmallModelService: async () => ({
      describeSmallModel: async () => ({ inputCharBudget: 64_000 }),
      generateSmallModelText: async (args) => { state.calls.push(args); return generate(args, state); },
    }),
  });
  resources.push({ runtime, server });
  const status = (type) => runtime.processPayload({ type: 'session.status', properties: { sessionID: 'session', status: { type } } }, '/project');
  return { state, runtime, status };
}

afterEach(async () => {
  for (const { runtime, server } of resources.splice(0)) {
    runtime.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  vi.restoreAllMocks();
});

describe('session assist runtime', () => {
  it('generates after a successful turn without a quiet wait and coalesces idle events in the same tick', async () => {
    const { state, status } = await fixture(async () => output('Changes ready', 'Run the tests'));
    status('idle');
    status('idle');
    status('idle');
    expect(state.calls).toHaveLength(0);
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.calls).toHaveLength(1);
    expect(state.patches[0].metadata.openchamber.assist).toMatchObject({
      suggestion: 'Run the tests', forMessageID: 'answer',
    });
  });

  it.each(['busy', 'retry', 'user', 'stop'])('cancels scheduled work before reading when %s follows idle in the same tick', async (activity) => {
    const { state, runtime, status } = await fixture();
    status('idle');
    if (activity === 'stop') runtime.stop();
    else if (activity === 'user') runtime.processPayload({ type: 'message.updated', properties: {
      info: { id: 'next-user', sessionID: 'session', role: 'user', time: { created: Date.now() } },
    } });
    else status(activity);
    await pause();
    expect(state.requests).toHaveLength(0);
    expect(state.calls).toHaveLength(0);
    expect(state.patches).toHaveLength(0);
  });

  it.each([
    { reason: 'unfinished', extra: { time: { created: 1 } } },
    { reason: 'aborted', extra: { error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } },
    { reason: 'failed', extra: { error: { name: 'UnknownError', data: { message: 'Turn failed' } } } },
  ])('does not generate for an $reason answer when the session becomes idle', async ({ extra }) => {
    const { state, status } = await fixture();
    state.messages[1] = message('answer', 'assistant', 'Partial answer', extra);
    status('idle');
    await vi.waitFor(() => expect(state.requests.some((request) => request.limit === '50')).toBe(true));
    await pause();
    expect(state.calls).toHaveLength(0);
    expect(state.patches).toHaveLength(0);
  });

  it('uses bounded authenticated SDK reads and preserves metadata with an empty suggestion', async () => {
    const { state, status } = await fixture(async (_args, current) => {
      current.session.metadata.openchamber.concurrent = 'new';
      return output();
    });
    status('idle');
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.requests.every((r) => r.directory === '/project' && r.auth === 'fixture')).toBe(true);
    expect(state.requests.filter((r) => r.limit).map((r) => r.limit)).toEqual(['50', '1']);
    expect(state.calls[0]).toMatchObject({ restrictToPreferredProvider: true, onOverflow: 'error', preferredProviderID: 'test-provider', preferredModelID: 'test-model', sessionID: 'session' });
    expect(state.patches[0].metadata).toMatchObject({ external: 'keep', openchamber: {
      note: 'keep', concurrent: 'new', assist: { recap: 'Зміни готові', suggestion: '', forMessageID: 'answer' },
    } });
  });

  it('does no work with both settings off and skips child, archived, or reverted sessions', async () => {
    const { state, status } = await fixture();
    state.targets = { recap: false, suggestion: false };
    status('idle');
    await pause();
    expect(state.requests).toHaveLength(0);
    state.targets.recap = true;
    state.session.parentID = 'parent';
    status('idle');
    await vi.waitFor(() => expect(state.gets).toBe(1));
    delete state.session.parentID;
    state.session.revert = { messageID: 'user' };
    status('idle');
    await vi.waitFor(() => expect(state.gets).toBe(2));
    delete state.session.revert;
    state.session.time.archived = 1;
    status('idle');
    await vi.waitFor(() => expect(state.gets).toBe(3));
    expect(state.calls).toHaveLength(0);
  });

  it('keeps recent context for recap-only and performs no write for an empty suggestion-only result', async () => {
    const { state, status } = await fixture();
    state.targets.suggestion = false;
    state.messages.unshift(message('previous-user', 'user', 'Попередня задача'), message('previous-answer', 'assistant', 'Зміст зробленого', { parentID: 'previous-user' }));
    status('idle');
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.calls[0].prompt).toContain('Зміст зробленого');
    expect(state.calls[0].system).not.toContain('suggestion');
    state.targets = { recap: false, suggestion: true };
    status('idle');
    await vi.waitFor(() => expect(state.calls).toHaveLength(2));
    await pause();
    expect(state.patches).toHaveLength(1);
  });

  it('does not write a stale result when the tail moves during generation', async () => {
    const { state, status } = await fixture(async (_args, current) => {
      current.messages.push(message('new-user', 'user', 'Нова задача'));
      return output();
    });
    status('idle');
    await vi.waitFor(() => expect(state.requests.some((r) => r.limit === '1')).toBe(true));
    await pause();
    expect(state.patches).toHaveLength(0);
  });

  it('does not fall back to stale metadata when the fresh read fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, status } = await fixture();
    state.failFresh = true;
    status('idle');
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(state.gets).toBe(2);
    expect(state.patches).toHaveLength(0);
  });

  it('cancels old work and retains an expired newer idle timer until it can run', async () => {
    const releases = [];
    const { state, status } = await fixture(() => new Promise((resolve) => releases.push(resolve)));
    status('idle');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    status('busy');
    expect(state.calls[0].signal.aborted).toBe(true);
    state.messages.push(message('next-user', 'user', 'Далі'), message('next-answer', 'assistant', 'Готово', { parentID: 'next-user' }));
    status('idle');
    await pause();
    releases[0](output('Старий результат'));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(state.patches).toHaveLength(0);
    releases[1](output('Новий результат'));
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.patches[0].metadata.openchamber.assist).toMatchObject({ recap: 'Новий результат', forMessageID: 'next-answer' });
  });

  it('aborts on stop and honors settings switched off during generation', async () => {
    let release;
    const { state, runtime, status } = await fixture(() => new Promise((resolve) => { release = resolve; }));
    status('idle');
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    runtime.stop();
    expect(state.calls[0].signal.aborted).toBe(true);
    release(output());
    await pause();
    expect(state.patches).toHaveLength(0);
    const second = await fixture(async (_args, current) => {
      current.targets = { recap: false, suggestion: false };
      return output();
    });
    second.status('idle');
    await vi.waitFor(() => expect(second.state.gets).toBe(2));
    await pause();
    expect(second.state.patches).toHaveLength(0);
  });

  it('ignores historical user updates but cancels a new request during generation', async () => {
    let release;
    const { state, runtime, status } = await fixture(() => new Promise((resolve) => { release = resolve; }));
    status('idle');
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    const userUpdate = (created) => runtime.processPayload({ type: 'message.updated', properties: {
      info: { id: 'user', sessionID: 'session', role: 'user', time: { created } },
    } });
    userUpdate(1);
    expect(state.calls[0].signal.aborted).toBe(false);
    userUpdate(Date.now());
    expect(state.calls[0].signal.aborted).toBe(true);
    release(output());
    await pause();
    expect(state.patches).toHaveLength(0);
  });

  it('rejects endpoint changes before writing instead of carrying a session into a new runtime', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, status } = await fixture(async (_args, current) => {
      current.base = 'http://unreachable.invalid';
      return output();
    });
    status('idle');
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(state.patches).toHaveLength(0);
    expect(state.gets).toBe(1);
  });
});

describe('session assist generation', () => {
  it('generates Chinese recap and suggestion together and merges them into fresh metadata', async () => {
    const { state, status } = await fixture(async (_args, current) => {
      current.session.metadata = { concurrent: 'kept', openchamber: { goal: { id: 'goal_1' } } };
      return output('登录失败会保留旧列表。', '再验证重连后列表能正确刷新。');
    });
    state.messages = [
      message('user', 'user', '请修复登录失败时把列表清空的问题。'),
      message('answer', 'assistant', '已保留旧列表，并补充了失败回归测试。'),
    ];
    status('idle');
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({
      restrictToPreferredProvider: true,
      preferredProviderID: 'test-provider',
      preferredModelID: 'test-model',
    });
    expect(state.calls[0].prompt).toContain('请修复登录失败时把列表清空的问题。');
    expect(state.calls[0].system).toContain('"recap"');
    expect(state.calls[0].system).toContain('"suggestion"');
    expect(state.patches[0].metadata).toMatchObject({
      concurrent: 'kept',
      openchamber: {
        goal: { id: 'goal_1' },
        assist: {
          recap: '登录失败会保留旧列表。',
          suggestion: '再验证重连后列表能正确刷新。',
          forMessageID: 'answer',
          generatedAt: expect.any(Number),
        },
      },
    });
  });

  it('retains an idle cycle that expires during generation and reruns with the latest directory', async () => {
    const releases = [];
    const { state, runtime, status } = await fixture(() => new Promise((resolve) => releases.push(resolve)));
    status('idle');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    status('busy');
    expect(state.calls[0].signal.aborted).toBe(true);
    state.messages.push(
      message('next-user', 'user', '下一个任务'),
      message('next-answer', 'assistant', '完成了', { parentID: 'next-user' }),
    );
    runtime.processPayload(
      { type: 'session.status', properties: { sessionID: 'session', status: { type: 'idle' } } },
      '/workspace-next',
    );
    await pause();
    releases[0](output('旧结果'));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(state.patches).toHaveLength(0);
    releases[1](output('新结果'));
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.calls[1].directory).toBe('/workspace-next');
    expect(state.patches[0].metadata.openchamber.assist).toMatchObject({ recap: '新结果', forMessageID: 'next-answer' });
  });
});

describe('session assist runtime for native CLI sessions', () => {
  it.each([
    { sessionId: 'ncl_s', providerID: 'claude-native' },
    { sessionId: 'ncx_s', providerID: 'codex-native' },
  ])('generates for $providerID without a quiet wait using native reads and metadata', async ({ sessionId, providerID }) => {
    const state = { reads: [], writes: [], openCodeUrls: 0 };
    const records = [message('user', 'user', 'Fix the build'), message('answer', 'assistant', 'Fixed it', { providerID })];
    const runtime = createSessionAssistRuntime({
      buildOpenCodeUrl: () => {
        state.openCodeUrls += 1;
        return 'http://127.0.0.1:9';
      },
      getOpenCodeAuthHeaders: () => ({}),
      getTargets: () => ({ recap: true, suggestion: true }),
      getSmallModelService: async () => ({
        describeSmallModel: async () => ({ inputCharBudget: 64_000 }),
        generateSmallModelText: async () => output('Build fixed', 'Run the tests'),
      }),
      nativeSessions: {
        isNativeSessionId: (id) => id === sessionId,
        getSession: async (sessionId) => ({ id: sessionId, directory: '/project', time: {} }),
        loadMessages: async (_sessionId, _directory, page) => {
          state.reads.push(page);
          return { records: page.limit === 1 ? records.slice(-1) : records, cursor: null, complete: true, childSessions: [] };
        },
        setSessionAssist: async (sessionId, directory, assist) => {
          state.writes.push({ sessionId, directory, assist });
        },
      },
    });
    try {
      runtime.processPayload({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } }, '/project');
      await vi.waitFor(() => expect(state.writes).toHaveLength(1));
      expect(state.writes[0]).toMatchObject({
        sessionId,
        directory: '/project',
        assist: { recap: 'Build fixed', suggestion: 'Run the tests', forMessageID: 'answer' },
      });
      expect(state.reads.map((page) => page.limit)).toEqual([50, 1]);
      expect(state.openCodeUrls).toBe(0);
    } finally {
      runtime.stop();
    }
  });
});
