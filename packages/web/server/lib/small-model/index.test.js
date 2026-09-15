import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The settings override is read straight from disk at module load, so without
// this the suite would resolve whatever small model the developer running it
// happens to have configured.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'small-model-settings-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;
const SETTINGS_FILE = path.join(TEMP_DATA_DIR, 'settings.json');

vi.mock('../opencode/auth.js', () => ({ readAuthFile: vi.fn() }));
vi.mock('../opencode/shared.js', () => ({
  readConfig: vi.fn(),
  readConfigLayers: vi.fn(),
}));
vi.mock('./catalog.js', () => ({
  getModelCatalog: vi.fn(),
  getCatalogProvider: vi.fn(),
}));
vi.mock('./call.js', () => ({
  DEDICATED_WIRE_FORMAT_PROVIDERS: new Set(['github-copilot', 'copilot', 'openai', 'anthropic', 'google']),
  callSmallModel: vi.fn(),
  getProviderTransportKind: vi.fn(({ providerID }) => `${providerID}-transport`),
  isRuntimeOnlyProvider: (providerID) => providerID === 'claude-code' || providerID === 'codex',
  resolveRuntimeOnlyTransport: vi.fn(async () => null),
  resolveProviderLogin: vi.fn(async ({ auth, providerID }) => {
    const entry = auth?.[providerID];
    return entry && typeof entry === 'object' ? entry : null;
  }),
}));
vi.mock('./runtime-providers.js', () => ({
  getRuntimeProviderSnapshot: vi.fn(async () => null),
  getRuntimeProviderTransportFromSnapshot: vi.fn((snapshot, providerID) => {
    if (!snapshot?.connected?.has(providerID)) return null;
    const provider = snapshot.providers?.get(providerID);
    return provider?.apiKey && provider.baseURL ? provider : null;
  }),
}));

const { generateSmallModelText, describeSmallModel, listAuthenticatedProviders } = await import('./index.js');
const { readAuthFile } = await import('../opencode/auth.js');
const { getRuntimeProviderSnapshot } = await import('./runtime-providers.js');
const { readConfigLayers } = await import('../opencode/shared.js');
const { getModelCatalog, getCatalogProvider } = await import('./catalog.js');
const { callSmallModel, resolveRuntimeOnlyTransport } = await import('./call.js');

const claudeCodeSnapshot = ({ connected = true, apiKey = 'plugin-key', baseURL = 'http://127.0.0.1:60668/v1' } = {}) => ({
  providers: new Map([['claude-code', {
    id: 'claude-code',
    apiKey,
    baseURL,
    anonymousZen: false,
  }]]),
  connected: new Set(connected ? ['claude-code'] : []),
});

const CLAUDE_CODE_CATALOG = {
  'claude-code': {
    id: 'claude-code',
    models: {
      haiku: { id: 'haiku', family: 'claude-haiku', limit: { context: 200_000, output: 8_000 } },
    },
  },
};

