import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { captureDefaultSendSelection, resolveSessionSendSelection } from './defaultSendSelection';
import { buildNativeProvider } from '@/lib/native-agents/providers';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';

const sessionId = 'ses_todo_send';

const resetSelections = () => {
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    sessionAgentModelSelections: new Map(),
    agentModelVariantSelections: new Map(),
  });
  useConfigStore.setState({
    currentProviderId: '',
    currentModelId: '',
    currentAgentName: undefined,
    currentVariant: undefined,
    settingsDefaultModel: undefined, settingsDefaultVariant: undefined,
  });
};

beforeEach(resetSelections);
afterEach(resetSelections);

describe('resolveSessionSendSelection', () => {
  test('a fallback native send keeps its own effort when the settings model is unavailable', () => {
    useConfigStore.setState({
      providers: [buildNativeProvider('antigravity', [{ id: 'gemini-test', name: 'Gemini Test', efforts: ['low', 'high'],
        defaultEffort: null, contextWindow: null, outputLimit: null, fast: false, input: { image: false, pdf: false } }])],
      settingsDefaultModel: 'codex-native/gpt-test', settingsDefaultVariant: 'low',
      currentProviderId: 'antigravity-native', currentModelId: 'gemini-test', currentVariant: 'high',
    });
    expect(captureDefaultSendSelection()).toMatchObject({ providerID: 'antigravity-native', modelID: 'gemini-test', variant: 'high' });
  });

  test('sends on the model saved for the session, not the app-wide selection', () => {
    useConfigStore.setState({ currentProviderId: 'app-provider', currentModelId: 'app-model' });
    useSelectionStore.setState({
      sessionModelSelections: new Map([[sessionId, { providerId: 'session-provider', modelId: 'session-model' }]]),
    });

    expect(resolveSessionSendSelection(sessionId)).toMatchObject({
      providerID: 'session-provider',
      modelID: 'session-model',
    });
  });

  test('falls back to the app-wide selection when the session saved none', () => {
    useConfigStore.setState({
      currentProviderId: 'app-provider',
      currentModelId: 'app-model',
      currentAgentName: 'build',
    });

    expect(resolveSessionSendSelection(sessionId)).toEqual({
      providerID: 'app-provider',
      modelID: 'app-model',
      agent: 'build',
      variant: undefined,
    });
  });

  test('answers null when nothing is selected anywhere', () => {
    expect(resolveSessionSendSelection(sessionId)).toBeNull();
  });
});
