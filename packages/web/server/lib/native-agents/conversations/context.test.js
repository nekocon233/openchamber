import { describe, expect, it } from 'vitest';
import { prepareConversationContext } from './context.js';

describe('conversation context model aliases', () => {
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
