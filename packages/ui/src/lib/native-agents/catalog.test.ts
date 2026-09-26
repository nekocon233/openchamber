import { afterEach, describe, expect, test } from 'bun:test';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeCatalog } from '@/lib/api/types';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { loadNativeProviders } from './catalog';
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
