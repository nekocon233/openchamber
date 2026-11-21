import { createHash } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError, invalidRequestError } from '../errors.js';
import type { NativeMessageRecord, NativePart, NativeSessionRecord, NativeToolState } from '../records.js';
import type { ConversationManifest, ConversationSegment } from './store.js';

export interface ConversationNativeMessagePage {
  records: NativeMessageRecord[];
  cursor: string | null;
  complete: boolean;
  childSessions: NativeSessionRecord[];
  metadataComplete?: boolean | undefined;
  historyRevision?: number | string | undefined;
}

export interface ConversationNativeHistoryReader {
  loadMessages: (
    sessionId: string,
    directory: string,
    options: { limit: number; before?: string | undefined },
  ) => Promise<ConversationNativeMessagePage>;
}

export type ConversationPrefixObserver = (segment: ConversationSegment, skippedIds: string[]) => void;

export type ConversationSegmentHistory = {
  records: NativeMessageRecord[];
  children: NativeSessionRecord[];
  metadataComplete: boolean;
  timeOffset: number;
};

export type ConversationHistoryEntry = {
  record: NativeMessageRecord;
  segmentId: string;
  nativeMessageId: string;
};

export type ConversationHistory = {
  entries: ConversationHistoryEntry[];
  childSessions: NativeSessionRecord[];
  metadataComplete: boolean;
};

export type ConversationPage = {
  records: NativeMessageRecord[];
  cursor: string | null;
  complete: boolean;
  childSessions: NativeSessionRecord[];
  metadataComplete: boolean;
  historyRevision: number;
  historyUnavailable: boolean;
};

type ShiftableTime = {
  created?: number;
  completed?: number;
  start?: number;
  end?: number;
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);

export const conversationMessageId = (conversationId: string, segment: ConversationSegment, nativeId: string): string => {
  const send = segment.sends.find((entry) => entry.nativeMessageId === nativeId);
  if (send && segment.ownerId === conversationId) return send.messageId;
  return `ncv_m_${digest(`${conversationId}:${segment.sessionId}:${nativeId}`)}`;
};

export const conversationPartId = (
  conversationId: string,
  segment: ConversationSegment,
  nativeId: string,
  nativeMessageId: string,
): string => {
  const messageId = conversationMessageId(conversationId, segment, nativeMessageId);
  if (nativeId.startsWith(`${nativeMessageId}_`)) return `${messageId}${nativeId.slice(nativeMessageId.length)}`;
  return `ncv_p_${digest(`${conversationId}:${segment.sessionId}:${nativeId}`)}`;
};

const shiftedTime = <Time extends ShiftableTime>(time: Time, offset: number): Time => {
  const shifted = { ...time };
  if (shifted.created !== undefined) shifted.created += offset;
  if (shifted.completed !== undefined) shifted.completed += offset;
  if (shifted.start !== undefined) shifted.start += offset;
  if (shifted.end !== undefined) shifted.end += offset;
  return shifted;
};

export const projectConversationPart = (id: string, segment: ConversationSegment, part: NativePart): NativePart => {
  const offset = segment.timeOffset ?? 0;
  const messageID = conversationMessageId(id, segment, part.messageID);
  const partID = conversationPartId(id, segment, part.id, part.messageID);
  if (part.type === 'text') {
    return { ...part, sessionID: id, messageID, id: partID, time: shiftedTime(part.time, offset) };
  }
  if (part.type === 'reasoning') {
    return { ...part, sessionID: id, messageID, id: partID, time: shiftedTime(part.time, offset) };
  }
  if (part.type === 'tool') {
    const state: NativeToolState = part.state.status === 'running'
      ? { ...part.state, time: shiftedTime(part.state.time, offset) }
      : part.state.status === 'completed'
        ? { ...part.state, time: shiftedTime(part.state.time, offset) }
        : { ...part.state, time: shiftedTime(part.state.time, offset) };
    return {
      ...part,
      sessionID: id,
      messageID,
      id: partID,
      state,
    };
  }
  return { ...part, sessionID: id, messageID, id: partID };
};

export const projectConversationRecord = (
  id: string,
  segment: ConversationSegment,
  record: NativeMessageRecord,
): NativeMessageRecord => {
  const messageId = conversationMessageId(id, segment, record.info.id);
  const offset = segment.timeOffset ?? 0;
  let info: NativeMessageRecord['info'];
  if (record.info.role === 'user') {
    const userInfo = { ...record.info, id: messageId, sessionID: id, time: shiftedTime(record.info.time, offset) };
    const send = segment.sends.find((entry) => entry.nativeMessageId === record.info.id);
    if (send) {
      userInfo.model = send.selection.variant !== undefined
        ? { ...send.selection.model, variant: send.selection.variant }
        : { ...send.selection.model };
      userInfo.agent = send.selection.agent;
    }
    info = userInfo;
  } else if (record.info.role === 'assistant') {
    info = {
      ...record.info,
      id: messageId,
      sessionID: id,
      time: shiftedTime(record.info.time, offset),
      parentID: record.info.parentID ? conversationMessageId(id, segment, record.info.parentID) : record.info.parentID,
    };
  } else {
    info = { ...record.info, id: messageId, sessionID: id, time: shiftedTime(record.info.time, offset) };
  }
  const parts = record.parts.map((part) => projectConversationPart(id, segment, part));
  return { info, parts };
};

const historyChanged = (): NativeAgentError => new NativeAgentError('The conversation history changed. Reload and retry.', {
  status: 409, code: 'NATIVE_HISTORY_CHANGED',
});

