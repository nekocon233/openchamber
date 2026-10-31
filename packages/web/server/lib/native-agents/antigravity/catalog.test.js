import { describe, expect, it } from 'vitest';
import { parseAntigravityModels } from './catalog.js';

describe('Antigravity model families', () => {
  it('groups only published efforts, retaining family order and concrete aliases', () => {
    const models = parseAntigravityModels([
      'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
      'gemini-4-argon-high\tGemini 4 Argon (High)',
      'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
      'gemini-4-argon-low\tGemini 4 Argon (Low)',
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\r\n'));
    expect(models).toMatchObject([
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], aliases: [
        { id: 'gemini-4-argon-medium', variant: 'medium' },
        { id: 'gemini-4-argon-high', variant: 'high' },
        { id: 'gemini-4-argon-low', variant: 'low' },
      ] },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'high'] },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', efforts: [], aliases: [{ id: 'gpt-oss-120b-medium', variant: 'medium' }] },
    ]);
    expect(models.every((model) => model.contextWindow === null && !model.input.image && !model.input.pdf)).toBe(true);
  });

  it('offers xhigh and max only when the CLI lists matching variants', () => {
    expect(parseAntigravityModels('future-max\tFuture (Max)\nfuture-xhigh\tFuture (XHigh)\nfuture-low\tFuture (Low)'))
      .toMatchObject([{ id: 'future', efforts: ['low', 'xhigh', 'max'] }]);
  });

  it('does not infer effort from an id or display label alone', () => {
    expect(parseAntigravityModels('fixed-high\tFixed\nother\tOther (High)\nmismatch-low\tMismatch (High)'))
      .toMatchObject([
        { id: 'fixed-high', name: 'Fixed', efforts: [], aliases: [] },
        { id: 'other', name: 'Other (High)', efforts: [], aliases: [] },
        { id: 'mismatch-low', name: 'Mismatch (High)', efforts: [], aliases: [] },
      ]);
  });

  it('distinguishes a successful empty catalog from malformed output', () => {
    expect(parseAntigravityModels('\n')).toEqual([]);
    for (const output of ['model', 'model\t', 'model\tName\textra', 'm\tM\nm\tM', 'm-low\tM (Low)\nm-high\tOther (High)']) {
      expect(() => parseAntigravityModels(output)).toThrow(expect.objectContaining({ code: 'NATIVE_ANTIGRAVITY_CATALOG' }));
    }
  });
});
