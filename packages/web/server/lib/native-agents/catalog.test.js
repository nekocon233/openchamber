import { describe, expect, it } from 'vitest';

import { claudeLaunchModel, claudeModels, codexModels, codexVariantSettings } from './catalog.js';

describe('native model catalogs', () => {
  it('offers every Claude effort level on each alias', () => {
    const models = claudeModels();
    expect(models.map((model) => model.id)).toEqual(['opus', 'sonnet', 'fable', 'haiku']);
    for (const model of models) expect(model.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('launches each Claude alias with the context window the catalog reports', () => {
    expect(claudeModels().map((model) => [model.id, model.contextWindow, claudeLaunchModel(model.id)])).toEqual([
      ['opus', 1_000_000, 'opus[1m]'],
      ['sonnet', 1_000_000, 'sonnet[1m]'],
      ['fable', 1_000_000, 'fable[1m]'],
      ['haiku', 200_000, 'haiku'],
    ]);
    expect(claudeLaunchModel('claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('keeps the visible Codex models with the efforts Codex reports for each', () => {
    const models = codexModels({
      data: [
        {
          id: 'gpt-6-astra',
          displayName: 'GPT-6-Astra',
          hidden: false,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
          serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses at a higher price.' }],
          inputModalities: ['text', 'image'],
        },
        { id: 'internal-reviewer', displayName: 'Reviewer', hidden: true, supportedReasoningEfforts: [], inputModalities: ['text'] },
        { id: 'gpt-5.3-codex-spark', displayName: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], inputModalities: ['text'] },
      ],
      nextCursor: null,
    });
    expect(models).toEqual([
      {
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        contextWindow: 272_000,
        outputLimit: 128_000,
        efforts: ['low', 'ultra'],
        defaultEffort: 'medium',
        fast: true,
        input: { image: true, pdf: false },
      },
      {
        id: 'gpt-5.3-codex-spark',
        name: 'gpt-5.3-codex-spark',
        contextWindow: 272_000,
        outputLimit: 128_000,
        efforts: ['high'],
        defaultEffort: null,
        fast: false,
        input: { image: false, pdf: false },
      },
    ]);
  });

  it('reads a Codex variant as its effort and whether it runs on the Fast tier', () => {
    expect(codexVariantSettings(undefined)).toEqual({ effort: null, fast: false });
    expect(codexVariantSettings('high')).toEqual({ effort: 'high', fast: false });
    expect(codexVariantSettings('xhigh-fast')).toEqual({ effort: 'xhigh', fast: true });
  });
});
