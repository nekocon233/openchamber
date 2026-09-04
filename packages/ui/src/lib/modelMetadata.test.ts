import { describe, expect, test } from 'bun:test';
import { mergeModelMetadataWithLiveModel } from './modelMetadata';

describe('mergeModelMetadataWithLiveModel', () => {
  test('gives ModelPickerList complete live metadata for plugin models missing from the catalog', () => {
    const metadata = mergeModelMetadataWithLiveModel('claude-code', {
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      limit: { context: 200_000, output: 64_000 },
    });

    expect(metadata?.tool_call).toBe(true);
    expect(metadata?.reasoning).toBe(true);
    expect(metadata?.attachment).toBe(true);
    expect(metadata?.modalities?.input).toEqual(['text', 'image', 'pdf']);
    expect(metadata?.modalities?.output).toEqual(['text']);
    expect(metadata?.limit).toEqual({ context: 200_000, output: 64_000 });
  });

  test('prefers live runtime capabilities and limits while retaining catalog-only fields', () => {
    const metadata = mergeModelMetadataWithLiveModel(
      'anthropic',
      {
        id: 'claude',
        capabilities: {
          toolcall: false,
          reasoning: true,
          attachment: true,
          input: { text: true, image: true, pdf: true },
          output: { text: true },
        },
        limit: { context: 250_000, output: 32_000 },
      },
      {
        id: 'claude',
        providerId: 'anthropic',
        tool_call: true,
        reasoning: false,
        attachment: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200_000, output: 16_000 },
        knowledge: '2025-01',
      },
    );

    expect(metadata?.tool_call).toBe(false);
    expect(metadata?.reasoning).toBe(true);
    expect(metadata?.attachment).toBe(true);
    expect(metadata?.modalities?.input).toEqual(['text', 'image', 'pdf']);
    expect(metadata?.limit).toEqual({ context: 250_000, output: 32_000 });
    expect(metadata?.knowledge).toBe('2025-01');
  });
});
