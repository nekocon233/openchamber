import { describe, expect, it } from 'vitest';

import { claudeModels, codexModels } from './catalog.js';

describe('native model catalogs', () => {
  it('offers every Claude effort level on each alias', () => {
    const models = claudeModels();
    expect(models.map((model) => model.id)).toEqual(['opus', 'sonnet', 'fable', 'haiku']);
    for (const model of models) expect(model.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
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
        input: { image: true, pdf: false },
      },
      {
        id: 'gpt-5.3-codex-spark',
        name: 'gpt-5.3-codex-spark',
        contextWindow: 272_000,
        outputLimit: 128_000,
        efforts: ['high'],
        defaultEffort: null,
        input: { image: false, pdf: false },
      },
    ]);
  });
});
