import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-codex-small-model-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;
const { configureNativeSmallModels, generateSmallModelText, describeSmallModel, listAuthenticatedProviders } = await import('./index.js');
const modelID = 'gpt-5.6-luna';
const model = 'codex-native/' + modelID;
const generations = [];
const nativeModel = { id: modelID, hasLogin: true, contextWindow: 8_000, outputLimit: 2_000, effort: 'low' };
const configureCodex = (runtime) => configureNativeSmallModels({ 'codex-native': { transport: 'codex-app-server', ...runtime } });

beforeEach(() => {
  generations.length = 0;
  configureCodex({
    available: async () => true,
    describe: async () => nativeModel,
    generate: async (request) => { generations.push(request); return 'Generated'; },
  });
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

describe('native Codex small-model routing', () => {
  it('honors an explicit Codex override from a Claude session and preserves structured output', async () => {
    const responseSchema = { type: 'object', properties: { title: { type: 'string' } } };
    expect(await generateSmallModelText({
      model, prompt: 'Summarize', preferredProviderID: 'claude-native', directory: dataDir,
      maxOutputTokens: 4_000, responseSchema,
    })).toMatchObject({ text: 'Generated', providerID: 'codex-native', modelID, source: 'request' });
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ modelID, directory: dataDir, effort: 'low', maxOutputTokens: 2_000, responseSchema });
  });

  it('uses the persisted small-model setting for all auxiliary callers', async () => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ smallModelUseDefault: false, smallModelOverride: model }));
    expect(await generateSmallModelText({ prompt: 'Title', preferredProviderID: 'claude-native' }))
      .toMatchObject({ providerID: 'codex-native', modelID, source: 'settings' });
  });

  it('reports Codex credentials, structured output and the same context budget used for generation', async () => {
    expect(await describeSmallModel({ overrideModel: model, outputReserveTokens: 4_000 })).toMatchObject({
      hasLogin: true, structuredOutput: true, transport: 'codex-app-server',
      contextKnown: true, contextTokens: 8_000, inputCharBudget: 24_000, outputTokens: 2_000,
    });
    expect(await listAuthenticatedProviders()).toContain('codex-native');
  });

  it('rejects oversized structured input before starting Codex', async () => {
    await expect(generateSmallModelText({ model, prompt: 'x'.repeat(40_000), onOverflow: 'error' }))
      .rejects.toMatchObject({ statusCode: 413, code: 'context-too-small' });
    expect(generations).toEqual([]);
  });

  it('reports an unavailable runtime and refuses generation after logout', async () => {
    configureNativeSmallModels(null);
    await expect(generateSmallModelText({ model, prompt: 'Title' })).rejects.toMatchObject({ statusCode: 503 });
    configureCodex({
      available: async () => false,
      describe: async () => ({ ...nativeModel, hasLogin: false }),
      generate: async (request) => { generations.push(request); return ''; },
    });
    expect(await describeSmallModel({ overrideModel: model })).toMatchObject({ hasLogin: false });
    await expect(generateSmallModelText({ model, prompt: 'Title' })).rejects.toMatchObject({ statusCode: 401, code: 'no-provider-login' });
    expect(generations).toEqual([]);
  });
});
