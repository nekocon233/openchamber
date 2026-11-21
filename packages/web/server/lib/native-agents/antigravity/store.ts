import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { isString } from '../../shared/guards.js';
import { NativeAgentError } from '../errors.js';
import { encodeAntigravitySessionId, decodeNativeSessionId } from '../ids.js';
import { buildSessionRecord, unconfirmedSessionRecord } from '../records.js';
import type { NativeMessageRecord, NativeSessionRecord } from '../records.js';
import type { NativeRegistry, RegistryListedSession, RegistrySessionEntry } from '../registry.js';
import { parseAgyTranscript } from './protocol.js';
import type { AgyParsedTranscript, AgyTranscriptStep } from './protocol.js';
import { projectAntigravityHistory, resolveAntigravityBindings } from './projector.js';
import { agySavedTasks } from './tasks.js';
import type { AgySavedTask, AgySavedTaskRecord } from './tasks.js';
import { agyInteractionHistory } from './interaction-proposals.js';
import type { AntigravityProposal } from './decisions.js';
import { restoreAntigravityMeasurements } from './measurements.js';
import { antigravityStatisticsRecords } from './statistics.js';
import type { AgyStatisticsRecord } from './statistics.js';
import { readAgyCompactionBudget } from './context-metadata.js';

export type AgyStoreRegistry = Pick<
  NativeRegistry,
  'getSession' | 'listSessions' | 'sendRecords' | 'bindAntigravityMessage'
>;

export interface CreateAntigravityStoreOptions {
  registry: AgyStoreRegistry;
  home?: string | null | undefined;
  now?: (() => number) | undefined;
}

export interface AgyStatisticsSessionsResult {
  sessions: NativeSessionRecord[];
  failedSessions: number;
}

export interface AgyStatisticsLoadResult {
  records: AgyStatisticsRecord[];
  childSessions: NativeSessionRecord[];
  complete?: boolean;
}

export type AgyTaskSnapshot = {
  state: 'history' | 'unknown';
  generation: string;
  revision: number;
  tasks: AgySavedTask[];
  omitted: number;
};

export type AgyTaskOutputResult =
  | { state: 'ready'; text: string; truncated: boolean }
  | { state: 'unavailable'; reason: 'query_closed' | 'not_recorded' | 'unreadable' };

export interface AgyHistoryResult {
  records: NativeMessageRecord[];
  interactionProposal?: AntigravityProposal | null;
  interactionSourceComplete?: boolean;
  childSessions: NativeSessionRecord[];
  metadataComplete?: boolean;
}

export interface AgyChildActivity {
  parentId: string;
  updatedAt: number;
  busy: boolean;
}

export interface AgyStore {
  readChildActivity: (ids: readonly string[]) => Map<string, AgyChildActivity>;
  transcriptPath: (nativeId: string, name?: string) => string;
  hasTranscript: (nativeId: string) => boolean;
  listRootSessions: {
    (directory: string | undefined, options: { statistics: true; signal?: AbortSignal | undefined }): Promise<AgyStatisticsSessionsResult>;
    (directory?: string, options?: { statistics?: false | undefined; signal?: AbortSignal | undefined }): Promise<NativeSessionRecord[]>;
  };
  listStatisticsSessions: (signal?: AbortSignal) => Promise<AgyStatisticsSessionsResult>;
  loadStatistics: (
    sessionId: string,
    directory: string,
    options?: { signal?: AbortSignal | undefined; tools?: 'none' | 'detail' | undefined },
  ) => Promise<AgyStatisticsLoadResult | null>;
  getSession: (sessionId: string, nativeId: string, directory: string) => Promise<NativeSessionRecord | null>;
  sessionExists: (sessionId: string, nativeId: string, directory?: string) => Promise<boolean>;
  taskSnapshot: (sessionId: string, nativeId: string, directory: string) => Promise<AgyTaskSnapshot | null>;
  taskOutput: (sessionId: string, nativeId: string, directory: string, taskId: string, generation: string) => Promise<AgyTaskOutputResult>;
  loadHistory: (sessionId: string, nativeId: string, directory: string) => Promise<AgyHistoryResult | null>;
  completedGenerations: (nativeId: string) => AgyTranscriptStep[];
  finalResponse: (
    nativeId: string,
    userStepIndex: number | null,
    options?: { allowTruncatedContent?: boolean | undefined },
  ) => AgyTranscriptStep | null;
}

