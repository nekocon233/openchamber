import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeInteractions } from './interactions.js';

const roots = [];
const sessionId = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';
const forkId = 'ncx_01a0d2a6-c000-7000-8000-000000000001';
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const record = (tool, callID) => ({
  info: { id: 'assistant', role: 'assistant', time: { created: 1, completed: 2 } },
  parts: [{ id: 'part', messageID: 'assistant', sessionID: sessionId, type: 'tool', tool, callID,
    state: { status: 'completed', input: { plan: 'A plan', questions: [{ question: 'Q' }] }, metadata: {}, output: '', time: { start: 1, end: 2 } } }],
});

describe('native interaction answers', () => {
  it('preserves lossless answers across owner reloads and only copies retained calls into a fork', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-interactions-'));
    roots.push(root);
    const store = createNativeInteractions({ dataDir: root, now: () => 3 });
    await store.record({ id: 'answer-one', sessionID: sessionId, tool: { callID: 'call-one' } }, { status: 'replied', answers: [['A', 'B'], ['"quoted"\n第二行']] });
    await store.record({ id: 'answer-two', sessionID: sessionId, kind: 'codex-plan-exit', tool: { callID: 'plan-call' } }, { status: 'replied', answers: [['plan']] });
    const reopened = createNativeInteractions({ dataDir: root });
    const attached = await reopened.attach(sessionId, [record('question', 'call-one')]);
    expect(attached[0].parts[0].state.metadata.questionAnswers).toEqual([['A', 'B'], ['"quoted"\n第二行']]);
    const plan = await reopened.attach(sessionId, [record('plan_exit', 'plan-call')]);
    expect(plan[0].parts[1]).toMatchObject({ tool: 'question', state: { metadata: { questionAnswers: [['plan']], nativeQuestionKind: 'codex-plan-exit' } } });
    // The approval settled at 3, after the reply completed at 2; the row keeps
    // the plan tool's interval so it cannot invalidate turn telemetry.
    expect(plan[0].parts[1].state.time).toEqual({ start: 1, end: 2 });
    await reopened.fork(sessionId, forkId, new Set(['call-one']));
    expect((await reopened.attach(forkId, [record('plan_exit', 'plan-call')]))[0].parts).toHaveLength(1);
    expect((await reopened.attach(forkId, [record('question', 'call-one')]))[0].parts[0].state.metadata.questionAnswers).toHaveLength(2);
    await reopened.forget(forkId);
    expect((await reopened.attach(forkId, [record('question', 'call-one')]))[0].parts[0].state.metadata).toEqual({});
  });
});
