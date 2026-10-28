import { createHash } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError, invalidRequestError } from '../errors.js';

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const conversationMessageId = (conversationId, segment, nativeId) => {
  const send = /^(?:nc[lx]_u_|ndh_u_)/.test(nativeId)
    ? segment.sends.find((entry) => entry.nativeMessageId === nativeId) : undefined;
  if (send && segment.ownerId === conversationId) return send.messageId;
  return `ncv_m_${digest(`${conversationId}:${segment.sessionId}:${nativeId}`)}`;
};

export const conversationPartId = (conversationId, segment, nativeId, nativeMessageId) => {
  const messageId = conversationMessageId(conversationId, segment, nativeMessageId);
  if (nativeId.startsWith(`${nativeMessageId}_`)) return `${messageId}${nativeId.slice(nativeMessageId.length)}`;
  return `ncv_p_${digest(`${conversationId}:${segment.sessionId}:${nativeId}`)}`;
};

const shiftedTime = (time, offset) => ({
  ...time,
  ...(time.created === undefined ? {} : { created: time.created + offset }),
  ...(time.completed === undefined ? {} : { completed: time.completed + offset }),
  ...(time.start === undefined ? {} : { start: time.start + offset }),
  ...(time.end === undefined ? {} : { end: time.end + offset }),
});

export const projectConversationPart = (id, segment, part) => ({
  ...part, sessionID: id,
  messageID: conversationMessageId(id, segment, part.messageID),
  id: conversationPartId(id, segment, part.id, part.messageID),
  ...(part.time ? { time: shiftedTime(part.time, segment.timeOffset ?? 0) } : {}),
  ...(part.type === 'tool' ? { state: { ...part.state, time: shiftedTime(part.state.time, segment.timeOffset ?? 0) } } : {}),
});

export const projectConversationRecord = (id, segment, record) => {
  const messageId = conversationMessageId(id, segment, record.info.id);
  const info = { ...record.info, id: messageId, sessionID: id, time: shiftedTime(record.info.time, segment.timeOffset ?? 0) };
  if (info.role === 'user') {
    const send = segment.sends.find((entry) => entry.nativeMessageId === record.info.id);
    if (send) {
      info.model = { ...send.selection.model, ...(send.selection.variant ? { variant: send.selection.variant } : {}) };
      info.agent = send.selection.agent;
    }
  }
  if (info.parentID) info.parentID = conversationMessageId(id, segment, info.parentID);
  const parts = record.parts.map((part) => projectConversationPart(id, segment, part));
  return { info, parts };
};

const historyChanged = () => new NativeAgentError('The conversation history changed. Reload and retry.', {
  status: 409, code: 'NATIVE_HISTORY_CHANGED',
});