interface CachedTranscriptFile {
  bytes: Buffer;
  version: string | null;
  parsed: AgyParsedTranscript;
}

interface CachedTranscriptEntry {
  full: CachedTranscriptFile | null;
  preview: CachedTranscriptFile | null;
  transcript: AgyParsedTranscript;
  size: number;
}

interface AgyChildrenResult {
  childSessions: NativeSessionRecord[];
  complete: boolean;
}

const SUMMARY_COLUMNS = 'conversation_id, parent_conversation_id, title, preview, last_modified_time, workspace_uris';
const SELECT_ROOTS = `select ${SUMMARY_COLUMNS}
from conversation_summaries where parent_conversation_id = '' order by last_modified_time desc`;
const SELECT_ONE = `select ${SUMMARY_COLUMNS} from conversation_summaries where conversation_id = ? limit 1`;
const SELECT_CHILDREN = `select ${SUMMARY_COLUMNS} from conversation_summaries where parent_conversation_id = ? order by last_modified_time`;
const SELECT_CHILD_ACTIVITY = `select conversation_id, parent_conversation_id, last_modified_time, status, not_fully_idle
from conversation_summaries where conversation_id in (select value from json_each(?))`;
const TRANSCRIPT_CACHE_BYTES = 32 * 1024 * 1024;
const TRANSCRIPT_CACHE_SESSIONS = 8;

const fileError = z.object({ code: z.string() });

const fileVersion = ({ dev, ino, size, mtimeNs, ctimeNs }: fs.BigIntStats): string => (
  `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`
);

const mergeTranscripts = (older: AgyParsedTranscript, newer: AgyParsedTranscript): AgyParsedTranscript => {
  const entries = new Map(older.entries.map((entry) => [entry.step_index, entry]));
  for (const entry of newer.entries) entries.set(entry.step_index, entry);
  return {
    entries: [...entries.values()].sort((left, right) => left.step_index - right.step_index),
    malformed: older.malformed + newer.malformed,
    unknownTypes: [...new Set([...older.unknownTypes, ...newer.unknownTypes])],
  };
};

