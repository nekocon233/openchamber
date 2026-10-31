import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { NativeAgentError } from '../errors.js';
import { encodeAntigravitySessionId } from '../ids.js';
import { buildSessionRecord, unconfirmedSessionRecord } from '../records.js';
import { parseAgyTranscript } from './protocol.js';
import { projectAntigravityHistory, resolveAntigravityBindings } from './projector.js';
import { agySavedTasks } from './tasks.js';
import { agyInteractionHistory } from './interaction-proposals.js';

const SUMMARY_COLUMNS = 'conversation_id, parent_conversation_id, title, preview, last_modified_time, workspace_uris';
const SELECT_ROOTS = `select ${SUMMARY_COLUMNS}
from conversation_summaries where parent_conversation_id = '' order by last_modified_time desc`;
const SELECT_ONE = `select ${SUMMARY_COLUMNS} from conversation_summaries where conversation_id = ? limit 1`;
const SELECT_CHILDREN = `select ${SUMMARY_COLUMNS} from conversation_summaries where parent_conversation_id = ? order by last_modified_time`;

const summaryRow = z.object({
  conversation_id: z.string().uuid(),
  parent_conversation_id: z.union([z.literal(''), z.string().uuid()]),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  last_modified_time: z.string(),
  workspace_uris: z.string(),
});

const unavailable = (message) => new NativeAgentError(message, {
  code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE',
  status: 502,
});

const normalizedDirectory = (value) => {
  const resolved = path.resolve(value);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
};

const workspaceDirectory = (value) => {
  try {
    const uris = JSON.parse(value);
    if (!Array.isArray(uris) || typeof uris[0] !== 'string') return null;
    return normalizedDirectory(fileURLToPath(uris[0]));
  } catch {
    return null;
  }
};

