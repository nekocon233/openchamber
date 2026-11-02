import { describe, expect, test } from 'bun:test';

import { getModelDisplayName, getProviderModelDisplayName, humanizeModelId } from './modelDisplay';

describe('modelDisplay', () => {
  test('prefers model name over ids', () => {
    expect(getModelDisplayName({ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' })).toBe('Claude Sonnet 4.5');
  });

  test('falls back to a human-readable model id when name is missing', () => {
    expect(getModelDisplayName({ id: 'claude-sonnet-4-5' })).toBe('Claude Sonnet 4.5');
  });

  test('falls back to a human-readable explicit model id when provider data is unavailable', () => {
    expect(getProviderModelDisplayName(undefined, 'claude-sonnet-4-5')).toBe('Claude Sonnet 4.5');
  });

  test('separates a Claude gateway model suffix from a recorded effort', () => {
    expect(getProviderModelDisplayName(undefined, 'claude-opus-5-5-high', { separateEffort: true })).toBe('Claude Opus 5.5');
    expect(getProviderModelDisplayName(undefined, 'claude-sonnet-5-5-low', { separateEffort: true })).toBe('Claude Sonnet 5.5');
    expect(getProviderModelDisplayName(undefined, 'claude-opus-5-5-high')).toBe('Claude Opus 5.5 High');
  });

  test('normalizes native Claude routing aliases and colon effort suffixes', () => {
    for (const id of ['group/auto-claude-opus-5-5:high', 'auto/claude-opus-5-5:high', 'antigravity/claude-opus-5-5-high']) {
      expect(getProviderModelDisplayName(undefined, id, { separateEffort: true })).toBe('Claude Opus 5.5');
    }
    expect(getProviderModelDisplayName(undefined, 'group/auto-claude-sonnet-5-5', { separateEffort: true })).toBe('Claude Sonnet 5.5');
    expect(getProviderModelDisplayName(undefined, 'group/auto-claude-opus-5-5:high')).toBe('Auto Claude Opus 5.5 (High)');
  });

  test('keeps catalog names and other model suffixes intact when separating effort', () => {
    expect(getModelDisplayName({ id: 'custom-high', name: 'Custom High' }, undefined, { separateEffort: true })).toBe('Custom High');
    expect(getProviderModelDisplayName(undefined, 'gemini-4-argon-high', { separateEffort: true })).toBe('Gemini 4 Argon High');
    expect(getProviderModelDisplayName(undefined, 'custom-high', { separateEffort: true })).toBe('Custom High');
    expect(getProviderModelDisplayName(undefined, 'claude-opus-5-5:turbo', { separateEffort: true })).toBe('Claude Opus 5.5 (Turbo)');
  });

  test('uses fallback label only when no model id is available', () => {
    expect(getProviderModelDisplayName(undefined, undefined, { fallbackLabel: 'Select model' })).toBe('Select model');
  });

  test('supports provider model records and truncation', () => {
    const provider = {
      models: {
        'very-long-model-id': { id: 'very-long-model-id', name: 'Very Long Model Name' },
      },
    };

    expect(getProviderModelDisplayName(provider, 'very-long-model-id', { maxLength: 9 })).toBe('Very L...');
  });

  test('humanizes provider-prefixed model ids using common model catalog patterns', () => {
    expect(humanizeModelId('anthropic/claude-opus-4-7-fast')).toBe('Claude Opus 4.7 Fast');
    expect(humanizeModelId('google/gemini-3.1-flash-lite-preview')).toBe('Gemini 3.1 Flash Lite Preview');
    expect(humanizeModelId('meta-llama/llama-3.2-3b-instruct:free')).toBe('Llama 3.2 3B Instruct (free)');
    expect(humanizeModelId('openai/gpt-4o-mini-2024-07-18')).toBe('GPT-4o Mini (2024-07-18)');
    expect(humanizeModelId('openai/gpt-5.4-mini-fast')).toBe('GPT-5.4 Mini Fast');
    expect(humanizeModelId('qwen/qwen3-coder:free')).toBe('Qwen3 Coder (free)');
    expect(humanizeModelId('xai/grok-4-1-fast-non-reasoning')).toBe('Grok 4.1 Fast (Non-Reasoning)');
    expect(humanizeModelId('z-ai/glm-4.5-air')).toBe('GLM-4.5 Air');
  });

  test('humanizes alias and custom model ids without provider data', () => {
    expect(humanizeModelId('~openai/gpt-mini-latest')).toBe('GPT Mini Latest');
    expect(humanizeModelId('my-custom_provider/myAwesomeModel-v2-fast')).toBe('My Awesome Model V2 Fast');
  });
});
