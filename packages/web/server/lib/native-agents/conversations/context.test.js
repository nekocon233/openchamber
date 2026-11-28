import { describe, expect, it, vi } from 'vitest';
import { prepareConversationContext } from './context.js';
import { projectConversationRecord } from './history.js';
import { projectAntigravityHistory } from '../antigravity/projector.js';
import { parseAgyTranscript } from '../antigravity/protocol.js';

describe('conversation context model aliases', () => {
  it('reuses the separate Claude summary after its completed compaction boundary', async () => {
    const context = await prepareConversationContext({
      manifest: { directory: '/fixture' },
      entries: [
        { segmentId: 'claude', record: { info: { id: 'old', role: 'user' }, parts: [{ type: 'text', text: 'Covered history '.repeat(20000) }] } },
        { segmentId: 'claude', record: { info: { id: 'boundary', role: 'compaction', status: 'completed', summary: '' }, parts: [] } },
        { segmentId: 'claude', record: { info: { id: 'summary', role: 'assistant', summary: true }, parts: [{ type: 'text', text: 'Native Claude checkpoint' }] } },
        { segmentId: 'claude', record: { info: { id: 'recent', role: 'user' }, parts: [
          { type: 'text', text: 'Continue this work' },
          { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'data:text/plain;base64,UmV0YWluZWQgbm90ZXMu' },
        ] } },
      ],
      target: { model: { providerID: 'codex-native', modelID: 'codex-model' } },
      catalog: { models: [{ id: 'codex-model', contextWindow: 64000 }] },
      signal: new AbortController().signal,
      smallModels: async () => { throw new Error('A completed native summary must be reused'); },
      saveCheckpoint: async () => {},
    });
    expect(context).toContain('Native Claude checkpoint');
    expect(context).toContain('Continue this work');
    expect(context).toContain('Attached file notes.txt:\n\nRetained notes.');
    expect(context).not.toContain('Covered history');
  });
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


describe('first Antigravity side question', () => {
  const model = { providerID: 'antigravity-native', modelID: 'gemini-test' };
  const request = (overrides = {}) => ({
    manifest: {
      directory: '/fixture', active: null, segments: [], historyRevision: 0,
      metadata: { openchamber: { kind: 'btw' } },
    },
    entries: [
      { record: { info: { id: 'earlier', role: 'user' }, parts: [{ type: 'text', text: 'Original user request' }] } },
      { record: { info: { id: 'tool', role: 'assistant' }, parts: [{
        type: 'tool', tool: 'read', state: {
          status: 'completed', title: 'Read fixture', input: { path: 'notes.txt' },
          output: `Start of older output\n${'x'.repeat(1_100_000)}\nMiddle of older output\n${'x'.repeat(1_100_000)}\nEnd of older output`,
        },
      }] } },
      { record: { info: { id: 'recent', role: 'user' }, parts: [{ type: 'text', text: 'Recent user request' }] } },
      { record: { info: {
        id: 'answer', role: 'assistant', time: { completed: 1 }, ...model, variant: 'high',
        contextWindow: 1_000_000, metadata: { nativeContextSource: 'provider' },
      }, parts: [
        { type: 'text', text: 'Recent answer' },
        { type: 'tool', tool: 'bash', state: { status: 'completed', input: {}, output: 'Complete recent result' } },
      ] } },
    ],
    target: { model, variant: 'high' },
    catalog: { models: [{ id: model.modelID, contextWindow: null }] },
    signal: new AbortController().signal,
    smallModels: async () => ({ describeSmallModel: async () => null }),
    saveCheckpoint: async () => {},
    ...overrides,
  });

  it.each(['gemini-test', 'gemini-test-high'])('fits long inherited history measured on %s', async (sourceModelID) => {
    const input = request({ smallModels: async () => { throw new Error('This side question needs no utility model'); } });
    input.entries[3].record.info.modelID = sourceModelID;
    input.catalog.models[0].aliases = [{ id: 'gemini-test-high' }];
    const context = await prepareConversationContext(input);
    expect(context).toContain('Original user request');
    expect(context).toContain('notes.txt');
    expect(context).toContain('Start of older output');
    expect(context).not.toContain('Middle of older output');
    expect(context).toContain('End of older output');
    expect(context).toContain('Recent user request');
    expect(context).toContain('Complete recent result');
    expect(Buffer.byteLength(context)).toBeLessThan(177_000);
    expect(input.entries[1].record.parts[0].state.output).toContain('Middle of older output');
  });

  it('keeps the latest whole turn when it fits in more than half of the window', async () => {
    const input = request();
    const older = input.entries[1].record.parts[0].state;
    const lastReply = input.entries[3].record;
    const recent = lastReply.parts[1].state;
    older.output = `Earlier start${'x'.repeat(20_000)}Earlier middle${'x'.repeat(20_000)}Earlier end`;
    recent.output = `Recent start${'y'.repeat(6_000)}Recent middle${'y'.repeat(6_000)}Recent end`;
    lastReply.info.contextWindow = 10_000;

    const context = await prepareConversationContext(input);
    expect(context?.includes(recent.output)).toBe(true);
    expect(context).toContain('Earlier start');
    expect(context).not.toContain('Earlier middle');
    expect(context).toContain('Earlier end');
  });

  it('fits the latest whole turn when multiple recent turns would force a summary', async () => {
    const input = request();
    input.entries[0].record.parts[0].text = `Earlier user request ${'x'.repeat(14_500)}`;
    input.entries[3].record.info.contextWindow = 10_000;
    input.entries.splice(2, 0,
      { record: { info: { id: 'middle-user', role: 'user' }, parts: [{ type: 'text', text: 'Retain the middle request' }] } },
      { record: { info: { id: 'middle-tool', role: 'assistant' }, parts: [{ type: 'tool', tool: 'read', state: {
        status: 'completed', title: 'Read middle', input: {}, output: `Middle start${'m'.repeat(6_500)}Middle end`,
      } }] } },
    );
    const context = await prepareConversationContext(input);
    expect(context).toContain('Retain the middle request');
    expect(context).toContain('Middle start');
    expect(context).toContain('Middle end');
    expect(context).toContain('Complete recent result');
  });

  it('uses the configured summary when the remaining space cannot keep both ends of a result', async () => {
    const input = request({ smallModels: async () => ({
      describeSmallModel: async ({ overrideModel }) => overrideModel ? null : {
        hasLogin: true, source: 'settings', providerID: 'codex-native', modelID: 'configured', inputCharBudget: 8_000,
      },
      generateSmallModelText: async () => ({ text: 'Earlier result summary' }),
    }) });
    const user = input.entries[0].record.parts[0];
    input.entries[1].record.parts[0].state.output = `😀${'x'.repeat(9_000)}🚀`;
    input.entries[3].record.info.contextWindow = 2_000;
    let excerpts = 0;
    let summaries = 0;
    for (let length = 3_720; length <= 3_940; length += 1) {
      user.text = 'y'.repeat(length);
      const context = await prepareConversationContext(input);
      if (context?.includes('Earlier result summary')) summaries += 1;
      else {
        expect(context?.includes('😀')).toBe(true);
        expect(context?.includes('🚀')).toBe(true);
        expect(context?.isWellFormed()).toBe(true);
        excerpts += 1;
      }
    }
    expect(excerpts).toBeGreaterThan(0);
    expect(summaries).toBeGreaterThan(0);
  });

  it('uses the conservative budget when the observed window belongs to another effort', async () => {
    await expect(prepareConversationContext(request({ target: { model, variant: 'low' } })))
      .rejects.toMatchObject({ code: 'NATIVE_CONVERSATION_SUMMARY_UNAVAILABLE' });
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
