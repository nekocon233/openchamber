import { describe, expect, it } from 'vitest';
import { createQuestionRegistry } from './questions.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const input = { directory: '/workspace', sessionID: 'ndh_test', questions: [{ question: 'Choose', header: 'Choice', options: [{ label: 'A', description: '' }] }] };

describe('native question delivery acknowledgement', () => {
  it('restores an owner request id and withdraws it without a user rejection', async () => {
    const events = [];
    let settled = 0;
    const registry = createQuestionRegistry({ publish: (_directory, event) => events.push(event), onSettled: () => { settled += 1; } });
    const question = registry.ask({ ...input, id: 'ncq_saved' });
    expect(registry.list('/workspace')[0].id).toBe('ncq_saved');
    expect(() => registry.ask({ ...input, id: 'ncq_saved' })).toThrow('already pending');
    expect(registry.withdraw('ncq_saved')).toBe(true);
    expect(await question).toEqual({ status: 'rejected', reason: 'interrupted' });
    expect(events.map((event) => event.type)).toEqual(['question.asked']);
    expect(settled).toBe(0);
    expect(registry.withdraw('ncq_saved')).toBe(false);
  });

  it('publishes a settled selection when its owner withdraws an uncertain dispatch', async () => {
    const events = [];
    const registry = createQuestionRegistry({ publish: (_directory, event) => events.push(event), onSettled: () => { throw new Error('owner persists this answer'); } });
    const question = registry.ask({ ...input, id: 'ncq_unknown' });
    registry.withdraw('ncq_unknown', { status: 'replied', answers: [['A']] });
    await question;
    expect(events.at(-1)).toEqual({ type: 'question.replied', properties: { sessionID: input.sessionID, requestID: 'ncq_unknown', answers: [['A']] } });
    expect(registry.list('/workspace')).toEqual([]);
  });
  it('waits for delivery before settling and refuses a duplicate reply', async () => {
    const events = [];
    const delivered = deferred();
    const registry = createQuestionRegistry({ publish: (_directory, event) => events.push(event) });
    const question = registry.ask({ ...input, onReply: () => delivered.promise });
    const id = registry.list('/workspace')[0].id;
    const reply = registry.reply(id, [['A']]);
    expect(registry.list('/workspace')).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(['question.asked']);
    expect(() => registry.reply(id, [['A']])).toThrow('being delivered');
    delivered.resolve();
    await reply;
    expect(await question).toEqual({ status: 'replied', answers: [['A']] });
    expect(registry.list('/workspace')).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['question.asked', 'question.replied']);
  });

  it('keeps a failed delivery retryable without blocking another session', async () => {
    let attempts = 0;
    const registry = createQuestionRegistry({ publish: () => {} });
    const first = registry.ask({ ...input, onReply: async () => { attempts += 1; if (attempts === 1) throw new Error('offline'); } });
    const id = registry.list('/workspace')[0].id;
    await expect(registry.reply(id, [['A']])).rejects.toThrow('offline');
    expect(registry.list('/workspace')[0].id).toBe(id);
    const other = registry.ask({ ...input, sessionID: 'ncl_other' });
    const otherId = registry.list('/workspace')[1].id;
    await registry.reply(otherId, [['A']]);
    expect(await other).toMatchObject({ status: 'replied' });
    await registry.reply(id, [['A']]);
    expect(await first).toMatchObject({ status: 'replied' });
    expect(attempts).toBe(2);
  });

  it('lets authoritative cancellation settle during an in-flight reply', async () => {
    const delivered = deferred();
    const controller = new AbortController();
    const registry = createQuestionRegistry({ publish: () => {} });
    const question = registry.ask({ ...input, signal: controller.signal, onReply: () => delivered.promise });
    const id = registry.list('/workspace')[0].id;
    const reply = registry.reply(id, [['A']]);
    await Promise.resolve();
    controller.abort();
    expect(await question).toEqual({ status: 'rejected', reason: 'interrupted' });
    delivered.resolve();
    await expect(reply).rejects.toMatchObject({ code: 'NATIVE_QUESTION_NOT_FOUND' });
    expect(registry.list('/workspace')).toEqual([]);
  });
});
