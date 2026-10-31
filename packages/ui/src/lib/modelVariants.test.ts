import { describe, expect, test } from 'bun:test';
import { configuredVariantForModel, preferredModelVariant, listModelVariantIds, modelVariantNames } from './modelVariants';

describe('listModelVariantIds', () => {
  test('reads ids from the OpenCode 2 array, not array indices', () => {
    const variants = [{ id: 'none' }, { id: 'low' }, { id: 'high' }];
    expect(listModelVariantIds(variants)).toEqual(['none', 'low', 'high']);
  });

  test('reads keys from the v1 record', () => {
    expect(listModelVariantIds({ low: {}, high: {} })).toEqual(['low', 'high']);
  });

  test('is empty for a model without variants', () => {
    expect(listModelVariantIds(undefined)).toEqual([]);
    expect(modelVariantNames(undefined)).toEqual([]);
    expect(modelVariantNames({})).toEqual([]);
  });
});

describe('preferredModelVariant', () => {
  test('takes the last listed level', () => {
    expect(preferredModelVariant(['low', 'medium', 'high'])).toBe('high');
    expect(preferredModelVariant(['low', 'max'])).toBe('max');
  });

  test('is the only level when a model lists one', () => {
    expect(preferredModelVariant(['high'])).toBe('high');
  });

  test('is undefined when a model lists no level', () => {
    expect(preferredModelVariant([])).toBeUndefined();
  });

  test('never lets a Fast twin outrank its plain level', () => {
    expect(preferredModelVariant(['low', 'high', 'low-fast', 'high-fast'])).toBe('high');
    expect(preferredModelVariant(['low', 'max', 'ultra', 'low-fast', 'max-fast', 'ultra-fast'])).toBe('max');
    // Without a plain twin the id is its own level, not a duplicate.
    expect(preferredModelVariant(['low', 'high-fast'])).toBe('high-fast');
  });

  test('prefers max over ultra regardless of order and preserves a Fast-only catalog', () => {
    expect(preferredModelVariant(['ultra', 'max', 'low'])).toBe('max');
    expect(preferredModelVariant(['low-fast', 'max-fast', 'ultra-fast'])).toBe('max-fast');
  });
});

describe('configuredVariantForModel', () => {
  test('keeps defaults with their model and recognizes confirmed aliases', () => {
    const target = { providerId: 'antigravity-native', modelId: 'gemini-test', model: {
      id: 'gemini-test', modelID: 'gemini-test', nativeAliases: [{ id: 'gemini-test-low', variant: 'low' }],
    } };
    expect(configuredVariantForModel({ ...target, defaultModel: 'codex-native/gpt-test', defaultVariant: 'max' })).toBeUndefined();
    expect(configuredVariantForModel({ ...target, defaultModel: 'antigravity-native/other', defaultVariant: 'low' })).toBeUndefined();
    expect(configuredVariantForModel({ ...target, defaultModel: 'antigravity-native/gemini-test-low', defaultVariant: 'low' })).toBe('low');
    expect(configuredVariantForModel({ ...target, defaultModel: undefined, defaultVariant: 'low' })).toBe('low');
    expect(configuredVariantForModel({ ...target, defaultModel: 'antigravity-native/gemini-test', defaultVariant: 'max' })).toBe('max');
  });
});
