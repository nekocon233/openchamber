import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-claude-small-model-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;
const { configureNativeSmallModels, generateSmallModelText, describeSmallModel, listAuthenticatedProviders } = await import('./index.js');
const model = 'claude-native/haiku';
const generations = [];
const nativeModel = { id: 'haiku', hasLogin: true, contextWindow: 200_000, outputLimit: 64_000, effort: 'low' };
const claudeRuntime = (overrides = {}) => ({
  transport: 'claude-agent-sdk',
  available: async () => true,
  describe: async () => nativeModel,
  generate: async (request) => { generations.push(request); return '{"recap":"Done"}'; },
  ...overrides,
});

beforeEach(() => {
  generations.length = 0;
  configureNativeSmallModels({ 'claude-native': claudeRuntime() });
});
afterEach(() => {
  configureNativeSmallModels(null);
  fs.rmSync(path.join(dataDir, 'settings.json'), { force: true });
});
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('native Claude Code small-model routing', () => {
  it('uses the persisted Claude Code small model, from a Codex session too', async () => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ smallModelUseDefault: false, smallModelOverride: model }));
    expect(await generateSmallModelText({
      prompt: 'Recap', directory: dataDir, preferredProviderID: 'codex-native', restrictToPreferredProvider: true, maxOutputTokens: 4_000,
    })).toMatchObject({ text: '{"recap":"Done"}', providerID: 'claude-native', modelID: 'haiku', source: 'settings' });
    expect(generations).toEqual([expect.objectContaining({ modelID: 'haiku', effort: 'low', directory: dataDir, maxOutputTokens: 4_000 })]);
  });

  it('reports the Claude Code login, structured output and the window of the selected model', async () => {
    expect(await describeSmallModel({ overrideModel: model, outputReserveTokens: 4_000 })).toMatchObject({
      providerID: 'claude-native', modelID: 'haiku', hasLogin: true, structuredOutput: true, transport: 'claude-agent-sdk',
      contextKnown: true, contextTokens: 200_000, inputCharBudget: 784_000, outputTokens: 4_000,
    });
    expect(await listAuthenticatedProviders()).toContain('claude-native');
  });

  it('offers each CLI on its own login', async () => {
    configureNativeSmallModels({
      'codex-native': claudeRuntime({ transport: 'codex-app-server', available: async () => { throw new Error('Codex is not installed'); } }),
      'claude-native': claudeRuntime(),
    });
    const providers = await listAuthenticatedProviders();
    expect(providers).toContain('claude-native');
    expect(providers).not.toContain('codex-native');
  });

  it('refuses generation while Claude Code is signed out or its runtime is missing', async () => {
    configureNativeSmallModels({
      'claude-native': claudeRuntime({ available: async () => false, describe: async () => ({ ...nativeModel, hasLogin: false }) }),
    });
    expect(await listAuthenticatedProviders()).not.toContain('claude-native');
    await expect(generateSmallModelText({ model, prompt: 'Recap' })).rejects.toMatchObject({ statusCode: 401, code: 'no-provider-login' });
    configureNativeSmallModels({ 'codex-native': claudeRuntime({ transport: 'codex-app-server' }) });
    await expect(generateSmallModelText({ model, prompt: 'Recap' })).rejects.toMatchObject({ statusCode: 503, code: 'native-runtime-unavailable' });
    expect(generations).toEqual([]);
  });
});
