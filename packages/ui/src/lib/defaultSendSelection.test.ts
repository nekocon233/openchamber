import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resolveSessionSendSelection } from './defaultSendSelection';
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
  });
};

beforeEach(resetSelections);
afterEach(resetSelections);

describe('resolveSessionSendSelection', () => {
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
