import { describe, expect, test } from 'bun:test';

import { modelForSessionKind } from './session-model';

const CLAUDE_SESSION = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const providers = [
  { id: 'anthropic', models: [{ id: 'claude-sonnet' }] },
  { id: 'openai', models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] },
  { id: 'claude-native', models: [{ id: 'opus' }, { id: 'haiku' }] },
  { id: 'codex-native', models: [{ id: 'gpt-5.5' }] },
];

describe('modelForSessionKind', () => {
  test('keeps a selection that fits the session', () => {
    expect(modelForSessionKind({ sessionId: CLAUDE_SESSION, selectedProviderId: 'claude-native', providers, defaultModel: undefined })).toBeNull();
    expect(modelForSessionKind({ sessionId: 'ses_a', selectedProviderId: 'openai', providers, defaultModel: undefined })).toBeNull();
  });

  test("moves a native session onto its CLI's first model", () => {
    expect(modelForSessionKind({ sessionId: CLAUDE_SESSION, selectedProviderId: 'anthropic', providers, defaultModel: 'openai/gpt-5' }))
      .toEqual({ providerId: 'claude-native', modelId: 'opus' });
    expect(modelForSessionKind({ sessionId: CLAUDE_SESSION, selectedProviderId: 'codex-native', providers, defaultModel: undefined }))
      .toEqual({ providerId: 'claude-native', modelId: 'opus' });
  });

  test('moves an OpenCode session off a native model, preferring the default from settings', () => {
    expect(modelForSessionKind({ sessionId: 'ses_a', selectedProviderId: 'claude-native', providers, defaultModel: 'openai/gpt-5-mini' }))
      .toEqual({ providerId: 'openai', modelId: 'gpt-5-mini' });
    expect(modelForSessionKind({ sessionId: 'ses_a', selectedProviderId: 'claude-native', providers, defaultModel: 'claude-native/opus' }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet' });
    expect(modelForSessionKind({ sessionId: 'ses_a', selectedProviderId: 'claude-native', providers, defaultModel: 'gone/model' }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet' });
  });

  test('has nothing to offer when the fitting provider is missing', () => {
    expect(modelForSessionKind({ sessionId: CLAUDE_SESSION, selectedProviderId: 'anthropic', providers: providers.slice(0, 2), defaultModel: undefined })).toBeNull();
  });
});