const modifiedTime = (row) => {
  const parsed = Date.parse(row.last_modified_time.trim().replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
};

/** Read-only access to agy's own index and transcripts. */
export const createAntigravityStore = ({ registry, home = null, now = Date.now }) => {
  const root = home ?? path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const summaries = path.join(root, 'conversation_summaries.db');
  const transcriptPath = (nativeId, name = 'transcript.jsonl') => path.join(
    root, 'brain', nativeId, '.system_generated', 'logs', name,
  );
  const registered = async (directory) => new Map(
    (await registry.listSessions({ backend: 'antigravity', directory }))
      .map((entry) => [entry.nativeId, entry]),
  );
  const open = () => new DatabaseSync(summaries, { readOnly: true });
  const hasSummaries = () => fs.existsSync(summaries);
  const hasTranscript = (nativeId) => fs.existsSync(transcriptPath(nativeId, 'transcript_full.jsonl'))
    || fs.existsSync(transcriptPath(nativeId));

  const recordOf = (row, entry, parent = null) => {
    const modified = modifiedTime(row) ?? entry?.confirmedAt ?? entry?.createdAt ?? now();
    // Children may work in their own worktree. They remain in their parent's
    // UI directory; only native ids, never log_uri, select their transcript.
    const directory = parent?.directory ?? workspaceDirectory(row.workspace_uris) ?? entry?.directory;
    if (!directory) throw unavailable(`Antigravity conversation ${row.conversation_id} has no readable workspace`);
    const title = entry?.title || row.title?.trim() || row.preview?.trim() || 'Antigravity session';
    const record = buildSessionRecord({
      id: entry?.sessionId ?? `nag_${row.conversation_id}`,
      backend: 'antigravity', directory, title,
      created: entry?.createdAt ?? modified,
      updated: modified,
      archived: parent?.time.archived ?? entry?.archivedAt ?? null,
      parentID: row.parent_conversation_id ? encodeAntigravitySessionId(row.parent_conversation_id) : null,
    });
    if (record.parentID) record.metadata.openchamber.native.activityKnown = false;
    return record;
  };

  const one = async (sessionId, nativeId, directory) => {
    const entry = (await registry.getSession(sessionId))
      ?? (await registry.listSessions({ backend: 'antigravity', directory }))
        .find((candidate) => candidate.nativeId === nativeId) ?? null;
    if (!hasSummaries()) {
      if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
        return unconfirmedSessionRecord({ sessionId, ...entry });
      }
      return null;
    }
    let db;
    try {
      db = open();
      const raw = db.prepare(SELECT_ONE).get(nativeId);
      if (!raw) {
        db.close();
        db = null;
        if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
          return unconfirmedSessionRecord({ sessionId, ...entry });
        }
        return null;
      }
      const row = summaryRow.parse(raw);
      let rootRow = row;
      const visited = new Set([row.conversation_id]);
      while (rootRow.parent_conversation_id !== '') {
        if (visited.has(rootRow.parent_conversation_id) || visited.size > 10) throw unavailable('Invalid Antigravity parent chain');
        visited.add(rootRow.parent_conversation_id);
        rootRow = summaryRow.parse(db.prepare(SELECT_ONE).get(rootRow.parent_conversation_id));
      }
      db.close();
      db = null;
      const rootEntry = row === rootRow ? entry : await registry.getSession(encodeAntigravitySessionId(rootRow.conversation_id));
      const rootRecord = recordOf(rootRow, rootEntry);
      const record = row === rootRow ? rootRecord : recordOf(row, entry, rootRecord);
      if (normalizedDirectory(record.directory) !== normalizedDirectory(directory)) return null;
      return record;
    } catch (error) {
      if (db) db.close();
      if (error instanceof NativeAgentError) throw error;
      throw unavailable(`Could not read Antigravity conversation ${nativeId}: ${error instanceof Error ? error.message : error}`);
    }
  };

  const readTranscript = (nativeId) => {
    try {
      const read = (name) => {
        try { return parseAgyTranscript(fs.readFileSync(transcriptPath(nativeId, name), 'utf8'), { encodedArguments: name === 'transcript.jsonl' }); }
        catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      };
      const full = read('transcript_full.jsonl');
      const preview = read('transcript.jsonl');
      if (!full && !preview) throw new Error('The native transcript is missing');
      if (!full) return preview;
      if (!preview) return full;
      // The preview can be ahead while the CLI appends its full log. Complete
      // full records own their step; preview-only steps retain their markers.
      const entries = new Map(preview.entries.map((entry) => [entry.step_index, entry]));
      for (const entry of full.entries) entries.set(entry.step_index, entry);
      return {
        entries: [...entries.values()].sort((left, right) => left.step_index - right.step_index),
        malformed: full.malformed + preview.malformed,
        unknownTypes: [...new Set([...full.unknownTypes, ...preview.unknownTypes])],
      };
    } catch (error) {
      throw unavailable(`Could not read Antigravity transcript ${nativeId}: ${error instanceof Error ? error.message : error}`);
    }
  };

  const childrenOf = (nativeId, parent) => {
    if (!hasSummaries()) return { childSessions: [], complete: true };
    let db;
    try {
      db = open();
      const rows = db.prepare(SELECT_CHILDREN).all(nativeId);
      const childSessions = [];
      let complete = true;
      for (const raw of rows) {
        const parsed = summaryRow.safeParse(raw);
        if (!parsed.success || parsed.data.conversation_id === nativeId) { complete = false; continue; }
        childSessions.push(recordOf(parsed.data, null, parent));
      }
      return { childSessions, complete };
    } finally {
      db?.close();
    }
  };

  const savedTasks = async (sessionId, nativeId, directory) => {
    if (!await one(sessionId, nativeId, directory)) return null;
    if (!hasTranscript(nativeId)) {
      const entry = await registry.getSession(sessionId);
      if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) return { records: [], revision: 0, complete: true };
      throw unavailable(`Antigravity transcript is missing: ${nativeId}`);
    }
    const transcript = readTranscript(nativeId);
    const records = agySavedTasks(transcript.entries, nativeId);
    for (const record of records) {
      if (fs.existsSync(path.join(root, 'brain', nativeId, '.system_generated', 'tasks', `task-${record.stepIndex}.log`))) record.task.outputAvailable = true;
    }
    return {
      records, revision: (transcript.entries.at(-1)?.step_index ?? -1) + 1,
      complete: transcript.malformed === 0 && transcript.unknownTypes.length === 0,
    };
  };

  return {
    transcriptPath,

    hasTranscript,

    async listRootSessions(directory) {
      const entries = await registered(directory);
      const unconfirmed = [...entries.values()].filter((entry) => (
        entry.origin === 'openchamber' && entry.confirmedAt === undefined
      ));
      if (!hasSummaries()) {
        const confirmed = [...entries.values()].some((entry) => entry.confirmedAt !== undefined);
        if (confirmed) throw unavailable('The Antigravity conversation index is missing');
        return unconfirmed.map((entry) => unconfirmedSessionRecord({ ...entry }));
      }
      let rows;
      let db;
      try {
        db = open();
        rows = db.prepare(SELECT_ROOTS).all();
        db.close();
        db = null;
      } catch (error) {
        if (db) db.close();
        throw unavailable(`Could not list Antigravity conversations: ${error instanceof Error ? error.message : error}`);
      }
      const records = [];
      const seen = new Set();
      for (const raw of rows) {
        const parsed = summaryRow.safeParse(raw);
        if (!parsed.success) continue;
        const entry = entries.get(parsed.data.conversation_id);
        let record;
        try {
          record = recordOf(parsed.data, entry);
        } catch {
          continue;
        }
        if (normalizedDirectory(record.directory) !== normalizedDirectory(directory)) continue;
        records.push(record);
        seen.add(parsed.data.conversation_id);
      }
      for (const entry of unconfirmed) {
        if (!seen.has(entry.nativeId)) records.push(unconfirmedSessionRecord({ ...entry }));
      }
      return records;
    },

    getSession: one,

    async sessionExists(sessionId, nativeId, directory) {
      return (await one(sessionId, nativeId, directory)) !== null;
    },

    async taskSnapshot(sessionId, nativeId, directory) {
      const saved = await savedTasks(sessionId, nativeId, directory);
      if (!saved) return null;
      return {
        state: saved.complete ? 'history' : 'unknown',
        generation: `agy-history:${nativeId}`,
        revision: saved.revision,
        tasks: saved.records.slice(-200).map((record) => record.task),
        omitted: Math.max(0, saved.records.length - 200),
      };
    },

    async taskOutput(sessionId, nativeId, directory, taskId, generation) {
      if (generation !== `agy-history:${nativeId}`) return { state: 'unavailable', reason: 'query_closed' };
      const saved = await savedTasks(sessionId, nativeId, directory);
      const record = saved?.records.find((candidate) => candidate.task.id === taskId);
      if (!record) return { state: 'unavailable', reason: 'not_recorded' };
      const conversationRoot = path.join(root, 'brain', nativeId);
      const logPath = path.join(conversationRoot, '.system_generated', 'tasks', `task-${record.stepIndex}.log`);
      let fd;
      try {
        const canonicalRoot = fs.realpathSync(conversationRoot);
        if (!fs.realpathSync(logPath).startsWith(`${canonicalRoot}${path.sep}`)) return { state: 'unavailable', reason: 'unreadable' };
        fd = fs.openSync(logPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return { state: 'unavailable', reason: 'unreadable' };
        const length = Math.min(stat.size, 256 * 1024);
        const buffer = Buffer.alloc(length);
        const bytes = fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
        return { state: 'ready', text: buffer.toString('utf8', 0, bytes), truncated: stat.size > length };
      } catch (error) {
        if (error.code !== 'ENOENT') return { state: 'unavailable', reason: 'unreadable' };
        return record.output === '' ? { state: 'unavailable', reason: 'not_recorded' }
          : { state: 'ready', text: record.output, truncated: record.truncated };
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    },

    async loadHistory(sessionId, nativeId, directory) {
      const session = await one(sessionId, nativeId, directory);
      if (!session) return null;
      const entry = await registry.getSession(sessionId);
      if (!hasTranscript(nativeId)) {
        if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
          return { records: [], childSessions: [] };
        }
        throw unavailable(`Antigravity transcript is missing: ${nativeId}`);
      }
      const transcript = readTranscript(nativeId);
      const { bindings, sends } = await resolveAntigravityBindings({
        sessionId, entries: transcript.entries, registry,
      });
      const records = projectAntigravityHistory({
        sessionId, nativeId, directory: session.directory,
        entries: transcript.entries, bindings, now,
      });
      const interactionHistory = !session.parentID && session.time.archived == null ? agyInteractionHistory({
        sessionId, nativeId, directory: session.directory, readRoot: root,
        entries: transcript.entries, bindings, sends, now,
      }) : { proposals: [], latest: null };
      const interactionSourceComplete = transcript.malformed === 0 && transcript.unknownTypes.length === 0;
      const owners = new Map(records.map((record) => [record.info.id, record]));
      for (const interaction of interactionHistory.proposals) {
        owners.get(interaction.messageID)?.parts.push(interaction.part);
      }
      // A damaged child index must not discard the parent's readable history.
      let children;
      try { children = childrenOf(nativeId, session); }
      catch { children = { childSessions: [], complete: false }; }
      return {
        records,
        interactionProposal: interactionSourceComplete ? interactionHistory.latest?.proposal ?? null : null,
        interactionSourceComplete,
        childSessions: children.childSessions,
        ...(transcript.malformed > 0 || transcript.unknownTypes.length > 0 || !children.complete ? { metadataComplete: false } : {}),
      };
    },

    /** Used only to distinguish a final response from agy's sticky stream error. */
    finalResponse(nativeId, userStepIndex) {
      if (!hasTranscript(nativeId) || userStepIndex === null) return null;
      const transcript = readTranscript(nativeId);
      const current = transcript.entries.filter((entry) => (
        entry.step_index >= userStepIndex && entry.type !== 'EPHEMERAL_MESSAGE'
      ));
      const last = current.at(-1);
      return last?.type === 'PLANNER_RESPONSE'
        && last.status === 'DONE'
        && (last.content ?? '').trim() !== ''
        && last.tool_calls.length === 0 ? last : null;
    },
  };
};
