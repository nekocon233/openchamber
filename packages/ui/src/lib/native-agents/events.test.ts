import { describe, expect, test } from 'bun:test';
import { translateNativeEvent } from './events';
import { localizeNativeForm, nativeQuestionAnswers, projectNativeQuestion } from './forms';
import { nativeMessagePageSchema, nativeQuestionListSchema } from './schemas';
import { buildFormAnswer, initialFormValues, missingRequiredKeys } from '@/components/chat/formCardState';

const sessionID = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const question = {
  id: 'ncq_plan', sessionID, kind: 'claude-plan-exit' as const,
  questions: [{ header: 'Plan', question: 'Review this plan', options: [
    { label: 'build', description: 'Execute' }, { label: 'plan', description: 'Keep planning' },
  ] }],
};

describe('native records in the shared v2 domain', () => {
  test('accepts native model catalog invalidation without admitting OpenCode catalog kinds', () => {
    const event = { type: 'catalog.updated', properties: { kind: 'native-model' } };
    expect(translateNativeEvent(event)).toEqual(event);
    expect(translateNativeEvent({ type: 'catalog.updated', properties: { kind: 'model' } })).toBeNull();
  });

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

  test('a background task set passes through whole, and a malformed one is dropped', () => {
    const tasks = [{ id: 'bwait', type: 'local_bash', description: 'Wait for the training job' }];
    expect(translateNativeEvent({ type: 'session.background.updated', properties: { sessionID, tasks } }))
      .toEqual({ type: 'session.background.updated', properties: { sessionID, tasks } });
    expect(translateNativeEvent({ type: 'session.background.updated', properties: { sessionID, tasks: [{ id: '' }] } }))
      .toBeNull();
  });

  test('checklist snapshots retain completeness and reject malformed identity or item records', () => {
    const snapshot = { state: 'ready', identity: 'shared-list', source: 'files', revision: 2, observedAt: 3,
      complete: false, unreadable: 1, items: [{ id: '1', subject: 'Build', status: 'pending', owner: 'worker', blocks: ['2'], blockedBy: [] }] };
    expect(translateNativeEvent({ type: 'session.checklist.updated', properties: { sessionID, snapshot } }))
      .toEqual({ type: 'session.checklist.updated', properties: { sessionID, snapshot } });
    expect(translateNativeEvent({ type: 'session.checklist.updated', properties: { sessionID, snapshot: { ...snapshot, identity: '' } } })).toBeNull();
    expect(translateNativeEvent({ type: 'session.checklist.updated', properties: { sessionID, snapshot: { ...snapshot, items: [{ id: '1', status: 'broken' }] } } })).toBeNull();
    expect(translateNativeEvent({ type: 'session.checklist.updated', properties: { sessionID,
      snapshot: { state: 'unavailable', reason: 'source_unknown' } } }))
      .toMatchObject({ properties: { snapshot: { state: 'unavailable', reason: 'source_unknown' } } });
  });

  test('task details carry generation and terminal membership without entering the active-set channel', () => {
    const snapshot = { state: 'active', generation: 'query-1', revision: 4, omitted: 0, tasks: [{
      id: 'done', type: 'local_bash', description: 'Finished', active: false, ambient: false, status: 'completed',
      canStop: false, outputAvailable: true, summary: 'Done', endedAt: 8,
    }] };
    expect(translateNativeEvent({ type: 'session.tasks.updated', properties: { sessionID, snapshot } }))
      .toEqual({ type: 'session.tasks.updated', properties: { sessionID, snapshot } });
    expect(translateNativeEvent({ type: 'session.tasks.updated', properties: { sessionID, snapshot: { ...snapshot, generation: null } } })).toBeNull();
    expect(translateNativeEvent({ type: 'session.tasks.updated', properties: { sessionID, snapshot: { ...snapshot, state: 'inactive', generation: null } } })).toBeNull();
    expect(translateNativeEvent({ type: 'session.tasks.updated', properties: { sessionID: 'ses_1', snapshot } })).toBeNull();
  });

  test('question creation and settlement use the shared form lifecycle', () => {
    expect(translateNativeEvent({ type: 'question.asked', properties: question }))
      .toMatchObject({ type: 'form.created', properties: { form: { id: question.id, sessionID } } });
    for (const type of ['question.replied', 'question.rejected']) {
      expect(translateNativeEvent({ type, properties: { sessionID, requestID: question.id } }))
        .toEqual({ type: 'form.settled', properties: { sessionID, formID: question.id } });
    }
  });

  test('Antigravity questions preserve choices, multiple answers and custom text through live and snapshot forms', () => {
    const antigravityQuestion = {
      ...question, kind: undefined, sessionID: 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188',
      questions: [{ header: 'Scope', question: 'Which files should change?', multiple: true, options: [
        { label: 'Source', description: 'Update the source' }, { label: 'Tests', description: 'Update coverage' },
      ] }, { header: 'Details', question: 'What else should change?', options: [] }],
    };
    const [restored] = nativeQuestionListSchema.parse([antigravityQuestion]);
    const form = projectNativeQuestion(restored);
    expect(translateNativeEvent({ type: 'question.asked', properties: antigravityQuestion }))
      .toEqual({ type: 'form.created', properties: { form } });
    if (!form) throw new Error('Missing Antigravity question form');
    expect(form).toMatchObject({ title: 'Scope', metadata: { openchamberNativeQuestionKind: 'question' }, fields: [
      { key: 'question-0', type: 'multiselect', title: 'Scope', description: 'Which files should change?', custom: true,
        options: [{ value: 'Source' }, { value: 'Tests' }] },
      { key: 'question-1', type: 'string', title: 'Details', custom: true, options: [] },
    ] });
    expect(localizeNativeForm(form, (key) => `translated:${key}`)).toBe(form);
    expect(nativeQuestionAnswers({ 'question-1': 'Keep the existing API.', 'question-0': ['Tests', 'Source'] }))
      .toEqual([['Tests', 'Source'], ['Keep the existing API.']]);
    for (const type of ['question.replied', 'question.rejected']) {
      expect(translateNativeEvent({ type, properties: { sessionID: restored.sessionID, requestID: restored.id } }))
        .toEqual({ type: 'form.settled', properties: { sessionID: restored.sessionID, formID: restored.id } });
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

  test('ordinary Antigravity questions with empty headers use localized field labels', () => {
    const form = projectNativeQuestion({
      id: 'ncq_empty_headers', sessionID: 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188',
      questions: [
        { header: '', question: 'Which files should change?', options: [{ label: 'Source', description: '' }] },
        { header: '', question: 'How should the tests run?', options: [{ label: 'Unit tests', description: '' }] },
      ],
    });
    if (!form) throw new Error('Missing Antigravity question form');
    const localized = localizeNativeForm(form, (key, params) => `localized:${key}:${params?.index ?? ''}`);
    expect(localized.title).toBe('');
    expect(localized.fields.map((field) => field.title)).toEqual([
      'localized:chat.questionCard.questionFallback:1', 'localized:chat.questionCard.questionFallback:2',
    ]);
    expect(form.fields.map((field) => field.title)).toEqual(['', '']);
    expect(localized.fields[0]).toMatchObject({ description: 'Which files should change?', options: [{ value: 'Source', label: 'Source' }] });
  });

  for (const decision of [
    { backend: 'Codex', sessionID: 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00', kind: 'codex-plan-exit' },
    { backend: 'Antigravity', sessionID: 'nag_f1033b7a-88c5-4b77-bbec-6d63ec3a1188', kind: 'antigravity-plan-exit' },
  ]) {
  test(`${decision.backend} plan decisions survive snapshot parsing and use the same translated form as live events`, () => {
    const planQuestion = { ...question, sessionID: decision.sessionID, kind: decision.kind };
    const [restored] = nativeQuestionListSchema.parse([planQuestion]);
    const form = projectNativeQuestion(restored);
    expect(translateNativeEvent({ type: 'question.asked', properties: planQuestion }))
      .toEqual({ type: 'form.created', properties: { form } });
    if (!form) throw new Error(`Missing ${decision.backend} plan form`);
    const translated = localizeNativeForm(form, (key) => `localized:${key}`);
    const field = translated.fields[0];
    if (field.type !== 'string') throw new Error('Expected a single-choice field');
    expect(translated.title).toBe('localized:chat.questionCard.planExitTitle');
    expect(field.title).toBe(translated.title);
    expect(field.description).toContain('Review this plan');
    expect(field.options?.map((option) => option.value)).toEqual(['build', 'plan']);
    expect(field.options?.map((option) => option.label)).toEqual([
      'localized:chat.questionCard.planExitApprove', 'localized:chat.questionCard.planExitKeepPlanning',
    ]);
    expect(field.custom).toBe(true);
    const values = initialFormValues(translated.fields);
    expect(missingRequiredKeys(translated.fields, values)).toEqual(['question-0']);
    const feedback = 'Revise the plan before changing files.\nKeep the existing API.';
    values['question-0'] = { ...values['question-0'], custom: true, text: feedback };
    expect(missingRequiredKeys(translated.fields, values)).toEqual([]);
    expect(nativeQuestionAnswers(buildFormAnswer(translated.fields, values))).toEqual([[feedback]]);
    expect(translateNativeEvent({ type: 'question.replied', properties: {
      sessionID: restored.sessionID, requestID: restored.id,
    } })).toEqual({ type: 'form.settled', properties: { sessionID: restored.sessionID, formID: restored.id } });
  });
  }

  test('preserves plan-approval provenance through live events and history parsing', () => {
    const codexSession = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';
    const messageID = 'ncx_u_plan_5b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f';
    const part = {
      id: `${messageID}_p0`, sessionID: codexSession, messageID, type: 'text', text: 'Implement the plan.',
      metadata: { openchamberOrigin: 'codex-plan-approval' },
    };
    const history = nativeMessagePageSchema.parse({
      records: [{
        info: { id: messageID, sessionID: codexSession, role: 'user', time: { created: 1 },
          agent: 'build', model: { providerID: 'codex-native', modelID: 'gpt-5.5' } },
        parts: [part],
      }], cursor: null, complete: true, childSessions: [],
    });
    expect(history.records[0].parts[0]).toEqual(part);
    expect(translateNativeEvent({ type: 'message.part.updated', properties: { part, sessionID: codexSession, time: 1 } }))
      .toMatchObject({ properties: { part } });
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
