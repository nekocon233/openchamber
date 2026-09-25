import { beforeEach, describe, expect, test } from 'bun:test';

import { buildNativeProvider } from '@/lib/native-agents/providers';
import { createTestNativeAgentsAPI } from '@/lib/native-agents/test-utils/runtime';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { executeCodexComposerCommand } from '../codexCommands';

const sessionId = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';
const models = [{ id: 'test-model', name: 'Test model', efforts: ['low', 'high'], defaultEffort: 'high', fast: true, contextWindow: 100000, outputLimit: 10000, input: { image: true, pdf: false } }];
const native = buildNativeProvider('codex', models);

beforeEach(() => {
  useConfigStore.setState({
    providers: [{ ...native, models: Object.values(native.models) }],
    currentProviderId: native.id,
    currentModelId: 'test-model',
    currentVariant: 'high',
    currentVariantSelection: { override: 'high', inherited: undefined },
    currentAgentName: 'build',
  });
  useSelectionStore.getState().clearSessionSelections(sessionId);
});

const context = (api = createTestNativeAgentsAPI({})) => ({
  sessionId, directory: '/work/project', model: 'test-model', variant: 'high', agent: 'build', api,
  t: (key: string) => key,
  isCurrent: () => true,
  openModelMenu: () => {},
});

describe('Codex command execution', () => {
  test('model and effort changes update the same selections the next prompt uses, without sending a prompt', async () => {
    await executeCodexComposerCommand({ name: 'model', argument: 'test-model low' }, context());
    expect(useConfigStore.getState().currentModelId).toBe('test-model');
    expect(useConfigStore.getState().currentVariant).toBe('low');
    expect(useSelectionStore.getState().getAgentModelVariantForSession(sessionId, 'build', native.id, 'test-model')).toBe('low');
    await expect(executeCodexComposerCommand({ name: 'model', argument: 'missing-model' }, context())).rejects.toThrow();
    expect(useConfigStore.getState().currentModelId).toBe('test-model');
  });

  test('plan arguments become a prompt with explicit plan mode and a bare plan sends nothing', async () => {
    expect(await executeCodexComposerCommand({ name: 'plan', argument: 'Check auth\nThen propose a plan' }, context())).toEqual({ kind: 'prompt', text: 'Check auth\nThen propose a plan', agent: 'plan' });
    expect(useSelectionStore.getState().getSessionAgentSelection(sessionId)).toBe('plan');
    expect(await executeCodexComposerCommand({ name: 'plan', argument: '' }, context())).toEqual({ kind: 'done' });
  });

  test('Fast resolves the native default effort and discards a completion after navigation', async () => {
    const api = createTestNativeAgentsAPI({ catalog: async () => ({ backends: { claude: { status: 'ok', models: [] }, codex: { status: 'ok', models } } }) });
    await executeCodexComposerCommand({ name: 'fast', argument: 'on' }, { ...context(api), variant: undefined });
    expect(useConfigStore.getState().currentVariant).toBe('high-fast');
    await executeCodexComposerCommand({ name: 'fast', argument: 'off' }, { ...context(api), variant: 'high-fast', isCurrent: () => false });
    expect(useConfigStore.getState().currentVariant).toBe('high-fast');
  });

  test('review goes to the dedicated command API with the selected model, effort and target', async () => {
    const calls: Parameters<ReturnType<typeof createTestNativeAgentsAPI>['codexCommand']>[0][] = [];
    const api = createTestNativeAgentsAPI({ codexCommand: async (request) => { calls.push(request); return { kind: 'accepted' }; } });
    await executeCodexComposerCommand({ name: 'review', argument: '--base main' }, context(api));
    expect(calls).toEqual([{ name: 'review', directory: '/work/project', sessionId, model: 'test-model', variant: 'high', target: { type: 'baseBranch', branch: 'main' } }]);
  });

  test('a delayed Fast catalog does not overwrite a newer picker choice', async () => {
    const api = createTestNativeAgentsAPI({ catalog: async () => {
      useConfigStore.getState().setCurrentVariantOverride('low', undefined);
      return { backends: { claude: { status: 'ok', models: [] }, codex: { status: 'ok', models } } };
    } });
    await executeCodexComposerCommand({ name: 'fast', argument: 'on' }, { ...context(api), variant: undefined });
    expect(useConfigStore.getState().currentVariant).toBe('low');
  });

  test('preserves command failures and refuses session-only actions in a draft', async () => {
    const api = createTestNativeAgentsAPI({ codexCommand: async () => { throw new Error('offline'); } });
    await expect(executeCodexComposerCommand({ name: 'skills', argument: '' }, context(api))).rejects.toThrow('offline');
    await expect(executeCodexComposerCommand({ name: 'stop', argument: '' }, { ...context(api), sessionId: null })).rejects.toThrow('chat.codexCommand.needsSession');
  });
});