/** Reads native pages without admitting a partial source as complete history. */
export const readConversationSegment = async (native, manifest, segment) => {
  const pages = [];
  const children = new Map();
  const cursors = new Set();
  let cursor;
  let revision;
  let metadataComplete = true;
  for (;;) {
    const page = await native.loadMessages(segment.sessionId, manifest.directory, { limit: 500, before: cursor });
    if (revision !== undefined && page.historyRevision !== revision) throw historyChanged();
    revision = page.historyRevision;
    if (page.metadataComplete === false) metadataComplete = false;
    pages.unshift(page.records);
    for (const child of page.childSessions) children.set(child.id, { ...child, parentID: child.parentID === segment.sessionId ? segment.ownerId : child.parentID });
    if (page.complete) break;
    if (!page.cursor || cursors.has(page.cursor)) throw historyChanged();
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
  let records = pages.flat();
  if (segment.through) {
    const index = records.findIndex((record) => record.info.id === segment.through);
    if (index === -1) throw historyChanged();
    records = records.slice(0, index + 1);
  }
  if (segment.before) {
    const index = records.findIndex((record) => record.info.id === segment.before);
    if (index === -1) throw historyChanged();
    records = records.slice(0, index);
  }
  const timeOffset = segment.timeOffset ?? (records[0] ? Math.max(0, segment.createdAt - records[0].info.time.created) : 0);
  return { records, children: [...children.values()], metadataComplete, timeOffset };
};

/** Entries retain their source outside the public record for rewind and fork boundaries. */
export const readConversationHistory = async (native, manifest) => {
  const entries = [];
  const children = new Map();
  let metadataComplete = true;
  for (const segment of manifest.segments) {
    const history = await readConversationSegment(native, manifest, segment);
    metadataComplete &&= history.metadataComplete;
    for (const child of history.children) children.set(child.id, child);
    for (const original of history.records) {
      const record = projectConversationRecord(manifest.id, { ...segment, timeOffset: history.timeOffset }, original);
      entries.push({ record, segmentId: segment.id, nativeMessageId: original.info.id });
    }
  }
  return { entries, childSessions: [...children.values()], metadataComplete };
};

const cursorSchema = z.object({
  sessionId: z.string(), revision: z.number().int().nonnegative(), segmentId: z.string().uuid(), before: z.string().optional(),
}).strict();
const pageCursor = (manifest, segmentId, before) => `ncvpage_${Buffer.from(JSON.stringify({
  sessionId: manifest.id, revision: manifest.historyRevision, segmentId, before,
})).toString('base64url')}`;

/** A page reads only the execution segments it needs. Unavailable older sources
 * retain a retry cursor without discarding a readable newest window. */
export const readConversationPage = async (native, manifest, { limit, before }) => {
  let index = manifest.segments.length - 1;
  let boundary;
  if (before !== undefined) {
    if (!before.startsWith('ncvpage_')) throw invalidRequestError('Invalid conversation history cursor');
    let cursor;
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(before.slice(8), 'base64url').toString('utf8'))); }
    catch { throw invalidRequestError('Invalid conversation history cursor'); }
    if (cursor.sessionId !== manifest.id || cursor.revision !== manifest.historyRevision) throw historyChanged();
    index = manifest.segments.findIndex((segment) => segment.id === cursor.segmentId);
    if (index === -1) throw historyChanged();
    boundary = cursor.before;
  }
  const records = [];
  const children = new Map();
  let metadataComplete = true;
  let cursor = null;
  let historyUnavailable = false;
  while (index >= 0 && records.length < limit) {
    const segment = manifest.segments[index];
    let history;
    try { history = await readConversationSegment(native, manifest, segment); }
    catch (error) {
      if (records.length === 0) throw error;
      cursor = pageCursor(manifest, segment.id, boundary);
      historyUnavailable = true;
      break;
    }
    metadataComplete &&= history.metadataComplete;
    for (const child of history.children) children.set(child.id, child);
    let end = history.records.length;
    if (boundary) {
      end = history.records.findIndex((record) => record.info.id === boundary);
      if (end === -1) throw historyChanged();
    }
    const start = Math.max(0, end - (limit - records.length));
    records.unshift(...history.records.slice(start, end).map((record) => projectConversationRecord(manifest.id, { ...segment, timeOffset: history.timeOffset }, record)));
    if (start > 0) { cursor = pageCursor(manifest, segment.id, history.records[start].info.id); break; }
    index -= 1;
    boundary = undefined;
    cursor = index >= 0 ? pageCursor(manifest, manifest.segments[index].id) : null;
  }
  return { records, cursor, complete: cursor === null, childSessions: [...children.values()], metadataComplete,
    historyRevision: manifest.historyRevision, historyUnavailable };
};

/** A fork freezes its retained prefix, so later source turns cannot enter it. */
export const conversationPrefix = (manifest, history, beforeMessageId) => {
  const end = beforeMessageId === null ? history.entries.length : history.entries.findIndex((entry) => entry.record.info.id === beforeMessageId);
  if (end === -1) throw invalidRequestError('Unknown conversation fork point');
  const retained = history.entries.slice(0, end);
  return manifest.segments.flatMap((segment) => {
    const last = retained.findLast((entry) => entry.segmentId === segment.id);
    if (!last) return [];
    const kept = new Set(retained.filter((entry) => entry.segmentId === segment.id).map((entry) => entry.nativeMessageId));
    return [{ ...structuredClone(segment), through: last.nativeMessageId, before: undefined,
      sends: segment.sends.filter((send) => kept.has(send.nativeMessageId)) }];
  });
};
