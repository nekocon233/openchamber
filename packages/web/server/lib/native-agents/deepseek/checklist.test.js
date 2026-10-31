import { describe, expect, it } from 'vitest';
import { deepseekChecklistSnapshot, readDeepseekChecklist } from './checklist.js';

const write = (seq, items) => ({ seq, type: 'todo/write', data: { todos: items } });
const item = (content, status = 'pending') => ({ content, status });
const read = (changes = {}) => readDeepseekChecklist({ nativeId: 'session-a', events: [], hasMore: false, throughSeq: 100,
  loadOlder: async () => { throw new Error('Unexpected page'); }, observedAt: 1, ...changes });

describe('DeepSeek committed checklist', () => {
  it('uses the last successful list and retains stable item identity across updates', async () => {
    const first = await read({ events: [write(1, [item('A')]), write(2, [item('B'), item('A', 'completed')])] });
    const previous = await read({ events: [write(1, [item('A')])] });
    expect(first.items.map((entry) => [entry.subject, entry.status])).toEqual([['B', 'pending'], ['A', 'completed']]);
    expect(first.items[1].id).toBe(previous.items[0].id);
    expect(first).toMatchObject({ state: 'ready', complete: true, source: 'history', unreadable: 0 });
  });

  it('preserves the last list after a new turn starts and pages older committed events', async () => {
    const pages = [];
    const snapshot = await read({ events: [{ seq: 20, type: 'turn/start', data: {} }], hasMore: true,
      loadOlder: async (before) => { pages.push(before); return { events: [write(10, [item('Keep the plan', 'in_progress')])], hasMore: false }; },
    });
    expect(snapshot.items[0].subject).toBe('Keep the plan');
    expect(pages).toEqual([20]);
  });

  it('respects a rewind boundary and treats an empty committed write as empty', async () => {
    const events = [write(1, [item('Before')]), write(8, [])];
    expect((await read({ events, throughSeq: 7 })).items[0].subject).toBe('Before');
    expect((await read({ events })).items).toEqual([]);
    expect((await read({ events, throughSeq: 0 })).state).toBe('unavailable');
  });

  it('keeps a missing list unknown and does not turn a failed page into empty success', async () => {
    expect(await read()).toEqual({ state: 'unavailable', reason: 'source_unknown' });
    await expect(read({ events: [{ seq: 10, type: 'turn/start', data: {} }], hasMore: true,
      loadOlder: async () => { throw new Error('Disconnected'); },
    })).rejects.toThrow('Disconnected');
  });

  it.each([[item('Bad', 'unknown')], [item('Duplicate'), item('Duplicate')], [{ content: 1, status: 'pending' }]].map((items) => ({ items })))('rejects malformed or duplicate authoritative data: %o', async ({ items }) => {
    await expect(read({ events: [write(1, [item('Older')]), write(2, items)] })).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_INVALID_CHECKLIST' });
  });

  it('rejects non-progressing history and scopes lists to the native source', async () => {
    await expect(read({ events: [{ seq: 10, type: 'turn/start' }], hasMore: true,
      loadOlder: async () => ({ events: [{ seq: 10, type: 'turn/start' }], hasMore: true }),
    })).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_CHECKLIST_HISTORY_INCOMPLETE' });
    const a = deepseekChecklistSnapshot({ nativeId: 'a', event: write(1, []), observedAt: 1 });
    const b = deepseekChecklistSnapshot({ nativeId: 'b', event: write(1, []), observedAt: 1 });
    expect(a.identity).not.toBe(b.identity);
  });
});
