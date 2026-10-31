import { afterEach, describe, expect, test } from 'bun:test';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeCatalog } from '@/lib/api/types';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { findCatalogModel, nativeModelAliasVariant } from '@/lib/opencode/model';
import { invalidateNativeProviders, loadNativeProviders } from './catalog';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from './test-utils/runtime';

const model = (id: string) => ({
  id,
  name: id,
  contextWindow: 200_000,
  outputLimit: 32_000,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  fast: false,
  input: { image: true, pdf: false },
});

let runtimeIndex = 0;
// Each test reads through a fresh runtime: the catalog is cached per runtime.
const useRuntime = (catalog: () => Promise<NativeCatalog>) => {
  runtimeIndex += 1;
  switchRuntimeEndpoint({ apiBaseUrl: `http://catalog-${runtimeIndex}.test`, runtimeKey: `catalog-${runtimeIndex}` });
  let reads = 0;
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({
    catalog: async () => {
      reads += 1;
      return catalog();
    },
  })));
  return { reads: () => reads };
};

afterEach(() => {
  registerRuntimeAPIs(null);
});

describe('loadNativeProviders', () => {
  test('keeps a legacy Opus selection on the unified row without assigning an effort', async () => {
    useRuntime(async () => ({ backends: {
      claude: { status: 'ok', models: [{ ...model('connection:gateway:opus'), name: 'Opus (Claude 5.6 / agy 5.5)', aliases: [{ id: 'opus' }] }] },
      codex: { status: 'ok', models: [] },
    } }));
    const provider = (await loadNativeProviders())[0];
    const selected = findCatalogModel(provider.models, 'opus');
    expect(selected?.id).toBe('connection:gateway:opus');
    expect(selected?.name).toBe('Opus (Claude 5.6 / agy 5.5)');
    expect(nativeModelAliasVariant(selected, 'opus')).toBeUndefined();
    expect(selected?.variants.map((variant) => variant.id)).toEqual(['low', 'high']);
  });

  test('lists a provider per CLI with models, read once per runtime', async () => {
    const runtime = useRuntime(async () => ({
      backends: {
        claude: { status: 'ok', models: [model('opus'), model('haiku')] },
        codex: { status: 'ok', models: [model('gpt-5.5')] },
      },
    }));
    const providers = await loadNativeProviders();
    expect(providers.map((provider) => [provider.id, provider.models.map((entry) => entry.id)])).toEqual([
      ['claude-native', ['opus', 'haiku']],
      ['codex-native', ['gpt-5.5']],
    ]);
    expect(providers[0].models[0].variants).toEqual([{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high', settings: { reasoningEffort: 'high' } }]);
    await loadNativeProviders();
    expect(runtime.reads()).toBe(1);
  });

  test('offers each effort again as a fast variant on a model with Codex\'s Fast tier', async () => {
    useRuntime(async () => ({
      backends: {
        claude: { status: 'ok', models: [model('opus')] },
        codex: { status: 'ok', models: [{ ...model('gpt-5.5'), fast: true }, model('gpt-5.3-codex-spark')] },
      },
    }));
    const codex = (await loadNativeProviders()).find((provider) => provider.id === 'codex-native');
    expect(codex?.models.find((entry) => entry.id === 'gpt-5.5')?.variants.map((entry) => entry.id)).toEqual(['low', 'high', 'low-fast', 'high-fast']);
    expect(codex?.models.find((entry) => entry.id === 'gpt-5.3-codex-spark')?.variants.map((entry) => entry.id)).toEqual(['low', 'high']);
  });

  test('lists Antigravity CLI with text-only model input', async () => {
    useRuntime(async () => ({
      backends: {
        claude: { status: 'ok', models: [] },
        codex: { status: 'ok', models: [] },
        antigravity: { status: 'ok', models: [{ ...model('gemini-3-pro'), input: { image: false, pdf: false } }] },
      },
    }));
    const antigravity = (await loadNativeProviders()).find((provider) => provider.id === 'antigravity-native');
    expect(antigravity?.name).toBe('Antigravity CLI');
    expect(antigravity?.models[0].capabilities.input).toEqual(['text']);
  });

  test('offers one Antigravity model with separate effort choices and retains saved slug selections', async () => {
    const aliases = [{ id: 'gemini-test-low', variant: 'low' }, { id: 'gemini-test-high', variant: 'high' }];
    useRuntime(async () => ({ backends: {
      claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] },
      antigravity: { status: 'ok', models: [{ ...model('gemini-test'), aliases }] },
    } }));
    const provider = (await loadNativeProviders())[0];
    expect(provider.models).toHaveLength(1);
    const selected = findCatalogModel(provider.models, 'gemini-test-low');
    expect(selected?.id).toBe('gemini-test');
    expect(selected?.variants.map((variant) => variant.id)).toEqual(['low', 'high']);
    expect(nativeModelAliasVariant(selected, 'gemini-test-low')).toBe('low');
    expect(nativeModelAliasVariant(selected, 'gemini-test')).toBeUndefined();
  });

  test('a failing backend keeps what an earlier read found and is not re-read right away', async () => {
    let codexWorks = true;
    const runtime = useRuntime(async () => ({
      backends: {
        claude: { status: 'ok', models: [model('opus')] },
        codex: codexWorks ? { status: 'ok', models: [model('gpt-5.5')] } : { status: 'error', message: 'codex CLI was not found' },
      },
    }));
    codexWorks = false;
    expect((await loadNativeProviders()).map((provider) => provider.id)).toEqual(['claude-native']);
    expect((await loadNativeProviders()).map((provider) => provider.id)).toEqual(['claude-native']);
    expect(runtime.reads()).toBe(1);
  });

  test('a failed read is not an empty catalog', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      useRuntime(async () => {
        throw new Error('offline');
      });
      expect(await loadNativeProviders()).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('offers nothing where native sessions are unavailable', async () => {
    runtimeIndex += 1;
    switchRuntimeEndpoint({ apiBaseUrl: `http://catalog-${runtimeIndex}.test`, runtimeKey: `catalog-${runtimeIndex}` });
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ supported: false })));
    expect(await loadNativeProviders()).toEqual([]);
  });
});


