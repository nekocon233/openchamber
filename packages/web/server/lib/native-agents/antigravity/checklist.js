import { AGY_CHECKLIST_SERVER, AGY_CHECKLIST_TOOL, parseChecklistInput, checklistReceipt } from './checklist-protocol.mjs';
import { NativeAgentError } from '../errors.js';

export const AGY_CHECKLIST_PART_TOOL = `${AGY_CHECKLIST_SERVER}_${AGY_CHECKLIST_TOOL}`;

/** Only a successful receipt for these exact arguments commits a whole list. */
export const antigravityChecklistSnapshot = ({ sessionId, records, complete = true, observedAt }) => {
  let latest = null;
  let unreadable = 0;
  let latestUnrecorded = -1;
  for (const record of records) for (const part of record.parts) {
    if (part.type !== 'tool' || part.tool !== AGY_CHECKLIST_PART_TOOL || part.state.status !== 'completed'
      || part.state.metadata?.nativeBackend !== 'antigravity' || part.state.metadata?.openchamberToolSource !== 'mcp') continue;
    const step = /_(\d+)$/.exec(part.callID);
    if (!step) continue;
    const revision = Number(step[1]) + 1;
    const input = !part.state.metadata?.nativeInputTruncated ? parseChecklistInput(part.state.input) : null;
    const receipt = input ? checklistReceipt(input) : null;
    if (!receipt || !part.state.output.split(/\r?\n/).some((line) => line === receipt)) {
      latestUnrecorded = Math.max(latestUnrecorded, revision);
      continue;
    }
    if (!latest || latest.revision < revision) latest = { input, revision };
  }
  if (!latest) {
    if (!complete || latestUnrecorded >= 0) throw new NativeAgentError('Antigravity checklist history is incomplete. Reload and retry.', {
      status: 502, code: 'NATIVE_ANTIGRAVITY_CHECKLIST_INCOMPLETE',
    });
    return { state: 'unavailable', reason: 'source_unknown' };
  }
  if (!complete || latestUnrecorded > latest.revision) unreadable = 1;
  return {
    state: 'ready', identity: `antigravity:${sessionId}`, source: 'history',
    revision: latest.revision, observedAt, complete: unreadable === 0, unreadable,
    items: latest.input.todos.map((todo) => ({ id: todo.id, subject: todo.content, status: todo.status, blocks: [], blockedBy: [] })),
  };
};
