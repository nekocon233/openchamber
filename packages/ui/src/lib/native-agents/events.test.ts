import { describe, expect, test } from 'bun:test';
import { translateNativeEvent } from './events';
import { localizeNativeForm, nativeQuestionAnswers, projectNativeQuestion } from './forms';
import { nativeMessagePageSchema } from './schemas';

const sessionID = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const question = {
  id: 'ncq_plan', sessionID, kind: 'claude-plan-exit' as const,
  questions: [{ header: 'Plan', question: 'Review this plan', options: [
    { label: 'build', description: 'Execute' }, { label: 'plan', description: 'Keep planning' },
  ] }],
};

describe('native records in the shared v2 domain', () => {
  test('a complete session update clears a previous archive and revert', () => {
    const event = translateNativeEvent({ type: 'session.updated', properties: { info: {
      id: sessionID, projectID: '', directory: '/repo', title: 'Work',
      time: { created: 1, updated: 2 },
    } } });
    expect(event).toMatchObject({ type: 'session.patched', properties: {
      sessionID, patch: { revert: null, time: { archived: null }, cost: 0 },
    } });
  });

  test('does not admit OpenCode IDs or incomplete native messages', () => {
    expect(translateNativeEvent({ type: 'session.status', properties: {
      sessionID: 'ses_opencode', status: { type: 'busy' },
    } })).toBeNull();
    expect(translateNativeEvent({ type: 'message.updated', properties: { info: {
      id: 'ncl_a_1', sessionID, role: 'assistant',
    } } })).toBeNull();
  });

  test('question creation and settlement use the shared form lifecycle', () => {
    expect(translateNativeEvent({ type: 'question.asked', properties: question }))
      .toMatchObject({ type: 'form.created', properties: { form: { id: question.id, sessionID } } });
    for (const type of ['question.replied', 'question.rejected']) {
      expect(translateNativeEvent({ type, properties: { sessionID, requestID: question.id } }))
        .toEqual({ type: 'form.settled', properties: { sessionID, formID: question.id } });
    }
  });

  test('translated plan choices retain the native wire answers', () => {
    const form = projectNativeQuestion(question);
    if (!form) throw new Error('Missing native plan form');
    const localized = localizeNativeForm(form, (key) => `translated:${key}`);
    const field = localized.fields[0];
    if (field.type !== 'string') throw new Error('Expected a single-choice plan field');
    expect(field.options?.map((option) => option.value)).toEqual(['build', 'plan']);
    expect(field.options?.[0].label).toContain('planExitApprove');
    expect(nativeQuestionAnswers({ 'question-0': 'build' })).toEqual([['build']]);
    expect(nativeQuestionAnswers({ 'question-1': ['B', 'C'], 'question-0': 'A' })).toEqual([['A'], ['B', 'C']]);
    expect(() => nativeQuestionAnswers({ 'question-1': 'build' })).toThrow('incomplete');
  });

  test('one malformed history record or part does not discard unrelated records', () => {
    const result = nativeMessagePageSchema.parse({
      records: [
        { info: { id: 'broken', role: 'assistant' }, parts: [] },
        { info: { id: 'ncl_u_1', sessionID, role: 'user', time: { created: 1 },
          agent: 'build', model: { providerID: 'claude-native', modelID: 'opus' } },
        parts: [{ type: 'invalid' }, { id: 'p1', messageID: 'ncl_u_1', sessionID, type: 'text', text: 'Hello' }] },
      ], cursor: null, complete: true, childSessions: [],
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].parts).toHaveLength(1);
    expect(result.records[0].info.role).toBe('user');
  });
});
