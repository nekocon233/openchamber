import { describe, expect, it } from 'vitest';
import { prepareConversationContext } from './context.js';

describe('conversation context model aliases', () => {
  it('refuses oversized DeepSeek to Antigravity handoff without using another connected provider', async () => {
    const descriptions = [];
    let saved = false;
    await expect(prepareConversationContext({
      manifest: { directory: '/fixture', segments: [{ id: 'source', sends: [{ selection: { model: { providerID: 'deepseek-native', modelID: 'deepseek-model' } } }] }], active: 'source' },
      entries: [{ record: { info: { id: 'older', role: 'user' }, parts: [{ type: 'text', text: 'Context '.repeat(20000) }] } }],
      target: { model: { providerID: 'antigravity-native', modelID: 'gemini-test' } },
      catalog: { models: [{ id: 'gemini-test', contextWindow: 64000 }] },
      signal: new AbortController().signal,
      smallModels: async () => ({ describeSmallModel: async ({ overrideModel }) => { descriptions.push(overrideModel); return null; } }),
      saveCheckpoint: async () => { saved = true; },
    })).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_SUMMARY_UNAVAILABLE' });
    expect(descriptions).toEqual(['antigravity-native/gemini-test']);
    expect(saved).toBe(false);
  });

  it('summarizes oversized Antigravity history only on the selected destination model', async () => {
    const descriptions = [];
    const models = [];
    const checkpoints = [];
    const context = await prepareConversationContext({
      manifest: { directory: '/fixture', historyRevision: 2, segments: [{ id: 'source', sends: [{ selection: { model: { providerID: 'antigravity-native', modelID: 'gemini-test' } } }] }], active: 'source' },
      entries: [
        { record: { info: { id: 'older', role: 'user' }, parts: [{ type: 'text', text: 'Historical work '.repeat(12000) }] } },
        { record: { info: { id: 'recent', role: 'user' }, parts: [{ type: 'text', text: 'Keep this complete recent turn' }] } },
      ],
      target: { model: { providerID: 'codex-native', modelID: 'codex-model' } },
      catalog: { models: [{ id: 'codex-model', contextWindow: 64000 }] },
      signal: new AbortController().signal,
      smallModels: async () => ({
        describeSmallModel: async ({ overrideModel }) => {
          descriptions.push(overrideModel);
          return overrideModel.startsWith('codex-native/') ? { hasLogin: true, inputCharBudget: 32000 } : null;
        },
        generateSmallModelText: async ({ model }) => { models.push(model); return { text: 'Preserved earlier work', inputTruncated: false }; },
      }),
      saveCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
    });
    expect(descriptions).toEqual(['antigravity-native/gemini-test', 'codex-native/codex-model']);
    expect(models.length).toBeGreaterThan(1);
    expect(new Set(models)).toEqual(new Set(['codex-native/codex-model']));
    expect(context).toContain('Preserved earlier work');
    expect(context).toContain('Keep this complete recent turn');
    expect(checkpoints).toEqual([{ text: 'Preserved earlier work', through: 'older', revision: 2 }]);
  });

  it('prepares a handoff for a saved Opus id after the picker merges it into the gateway row', async () => {
    const context = await prepareConversationContext({
      manifest: { directory: '/fixture', segments: [] },
      entries: [{ record: { info: { id: 'message', role: 'user' }, parts: [{ type: 'text', text: 'Continue the work' }] } }],
      target: { model: { providerID: 'claude-native', modelID: 'opus' } },
      catalog: { models: [{ id: 'connection:gateway:opus', contextWindow: 1000000, aliases: [{ id: 'opus' }] }] },
      signal: new AbortController().signal,
      smallModels: async () => { throw new Error('A short history must not generate a summary'); },
      saveCheckpoint: async () => {},
    });
    expect(context).toContain('Continue the work');
    expect(context).toContain('not a request to replay tools');
  });
});
