import { describe, expect, it } from 'vitest';
import { prepareConversationContext } from './context.js';
import { projectConversationRecord } from './history.js';
import { projectAntigravityHistory } from '../antigravity/projector.js';
import { parseAgyTranscript } from '../antigravity/protocol.js';

describe('conversation context model aliases', () => {
  it('hands off validated Antigravity tasks and child reports while keeping reasoning at the source', async () => {
    const parent = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
    const child = '410d8822-277d-48ee-a2eb-42b5c19688dc';
    const message = (sender, text) => '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-31T02:01:00Z sender='
      + sender + ' priority=MESSAGE_PRIORITY_HIGH content=' + text + '\n</SYSTEM_MESSAGE>';
    const project = (nativeId, steps, relationships) => {
      const entries = parseAgyTranscript(steps.map((step) => JSON.stringify({
        status: 'DONE', created_at: '2026-10-31T02:00:00Z', ...step,
      })).join('\n') + '\n').entries;
      return projectAntigravityHistory({ sessionId: 'nag_' + nativeId, nativeId, directory: '/fixture', entries,
        bindings: new Map(), ...relationships });
    };
    const sources = [
      { nativeId: child, records: project(child, [
        { step_index: 0, type: 'SYSTEM_MESSAGE', content: message(parent, 'Inspect the fixture tests.') },
        { step_index: 1, type: 'PLANNER_RESPONSE', thinking: 'Private fixture reasoning', content: 'Tests inspected.' },
      ], { parentSessionId: 'nag_' + parent }) },
      { nativeId: parent, records: project(parent, [
        { step_index: 0, type: 'USER_INPUT', content: 'Investigate the project.' },
        { step_index: 1, type: 'SYSTEM_MESSAGE', content: message(child, 'Fixture report: all assertions verified.') },
      ], { childSessionIds: ['nag_' + child] }) },
    ];
    const entries = sources.flatMap(({ nativeId, records }) => records.map((record) => ({ record: projectConversationRecord(
      'ncv_fixture', { sessionId: 'nag_' + nativeId, ownerId: 'ncv_fixture', sends: [], timeOffset: 100 }, record,
    ) })));
    const reasoning = entries.flatMap((entry) => entry.record.parts).find((part) => part.type === 'reasoning');
    expect(reasoning.sessionID).toBe('ncv_fixture');
    expect(reasoning.id).toMatch(/^ncv_p_/);
    const context = await prepareConversationContext({
      manifest: { directory: '/fixture', segments: [] }, entries,
      target: { model: { providerID: 'codex-native', modelID: 'test' } },
      catalog: { models: [{ id: 'test', contextWindow: 64000 }] },
      signal: new AbortController().signal,
      smallModels: async () => { throw new Error('Short context needs no summary'); },
      saveCheckpoint: async () => {},
    });
    expect(context).toContain('[user]\nInspect the fixture tests.');
    expect(context).toContain('[assistant]\nFixture report: all assertions verified.');
    expect(context).not.toContain('Private fixture reasoning');
    expect(context).not.toContain('<SYSTEM_MESSAGE>');
  });

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
