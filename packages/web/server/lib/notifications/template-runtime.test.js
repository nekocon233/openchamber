import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  buildOpenCodeUrl: (path) => path,
  getOpenCodeAuthHeaders: () => ({}),
  resolveGitBinaryForSpawn: () => 'git',
});

describe('notification template runtime zen models', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns no selectable zen models after provider retirement', async () => {
    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models).toEqual([]);
  });

  it('preserves stored zen model value for compatibility without validation', async () => {
    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('trinity-large-preview-free');
  });
});

describe('notification template message extraction', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes reasoning parts from payload message text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'text', text: 'final answer' },
          ],
        },
      },
    })).toBe('final answer');
  });

  it('ignores untyped parts even when they contain text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { text: 'untyped text' },
            { content: 'untyped content' },
            { type: 'text', text: 'typed final answer' },
          ],
        },
      },
    })).toBe('typed final answer');
  });

  it('excludes reasoning parts when fetching assistant messages', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      {
        info: { id: 'msg-1', role: 'assistant', finish: 'stop' },
        parts: [
          { type: 'reasoning', text: 'private chain of thought' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ])));

    await expect(runtime.fetchLastAssistantMessageText(
      'session-1',
      'msg-1',
      undefined,
      'C:\\work\\project',
    )).resolves.toBe('final answer');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/session/session-1/message?limit=5&directory=C%3A%5Cwork%5Cproject',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('notification template native sessions', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const NATIVE_ID = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
  const createNativeRuntime = (calls) => createNotificationTemplateRuntime({
    readSettingsFromDisk: async () => ({}),
    persistSettings: vi.fn(async () => {}),
    buildOpenCodeUrl: (path) => path,
    getOpenCodeAuthHeaders: () => ({}),
    resolveGitBinaryForSpawn: () => 'git',
    nativeSessions: {
      isNativeSessionId: (sessionId) => sessionId.startsWith('ncl_'),
      getSession: async (sessionId, directory) => {
        calls.push(['session', sessionId, directory]);
        return { id: sessionId, title: 'Native work' };
      },
      loadMessages: async (sessionId, directory, page) => {
        calls.push(['messages', sessionId, directory, page]);
        return {
          records: [
            { info: { id: 'ncl_u_1', role: 'user' }, parts: [{ type: 'text', text: 'Do it' }] },
            { info: { id: 'ncl_a_1', role: 'assistant', finish: 'stop' }, parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Done it' }] },
          ],
        };
      },
    },
  });

  it('reads the title and last reply of a native session from the native runtime, never from OpenCode', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async () => {
      throw new Error('OpenCode must not be asked about a native session');
    });
    const runtime = createNativeRuntime(calls);

    expect(await runtime.fetchLastAssistantMessageText(NATIVE_ID, undefined, undefined, '/work/project')).toBe('Done it');
    const variables = await runtime.buildTemplateVariables({ properties: {} }, NATIVE_ID, '/work/project');
    expect(variables.session_name).toBe('Native work');
    expect(calls).toEqual([
      ['messages', NATIVE_ID, '/work/project', { limit: 5 }],
      ['session', NATIVE_ID, '/work/project'],
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await runtime.fetchLastAssistantMessageText(NATIVE_ID, undefined, undefined, undefined)).toBe('');
  });
});