const readTranscriptFile = (
  file: string,
  encodedArguments: boolean,
  previous: CachedTranscriptFile | null | undefined,
): CachedTranscriptFile | null => {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const before = fs.fstatSync(fd, { bigint: true });
    const version = fileVersion(before);
    if (previous && version === previous.version) return previous;
    const bytes = fs.readFileSync(fd);
    const stable = fileVersion(fs.fstatSync(fd, { bigint: true })) === version && BigInt(bytes.length) === before.size;
    const prefix = previous?.bytes;
    const append = Boolean(
      previous
      && prefix
      && prefix.at(-1) === 10
      && bytes.length > prefix.length
      && bytes.subarray(0, prefix.length).equals(prefix),
    );
    const parsed = parseAgyTranscript(bytes.toString('utf8', append && prefix ? prefix.length : 0), { encodedArguments });
    return {
      bytes,
      version: stable ? version : null,
      parsed: append && previous ? mergeTranscripts(previous.parsed, parsed) : parsed,
    };
  } catch (error) {
    if (fileError.safeParse(error).data?.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const summaryRow = z.object({
  conversation_id: z.string().uuid(),
  parent_conversation_id: z.union([z.literal(''), z.string().uuid()]),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  last_modified_time: z.string(),
  workspace_uris: z.string(),
});

type SummaryRow = z.infer<typeof summaryRow>;
const childActivityRow = summaryRow.pick({ conversation_id: true, last_modified_time: true }).extend({
  parent_conversation_id: z.string().uuid(),
  status: z.enum(['CASCADE_RUN_STATUS_IDLE', 'CASCADE_RUN_STATUS_RUNNING']),
  not_fully_idle: z.union([z.literal(0), z.literal(1)]),
});

const unavailable = (message: string) => new NativeAgentError(message, {
  code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE',
  status: 502,
});

const normalizedDirectory = (value: string): string => {
  const resolved = path.resolve(value);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
};

const workspaceDirectory = (value: string): string | null => {
  try {
    const uris: unknown = JSON.parse(value);
    if (!Array.isArray(uris)) return null;
    const first: unknown = uris[0];
    if (!isString(first)) return null;
    return normalizedDirectory(fileURLToPath(first));
  } catch {
    return null;
  }
};

const modifiedTime = (row: Pick<SummaryRow, 'last_modified_time'>): number | null => {
  const parsed = Date.parse(row.last_modified_time.trim().replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
};


export const createAntigravityStore = ({
  registry,
  home = null,
  now = Date.now,
}: CreateAntigravityStoreOptions): AgyStore => {
  const root = home ?? path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const summaries = path.join(root, 'conversation_summaries.db');
  const transcriptCache = new Map<string, CachedTranscriptEntry>();
  let transcriptCacheBytes = 0;

  const transcriptPath = (nativeId: string, name = 'transcript.jsonl'): string => path.join(
    root,
    'brain',
    nativeId,
    '.system_generated',
    'logs',
    name,
  );

  const registered = async (directory?: string): Promise<Map<string, RegistryListedSession>> => new Map(
    (await registry.listSessions({ backend: 'antigravity', directory })).map((entry) => [entry.nativeId, entry]),
  );

  const open = (waitForWrites = true): DatabaseSync => {
    const db = new DatabaseSync(summaries, { readOnly: true });
    db.exec(waitForWrites ? 'PRAGMA busy_timeout = 1000' : 'PRAGMA busy_timeout = 0');
    return db;
  };

  const hasSummaries = (): boolean => fs.existsSync(summaries);
  const hasTranscript = (nativeId: string): boolean => (
    fs.existsSync(transcriptPath(nativeId, 'transcript_full.jsonl'))
    || fs.existsSync(transcriptPath(nativeId))
  );

  const recordOf = (
    row: SummaryRow,
    entry: (RegistrySessionEntry & { sessionId?: string }) | null | undefined,
    parent: NativeSessionRecord | null = null,
  ): NativeSessionRecord => {
    const modified = modifiedTime(row) ?? entry?.confirmedAt ?? entry?.createdAt ?? now();
    const directory = parent?.directory ?? workspaceDirectory(row.workspace_uris) ?? entry?.directory;
    if (!directory) throw unavailable(`Antigravity conversation ${row.conversation_id} has no readable workspace`);
    const title = entry?.title || row.title?.trim() || row.preview?.trim() || 'Antigravity session';
    const record = buildSessionRecord({
      id: entry?.sessionId ?? `nag_${row.conversation_id}`,
      backend: 'antigravity',
      directory,
      title,
      created: entry?.createdAt ?? modified,
      updated: modified,
      archived: parent?.time.archived ?? entry?.archivedAt ?? null,
      parentID: row.parent_conversation_id ? encodeAntigravitySessionId(row.parent_conversation_id) : null,
    });
    if (record.parentID) record.metadata.openchamber.native.activityKnown = false;
    return record;
  };

  const one = async (sessionId: string, nativeId: string, directory?: string): Promise<NativeSessionRecord | null> => {
    const entry = (await registry.getSession(sessionId))
      ?? (await registry.listSessions({ backend: 'antigravity', directory }))
        .find((candidate) => candidate.nativeId === nativeId) ?? null;
    if (!hasSummaries()) {
      if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
        return unconfirmedSessionRecord({ sessionId, ...entry });
      }
      return null;
    }
    let db: DatabaseSync | null = null;
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
      if (directory !== undefined && normalizedDirectory(record.directory) !== normalizedDirectory(directory)) return null;
      return record;
    } catch (error) {
      if (db) db.close();
      if (error instanceof NativeAgentError) throw error;
      throw unavailable(`Could not read Antigravity conversation ${nativeId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const readTranscript = (nativeId: string): AgyParsedTranscript => {
    try {
      const previous = transcriptCache.get(nativeId);
      const full = readTranscriptFile(transcriptPath(nativeId, 'transcript_full.jsonl'), false, previous?.full);
      const preview = readTranscriptFile(transcriptPath(nativeId), true, previous?.preview);
      if (previous) {
        transcriptCache.delete(nativeId);
        transcriptCacheBytes -= previous.size;
      }
      let transcript: AgyParsedTranscript;
      if (previous && full === previous.full && preview === previous.preview) {
        transcript = previous.transcript;
      } else if (full && preview) {
        transcript = mergeTranscripts(preview.parsed, full.parsed);
      } else if (full) {
        transcript = full.parsed;
      } else if (preview) {
        transcript = preview.parsed;
      } else {
        throw new Error('The native transcript is missing');
      }
      const size = (full?.bytes.length ?? 0) + (preview?.bytes.length ?? 0);
      if (full?.version !== null && preview?.version !== null && size <= TRANSCRIPT_CACHE_BYTES) {
        transcriptCache.set(nativeId, { full, preview, transcript, size });
        transcriptCacheBytes += size;
        while (transcriptCache.size > TRANSCRIPT_CACHE_SESSIONS || transcriptCacheBytes > TRANSCRIPT_CACHE_BYTES) {
          const oldest = transcriptCache.keys().next().value;
          if (oldest === undefined) break;
          const evicted = transcriptCache.get(oldest);
          if (evicted) transcriptCacheBytes -= evicted.size;
          transcriptCache.delete(oldest);
        }
      }
      return transcript;
    } catch (error) {
      throw unavailable(`Could not read Antigravity transcript ${nativeId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const childrenOf = (nativeId: string, parent: NativeSessionRecord): AgyChildrenResult => {
    if (!hasSummaries()) return { childSessions: [], complete: true };
    let db: DatabaseSync | undefined;
    try {
      db = open();
      const rows = db.prepare(SELECT_CHILDREN).all(nativeId);
      const childSessions: NativeSessionRecord[] = [];
      let complete = true;
      for (const raw of rows) {
        const parsed = summaryRow.safeParse(raw);
        if (!parsed.success || parsed.data.conversation_id === nativeId) {
          complete = false;
          continue;
        }
        childSessions.push(recordOf(parsed.data, null, parent));
      }
      return { childSessions, complete };
    } finally {
      db?.close();
    }
  };

  const savedTasks = async (
    sessionId: string,
    nativeId: string,
    directory: string,
  ): Promise<{ records: AgySavedTaskRecord[]; revision: number; complete: boolean } | null> => {
    if (!await one(sessionId, nativeId, directory)) return null;
    if (!hasTranscript(nativeId)) {
      const entry = await registry.getSession(sessionId);
      if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) {
        return { records: [], revision: 0, complete: true };
      }
      throw unavailable(`Antigravity transcript is missing: ${nativeId}`);
    }
    const transcript = readTranscript(nativeId);
    const records = agySavedTasks(transcript.entries, nativeId);
    for (const record of records) {
      if (fs.existsSync(path.join(root, 'brain', nativeId, '.system_generated', 'tasks', `task-${record.stepIndex}.log`))) {
        record.task.outputAvailable = true;
      }
    }
    return {
      records,
      revision: (transcript.entries.at(-1)?.step_index ?? -1) + 1,
      complete: transcript.malformed === 0 && transcript.unknownTypes.length === 0,
    };
  };

  async function listRootSessions(
    directory: string | undefined,
    options: { statistics: true; signal?: AbortSignal | undefined },
  ): Promise<AgyStatisticsSessionsResult>;
  async function listRootSessions(
    directory?: string,
    options?: { statistics?: false | undefined; signal?: AbortSignal | undefined },
  ): Promise<NativeSessionRecord[]>;
  async function listRootSessions(
    directory?: string,
    { statistics = false, signal }: { statistics?: boolean | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<NativeSessionRecord[] | AgyStatisticsSessionsResult> {
    signal?.throwIfAborted();
    const entries = await registered(directory);
    const unconfirmed = [...entries.values()].filter((entry) => (
      entry.origin === 'openchamber' && entry.confirmedAt === undefined
    ));
    if (!hasSummaries()) {
      if (statistics) throw unavailable('The Antigravity conversation index is missing');
      const confirmed = [...entries.values()].some((entry) => entry.confirmedAt !== undefined);
      if (confirmed) throw unavailable('The Antigravity conversation index is missing');
      return unconfirmed.map((entry) => unconfirmedSessionRecord({ ...entry }));
    }
    let rows: unknown[];
    let db: DatabaseSync | null = null;
    try {
      db = open();
      rows = db.prepare(SELECT_ROOTS).all();
      db.close();
      db = null;
    } catch (error) {
      if (db) db.close();
      throw unavailable(`Could not list Antigravity conversations: ${error instanceof Error ? error.message : String(error)}`);
    }
    const records: NativeSessionRecord[] = [];
    const seen = new Set<string>();
    let failedSessions = 0;
    for (const raw of rows) {
      signal?.throwIfAborted();
      const parsed = summaryRow.safeParse(raw);
      if (!parsed.success) {
        failedSessions += 1;
        continue;
      }
      const entry = entries.get(parsed.data.conversation_id);
      let record: NativeSessionRecord;
      try {
        record = recordOf(parsed.data, entry);
      } catch {
        failedSessions += 1;
        continue;
      }
      if (directory !== undefined && normalizedDirectory(record.directory) !== normalizedDirectory(directory)) continue;
      records.push(record);
      seen.add(parsed.data.conversation_id);
    }
    for (const entry of unconfirmed) {
      if (!seen.has(entry.nativeId)) records.push(unconfirmedSessionRecord({ ...entry }));
    }
    return statistics ? { sessions: records, failedSessions } : records;
  }

  const store: AgyStore = {
    listRootSessions,
    listStatisticsSessions: (signal) => listRootSessions(undefined, { statistics: true, signal }),
    async loadStatistics(sessionId, directory, { signal, tools = 'none' } = {}) {
      signal?.throwIfAborted();
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== 'antigravity') return null;
      const nativeId = decoded.conversationId;
      const session = await one(sessionId, nativeId, directory);
      if (!session) return null;
      if (!hasTranscript(nativeId)) {
        const entry = await registry.getSession(sessionId);
        if (entry?.origin === 'openchamber' && entry.confirmedAt === undefined) return { records: [], childSessions: [] };
        throw unavailable(`Antigravity transcript is missing: ${nativeId}`);
      }
      const transcript = readTranscript(nativeId);
      let children: AgyChildrenResult;
      try {
        children = childrenOf(nativeId, session);
      } catch {
        children = { childSessions: [], complete: false };
      }
      const sends = await registry.sendRecords(sessionId);
      signal?.throwIfAborted();
      return {
        records: antigravityStatisticsRecords({
          nativeId,
          entries: transcript.entries,
          sends,
          parentID: session.parentID,
          tools,
        }),
        childSessions: children.childSessions,
        complete: transcript.malformed === 0 && transcript.unknownTypes.length === 0 && children.complete,
      };
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
      let fd: number | undefined;
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
        if (fileError.safeParse(error).data?.code !== 'ENOENT') return { state: 'unavailable', reason: 'unreadable' };
        return record.output === ''
          ? { state: 'unavailable', reason: 'not_recorded' }
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
        sessionId,
        entries: transcript.entries,
        registry,
      });
      let children: AgyChildrenResult;
      try {
        children = childrenOf(nativeId, session);
      } catch {
        children = { childSessions: [], complete: false };
      }
      const generationStep = transcript.entries.findLast((item) => item.type === 'PLANNER_RESPONSE' && item.status === 'DONE')?.step_index;
      const budget = readAgyCompactionBudget(root, nativeId, generationStep);
      const contextReading = budget && generationStep !== undefined ? { stepIndex: generationStep, budget } : null;
      const records = projectAntigravityHistory({
        sessionId,
        nativeId,
        directory: session.directory,
        entries: transcript.entries,
        bindings,
        parentSessionId: session.parentID,
        childSessionIds: children.childSessions.map((child) => child.id),
        now,
        contextReading,
      });
      restoreAntigravityMeasurements(records, sends);
      const interactionHistory = !session.parentID && session.time.archived == null
        ? agyInteractionHistory({
            sessionId,
            nativeId,
            directory: session.directory,
            readRoot: root,
            entries: transcript.entries,
            bindings,
            sends,
            now,
          })
        : { proposals: [], latest: null };
      const interactionSourceComplete = transcript.malformed === 0 && transcript.unknownTypes.length === 0;
      const owners = new Map(records.map((record) => [record.info.id, record]));
      for (const interaction of interactionHistory.proposals) {
        owners.get(interaction.messageID)?.parts.push(interaction.part);
      }
      const result: AgyHistoryResult = {
        records,
        interactionProposal: interactionSourceComplete ? interactionHistory.latest?.proposal ?? null : null,
        interactionSourceComplete,
        childSessions: children.childSessions,
      };
      if (transcript.malformed > 0 || transcript.unknownTypes.length > 0 || !children.complete) {
        result.metadataComplete = false;
      }
      return result;
    },
    completedGenerations(nativeId) {
      if (!hasTranscript(nativeId)) return [];
      return readTranscript(nativeId).entries.filter((entry) => entry.type === 'PLANNER_RESPONSE' && entry.status === 'DONE');
    },
    finalResponse(nativeId, userStepIndex, { allowTruncatedContent = false } = {}) {
      if (!hasTranscript(nativeId) || userStepIndex === null) return null;
      const transcript = readTranscript(nativeId);
      if (transcript.malformed > 0 || transcript.unknownTypes.length > 0) return null;
      const current = transcript.entries.filter((entry) => (
        entry.step_index >= userStepIndex && entry.type !== 'EPHEMERAL_MESSAGE'
      ));
      if (current[0]?.type !== 'USER_INPUT' || current[0].step_index !== userStepIndex
        || current.slice(1).some((entry) => entry.type === 'USER_INPUT')) return null;
      const last = current.at(-1);
      return last?.type === 'PLANNER_RESPONSE'
        && last.status === 'DONE'
        && (last.content ?? '').trim() !== ''
        && (last.error ?? '').trim() === ''
        && !last.truncated_fields.some((field) => field === 'error' || field === 'tool_calls'
          || (field === 'content' && !allowTruncatedContent))
        && last.tool_calls.length === 0 ? last : null;
    },
    transcriptPath,
    hasTranscript,
    readChildActivity(nativeIds) {
      const db = open(false);
      try {
        const activity = new Map<string, AgyChildActivity>();
        for (const raw of db.prepare(SELECT_CHILD_ACTIVITY).all(JSON.stringify(nativeIds))) {
          const parsed = childActivityRow.safeParse(raw);
          if (!parsed.success) continue;
          const row = parsed.data;
          const updatedAt = modifiedTime(row);
          if (updatedAt === null) continue;
          const busy = row.status === 'CASCADE_RUN_STATUS_RUNNING' || row.not_fully_idle === 1;
          activity.set(row.conversation_id, { parentId: encodeAntigravitySessionId(row.parent_conversation_id), updatedAt, busy });
        }
        return activity;
      } finally { db.close(); }
    },
  };
  return store;
};
