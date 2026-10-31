import { createHash } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError } from '../errors.js';

const todos = z.object({ todos: z.array(z.object({
  content: z.string().trim().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
})).refine((items) => new Set(items.map((item) => item.content)).size === items.length) });
const digest = (text) => createHash('sha256').update(text).digest('hex');
const unavailable = () => ({ state: 'unavailable', reason: 'source_unknown' });

/** DSH's committed todo/write event owns the whole list, including empty writes. */
export const deepseekChecklistSnapshot = ({ nativeId, event, revision = 0, observedAt }) => {
  const parsed = todos.safeParse(event.data);
  if (!parsed.success) throw new NativeAgentError('DeepSeek Harness returned an invalid task list. Reload and retry.', {
    status: 502, code: 'NATIVE_DEEPSEEK_INVALID_CHECKLIST',
  });
  return {
    state: 'ready', identity: `deepseek:${digest(nativeId)}`, source: 'history',
    revision, observedAt, complete: true, unreadable: 0,
    items: parsed.data.todos.map((item) => ({
      id: digest(item.content), subject: item.content, status: item.status, blocks: [], blockedBy: [],
    })),
  };
};

/** Retain the last committed list across turn/start, which resets DSH's view to null. */
export const readDeepseekChecklist = async ({ nativeId, events, hasMore, throughSeq, loadOlder, observedAt }) => {
  let page = events;
  let more = hasMore;
  for (;;) {
    const event = page.findLast((item) => item.seq <= throughSeq && item.type === 'todo/write');
    if (event) return deepseekChecklistSnapshot({ nativeId, event, observedAt });
    if (!more) return unavailable();
    const beforeSeq = page[0]?.seq;
    if (beforeSeq === undefined) throw new NativeAgentError('DeepSeek Harness task history is incomplete. Reload and retry.', {
      status: 502, code: 'NATIVE_DEEPSEEK_CHECKLIST_HISTORY_INCOMPLETE',
    });
    const next = await loadOlder(beforeSeq);
    if ((next.events.length > 0 && next.events[0].seq >= beforeSeq) || (next.events.length === 0 && next.hasMore)) {
      throw new NativeAgentError('DeepSeek Harness task history paging made no progress.', {
        status: 502, code: 'NATIVE_DEEPSEEK_CHECKLIST_HISTORY_INCOMPLETE',
      });
    }
    page = next.events;
    more = next.hasMore;
  }
};
