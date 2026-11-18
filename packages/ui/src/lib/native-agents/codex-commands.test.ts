import { describe, expect, test } from 'bun:test';

import { codexSpeedVariant, codexReviewTarget, parseCodexComposerCommand } from './codex-commands';

describe('Codex composer commands', () => {
  test('only intercepts implemented commands at the beginning of the prompt', () => {
    expect(parseCodexComposerCommand(' /model gpt-5.5 high ')).toEqual({ name: 'model', argument: 'gpt-5.5 high' });
    expect(parseCodexComposerCommand('/plan first\nsecond')).toEqual({ name: 'plan', argument: 'first\nsecond' });
    for (const text of ['/workspace/model', 'Explain /model', '/my-custom-skill', '']) expect(parseCodexComposerCommand(text)).toBeNull();
  });

  test('keeps review targets distinct from arbitrary instructions and rejects malformed flags', () => {
    expect(codexReviewTarget('')).toEqual({ type: 'uncommittedChanges' });
    expect(codexReviewTarget('--base feature/auth')).toEqual({ type: 'baseBranch', branch: 'feature/auth' });
    expect(codexReviewTarget('--commit abcdef123')).toEqual({ type: 'commit', sha: 'abcdef123' });
    expect(codexReviewTarget('Check auth')).toEqual({ type: 'custom', instructions: 'Check auth' });
    for (const input of ['--base', '--base main extra', '--commit nope', '--unknown']) expect(codexReviewTarget(input)).toBeNull();
  });

  test('toggles Fast without changing effort and rejects tiers absent from the model catalog', () => {
    const variants = ['low', 'high', 'low-fast', 'high-fast', 'high-ultrafast'];
    expect(codexSpeedVariant(variants, 'high', 'fast', '')).toBe('high-fast');
    expect(codexSpeedVariant(variants, 'high-fast', 'fast', '')).toBe('high');
    expect(codexSpeedVariant(variants, 'high-fast', 'fast', 'on')).toBe('high-fast');
    expect(codexSpeedVariant(variants, 'low', 'fast', 'off')).toBe('low');
    expect(codexSpeedVariant(['high'], 'high', 'fast', 'on')).toBeNull();
    expect(codexSpeedVariant(variants, 'high-fast', 'ultrafast', '')).toBe('high-ultrafast');
    expect(codexSpeedVariant(variants, 'high-ultrafast', 'ultrafast', '')).toBe('high');
    expect(codexSpeedVariant(variants, 'high-ultrafast', 'fast', '')).toBe('high-fast');
    expect(codexSpeedVariant(variants, 'high-ultrafast', 'fast', 'off')).toBe('high-ultrafast');
    expect(codexSpeedVariant(variants, 'low-fast', 'ultrafast', 'off')).toBe('low-fast');
    expect(codexSpeedVariant(variants, 'low-fast', 'ultrafast', 'on')).toBeNull();
    expect(codexSpeedVariant(variants, 'high', 'fast', 'yes')).toBeNull();
    expect(codexSpeedVariant(variants, undefined, 'fast', 'on')).toBeNull();
  });
});
