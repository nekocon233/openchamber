import { afterEach, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { refreshStoresForCatalogKind } from '@/stores/catalogRefresh';
import { useConfigStore } from '@/stores/useConfigStore';
import { loadNativeProviders } from './catalog';
import { translateNativeEvent } from './events';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from './test-utils/runtime';

afterEach(() => registerRuntimeAPIs(null));

test('a family upgrade event replaces the cached name in open directories while keeping the chosen model and effort', async () => {
  const id = 'connection:gateway:model';
  let name = 'Opus 5.5 (agy)';
  let reads = 0;
  switchRuntimeEndpoint({ apiBaseUrl: 'http://family-catalog.test', runtimeKey: 'family-catalog' });
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ catalog: async () => {
    reads += 1;
    return { backends: {
      claude: { status: 'ok', models: [{ id, name, contextWindow: 1000000, outputLimit: 128000,
        efforts: ['low', 'high', 'max'], defaultEffort: null, fast: false, input: { image: true, pdf: false } }] },
      codex: { status: 'ok', models: [] },
    } };
  } })));
  const snapshot = {
    providers: await loadNativeProviders(), agents: [], currentProviderId: 'claude-native', currentModelId: id,
    currentVariant: 'max', currentAgentName: undefined, selectedProviderId: 'claude-native',
    agentModelSelections: {}, defaultProviders: {},
  };
  useConfigStore.setState({ ...snapshot, directoryScoped: { '/project': snapshot } });
  name = 'Opus 5.6 (agy)';
  expect((await loadNativeProviders())[0].models[0].name).toBe('Opus 5.5 (agy)');
  const event = translateNativeEvent({ type: 'catalog.updated', properties: { kind: 'native-model' } });
  if (event?.type !== 'catalog.updated') throw new Error('The upgrade must publish catalog invalidation');
  await refreshStoresForCatalogKind(event.properties.kind);
  const state = useConfigStore.getState();
  for (const current of [state, state.directoryScoped['/project']]) {
    expect(current.providers[0].models[0].name).toBe('Opus 5.6 (agy)');
    expect(current.currentModelId).toBe(id);
    expect(current.currentVariant).toBe('max');
  }
  expect(reads).toBe(2);
});