describe('native connection catalog changes', () => {
  test('refreshes efforts for the same saved connection after a gap without extra directory reads', async () => {
    const connectionId = 'connection:connection-id:model-id';
    let efforts: string[] = [];
    const runtime = useRuntime(async () => ({ backends: {
      claude: { status: 'ok', models: [{ ...model(connectionId), efforts }] },
      codex: { status: 'ok', models: [] },
    } }));
    expect((await loadNativeProviders())[0].models[0].variants).toEqual([]);
    efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect((await loadNativeProviders())[0].models[0].variants).toEqual([]);
    invalidateNativeProviders(getRuntimeKey());
    const [first, second] = await Promise.all([loadNativeProviders(), loadNativeProviders()]);
    expect(first).toEqual(second);
    expect(first[0].models[0].id).toBe(connectionId);
    expect(first[0].models[0].variants.map((variant) => variant.id)).toEqual(efforts);
    expect(runtime.reads()).toBe(2);
  });

  test('a response started before a connection save cannot restore the old models', async () => {
    let resolvePending: (value: NativeCatalog) => void = () => { throw new Error('Promise not initialized'); };
    const pending = new Promise<NativeCatalog>((resolve) => { resolvePending = resolve; });
    let first = true;
    const runtime = useRuntime(async () => {
      if (first) { first = false; return pending; }
      return { backends: { claude: { status: 'ok', models: [model('new-connection')] }, codex: { status: 'ok', models: [] } } };
    });
    const oldRead = loadNativeProviders();
    invalidateNativeProviders(getRuntimeKey());
    resolvePending({ backends: { claude: { status: 'ok', models: [model('old-connection')] }, codex: { status: 'ok', models: [] } } });
    expect((await oldRead)[0].models[0].id).toBe('new-connection');
    expect((await loadNativeProviders())[0].models[0].id).toBe('new-connection');
    expect(runtime.reads()).toBe(2);
  });

  test('failed refresh keeps the preceding catalog without declaring an empty success', async () => {
    let failed = false;
    useRuntime(async () => {
      if (failed) throw new Error('offline');
      return { backends: { claude: { status: 'ok', models: [model('saved')] }, codex: { status: 'ok', models: [] } } };
    });
    await loadNativeProviders();
    failed = true;
    invalidateNativeProviders(getRuntimeKey());
    expect((await loadNativeProviders())[0].models[0].id).toBe('saved');
  });
});