describe('Claude Code explicit small-model selection', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({
      'claude-code': {
        type: 'oauth',
        access: 'claude-cli-managed',
        refresh: 'claude-cli-managed',
      },
    });
    readConfigLayers.mockReturnValue({ mergedConfig: {} });
    getModelCatalog.mockResolvedValue(CLAUDE_CODE_CATALOG);
    getCatalogProvider.mockImplementation((catalog, providerID) => catalog?.[providerID] ?? null);
    callSmallModel.mockReset();
    callSmallModel.mockResolvedValue('generated');
    resolveRuntimeOnlyTransport.mockReset();
    resolveRuntimeOnlyTransport.mockResolvedValue({
      providerID: 'claude-code',
      apiKey: 'plugin-key',
      baseURL: 'http://127.0.0.1:60668/v1',
      kind: 'claude-code-runtime',
      transportID: 'claude-code-runtime:test',
    });
    getRuntimeProviderSnapshot.mockResolvedValue(claudeCodeSnapshot());
    fs.rmSync(SETTINGS_FILE, { force: true });
  });

  it('allows an explicit request model', async () => {
    const result = await generateSmallModelText({
      prompt: 'summarize this',
      model: 'claude-code/haiku',
      directory: '/project',
    });

    expect(result).toMatchObject({ providerID: 'claude-code', modelID: 'haiku', source: 'request' });
    expect(callSmallModel).toHaveBeenCalledWith(expect.objectContaining({
      providerID: 'claude-code',
      modelID: 'haiku',
      resolvedProviderTransport: expect.objectContaining({ apiKey: 'plugin-key' }),
    }));
    expect(resolveRuntimeOnlyTransport).toHaveBeenCalledOnce();
    expect(resolveRuntimeOnlyTransport).toHaveBeenCalledWith('claude-code', { workingDirectory: '/project' });
  });

  it('allows an explicit OpenChamber settings model', async () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      smallModelUseDefault: false,
      smallModelOverride: 'claude-code/haiku',
    }));

    const result = await generateSmallModelText({ prompt: 'summarize this' });

    expect(result).toMatchObject({ providerID: 'claude-code', modelID: 'haiku', source: 'settings' });
    expect(callSmallModel).toHaveBeenCalledOnce();
  });

  it('allows an explicit OpenCode config model', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'claude-code/haiku' } });

    const result = await generateSmallModelText({ prompt: 'summarize this' });

    expect(result).toMatchObject({ providerID: 'claude-code', modelID: 'haiku', source: 'config' });
    expect(callSmallModel).toHaveBeenCalledOnce();
  });

  it('refuses the implicit session model with the normal no-model 404', async () => {
    await expect(generateSmallModelText({
      prompt: 'summarize this',
      preferredProviderID: 'claude-code',
      preferredModelID: 'haiku',
    })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(callSmallModel).not.toHaveBeenCalled();
    await expect(describeSmallModel({
      preferredProviderID: 'claude-code',
      preferredModelID: 'haiku',
    })).resolves.toBeNull();
  });

  it('refuses an implicit family match with the normal no-model 404', async () => {
    await expect(generateSmallModelText({
      prompt: 'summarize this',
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(callSmallModel).not.toHaveBeenCalled();
  });

  it('keeps describe and generation aligned with runtime callability', async () => {
    const available = await describeSmallModel({ overrideModel: 'claude-code/haiku' });
    expect(available).toMatchObject({
      providerID: 'claude-code',
      modelID: 'haiku',
      source: 'request',
      hasLogin: true,
      transport: 'claude-code-runtime:test',
    });
    expect(JSON.stringify(available)).not.toContain('plugin-key');
    expect(JSON.stringify(available)).not.toContain('127.0.0.1');

    resolveRuntimeOnlyTransport.mockResolvedValue(null);
    const unavailable = await describeSmallModel({ overrideModel: 'claude-code/haiku' });
    expect(unavailable).toMatchObject({ providerID: 'claude-code', modelID: 'haiku', hasLogin: false });
    await expect(generateSmallModelText({
      prompt: 'summarize this',
      model: 'claude-code/haiku',
    })).rejects.toMatchObject({ statusCode: 401, code: 'no-provider-login' });
    expect(callSmallModel).not.toHaveBeenCalled();
  });
});

describe('provider availability for the model pickers', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ openai: { type: 'api', key: 'sk-test' } });
    readConfigLayers.mockReturnValue({ mergedConfig: {} });
    getModelCatalog.mockResolvedValue({});
    getRuntimeProviderSnapshot.mockResolvedValue(null);
  });

  const snapshot = (providers, connected) => ({
    providers: new Map(providers.map((provider) => [provider.id, provider])),
    connected: new Set(connected ?? providers.map((provider) => provider.id)),
  });

  it('offers a plugin provider that OpenCode resolved at runtime', async () => {
    getRuntimeProviderSnapshot.mockResolvedValue(snapshot([
      { id: 'llmapi', apiKey: 'plugin-key', baseURL: 'https://api.llmapi.ai/v1', anonymousZen: false },
    ]));

    expect(await listAuthenticatedProviders()).toEqual(expect.arrayContaining(['openai', 'llmapi']));
  });

  it('offers runtime-only Claude Code when it is connected with a credential and endpoint', async () => {
    readAuthFile.mockReturnValue({});
    getRuntimeProviderSnapshot.mockResolvedValue(claudeCodeSnapshot());

    expect(await listAuthenticatedProviders('/project')).toContain('claude-code');
    expect(getRuntimeProviderSnapshot).toHaveBeenCalledWith('/project');
  });

  it('does not offer Claude Code from auth.json without a callable runtime provider', async () => {
    readAuthFile.mockReturnValue({
      'claude-code': { type: 'oauth', access: 'claude-cli-managed', refresh: 'claude-cli-managed' },
    });
    getRuntimeProviderSnapshot.mockResolvedValue(null);

    expect(await listAuthenticatedProviders()).not.toContain('claude-code');
  });

  it('does not offer a disconnected Claude Code runtime provider', async () => {
    readAuthFile.mockReturnValue({});
    getRuntimeProviderSnapshot.mockResolvedValue(claudeCodeSnapshot({ connected: false }));

    expect(await listAuthenticatedProviders()).not.toContain('claude-code');
  });

  it.each([
    ['credential', { apiKey: null }],
    ['endpoint', { baseURL: null }],
  ])('does not offer Claude Code without its runtime %s', async (_missing, overrides) => {
    readAuthFile.mockReturnValue({});
    getRuntimeProviderSnapshot.mockResolvedValue(claudeCodeSnapshot(overrides));

    expect(await listAuthenticatedProviders()).not.toContain('claude-code');
  });

  it('hides a provider with no endpoint to send a request to', async () => {
    getRuntimeProviderSnapshot.mockResolvedValue(snapshot([
      { id: 'endpointless', apiKey: 'plugin-key', baseURL: null, anonymousZen: false },
    ]));

    expect(await listAuthenticatedProviders()).not.toContain('endpointless');
  });

  it('never offers opencode zen without a real login', async () => {
    // The zen sentinel is not a credential, so the snapshot carries no apiKey.
    getRuntimeProviderSnapshot.mockResolvedValue(snapshot([
      { id: 'opencode', apiKey: null, baseURL: 'https://opencode.ai/zen/v1', anonymousZen: true },
    ]));

    expect(await listAuthenticatedProviders()).not.toContain('opencode');
  });

  it('keeps the auth.json providers when OpenCode cannot be reached', async () => {
    getRuntimeProviderSnapshot.mockResolvedValue(null);

    expect(await listAuthenticatedProviders()).toContain('openai');
  });
});

