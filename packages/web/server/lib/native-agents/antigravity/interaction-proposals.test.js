import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGY_PLAN_QUESTION_PREFIX } from './interaction-signals.js';
import { agyInteractionHistory, agyInteractionProposal } from './interaction-proposals.js';

const NATIVE_ID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const ROOT = path.resolve('/tmp/openchamber-agy-interaction-proposals');
const PLAN = '# Plan\n\nReview the files, then apply the agreed change.';
const entry = (step_index, type, extra = {}) => ({
  step_index, type, status: 'DONE', tool_calls: [], truncated_fields: [], created_at: '2026-10-31T01:00:00Z', ...extra,
});
const ask = (question = 'Which scope?', options = ['File', 'Module']) => ({
  name: 'ask_question', args: { questions: [{ question, options, is_multi_select: false }] }, argumentsEncoded: false,
});
const markedPlan = (plan = PLAN) => ask(`${AGY_PLAN_QUESTION_PREFIX}${plan}`, ['build', 'plan']);
const artifact = () => ({
  name: 'write_file',
  args: {
    Path: path.join(ROOT, 'brain', NATIVE_ID, 'implementation_plan.md'), Content: PLAN,
    ArtifactMetadata: { RequestFeedback: true, UserFacing: true },
  },
  argumentsEncoded: false,
});
const round = (start = 0, call = ask(), output = 'Q1: Which scope?\nA1: User Skipped') => [
  entry(start, 'USER_INPUT', { content: 'Investigate the change.' }),
  entry(start + 1, 'PLANNER_RESPONSE', { tool_calls: [call] }),
  entry(start + 2, 'GENERIC', { content: output }),
  entry(start + 3, 'PLANNER_RESPONSE', { content: 'Please review the proposal.' }),
];
const send = (stepIndex = 0, overrides = {}) => ({
  messageId: `client-${stepIndex}`, providerID: 'antigravity-native', modelID: 'gemini-test', variant: 'high', agent: 'plan', sentAt: 1000 + stepIndex,
  antigravity: { stepIndex, completion: { outcome: 'success', time: 2000 + stepIndex } }, ...overrides,
});
const input = (entries = round(), sends = [send()]) => ({
  entries, nativeId: NATIVE_ID, sessionId: `nag_${NATIVE_ID}`, directory: path.resolve('/tmp/project'), readRoot: ROOT,
  sends: new Map(sends.map((value) => [value.messageId, value])),
  bindings: new Map(sends.map((value) => [value.antigravity.stepIndex, value])),
  now: () => 3000,
});

