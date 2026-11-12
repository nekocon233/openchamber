import { describe, expect, it, vi } from 'vitest';
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
    expect(descriptions).toEqual(['antigravity-native/gemini-test', undefined]);
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


describe('native compaction handoff boundaries', () => {
  const entry = (id, text, segmentId = 'agy') => ({ segmentId, record: { info: { id, role: 'user' }, parts: [{ type: 'text', text }] } });
  const checkpoint = (status = 'completed', summary = 'Native summary', metadata) => ({ segmentId: 'agy', record: {
    info: { id: 'checkpoint', role: 'compaction', status, summary, metadata }, parts: [],
  } });
  const request = (entries, overrides = {}) => ({
    manifest: { directory: '/fixture', historyRevision: 0, segments: [{ id: 'agy', sends: [{ selection: { model: { providerID: 'antigravity-native', modelID: 'gemini' } } }] }], active: 'agy' },
    entries,
    target: { model: { providerID: 'deepseek-native', modelID: 'deepseek' } },
    catalog: { models: [{ id: 'deepseek', contextWindow: 64000 }] },
    signal: new AbortController().signal,
    smallModels: async () => ({ describeSmallModel: async () => null }),
    saveCheckpoint: async () => {},
    ...overrides,
  });

  it('reuses a completed native summary only inside its own execution segment', async () => {
    const context = await prepareConversationContext(request([
      entry('other', 'Keep the Claude segment', 'claude'),
      entry('old', 'Covered tool output '.repeat(12000)),
      checkpoint(),
      entry('recent', 'Continue after native compaction'),
    ], { smallModels: async () => { throw new Error('A retained native summary fits without another model call'); } }));
    expect(context).toContain('Keep the Claude segment');
    expect(context).toContain('Native summary');
    expect(context).toContain('Continue after native compaction');
    expect(context).not.toContain('Covered tool output');
  });

  it.each([
    ['running', 'Native summary', undefined], ['failed', 'Native summary', undefined],
    ['completed', '', undefined], ['completed', 'Native summary', { nativeOutputTruncated: true }],
  ])('preserves the source prefix when its checkpoint is %s or incomplete', async (status, summary, metadata) => {
    await expect(prepareConversationContext(request([
      entry('old', 'Preserve uncovered history '.repeat(10000)), checkpoint(status, summary, metadata),
    ]))).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_SUMMARY_UNAVAILABLE' });
  });

  it('uses only an explicitly configured Small Model when neither CLI offers a summary', async () => {
    const calls = [];
    const context = await prepareConversationContext(request([entry('old', 'Historical work '.repeat(10000))], {
      smallModels: async () => ({
        describeSmallModel: async (options) => options.overrideModel ? null
          : { source: 'settings', providerID: 'codex-native', modelID: 'configured', hasLogin: true, inputCharBudget: 32000 },
        generateSmallModelText: async (options) => { calls.push(options.model); return { text: 'Explicitly selected summary' }; },
      }),
    }));
    expect(context).toContain('Explicitly selected summary');
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(['codex-native/configured']));
  });
});


describe('handoff summary failure boundaries', () => {
  const request = (service, overrides = {}) => ({
    manifest: { directory: '/fixture', historyRevision: 0, segments: [{ id: 'source', sends: [{ selection: { model: { providerID: 'antigravity-native', modelID: 'gemini' } } }] }], active: 'source' },
    entries: [{ segmentId: 'source', record: { info: { id: 'history', role: 'user' }, parts: [{ type: 'text', text: 'History '.repeat(30000) }] } }],
    target: { model: { providerID: 'codex-native', modelID: 'selected' } },
    catalog: { models: [{ id: 'selected', contextWindow: 64000 }] },
    signal: new AbortController().signal,
    smallModels: async () => service,
    saveCheckpoint: async () => {}, ...overrides,
  });

  it('restarts a failed summary on the explicitly configured model and saves only its complete result', async () => {
    const models = [], checkpoints = [];
    const context = await prepareConversationContext(request({
      describeSmallModel: async ({ overrideModel }) => {
        if (overrideModel?.startsWith('antigravity-native/')) return null;
        return overrideModel ? { hasLogin: true, inputCharBudget: 32000 }
          : { hasLogin: true, inputCharBudget: 32000, source: 'settings', providerID: 'codex-native', modelID: 'configured' };
      },
      generateSmallModelText: async ({ model }) => {
        models.push(model);
        if (model.endsWith('/selected')) throw new Error('Selected CLI refused the summary');
        return { text: 'Complete configured summary' };
      },
    }, { saveCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); } }));
    expect(models[0]).toBe('codex-native/selected');
    expect(models.slice(1).every((model) => model === 'codex-native/configured')).toBe(true);
    expect(context).toContain('Complete configured summary');
    expect(checkpoints).toEqual([{ text: 'Complete configured summary', through: 'history', revision: 0 }]);
  });

  it('refuses an implicit model instead of sending history to it', async () => {
    let generated = false;
    await expect(prepareConversationContext(request({
      describeSmallModel: async ({ overrideModel }) => overrideModel ? null
        : { source: 'default', providerID: 'other', modelID: 'automatic', hasLogin: true, inputCharBudget: 32000 },
      generateSmallModelText: async () => { generated = true; return { text: 'Unexpected' }; },
    }))).rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_SUMMARY_UNAVAILABLE' });
    expect(generated).toBe(false);
  });

  it('stops after cancellation without trying the configured fallback', async () => {
    const controller = new AbortController(), descriptions = [];
    await expect(prepareConversationContext(request({
      describeSmallModel: async ({ overrideModel }) => { descriptions.push(overrideModel); return overrideModel?.startsWith('codex-native/') ? { hasLogin: true, inputCharBudget: 32000 } : null; },
      generateSmallModelText: async () => { controller.abort(new Error('Cancelled')); throw new Error('Stopped'); },
    }, { signal: controller.signal }))).rejects.toThrow('Cancelled');
    expect(descriptions).toEqual(['antigravity-native/gemini', 'codex-native/selected']);
  });

  it('enforces enterprise mode before a handoff summary generation', async () => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    let generated = false;
    try {
      await expect(prepareConversationContext(request({
        describeSmallModel: async () => ({ hasLogin: true, inputCharBudget: 32000 }),
        generateSmallModelText: async () => { generated = true; return { text: 'Unexpected' }; },
      }))).rejects.toMatchObject({ code: 'enterprise_mode' });
      expect(generated).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
});