export const readConversationSegment = async (
  native: ConversationNativeHistoryReader,
  manifest: ConversationManifest,
  segment: ConversationSegment,
  observePrefix?: ConversationPrefixObserver,
): Promise<ConversationSegmentHistory> => {
  const pages: NativeMessageRecord[][] = [];
  const children = new Map<string, NativeSessionRecord>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let revision: number | string | undefined;
  let metadataComplete = true;
  for (;;) {
    const page = await native.loadMessages(segment.sessionId, manifest.directory, { limit: 500, before: cursor });
    if (revision !== undefined && page.historyRevision !== revision) throw historyChanged();
    revision = page.historyRevision;
    if (page.metadataComplete === false) metadataComplete = false;
    pages.unshift(page.records);
    for (const child of page.childSessions) {
      const parentID = child.parentID === segment.sessionId ? segment.ownerId : child.parentID;
      const mappedChild: NativeSessionRecord = parentID !== undefined ? { ...child, parentID } : { ...child };
      children.set(child.id, mappedChild);
    }
    if (page.complete) break;
    if (!page.cursor || cursors.has(page.cursor)) throw historyChanged();
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
  let records = pages.flat();
  if (segment.from) {
    const index = records.findIndex((record) => record.info.id === segment.from);
    if (index === -1 && segment.sends.some((send) => send.nativeMessageId === segment.from && send.state === 'accepted')) throw historyChanged();
    observePrefix?.(segment, records.slice(0, index === -1 ? records.length : index).map((record) => record.info.id));
    records = index === -1 ? [] : records.slice(index);
  }
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
  const firstRecord = records[0];
  const timeOffset = segment.timeOffset ?? (firstRecord ? Math.max(0, segment.createdAt - firstRecord.info.time.created) : 0);
  return { records, children: [...children.values()], metadataComplete, timeOffset };
};

export const readConversationHistory = async (
  native: ConversationNativeHistoryReader,
  manifest: ConversationManifest,
  observePrefix?: ConversationPrefixObserver,
): Promise<ConversationHistory> => {
  const entries: ConversationHistoryEntry[] = [];
  const children = new Map<string, NativeSessionRecord>();
  let metadataComplete = true;
  for (const segment of manifest.segments) {
    const history = await readConversationSegment(native, manifest, segment, observePrefix);
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
  sessionId: z.string(),
  revision: z.number().int().nonnegative(),
  segmentId: z.string().uuid(),
  before: z.string().optional(),
}).strict();

const pageCursor = (manifest: ConversationManifest, segmentId: string, before?: string): string => `ncvpage_${Buffer.from(JSON.stringify({
  sessionId: manifest.id, revision: manifest.historyRevision, segmentId, before,
})).toString('base64url')}`;

export const readConversationPage = async (
  native: ConversationNativeHistoryReader,
  manifest: ConversationManifest,
  { limit, before }: { limit: number; before?: string | undefined },
  observePrefix?: ConversationPrefixObserver,
): Promise<ConversationPage> => {
  let index = manifest.segments.length - 1;
  let boundary: string | undefined;
  if (before !== undefined) {
    if (!before.startsWith('ncvpage_')) throw invalidRequestError('Invalid conversation history cursor');
    let cursor: z.infer<typeof cursorSchema>;
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(before.slice(8), 'base64url').toString('utf8'))); }
    catch { throw invalidRequestError('Invalid conversation history cursor'); }
    if (cursor.sessionId !== manifest.id || cursor.revision !== manifest.historyRevision) throw historyChanged();
    index = manifest.segments.findIndex((segment) => segment.id === cursor.segmentId);
    if (index === -1) throw historyChanged();
    boundary = cursor.before;
  }
  const records: NativeMessageRecord[] = [];
  const children = new Map<string, NativeSessionRecord>();
  let metadataComplete = true;
  let cursor: string | null = null;
  let historyUnavailable = false;
  while (index >= 0 && records.length < limit) {
    const segment = manifest.segments[index];
    if (!segment) break;
    let history: ConversationSegmentHistory;
    try { history = await readConversationSegment(native, manifest, segment, observePrefix); }
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
    if (start > 0) {
      const startRecord = history.records[start];
      if (!startRecord) throw historyChanged();
      cursor = pageCursor(manifest, segment.id, startRecord.info.id);
      break;
    }
    index -= 1;
    boundary = undefined;
    const previousSegment = manifest.segments[index];
    cursor = previousSegment ? pageCursor(manifest, previousSegment.id) : null;
  }
  return {
    records,
    cursor,
    complete: cursor === null,
    childSessions: [...children.values()],
    metadataComplete,
    historyRevision: manifest.historyRevision,
    historyUnavailable,
  };
};

export const conversationPrefix = (
  manifest: ConversationManifest,
  history: ConversationHistory,
  beforeMessageId: string | null,
): ConversationSegment[] => {
  const end = beforeMessageId === null ? history.entries.length : history.entries.findIndex((entry) => entry.record.info.id === beforeMessageId);
  if (end === -1) throw invalidRequestError('Unknown conversation fork point');
  const retained = history.entries.slice(0, end);
  return manifest.segments.flatMap((segment) => {
    const last = retained.findLast((entry) => entry.segmentId === segment.id);
    if (!last) return [];
    const kept = new Set(retained.filter((entry) => entry.segmentId === segment.id).map((entry) => entry.nativeMessageId));
    const copy = structuredClone(segment);
    copy.through = last.nativeMessageId;
    delete copy.before;
    copy.sends = segment.sends.filter((send) => kept.has(send.nativeMessageId));
    return [copy];
  });
};
