import { z } from 'zod';

import type { JsonValue } from '../../shared/json-values.js';
import { decodeNativeSessionId, encodeClaudeChildSessionId } from '../ids.js';
import type { NativeEventPublisher } from '../publisher.js';
import { buildSessionRecord } from '../records.js';
import type { NativeErrorInfo, NativeMessageRecord, NativeSessionRecord } from '../records.js';
import { claudeAbortedError, claudeTurnError, createClaudeProjection } from './projector.js';
import type { ClaudeProjection, ClaudeRawEntry } from './projector.js';

const opaqueJson = z.custom<JsonValue>(() => true);
const taskInput = z.object({ description: z.string().optional(), subagent_type: z.string().optional() });
const childFrame = z.object({
  type: z.enum(['assistant', 'user', 'stream_event']),
  parent_tool_use_id: z.string().min(1),
  uuid: z.string().optional(),
}).catchall(opaqueJson.optional());
const taskStarted = z.object({
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  is_backgrounded: z.boolean().optional(),
});
const taskFinished = z.object({
  task_id: z.string(),
  status: z.enum(['completed', 'failed', 'stopped']),
  summary: z.string().optional(),
});
const taskUpdated = z.object({
  task_id: z.string(),
  patch: z.object({ status: z.string().optional(), is_backgrounded: z.boolean().optional(), error: z.string().optional() }),
});
const toolResults = z.object({
  type: z.literal('user'),
  message: z.object({
    content: z.array(z.object({
      type: z.string(),
      tool_use_id: z.string().optional(),
      is_error: z.boolean().optional(),
    })),
  }),
  tool_use_result: z.object({ isAsync: z.boolean().optional() }).optional().catch(undefined),
});

type SubagentPhase = 'pending' | 'running' | 'settled';

type ClaudeSubagentState = {
  session: NativeSessionRecord;
  phase: SubagentPhase;
  backgrounded: boolean;
  entries: Set<string>;
  projection: ClaudeProjection;
};

export interface ClaudeSubagentsOptions {
  sessionUuid: string;
  directory: string;
  publisher: Pick<NativeEventPublisher, 'records' | 'delta' | 'status' | 'session' | 'error' | 'forget'>;
  now: () => number;
}

export interface ClaudeSubagents {
  announce: (parentID: string, projection: ClaudeProjection, messageIds: ReadonlyArray<string>) => void;
  handleFrame: (frame: ClaudeRawEntry) => boolean;
  session: (sessionId: string) => NativeSessionRecord | null;
  records: (sessionId: string) => NativeMessageRecord[] | null;
  isRunning: (sessionId: string) => boolean;
  busySessionIds: () => string[];
  stop: (error: NativeErrorInfo | null) => void;
  dispose: (error: NativeErrorInfo | null) => void;
}