describe('preferred provider isolation', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ google: { type: 'api', key: 'google-key' } });
    readConfigLayers.mockReturnValue({ mergedConfig: {} });
    getModelCatalog.mockResolvedValue({
      google: {
        id: 'google',
        models: {
          flash: { id: 'flash', family: 'gemini-flash', release_date: '2026-01-01' },
        },
      },
    });
    getCatalogProvider.mockImplementation((catalog, providerID) => catalog?.[providerID] ?? null);
    callSmallModel.mockReset();
    callSmallModel.mockResolvedValue('generated');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not cross providers by default when a preferred provider was supplied', async () => {
    await expect(generateSmallModelText({
      prompt: 'summarize this',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-haiku-4-5',
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(callSmallModel).not.toHaveBeenCalled();
  });

  it('crosses providers only when the caller explicitly opts out', async () => {
    const result = await generateSmallModelText({
      prompt: 'summarize this',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-haiku-4-5',
      restrictToPreferredProvider: false,
    });

    expect(result).toMatchObject({ providerID: 'google', modelID: 'flash', source: 'family-scan' });
    expect(callSmallModel).toHaveBeenCalledOnce();
  });
});

// 8k context leaves 4k input tokens after the output reserve → 16k chars.
const CATALOG = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-haiku-4-5': { id: 'claude-haiku-4-5', limit: { context: 8_000 }, structured_output: true },
      'legacy-tiny': { id: 'legacy-tiny', limit: { context: 8_000 }, structured_output: false },
      'unlisted-capability': { id: 'unlisted-capability', limit: { context: 8_000 } },
    },
  },
};