describe('Antigravity application interaction proposals', () => {
  it('adds a separate completed question tool on the final assistant without mutating native history', () => {
    const source = input();
    const before = structuredClone(source.entries);
    const result = agyInteractionProposal(source);
    expect(result.proposal).toMatchObject({
      sessionId: source.sessionId, directory: source.directory, userStep: 0,
      questions: [{ question: 'Which scope?', header: '', multiple: false }],
      send: { modelID: 'gemini-test', variant: 'high', agent: 'plan' },
    });
    expect(result.proposal.kind).toBeUndefined();
    expect(result.messageID).toBe(`nag_a_${NATIVE_ID.replaceAll('-', '')}_3`);
    expect(result.part).toMatchObject({
      type: 'tool', tool: 'question', messageID: result.messageID, callID: result.proposal.callID,
      state: { status: 'completed', input: { questions: result.proposal.questions } },
    });
    expect(result.proposal.tool).toEqual({ messageID: result.messageID, callID: result.proposal.callID });
    expect(source.entries).toEqual(before);
  });

  it('keeps stable identities across reads and changes the revision when an explicit plan changes', () => {
    const source = input(round(0, markedPlan()));
    const first = agyInteractionProposal(source);
    expect(agyInteractionProposal({ ...source, now: () => 9999 })).toEqual(first);
    expect(first.proposal).toMatchObject({ kind: 'antigravity-plan-exit', plan: PLAN });
    expect(first.part).toMatchObject({ tool: 'plan_exit', state: { input: { plan: PLAN }, metadata: { nativeQuestionKind: 'antigravity-plan-exit' } } });
    const updated = agyInteractionProposal(input(round(0, markedPlan('Updated plan.'))));
    expect(updated.proposal.revision).not.toBe(first.proposal.revision);
    expect(updated.proposal.callID).not.toBe(first.proposal.callID);
  });

  it.each(['A1:', 'A1: ', 'Created At: 2026-11-09T14:10:39+08:00\r\nCompleted At: 2026-11-09T14:10:48+08:00\r\nA1: \t'])('restores a plan with a numbered blank native answer: %j', (output) => {
    const source = input(round(0, markedPlan(), output));
    const before = structuredClone(source.entries);
    const result = agyInteractionProposal(source);
    expect(result?.proposal).toMatchObject({ kind: 'antigravity-plan-exit', plan: PLAN });
    expect(result?.part).toMatchObject({ tool: 'plan_exit', state: { input: { plan: PLAN } } });
    expect(agyInteractionHistory(source).latest).toEqual(result);
    expect(source.entries).toEqual(before);
  });

  it.each(['A1: \nA2: ', 'A1: User Skipped\r\nA2:\t'])('restores questions only when every numbered native answer is unanswered: %j', (output) => {
    const call = ask();
    call.args.questions.push(ask('Which checks?', ['Lint', 'Tests']).args.questions[0]);
    expect(agyInteractionProposal(input(round(0, call, output)))?.proposal.questions)
      .toMatchObject([{ question: 'Which scope?' }, { question: 'Which checks?' }]);
    for (const answered of ['A1: \nA2: Lint', 'A1: File\nA2: ', 'A1: ', 'A1: \nA1: ', 'A2: \nA1: ']) {
      expect(agyInteractionProposal(input(round(0, call, answered)))).toBeNull();
    }
  });

  it('removes a terminal plan closing tag while retaining its existing decision identity', () => {
    const source = input(round(0, markedPlan(`${PLAN}\n</openchamber-plan-v1>`)));
    const before = structuredClone(source.entries);
    const result = agyInteractionProposal(source);
    expect(result.proposal.plan).toBe(PLAN);
    expect(result.proposal.questions[0].question).toBe(PLAN);
    expect(result.part.state.input.plan).toBe(PLAN);
    expect(result.proposal.revision).toBe('8e9c440b7f9a6203c5ee81817246f9b9f819bb5fb039453fa4b7577ebb46856d');
    expect(source.entries).toEqual(before);
  });

  it('accepts a closing tag on a CRLF line with trailing whitespace', () => {
    const result = agyInteractionProposal(input(round(0, markedPlan(`${PLAN}\r\n  </openchamber-plan-v1> \r\n\t`))));
    expect(result.proposal.plan).toBe(PLAN);
    expect(result.proposal.questions[0].question).toBe(PLAN);
  });

  it.each(['</openchamber-plan-v1>', ' \n</openchamber-plan-v1>\n'])('refuses a plan containing only its closing tag: %j', (body) => {
    expect(agyInteractionProposal(input(round(0, markedPlan(body))))).toBeNull();
  });

  it('preserves closing tags in ordinary questions and inside plan examples', () => {
    const literal = `${PLAN}\n\n\`\`\`xml\n</openchamber-plan-v1>\n\`\`\``;
    expect(agyInteractionProposal(input(round(0, markedPlan(literal)))).proposal.plan).toBe(literal);
    const ordinary = `Explain this tag:\n</openchamber-plan-v1>`;
    expect(agyInteractionProposal(input(round(0, ask(ordinary)))).proposal.questions[0].question).toBe(ordinary);
  });

  it('aggregates unresolved questions and prioritizes them over a marked plan in the same round', () => {
    const entries = [
      entry(0, 'USER_INPUT'),
      entry(1, 'PLANNER_RESPONSE', { tool_calls: [ask(), ask('Which checks?', ['Lint', 'Tests']), markedPlan()] }),
      entry(2, 'GENERIC', { content: 'A1: User Skipped' }),
      entry(3, 'GENERIC', { content: 'A1: User Skipped' }),
      entry(4, 'GENERIC', { content: 'A1: User Skipped' }),
      entry(5, 'PLANNER_RESPONSE', { content: 'Please decide.' }),
    ];
    expect(agyInteractionProposal(input(entries)).proposal.questions.map((question) => question.question)).toEqual(['Which scope?', 'Which checks?']);
    expect(agyInteractionProposal(input(entries)).proposal.kind).toBeUndefined();
  });

  it('selects the latest marked plan rather than an earlier marked or later legacy artifact', () => {
    const entries = [
      entry(0, 'USER_INPUT'),
      entry(1, 'PLANNER_RESPONSE', { tool_calls: [markedPlan('Earlier plan.'), markedPlan('Latest marked plan.'), artifact()] }),
      entry(2, 'GENERIC', { content: 'A1: User Skipped' }),
      entry(3, 'GENERIC', { content: 'A1: User Skipped' }),
      entry(4, 'GENERIC', { status: 'ERROR', content: 'Write denied.' }),
      entry(5, 'PLANNER_RESPONSE', { content: 'Please review.' }),
    ];
    expect(agyInteractionProposal(input(entries)).proposal.plan).toBe('Latest marked plan.');
  });

  it('restores a legacy plan proposal only with complete final text and explicit native artifact feedback metadata', () => {
    const legacy = send(0, { antigravity: { stepIndex: 0 } });
    const entries = round(0, artifact(), 'Write denied by policy.');
    entries[2].status = 'ERROR';
    expect(agyInteractionProposal(input(entries, [legacy])).proposal.plan).toBe(PLAN);
    expect(agyInteractionProposal(input(round(), [legacy]))).toBeNull();
    expect(agyInteractionProposal(input(round(0, markedPlan()), [legacy]))).toBeNull();
    expect(agyInteractionProposal(input(round(0, artifact()), [send(0, { agent: 'build', antigravity: { stepIndex: 0 } })]))).toBeNull();
  });

  it.each(['error', 'aborted'])('refuses explicit %s completion even with complete final text and an artifact', (outcome) => {
    expect(agyInteractionProposal(input(round(0, artifact()), [send(0, { antigravity: { stepIndex: 0, completion: { outcome, time: 2 } } })]))).toBeNull();
  });

  it.each([
    { status: 'RUNNING' },
    { status: undefined },
    { content: '' },
    { truncated_fields: ['content'] },
    { tool_calls: [ask()] },
  ])('refuses an incomplete final response: %j', (extra) => {
    const entries = round();
    entries[3] = { ...entries[3], ...extra };
    expect(agyInteractionProposal(input(entries))).toBeNull();
  });

  it('refuses truncated tool arguments and truncated native question outcomes', () => {
    const partialArguments = round();
    partialArguments[1].truncated_fields = ['tool_calls'];
    expect(agyInteractionProposal(input(partialArguments))).toBeNull();
    const partialOutput = round();
    partialOutput[2].truncated_fields = ['content'];
    expect(agyInteractionProposal(input(partialOutput))).toBeNull();
  });

  it.each(['A1: File', 'A1: User Skipped on purpose', '', 'Q1: User Skipped\nA1: File'])('does not reactivate a native answer or an unknown outcome: %s', (output) => {
    expect(agyInteractionProposal(input(round(0, ask(), output)))).toBeNull();
  });

  it('refuses an unbound external turn, a mismatched send and invalid native ownership', () => {
    const source = input();
    expect(agyInteractionProposal({ ...source, bindings: new Map() })).toBeNull();
    expect(agyInteractionProposal({ ...source, sends: new Map() })).toBeNull();
    expect(agyInteractionProposal({ ...source, sends: new Map([['client-0', send(9)]]) })).toBeNull();
    expect(agyInteractionProposal({ ...source, sessionId: 'nag_another-session' })).toBeNull();
    expect(agyInteractionProposal({ ...source, readRoot: 'relative' })).toBeNull();
  });

  it('retains a question tool from an earlier round after a follow-up starts', () => {
    const first = round();
    const latest = entry(4, 'USER_INPUT', { content: 'File' });
    const source = input([...first, latest], [send(), send(4, { antigravity: { stepIndex: 4 } })]);
    const history = agyInteractionHistory(source);
    expect(history.proposals).toHaveLength(1);
    expect(history.proposals[0]).toEqual(agyInteractionProposal(input(first)));
    expect(history.latest).toBeNull();
    expect(agyInteractionProposal(source)).toBeNull();
  });

  it('retains completed question and plan tools across rounds while exposing only the latest proposal', () => {
    const source = input([...round(), ...round(4, markedPlan())], [send(), send(4)]);
    const history = agyInteractionHistory(source);
    expect(history.proposals.map((result) => result.part.tool)).toEqual(['question', 'plan_exit']);
    expect(history.latest).toEqual(history.proposals[1]);
    expect(history.latest).toEqual(agyInteractionProposal(source));
    expect(history.proposals[0].proposal.callID).not.toBe(history.proposals[1].proposal.callID);
  });

  it('does not recover an older proposal as current after a newer external or failed round', () => {
    const source = input([...round(), ...round(4)], [send()]);
    const history = agyInteractionHistory(source);
    expect(history.proposals).toHaveLength(1);
    expect(history.latest).toBeNull();
    expect(agyInteractionProposal(source)).toBeNull();
  });

  it.each([
    'tool_calls[0].args.questions',
    'tool_calls.0.args.Content',
    '/tool_calls/0/args/Content',
    '$.tool_calls[0].args',
  ])('refuses nested transcript argument truncation instead of approving valid remaining JSON: %s', (field) => {
    for (const call of [markedPlan(), artifact()]) {
      const entries = round(0, call);
      entries[1].truncated_fields = [field];
      expect(agyInteractionProposal(input(entries))).toBeNull();
    }
  });

  it('does not treat unrelated thinking truncation as truncated interaction arguments', () => {
    const entries = round();
    entries[1].truncated_fields = ['thinking'];
    expect(agyInteractionProposal(input(entries))?.proposal.questions).toHaveLength(1);
  });

  it.each([
    { error: 'Native tool failed.' },
    { truncated_fields: ['content[0]'] },
    { truncated_fields: ['/content/0'] },
    { content: 'A1: User Skipped\n<truncated 12 bytes>' },
    { content: 'A1: User Skipped\nA1: Actual answer' },
    { content: 'A1: User Skipped\nA2: Actual answer' },
  ])('refuses error or incomplete native output containing a skipped-answer string: %j', (extra) => {
    const entries = round();
    entries[2] = { ...entries[2], ...extra };
    expect(agyInteractionProposal(input(entries))).toBeNull();
  });

  it.each([
    { error: 'Final response failed.' },
    { truncated_fields: ['content[0]'] },
    { truncated_fields: ['/content/0'] },
    { truncated_fields: ['error'] },
    { content: 'Please review.\n<truncated 12 bytes>' },
  ])('refuses error or text-shortened final responses: %j', (extra) => {
    const entries = round(0, markedPlan());
    entries[3] = { ...entries[3], ...extra };
    expect(agyInteractionProposal(input(entries))).toBeNull();
  });

  it('does not fall back to an older complete plan when a later native plan attempt is truncated', () => {
    const complete = artifact();
    const partial = artifact();
    partial.args.Content = 'Later partial plan.\n<truncated 100 bytes>';
    const entries = [
      entry(0, 'USER_INPUT'),
      entry(1, 'PLANNER_RESPONSE', { tool_calls: [complete, partial] }),
      entry(2, 'GENERIC', { content: 'Write denied.', status: 'ERROR' }),
      entry(3, 'GENERIC', { content: 'Write denied.', status: 'ERROR' }),
      entry(4, 'PLANNER_RESPONSE', { content: 'Please review.' }),
    ];
    expect(agyInteractionProposal(input(entries))).toBeNull();
    entries[1].tool_calls[1] = {
      ...partial, argumentsEncoded: true,
      args: Object.fromEntries(Object.entries(partial.args).map(([key, value]) => [key, JSON.stringify(value)])),
    };
    expect(agyInteractionProposal(input(entries))).toBeNull();
  });
});