export const createClaudeSubagents = ({ sessionUuid, directory, publisher, now }: ClaudeSubagentsOptions): ClaudeSubagents => {
  const children = new Map<string, ClaudeSubagentState>();
  const tasks = new Map<string, ClaudeSubagentState>();

  const publishRecords = (child: ClaudeSubagentState, ids: ReadonlyArray<string>): void => {
    if (ids.length === 0) return;
    const records: NativeMessageRecord[] = [];
    for (const id of new Set(ids)) {
      const record = child.projection.record(id);
      if (record) records.push(record);
    }
    if (records.length > 0) publisher.records(directory, child.session.id, records);
  };

  const start = (child: ClaudeSubagentState): void => {
    if (child.phase !== 'pending') return;
    child.phase = 'running';
    publisher.status(directory, child.session.id, 'busy');
  };

  const finish = (child: ClaudeSubagentState, error: NativeErrorInfo | null): void => {
    if (child.phase === 'settled') return;
    child.phase = 'settled';
    publishRecords(child, child.projection.finishTurn({ error }));
    child.session.time.updated = now();
    publisher.session(directory, child.session, { created: false });
    if (error && error.name !== 'MessageAbortedError') publisher.error(directory, child.session.id, error);
    publisher.status(directory, child.session.id, 'idle');
  };

  const announce = (parentID: string, projection: ClaudeProjection, messageIds: ReadonlyArray<string>): void => {
    for (const messageId of new Set(messageIds)) {
      for (const part of projection.record(messageId)?.parts ?? []) {
        if (part.type !== 'tool' || part.tool !== 'task' || children.has(part.callID)) continue;
        const input = taskInput.safeParse(part.state.input).data;
        const id = encodeClaudeChildSessionId(sessionUuid, part.callID);
        const session = buildSessionRecord({
          id,
          backend: 'claude',
          directory,
          parentID,
          title: input?.description ?? input?.subagent_type ?? 'Subagent',
          created: part.state.time.start,
          updated: part.state.time.start,
        });
        children.set(part.callID, {
          session,
          phase: 'pending',
          backgrounded: false,
          entries: new Set(),
          projection: createClaudeProjection({
            sessionId: id,
            cwd: directory,
            live: true,
            now,
            childSessionIdForToolUse: (toolUseId) => encodeClaudeChildSessionId(sessionUuid, toolUseId),
          }),
        });
        publisher.session(directory, session, { created: true });
      }
    }
  };

  const finishToolChildren = (frame: ClaudeRawEntry): void => {
    const parsed = toolResults.safeParse(frame);
    if (!parsed.success) return;
    for (const result of parsed.data.message.content) {
      const child = result.type === 'tool_result' && result.tool_use_id ? children.get(result.tool_use_id) : null;
      if (!child) continue;
      if (parsed.data.tool_use_result?.isAsync) child.backgrounded = true;
      if (result.is_error) finish(child, claudeTurnError('Subagent tool failed'));
      else if (!child.backgrounded) finish(child, null);
    }
  };

  const find = (sessionId: string): ClaudeSubagentState | null => {
    const decoded = decodeNativeSessionId(sessionId);
    return decoded?.backend === 'claude' && decoded.sessionUuid === sessionUuid && decoded.toolUseId !== null
      ? children.get(decoded.toolUseId) ?? null
      : null;
  };

  return {
    announce,

    handleFrame(frame) {
      if (frame.type === 'system' && 'subtype' in frame && frame.subtype === 'task_started') {
        const parsed = taskStarted.safeParse(frame);
        const child = parsed.success && parsed.data.tool_use_id ? children.get(parsed.data.tool_use_id) : null;
        if (child && parsed.success) {
          tasks.set(parsed.data.task_id, child);
          child.backgrounded = parsed.data.is_backgrounded === true;
          start(child);
        }
        return false;
      }
      if (frame.type === 'system' && 'subtype' in frame && frame.subtype === 'task_notification') {
        const parsed = taskFinished.safeParse(frame);
        const child = parsed.success ? tasks.get(parsed.data.task_id) : null;
        if (child && parsed.success) {
          finish(child, parsed.data.status === 'completed' ? null
            : parsed.data.status === 'stopped' ? claudeAbortedError()
              : claudeTurnError(parsed.data.summary ?? 'Subagent failed'));
        }
        return false;
      }
      if (frame.type === 'system' && 'subtype' in frame && frame.subtype === 'task_updated') {
        const parsed = taskUpdated.safeParse(frame);
        const child = parsed.success ? tasks.get(parsed.data.task_id) : null;
        if (child && parsed.success) {
          const patch = parsed.data.patch;
          if (patch.is_backgrounded !== undefined) child.backgrounded = patch.is_backgrounded;
          if (patch.status === 'completed') finish(child, null);
          else if (patch.status === 'failed') finish(child, claudeTurnError(patch.error ?? 'Subagent failed'));
          else if (patch.status === 'killed') finish(child, claudeAbortedError());
        }
        return false;
      }
      if (frame.type === 'user') finishToolChildren(frame);
      if (!('parent_tool_use_id' in frame) || !frame.parent_tool_use_id) return false;
      const parsed = childFrame.safeParse(frame);
      if (!parsed.success) return false;
      const child = children.get(parsed.data.parent_tool_use_id);
      if (!child || child.phase === 'settled') return true;
      start(child);
      if (parsed.data.type === 'stream_event') {
        const { changed, delta } = child.projection.applyStreamEvent({ ...parsed.data, parent_tool_use_id: null });
        publishRecords(child, changed);
        if (delta) publisher.delta(directory, delta);
      } else if (parsed.data.uuid && !child.entries.has(parsed.data.uuid)) {
        child.entries.add(parsed.data.uuid);
        const changed = child.projection.applyEntry(parsed.data);
        publishRecords(child, changed);
        announce(child.session.id, child.projection, changed);
      }
      return true;
    },

    session(sessionId) { return find(sessionId)?.session ?? null; },
    records(sessionId) { return find(sessionId)?.projection.records() ?? null; },
    isRunning(sessionId) { return find(sessionId)?.phase === 'running'; },
    busySessionIds() {
      return [...children.values()].filter((child) => child.phase === 'running').map((child) => child.session.id);
    },
    stop(error) {
      for (const child of children.values()) finish(child, error);
    },
    dispose(error) {
      for (const child of children.values()) {
        finish(child, error);
        publisher.forget(child.session.id);
      }
      children.clear();
      tasks.clear();
    },
  };
};
