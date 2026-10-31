import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGY_PLAN_QUESTION_PREFIX, parseAgyInteractionSignal } from './interaction-signals.js';

const NATIVE_ID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const OTHER_NATIVE_ID = 'aa979243-d4d5-433e-bc44-03a2732e2308';
const ROOT = path.resolve('/tmp/openchamber-agy-interaction-signals');
const context = { nativeId: NATIVE_ID, readRoot: ROOT };
const PLAN = '# Implementation plan\n\n1. Review the input.\n2. Apply the agreed change.\n';
const question = (overrides = {}) => ({
  question: 'Which scope should be used?', options: ['Current file', 'Whole module'], is_multi_select: false, ...overrides,
});
const ask = (questions = [question()]) => ({ name: 'ask_question', args: { questions } });
const planQuestion = (overrides = {}) => ask([question({
  question: `${AGY_PLAN_QUESTION_PREFIX}${PLAN}`, options: ['build', 'plan'], ...overrides,
})]);
const artifact = (overrides = {}) => ({
  name: 'write_file',
  args: {
    Path: path.join(ROOT, 'brain', NATIVE_ID, 'implementation_plan.md'),
    Content: PLAN,
    Overwrite: true,
    ArtifactMetadata: { RequestFeedback: true, UserFacing: true, Summary: 'Review the proposed change.' },
    ...overrides,
  },
});
const encoded = (call) => ({
  ...call,
  argumentsEncoded: true,
  args: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, JSON.stringify(value)])),
});

