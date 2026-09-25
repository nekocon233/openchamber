import { describe, expect, test } from 'bun:test';

import { codexFastVariant, codexReviewTarget, parseCodexComposerCommand } from './codex-commands';

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
    const variants = ['low', 'high', 'low-fast', 'high-fast'];
    expect(codexFastVariant(variants, 'high', '')).toBe('high-fast');
    expect(codexFastVariant(variants, 'high-fast', '')).toBe('high');
    expect(codexFastVariant(variants, 'high-fast', 'on')).toBe('high-fast');
    expect(codexFastVariant(variants, 'low', 'off')).toBe('low');
    expect(codexFastVariant(['high'], 'high', 'on')).toBeNull();
    expect(codexFastVariant(variants, 'high', 'yes')).toBeNull();
    expect(codexFastVariant(variants, undefined, 'on')).toBeNull();
  });
});
