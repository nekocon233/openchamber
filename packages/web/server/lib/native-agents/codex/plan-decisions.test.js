import { describe, expect, it, vi } from 'vitest';

import { createQuestionRegistry } from '../questions.js';
import { createCodexPlanDecisions } from './plan-decisions.js';

const DIRECTORY = '/work/project';
const SESSION_ID = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';
const PLAN = {
  sessionId: SESSION_ID, directory: DIRECTORY, turnId: 'turn-plan', text: 'Add the regression test, then fix the parser.',
  send: { modelID: 'gpt-5.5', variant: 'high-fast', agent: 'plan' },
};

const createHarness = (prompt = async () => {}) => {
  const events = [];
  const sent = [];
  const failures = [];
  const questions = createQuestionRegistry({ publish: (directory, payload) => events.push({ directory, payload }) });
  const decisions = createCodexPlanDecisions({
    questions,
    prompt: async (sessionId, request, signal) => { await prompt(signal); sent.push({ sessionId, request }); },
    failed: (plan, error) => failures.push({ plan, error }),
  });
  decisions.propose(PLAN);
  const [question] = questions.list(DIRECTORY);
  return { decisions, questions, question, events, sent, failures };
};

describe('Codex plan decisions between turns', () => {
  it('keeps one discoverable question and sends an approved plan through the prompt owner once', async () => {
    const { decisions, questions, question, events, sent } = createHarness();
    decisions.propose(PLAN);
    expect(questions.list(DIRECTORY)).toEqual([question]);
    expect(questions.list('/other')).toEqual([]);
    expect(question).toMatchObject({
      sessionID: SESSION_ID, kind: 'codex-plan-exit',
      questions: [{ question: PLAN.text, options: [{ label: 'build' }, { label: 'plan' }] }],
    });
    expect(decisions.has(SESSION_ID)).toBe(true);
    questions.reply(question.id, [['build']]);
    expect(() => questions.reply(question.id, [['build']])).toThrow('No pending native question');
    await vi.waitFor(() => expect(decisions.has(SESSION_ID)).toBe(false));
    expect(sent).toEqual([{ sessionId: SESSION_ID, request: {
      directory: DIRECTORY, messageID: expect.stringMatching(/^ncx_u_[0-9a-f-]+$/),
      parts: [{ type: 'text', text: 'Implement the plan.' }],
      model: { providerID: 'codex-native', modelID: PLAN.send.modelID }, variant: 'high-fast', agent: 'build',
    } }]);
    expect(questions.list(DIRECTORY)).toEqual([]);
    expect(events.map((event) => event.payload.type)).toEqual(['question.asked', 'question.replied']);
  });

  it.each([[], [[]], [['']], [['  ']], [['plan']], [['build', 'plan']], [['build'], ['plan']]].map((answers) => ({ answers })))('does not execute an unapproved answer $answers', async ({ answers }) => {
    const { decisions, questions, question, sent } = createHarness();
    questions.reply(question.id, answers);
    await vi.waitFor(() => expect(decisions.has(SESSION_ID)).toBe(false));
    expect(sent).toEqual([]);
  });

  it('sends feedback in plan mode and offers the next revision separately', async () => {
    const { decisions, questions, question, sent } = createHarness();
    const feedback = 'Cover malformed input first.\nKeep the existing API.';
    questions.reply(question.id, [[feedback]]);
    await vi.waitFor(() => expect(decisions.has(SESSION_ID)).toBe(false));
    expect(sent[0].request).toMatchObject({ parts: [{ type: 'text', text: feedback }], agent: 'plan', variant: 'high-fast' });
    decisions.propose({ ...PLAN, turnId: 'revision', text: 'Revised plan' });
    const [revision] = questions.list(DIRECTORY);
    expect(revision.id).not.toBe(question.id);
    expect(revision.questions[0].question).toBe('Revised plan');
    decisions.clear();
  });

  it.each(['reject', 'cancel', 'clear'])('leaves planning in place on %s', async (action) => {
    const { decisions, questions, question, sent, failures } = createHarness();
    if (action === 'reject') questions.reject(question.id);
    else if (action === 'cancel') decisions.cancel(SESSION_ID);
    else decisions.clear();
    await vi.waitFor(() => expect(decisions.has(SESSION_ID)).toBe(false));
    expect(questions.list(DIRECTORY)).toEqual([]);
    expect(sent).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('cancels an answer invalidated before its continuation begins', async () => {
    const { decisions, questions, question, sent, failures } = createHarness();
    questions.reply(question.id, [['build']]);
    decisions.cancel(SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('keeps the decision cancellable while the prompt prepares its snapshot or resume', async () => {
    let release;
    const preparation = new Promise((resolve) => { release = resolve; });
    const { decisions, questions, question, sent, failures } = createHarness(async (signal) => {
      await preparation;
      signal.throwIfAborted();
    });
    questions.reply(question.id, [['build']]);
    await Promise.resolve();
    expect(decisions.has(SESSION_ID)).toBe(true);
    decisions.cancel(SESSION_ID);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('reports a failed start once without retrying or retaining a pending decision', async () => {
    const { decisions, questions, question, sent, failures } = createHarness(async () => { throw new Error('Codex unavailable'); });
    questions.reply(question.id, [['build']]);
    await vi.waitFor(() => expect(decisions.has(SESSION_ID)).toBe(false));
    expect(sent).toEqual([]);
    expect(failures).toEqual([{ plan: PLAN, error: expect.objectContaining({ message: 'Codex unavailable' }) }]);
  });

  it('supersedes an older question without cancelling an unrelated session', async () => {
    const { decisions, questions, question } = createHarness();
    const otherSession = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e11';
    decisions.propose({ ...PLAN, sessionId: otherSession });
    decisions.propose({ ...PLAN, turnId: 'new-plan' });
    expect(questions.list(DIRECTORY)).toHaveLength(2);
    expect(() => questions.reply(question.id, [['build']])).toThrow('No pending native question');
    await Promise.resolve();
    expect(decisions.has(SESSION_ID)).toBe(true);
    expect(decisions.has(otherSession)).toBe(true);
    decisions.clear();
  });
});