const request = (overrides = {}) => ({
  prompt: 'x'.repeat(20_000),
  model: 'anthropic/claude-haiku-4-5',
  directory: '/proj',
  ...overrides,
});

describe('generateSmallModelText — oversized input', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ anthropic: { type: 'api', key: 'sk-ant' } });
    readConfigLayers.mockReturnValue({ mergedConfig: {} });
    getModelCatalog.mockResolvedValue(CATALOG);
    callSmallModel.mockReset();
    callSmallModel.mockResolvedValue('generated');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('truncates and flags the response by default', async () => {
    const result = await generateSmallModelText(request());

    expect(result.inputTruncated).toBe(true);
    const sent = callSmallModel.mock.calls.at(-1)[0].prompt;
    expect(sent.length).toBeLessThan(20_000);
    expect(sent.endsWith('…')).toBe(true);
  });

  it('refuses without calling the provider when the caller cannot survive truncation', async () => {
    await expect(generateSmallModelText(request({ onOverflow: 'error' })))
      .rejects.toMatchObject({
        statusCode: 413,
        code: 'context-too-small',
        requiredChars: 20_000,
        availableChars: 16_000,
      });

    expect(callSmallModel).not.toHaveBeenCalled();
  });

  it('leaves an input that fits untouched under either policy', async () => {
    const result = await generateSmallModelText(request({ prompt: 'short prompt', onOverflow: 'error' }));

    expect(result.inputTruncated).toBeUndefined();
    expect(callSmallModel.mock.calls.at(-1)[0].prompt).toBe('short prompt');
  });

  it('includes the system prompt in overflow checks', async () => {
    await expect(generateSmallModelText(request({
      prompt: 'x'.repeat(15_900),
      system: 's'.repeat(200),
      onOverflow: 'error',
    }))).rejects.toMatchObject({
      statusCode: 413,
      code: 'context-too-small',
      requiredChars: 16_100,
      availableChars: 16_000,
    });

    expect(callSmallModel).not.toHaveBeenCalled();
  });

  it('reserves system space when truncating the prompt', async () => {
    const result = await generateSmallModelText(request({
      prompt: 'x'.repeat(16_000),
      system: 's'.repeat(100),
    }));

    expect(result.inputTruncated).toBe(true);
    const sent = callSmallModel.mock.calls.at(-1)[0];
    expect(sent.prompt.length + sent.system.length).toBe(16_000);
    expect(sent.prompt.endsWith('…')).toBe(true);
  });

  it('forwards schema, timeout, and abort signal to the transport', async () => {
    const controller = new AbortController();
    const schema = { type: 'object' };

    await generateSmallModelText(request({
      prompt: 'short',
      responseSchema: schema,
      timeoutMs: 240_000,
      signal: controller.signal,
    }));

    expect(callSmallModel.mock.calls.at(-1)[0]).toMatchObject({
      responseSchema: schema,
      timeoutMs: 240_000,
      signal: controller.signal,
    });
  });
});

describe('describeSmallModel — capability reporting', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ anthropic: { type: 'api', key: 'sk-ant' } });
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/claude-haiku-4-5' } });
    getModelCatalog.mockResolvedValue(CATALOG);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports the input budget and a known structured-output capability', async () => {
    const described = await describeSmallModel({ directory: '/proj' });

    expect(described).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      inputCharBudget: 16_000,
      contextTokens: 8_000,
      contextKnown: true,
      structuredOutput: true,
      hasLogin: true,
    });
  });

  it('reports hasLogin false when the resolved provider has no usable credential', async () => {
    readAuthFile.mockReturnValue({});

    const described = await describeSmallModel({ directory: '/proj' });

    expect(described).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      hasLogin: false,
    });
  });

  it('reports an explicit false so callers can block the model', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/legacy-tiny' } });

    const described = await describeSmallModel({ directory: '/proj' });

    expect(described.structuredOutput).toBe(false);
  });

  it('reports null — not false — when the catalog omits the capability', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/unlisted-capability' } });

    const described = await describeSmallModel({ directory: '/proj' });

    expect(described.structuredOutput).toBeNull();
  });
});

