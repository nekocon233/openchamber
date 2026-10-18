import { describe, expect, it } from 'vitest';

import { modelLimitsFromSettings } from './configuration.js';

const described = (value) => ({
  writable: true,
  namespaces: [{ ns: 'llm-deepseek', revision: 0, value }],
});

describe('DSH model context windows', () => {
  it('reads the configured window and output cap per model', () => {
    const limits = modelLimitsFromSettings(described({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 384_000 },
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
        { id: 'explicit-output', contextWindow: 200_000, outputLimit: 64_000, maxTokens: 32_000 },
      ],
    }));

    expect(limits).toEqual(new Map([
      ['deepseek-flash', { contextWindow: 1_000_000, outputLimit: 384_000 }],
      ['deepseek-v4-pro', { contextWindow: 1_000_000, outputLimit: null }],
      ['explicit-output', { contextWindow: 200_000, outputLimit: 64_000 }],
    ]));
  });

  it('leaves a model without a window as null instead of inventing one', () => {
    const limits = modelLimitsFromSettings(described({
      models: [{ id: 'custom-model' }],
    }));

    expect(limits.get('custom-model')).toEqual({ contextWindow: null, outputLimit: null });
  });

  it('skips entries whose window is not a positive number', () => {
    const limits = modelLimitsFromSettings(described({
      models: [
        { id: 'bad', contextWindow: -1 },
        { id: 'also-bad', contextWindow: '200000' },
        { id: 'good', contextWindow: 200_000 },
      ],
    }));

    expect([...limits.keys()]).toEqual(['good']);
  });

  it('returns nothing when the profile exposes no DeepSeek settings', () => {
    expect(modelLimitsFromSettings({ writable: true, namespaces: [{ ns: 'other', revision: 0, value: {} }] })).toEqual(new Map());
    expect(modelLimitsFromSettings(null)).toEqual(new Map());
    expect(modelLimitsFromSettings(described({ apiKeyEnv: 'DEEPSEEK_API_KEY' }))).toEqual(new Map());
    expect(modelLimitsFromSettings(described({ models: [{ contextWindow: 1_000_000 }] }))).toEqual(new Map());
  });
});
