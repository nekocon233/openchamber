import { describe, expect, test } from 'bun:test';
import { nativeQuestionSchema } from './schemas';
import { projectNativeQuestion, readNativePlanExecution, nativeQuestionAnswers } from './forms';
import { buildFormAnswer, initialFormValues } from '@/components/chat/formCardState';

const sessionID = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const question = {
  id: 'ncq_execution', sessionID, kind: 'claude-plan-exit',
  questions: [{ question: 'The plan', header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }] }],
};

describe('plan execution form contract', () => {
  for (const kind of ['claude-plan-exit', 'codex-plan-exit', 'deepseek-plan-exit', 'antigravity-plan-exit']) {
    test(`${kind} starts with approval selected`, () => {
      const form = projectNativeQuestion(nativeQuestionSchema.parse({ ...question, kind }));
      if (!form) throw new Error('Expected a plan form');
      expect(nativeQuestionAnswers(buildFormAnswer(form.fields, initialFormValues(form.fields)))).toEqual([['build']]);
    });
  }

  test('ordinary questions do not preselect a build option', () => {
    const form = projectNativeQuestion(nativeQuestionSchema.parse({ ...question, kind: undefined }));
    if (!form) throw new Error('Expected a question form');
    expect(buildFormAnswer(form.fields, initialFormValues(form.fields))).toEqual({});
  });

  test('a batched DeepSeek approval seeds only the field marked as a plan review', () => {
    const form = projectNativeQuestion(nativeQuestionSchema.parse({ ...question, kind: 'deepseek-plan-exit', questions: [
      { ...question.questions[0], header: 'Workflow', planApproval: false },
      { ...question.questions[0], planApproval: true },
    ] }));
    if (!form) throw new Error('Expected a plan form');
    expect(buildFormAnswer(form.fields, initialFormValues(form.fields))).toEqual({ 'question-1': 'build' });
  });

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
