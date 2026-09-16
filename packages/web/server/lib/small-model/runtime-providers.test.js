import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ZEN_ANONYMOUS_API_KEY,
  configureOpenCodeRuntimeProviders,
  getRuntimeProvider,
  getRuntimeProviderSnapshot,
  getRuntimeProviderTransport,
  resetOpenCodeRuntimeProviders,
} from './runtime-providers.js';

const providerPayload = (overrides = {}) => ({
  all: [
    {
      id: 'llmapi',
      source: 'config',
      options: { apiKey: 'plugin-key', baseURL: 'https://api.llmapi.ai/v1/' },
      models: {
        'claude-opus-4-8': { api: { id: 'claude-opus-4-8', url: '', npm: '@ai-sdk/anthropic' } },
        'gpt-5.6-luna': { api: { id: 'gpt-5.6-luna', url: 'https://api.llmapi.ai/v1', npm: '@ai-sdk/openai' } },
      },
    },
    {
      id: 'opencode',
      source: 'custom',
      options: { apiKey: ZEN_ANONYMOUS_API_KEY },
      models: { 'free-model': { api: { id: 'free-model', url: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible' } } },
    },
    {
      id: 'zai-coding-plan',
      source: 'api',
      key: 'auth-json-key',
      options: {},
      models: { 'glm-5': { api: { id: 'glm-5', url: 'https://api.z.ai/api/coding/paas/v4', npm: '@ai-sdk/openai-compatible' } } },
    },
  ],
  connected: ['llmapi', 'opencode', 'zai-coding-plan'],
  ...overrides,
});

describe('OpenCode runtime provider snapshot', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify(providerPayload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    configureOpenCodeRuntimeProviders({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
    });
  });

  afterEach(() => {
    configureOpenCodeRuntimeProviders(null);
    resetOpenCodeRuntimeProviders();
    vi.unstubAllGlobals();
  });

  it('reports the credential and endpoint a plugin registered at runtime', async () => {
    const provider = await getRuntimeProvider('llmapi');

    expect(provider).toMatchObject({ apiKey: 'plugin-key', baseURL: 'https://api.llmapi.ai/v1' });
    expect(provider.models.get('gpt-5.6-luna')).toEqual({
      api: { url: 'https://api.llmapi.ai/v1', npm: '@ai-sdk/openai' },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4096/provider');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Basic test' });
  });

  it('refuses the zen sentinel as a credential', async () => {
    const provider = await getRuntimeProvider('opencode');

    expect(provider.apiKey).toBeNull();
    expect(provider.anonymousZen).toBe(true);
    // The endpoint is still reported; only the credential is withheld.
    expect(provider.baseURL).toBe('https://opencode.ai/zen/v1');
  });

  it('falls back to the model endpoint when the provider carries no baseURL', async () => {
    expect((await getRuntimeProvider('zai-coding-plan')).baseURL).toBe('https://api.z.ai/api/coding/paas/v4');
  });

  it('serves one snapshot to concurrent callers instead of refetching', async () => {
    await Promise.all([getRuntimeProvider('llmapi'), getRuntimeProvider('opencode'), getRuntimeProvider('zai-coding-plan')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('scopes snapshots by directory and sends the directory to OpenCode', async () => {
    fetchMock.mockImplementation(async (input) => {
      const directory = new URL(input).searchParams.get('directory');
      return new Response(JSON.stringify(providerPayload({
        all: [{
          id: 'llmapi',
          options: { apiKey: `${directory}-key`, baseURL: `https://${directory === '/one' ? 'one' : 'two'}.example/v1` },
          models: {},
        }],
        connected: ['llmapi'],
      })), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const [one, two] = await Promise.all([
      getRuntimeProvider('llmapi', '/one'),
      getRuntimeProvider('llmapi', '/two'),
    ]);

    expect(one).toMatchObject({ apiKey: '/one-key', baseURL: 'https://one.example/v1' });
    expect(two).toMatchObject({ apiKey: '/two-key', baseURL: 'https://two.example/v1' });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'http://127.0.0.1:4096/provider?directory=%2Fone',
      'http://127.0.0.1:4096/provider?directory=%2Ftwo',
    ]);

    await getRuntimeProvider('llmapi', '/one');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a transport only for a connected provider with a key and endpoint', async () => {
    const transport = await getRuntimeProviderTransport('llmapi', '/workspace');

    expect(transport).toEqual({
      providerID: 'llmapi',
      apiKey: 'plugin-key',
      baseURL: 'https://api.llmapi.ai/v1',
    });
    expect(Object.isFrozen(transport)).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4096/provider?directory=%2Fworkspace');
  });

  it('answers "unknown" rather than "no providers" when OpenCode is unreachable', async () => {
    resetOpenCodeRuntimeProviders();
    fetchMock.mockRejectedValue(new Error('connection refused'));

    expect(await getRuntimeProviderSnapshot()).toBeNull();
  });

  it('keeps the previous snapshot when a later refresh fails', async () => {
    await getRuntimeProviderSnapshot();
    fetchMock.mockRejectedValue(new Error('connection refused'));

    // Past the snapshot TTL, so the next read genuinely attempts a refresh.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    const refreshed = await getRuntimeProviderSnapshot();
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.providers.has('llmapi')).toBe(true);
  });

  it('does not let a request from before reset publish or clear its replacement', async () => {
    let resolveOld;
    let resolveNew;
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));

    const oldRequest = getRuntimeProviderSnapshot('/workspace');
    resetOpenCodeRuntimeProviders();
    const newRequest = getRuntimeProviderSnapshot('/workspace');

    resolveOld(new Response(JSON.stringify(providerPayload({
      all: [{ id: 'llmapi', options: { apiKey: 'old-key', baseURL: 'https://old.example/v1' }, models: {} }],
      connected: ['llmapi'],
    })), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await oldRequest).toBeNull();

    const joinedReplacement = getRuntimeProviderSnapshot('/workspace');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveNew(new Response(JSON.stringify(providerPayload({
      all: [{ id: 'llmapi', options: { apiKey: 'new-key', baseURL: 'https://new.example/v1' }, models: {} }],
      connected: ['llmapi'],
    })), { status: 200, headers: { 'content-type': 'application/json' } }));

    const [replacement, joined] = await Promise.all([newRequest, joinedReplacement]);
    expect(replacement.providers.get('llmapi')).toMatchObject({ apiKey: 'new-key', baseURL: 'https://new.example/v1' });
    expect(joined).toBe(replacement);
    expect((await getRuntimeProvider('llmapi', '/workspace')).apiKey).toBe('new-key');
  });

  it('stays on file-based resolution until it is configured', async () => {
    configureOpenCodeRuntimeProviders(null);

    expect(await getRuntimeProvider('llmapi')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
