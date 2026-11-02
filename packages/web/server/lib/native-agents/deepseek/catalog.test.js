import { describe, expect, it } from 'vitest';

import { preferOfficialDeepSeek } from './catalog.js';

const group = (id, models) => ({ id, name: id, models: models.map((modelID) => ({ id: modelID, name: modelID })) });

describe('DSH catalog DeepSeek preference', () => {
  it('keeps the official provider and drops DeepSeek models from gateway groups', () => {
    const official = group('deepseek-official', ['deepseek-flash', 'deepseek-v4-pro']);
    const magpie = group('magpie', ['deepseek/deepseek-flash', 'gpt/gpt-6']);
    const other = group('other', ['deepseek/deepseek-v4-pro']);
    expect(preferOfficialDeepSeek([official, magpie, other])).toEqual([
      official,
      { ...magpie, models: [{ id: 'gpt/gpt-6', name: 'gpt/gpt-6' }] },
    ]);
  });

  it('leaves the catalog alone when no official provider is routable', () => {
    const magpie = group('magpie', ['deepseek/deepseek-flash']);
    expect(preferOfficialDeepSeek([magpie])).toEqual([magpie]);
    expect(preferOfficialDeepSeek([group('deepseek-official', []), magpie])).toHaveLength(2);
  });
});
