import { describe, expect, test } from 'bun:test';
import { nativeQuestionSchema } from './schemas';
import { projectNativeQuestion, readNativePlanExecution, nativeQuestionAnswers } from './forms';

const sessionID = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const question = {
  id: 'ncq_execution', sessionID, kind: 'claude-plan-exit',
  questions: [{ question: 'The plan', header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }] }],
};

describe('plan execution form contract', () => {
  test('older servers keep the original approval with no model selection capability', () => {
    const form = projectNativeQuestion(nativeQuestionSchema.parse(question));
    if (!form) throw new Error('Expected a plan form');
    expect(readNativePlanExecution(form)).toBeNull();
  });
  test('keeps the execution capability and pending model outside the answer fields', () => {
    const executionPending = { model: { providerID: 'codex-native', modelID: 'gpt-test' }, variant: 'max', expectedRevision: 4 };
    const form = projectNativeQuestion(nativeQuestionSchema.parse({ ...question, canSelectExecutionModel: true, executionPending }));
    if (!form) throw new Error('Expected a plan form');
    expect(readNativePlanExecution(form)?.openchamberPlanExecutionPending).toEqual(executionPending);
    expect(form.fields).toHaveLength(1);
    expect(nativeQuestionAnswers({ 'question-0': 'build' })).toEqual([['build']]);
  });
  test('an ordinary question cannot expose execution controls', () => {
    const form = projectNativeQuestion(nativeQuestionSchema.parse({ ...question, kind: undefined, canSelectExecutionModel: true }));
    if (!form) throw new Error('Expected a question form');
    expect(readNativePlanExecution(form)).toBeNull();
  });
  test('OpenCode form metadata cannot impersonate a native execution approval', () => {
    const form = projectNativeQuestion(nativeQuestionSchema.parse({ ...question, canSelectExecutionModel: true }));
    if (!form) throw new Error('Expected a plan form');
    expect(readNativePlanExecution({ ...form, sessionID: 'ses_opencode' })).toBeNull();
  });
});