describe('Antigravity interaction signals', () => {
  it('normalizes complete questions without assuming a native interaction is pending', () => {
    expect(parseAgyInteractionSignal(ask([
      question(), question({ question: 'Select the checks.', options: ['Lint', 'Tests'], is_multi_select: true }),
    ]), context)).toEqual({
      kind: 'questions',
      questions: [
        { question: 'Which scope should be used?', header: '', options: [{ label: 'Current file', description: '' }, { label: 'Whole module', description: '' }], multiple: false },
        { question: 'Select the checks.', header: '', options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }], multiple: true },
      ],
    });
  });

  it('recognizes only the versioned plan question with the exact execution choices', () => {
    expect(parseAgyInteractionSignal(planQuestion(), context)).toEqual({
      kind: 'plan', plan: PLAN,
      questions: [{ question: PLAN, header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }], multiple: false }],
    });
    expect(parseAgyInteractionSignal(ask([question({ question: PLAN, options: ['build', 'plan'] })]), context)?.kind).toBe('questions');
    expect(parseAgyInteractionSignal({ name: 'agent_response', args: { content: PLAN } }, context)).toBeNull();
  });

  it.each([
    { question: '<openchamber-plan-v2>\nPlan' },
    { question: '<openchamber-plan-v1>Plan' },
    { question: `${AGY_PLAN_QUESTION_PREFIX} \n\t` },
    { options: ['plan', 'build'] },
    { options: ['Build', 'plan'] },
    { options: ['build', 'plan', 'later'] },
    { is_multi_select: true },
  ])('refuses malformed reserved plan questions without exposing them as ordinary questions: %j', (override) => {
    expect(parseAgyInteractionSignal(planQuestion(override), context)).toBeNull();
  });

  it('refuses a plan marker mixed with another question', () => {
    expect(parseAgyInteractionSignal(ask([question(), planQuestion().args.questions[0]]), context)).toBeNull();
  });

  it.each([
    [], null, 'not an array', [{}],
    [question({ question: '' })],
    [question({ question: ' \n' })],
    [question({ question: 1 })],
    [question({ options: [] })],
    [question({ options: ['Same', 'Same'] })],
    [question({ options: ['Valid', ' '] })],
    [question({ options: [{ label: 'Current file' }] })],
    [question({ is_multi_select: 'false' })],
    [question({ is_multi_select: undefined })],
    [question({ unexpected: true })],
  ])('refuses invalid question arrays: %j', (questions) => {
    expect(parseAgyInteractionSignal(ask(questions), context)).toBeNull();
  });

  it('recovers an exact native plan proposal without requiring its denied write to have saved a file', () => {
    const call = artifact();
    const snapshot = structuredClone(call);
    expect(parseAgyInteractionSignal(call, context)).toMatchObject({ kind: 'plan', plan: PLAN });
    expect(call).toEqual(snapshot);
    expect(parseAgyInteractionSignal({
      name: 'write_to_file',
      args: { TargetFile: call.args.Path, CodeContent: PLAN, ArtifactMetadata: call.args.ArtifactMetadata },
    }, context)).toEqual(parseAgyInteractionSignal(call, context));
  });

  it.each([
    'implementation_plan.md',
    path.join(ROOT, 'implementation_plan.md'),
    path.join(ROOT, 'brain', OTHER_NATIVE_ID, 'implementation_plan.md'),
    path.join(ROOT, 'brain', NATIVE_ID, 'subdir', 'implementation_plan.md'),
    path.join(ROOT, 'brain', NATIVE_ID, 'implementation_plan.md.bak'),
    `${path.join(ROOT, 'brain', NATIVE_ID)}${path.sep}..${path.sep}${NATIVE_ID}${path.sep}implementation_plan.md`,
  ])('refuses an artifact path outside the exact current conversation plan: %s', (Path) => {
    expect(parseAgyInteractionSignal(artifact({ Path }), context)).toBeNull();
  });

  it.each([
    { ArtifactMetadata: undefined },
    { ArtifactMetadata: { RequestFeedback: true } },
    { ArtifactMetadata: { RequestFeedback: false, UserFacing: true } },
    { ArtifactMetadata: { RequestFeedback: true, UserFacing: false } },
    { ArtifactMetadata: { RequestFeedback: 'true', UserFacing: true } },
    { Content: '' },
    { Content: ' \n\t' },
    { Content: { plan: PLAN } },
  ])('refuses incomplete or non-reviewable artifacts: %j', (overrides) => {
    expect(parseAgyInteractionSignal(artifact(overrides), context)).toBeNull();
  });

  it('uses explicit preview decoding and preserves literal native content', () => {
    for (const call of [ask(), planQuestion(), artifact(), artifact({ Content: 'true' }), artifact({ Content: '"quoted"' })]) {
      expect(parseAgyInteractionSignal(encoded(call), context)).toEqual(parseAgyInteractionSignal(call, context));
    }
    expect(parseAgyInteractionSignal(artifact({ Content: '"quoted"' }), context)?.plan).toBe('"quoted"');
    expect(parseAgyInteractionSignal({ ...encoded(ask()), argumentsEncoded: false }, context)).toBeNull();
    expect(parseAgyInteractionSignal({ ...encoded(ask()), args: { questions: '[invalid' } }, context)).toBeNull();
  });

  it('refuses truncated arguments and invalid native ownership before creating a signal', () => {
    for (const call of [ask(), planQuestion(), artifact(), encoded(ask())]) {
      expect(parseAgyInteractionSignal(call, { ...context, argsTruncated: true })).toBeNull();
      expect(parseAgyInteractionSignal(call, { ...context, nativeId: '../another' })).toBeNull();
      expect(parseAgyInteractionSignal(call, { ...context, readRoot: 'relative/root' })).toBeNull();
      expect(parseAgyInteractionSignal(call, { ...context, argsTruncated: 'false' })).toBeNull();
    }
    expect(parseAgyInteractionSignal(null, context)).toBeNull();
    expect(parseAgyInteractionSignal(ask(), undefined)).toBeNull();
    expect(parseAgyInteractionSignal({ ...ask(), argumentsEncoded: 'false' }, context)).toBeNull();
  });

  it.each([
    { truncated: true },
    { args_truncated: true },
    { input_truncated: true },
    { truncated_fields: ['args.questions[0].question'] },
    { truncated_fields: ['args.Content'] },
    { truncated_fields: ['args'] },
    { truncated_fields: 'args' },
  ])('refuses native per-call truncation metadata: %j', (metadata) => {
    for (const call of [ask(), planQuestion(), artifact(), encoded(planQuestion()), encoded(artifact())]) {
      expect(parseAgyInteractionSignal({ ...call, ...metadata }, context)).toBeNull();
    }
  });

  it.each([
    { truncated: true },
    { args_truncated: true },
    { truncated_fields: ['questions[0].question'] },
    { truncated_fields: ['Content'] },
  ])('refuses argument truncation even when preview JSON remains complete: %j', (metadata) => {
    for (const source of [planQuestion(), artifact()]) {
      const call = { ...source, args: { ...source.args, ...metadata } };
      expect(parseAgyInteractionSignal(call, context)).toBeNull();
      expect(parseAgyInteractionSignal(encoded(call), context)).toBeNull();
    }
  });

  it.each([
    '<truncated 12 lines>',
    '<truncated 12 bytes>',
    '<truncated 12 of 100 bytes>',
    '<truncated 12 of 100 bytes from the middle of the output>',
  ])('refuses complete JSON carrying a native text-shortening notice: %s', (marker) => {
    for (const call of [planQuestion({ question: `${AGY_PLAN_QUESTION_PREFIX}${PLAN}\n${marker}` }), artifact({ Content: `${PLAN}\n${marker}` }), ask([question({ options: ['One', marker] })])]) {
      expect(parseAgyInteractionSignal(call, context)).toBeNull();
      expect(parseAgyInteractionSignal(encoded(call), context)).toBeNull();
    }
  });

  it('refuses truncated artifact metadata and accepts explicit complete metadata flags', () => {
    const metadata = { RequestFeedback: true, UserFacing: true, truncated_fields: ['Summary'] };
    expect(parseAgyInteractionSignal(artifact({ ArtifactMetadata: metadata }), context)).toBeNull();
    const complete = { ...planQuestion(), truncated: false, truncated_fields: [] };
    complete.args.truncated = false;
    complete.args.truncated_fields = [];
    expect(parseAgyInteractionSignal(complete, context)?.kind).toBe('plan');
    expect(parseAgyInteractionSignal(encoded(complete), context)?.kind).toBe('plan');
  });
});