// The input reserve and the requested output budget are the same number seen
// from two sides; if they drift, a caller that asks for a large answer overruns
// the model's context and the failure looks like a truncation bug.
describe('output budget and input reserve', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ anthropic: { type: 'api', key: 'sk-ant' } });
    readConfigLayers.mockReturnValue({ mergedConfig: {} });
    getModelCatalog.mockResolvedValue({
      anthropic: {
        id: 'anthropic',
        models: {
          roomy: { id: 'roomy', limit: { context: 100_000, output: 8_000 } },
          unlisted: { id: 'unlisted', limit: { context: 100_000 } },
        },
      },
    });
    callSmallModel.mockReset();
    callSmallModel.mockResolvedValue('generated');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('caps the request at the model\'s advertised output limit', async () => {
    await generateSmallModelText({
      prompt: 'short',
      model: 'anthropic/roomy',
      maxOutputTokens: 24_000,
    });

    expect(callSmallModel.mock.calls.at(-1)[0].maxOutputTokens).toBe(8_000);
  });

  it('honours the requested budget when the catalog states no output limit', async () => {
    await generateSmallModelText({
      prompt: 'short',
      model: 'anthropic/unlisted',
      maxOutputTokens: 24_000,
    });

    expect(callSmallModel.mock.calls.at(-1)[0].maxOutputTokens).toBe(24_000);
  });

  it('reserves exactly the requested output budget from the input allowance', async () => {
    // 100k context − 24k reserved for the answer = 76k tokens ≈ 304k chars.
    await expect(generateSmallModelText({
      prompt: 'x'.repeat(304_001),
      model: 'anthropic/unlisted',
      maxOutputTokens: 24_000,
      onOverflow: 'error',
    })).rejects.toMatchObject({ code: 'context-too-small', availableChars: 304_000 });

    await expect(generateSmallModelText({
      prompt: 'x'.repeat(303_999),
      model: 'anthropic/unlisted',
      maxOutputTokens: 24_000,
      onOverflow: 'error',
    })).resolves.toBeTruthy();
  });

  it('reports the same budget through describeSmallModel', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/unlisted' } });

    const described = await describeSmallModel({ directory: '/proj', outputReserveTokens: 24_000 });

    expect(described.inputCharBudget).toBe(304_000);
  });

  it('caps describe output and reserve at the same effective model limit as generation', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/roomy' } });

    const described = await describeSmallModel({ directory: '/proj', outputReserveTokens: 24_000 });

    expect(described.outputTokenLimit).toBe(8_000);
    expect(described.outputTokens).toBe(8_000);
    expect(described.inputCharBudget).toBe(92_000 * 4);
  });

  // A caller that wants "as much room as this model allows" cannot name a
  // number before knowing which model it got, so it hands over the decision.
  it('lets the reserve be decided from the resolved model\'s limits', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/roomy' } });

    const described = await describeSmallModel({
      directory: '/proj',
      outputReserveTokens: ({ contextTokens, outputTokenLimit }) => Math.min(contextTokens / 10, outputTokenLimit),
    });

    // 100k context, 8k output limit -> 8k reserved, leaving 92k tokens.
    expect(described.outputTokens).toBe(8_000);
    expect(described.inputCharBudget).toBe(92_000 * 4);
  });

  it('reports the reserve it used so the caller can request the same number', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/unlisted' } });

    const described = await describeSmallModel({ directory: '/proj', outputReserveTokens: 24_000 });

    expect(described.outputTokens).toBe(24_000);
  });
});

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});
