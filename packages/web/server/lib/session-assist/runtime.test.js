import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-assist-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const { createSessionAssistRuntime } = await import('./runtime.js');

const SESSION_ID = 'ses_assist';
const DIRECTORY = '/workspace';
const messages = [
  {
    info: {
      id: 'msg_user',
      sessionID: SESSION_ID,
      role: 'user',
      time: { created: 10 },
    },
    parts: [{ type: 'text', text: '请修复登录失败时把列表清空的问题。' }],
  },
  {
    info: {
      id: 'msg_assistant',
      parentID: 'msg_user',
      sessionID: SESSION_ID,
      role: 'assistant',
      providerID: 'claude-code',
      modelID: 'haiku',
      time: { created: 20, completed: 30 },
    },
    parts: [{ type: 'text', text: '已保留旧列表，并补充了失败回归测试。' }],
  },
];

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(input?.url ?? input).pathname;

describe('session assist generation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fs.rmSync(path.join(TEMP_DATA_DIR, 'settings.json'), { force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('generates Chinese recap and suggestion together and merges them into fresh metadata', async () => {
    const requests = [];
    let sessionReads = 0;
    const fetchMock = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse({ ok: true });
      if (pathname === `/session/${SESSION_ID}`) {
        sessionReads += 1;
        return jsonResponse({
          id: SESSION_ID,
          directory: DIRECTORY,
          metadata: sessionReads === 1
            ? { openchamber: { marker: 'initial' } }
            : { concurrent: 'kept', openchamber: { goal: { id: 'goal_1' } } },
        });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"recap":"登录失败会保留旧列表。","suggestion":"再验证重连后列表能正确刷新。"}',
        providerID: 'claude-code',
        modelID: 'haiku',
      })),
    };
    const runtime = createSessionAssistRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      quietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    expect(service.generateSmallModelText).toHaveBeenCalledWith(expect.objectContaining({
      restrictToPreferredProvider: true,
      preferredProviderID: 'claude-code',
      preferredModelID: 'haiku',
    }));
    const generation = service.generateSmallModelText.mock.calls[0][0];
    expect(generation.prompt).toContain('请修复登录失败时把列表清空的问题。');
    expect(generation.system).toContain('Shape: {"recap": string, "suggestion": string}');

    const patch = requests.find((request) => (
      request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH'
    ));
    expect(patch).toBeDefined();
    const metadata = JSON.parse(patch.body).metadata;
    expect(metadata).toMatchObject({
      concurrent: 'kept',
      openchamber: {
        goal: { id: 'goal_1' },
        assist: {
          recap: '登录失败会保留旧列表。',
          suggestion: '再验证重连后列表能正确刷新。',
          forMessageID: 'msg_assistant',
          generatedAt: expect.any(Number),
        },
      },
    });
    runtime.stop();
  });

  it('re-arms a quiet idle cycle that expires while generation is in flight', async () => {
    let patchCount = 0;
    let resolveFirstGeneration;
    let resolveFirstPatch;
    const firstPatch = new Promise((resolve) => { resolveFirstPatch = resolve; });
    const fetchMock = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        patchCount += 1;
        if (patchCount === 1) resolveFirstPatch();
        return jsonResponse({ ok: true });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ id: SESSION_ID, directory: DIRECTORY, metadata: {} });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const generated = {
      text: '{"recap":"保留旧列表。","suggestion":"验证下一次刷新。"}',
      providerID: 'anthropic',
      modelID: 'haiku',
    };
    const service = {
      generateSmallModelText: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstGeneration = resolve; }))
        .mockResolvedValue(generated),
    };
    const runtime = createSessionAssistRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      quietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'busy' }, directory: DIRECTORY },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: '/workspace-next' },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    resolveFirstGeneration(generated);
    await firstPatch;
    await vi.advanceTimersByTimeAsync(0);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(9);
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.generateSmallModelText).toHaveBeenCalledTimes(2);
    expect(service.generateSmallModelText.mock.calls[1][0].directory).toBe('/workspace-next');
    runtime.stop();
  });
});

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});
