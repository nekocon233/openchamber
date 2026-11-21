import fs from 'node:fs/promises';
import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { deleteForkSourceError, invalidRequestError, messageNotFoundError, revertMidTurnError } from '../errors.js';
import { decodeNativeSessionId, encodeCodexSessionId } from '../ids.js';
import { buildSessionRecord, unconfirmedSessionRecord } from '../records.js';
import { codexPlanItemSchema } from './items.js';
import { codexUserMessages, isCodexToolPart, projectCodexTurns, type CodexProjectedRecord, type CodexSendRecord } from './projector.js';
import { JsonRpcError, type JsonRpcRequest } from './rpc.js';
import { codexItemTimes, readCodexHistoryDetails, type CodexTurnDetails } from './history-details.js';

const LISTED_SOURCES = ['cli', 'vscode'];
const HIDDEN_ORIGINATORS = new Set(['openchamber_codex']);
const MAX_TITLE_LENGTH = 100;
const FORK_SUFFIX = ' (fork)';
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 20;
const TURN_PAGE_SIZE = 100;
const ITEM_PAGE_SIZE = 100;
const MISSING_THREAD_MESSAGE = /^(thread not loaded|invalid thread id)/;
const NO_ROLLOUT_MESSAGE = /^no rollout found/;
const FORKED_SOURCE_MESSAGE = /forked history still references it/;
const ARCHIVED_ROLLOUT = /[\\/]archived_sessions[\\/]/;
const missingDirectory = z.object({ code: z.enum(['ENOENT', 'ENOTDIR']) });
const jsonValueSchema = z.custom<JsonValue>(() => true);

const sameDirectory = async (left: string, right: string): Promise<boolean> => {
  if (left === right) return true;
  try {
    const [resolvedLeft, resolvedRight] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
    return resolvedLeft === resolvedRight;
  } catch (error) {
    if (missingDirectory.safeParse(error).success) return false;
    throw error;
  }
};

const threadSchema = z.object({
  id: z.string(),
  cwd: z.string().catch(''),
  name: z.string().nullish(),
  preview: z.string().catch(''),
  model: z.string().nullish(),
  originator: z.string().nullish(),
  path: z.string().nullish(),
  parentThreadId: z.string().nullish(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).passthrough();

type CodexThread = z.infer<typeof threadSchema>;

const threadListSchema = z.object({
  data: z.array(jsonValueSchema),
  nextCursor: z.string().nullish(),
}).passthrough();

const threadReadSchema = z.object({ thread: threadSchema }).passthrough();
const forkedThreadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() }).passthrough();

const turnsPageSchema = z.object({
  data: z.array(jsonValueSchema),
  nextCursor: z.string().nullish(),
}).passthrough();
const itemsPageSchema = z.object({
  data: z.array(z.object({ turnId: z.string(), item: jsonValueSchema })),
  nextCursor: z.string().nullish(),
}).passthrough();
const titleTurnSchema = z.object({ id: z.string(), status: z.string(), items: z.array(jsonValueSchema) });
const turnItemsSchema = z.object({ id: z.string(), items: z.array(jsonValueSchema) }).catchall(jsonValueSchema);
const statisticsItemSchema = z.object({
  type: z.string(),
  id: z.string(),
  clientId: z.string().nullish(),
  content: z.array(jsonValueSchema).optional(),
  command: z.string().optional(),
  commandActions: z.array(z.object({ type: z.string().optional(), path: z.string().nullish() })).optional(),
  cwd: z.string().nullish(),
  exitCode: z.number().nullish(),
  status: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  success: z.boolean().nullish(),
  error: z.object({ message: z.string() }).nullish(),
  receiverThreadIds: z.array(z.string()).optional(),
});
const statisticsTurnSchema = z.object({
  id: z.string(),
  status: z.string(),
  startedAt: z.number().nullish(),
  completedAt: z.number().nullish(),
  error: jsonValueSchema.optional(),
  items: z.array(statisticsItemSchema),
});
const MAX_PLAN_CHARS = 200_000;

const fitTitle = (title: string, length: number): string => (title.length > length ? `${title.slice(0, length - 1)}…` : title);
const fullTitleOf = (thread: CodexThread): string => thread.name || thread.preview.split('\n')[0] || 'Codex session';
const titleOf = (thread: CodexThread): string => fitTitle(fullTitleOf(thread), MAX_TITLE_LENGTH);
const forkTitleOf = (thread: CodexThread): string => `${fitTitle(fullTitleOf(thread), MAX_TITLE_LENGTH - FORK_SUFFIX.length)}${FORK_SUFFIX}`;

export interface CodexStoreRegistryEntry {
  sessionId: string;
  backend: 'claude' | 'codex' | 'deepseek' | 'antigravity';
  directory: string;
  createdAt: number;
  title?: string | undefined;
  archivedAt?: number | undefined;
}

export interface CodexStoreRegistry {
  unconfirmedSessions(filter?: {
    backend?: 'claude' | 'codex' | 'deepseek' | 'antigravity';
    directory?: string;
    sessionId?: string;
  }): Promise<CodexStoreRegistryEntry[]>;
  sendRecords(sessionId: string): Promise<Map<string, CodexSendRecord>>;
}

export interface CodexSessionStoreOptions {
  appServer: { request: JsonRpcRequest };
  registry: CodexStoreRegistry;
  readGlobalInstructions?: (() => Promise<string | null>) | undefined;
}

export interface CodexListThreadsOptions {
  statistics?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface CodexLoadHistoryOptions {
  statistics?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface CodexLatestPlan {
  text: string;
  truncated: boolean;
  turnId: string;
}

export interface CodexHistorySnapshot {
  records: CodexProjectedRecord[];
  childSessions: ReturnType<typeof buildSessionRecord>[];
  metadataComplete?: boolean;
  complete?: boolean;
}

export interface CodexRewindTarget {
  beforeTurnId: string;
  messageIds: string[];
}

type StatisticsTurnItemSummary = {
  type: string;
  id: string;
  clientId?: string | null | undefined;
  content?: JsonValue[] | undefined;
  command?: string | undefined;
  commandActions?: Array<{ type?: string | undefined; path?: string | undefined }> | undefined;
  cwd?: string | null | undefined;
  exitCode?: number | null | undefined;
  status?: string | undefined;
  server?: string | undefined;
  tool?: string | undefined;
  success?: boolean | null | undefined;
  error?: { message: string } | null | undefined;
  receiverThreadIds?: string[] | undefined;
  text: string;
  summary: string[];
  changes: JsonValue[];
  arguments: JsonObject;
  aggregatedOutput: string;
};

type StatisticsTurnSummary = {
  id: string;
  status: string;
  startedAt?: number | null | undefined;
  completedAt?: number | null | undefined;
  error?: JsonValue | undefined;
  items: StatisticsTurnItemSummary[];
};

export const createCodexSessionStore = ({
  appServer,
  registry,
  readGlobalInstructions = async () => null,
}: CodexSessionStoreOptions) => {
  const titleWrites = new Map<string, Promise<void>>();
  const writeTitle = <Result>(sessionId: string, work: () => Promise<Result>): Promise<Result> => {
    const previous = titleWrites.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.then(() => undefined, () => undefined);
    titleWrites.set(sessionId, settled);
    void settled.finally(() => {
      if (titleWrites.get(sessionId) === settled) titleWrites.delete(sessionId);
    });
    return next;
  };
  const sessionRecord = (thread: CodexThread, directory: string, { archived, parentID = null }: { archived: boolean; parentID?: string | null }) => buildSessionRecord({
    id: encodeCodexSessionId(thread.id),
    backend: 'codex',
    directory,
    title: titleOf(thread),
    created: thread.createdAt * 1000,
    updated: thread.updatedAt * 1000,
    archived: archived ? thread.updatedAt * 1000 : null,
    parentID,
  });

  const unconfirmedCodexRecord = (entry: CodexStoreRegistryEntry) => {
    if (entry.backend !== 'codex') return null;
    const input: Parameters<typeof unconfirmedSessionRecord>[0] = {
      sessionId: entry.sessionId,
      backend: 'codex',
      directory: entry.directory,
      createdAt: entry.createdAt,
    };
    if (entry.title !== undefined) input.title = entry.title;
    if (entry.archivedAt !== undefined) input.archivedAt = entry.archivedAt;
    return unconfirmedSessionRecord(input);
  };

  const listThreads = async (directory: string | undefined, archived: boolean, { statistics = false, signal }: CodexListThreadsOptions = {}): Promise<CodexThread[]> => {
    const threads: CodexThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; statistics || page < MAX_LIST_PAGES; page += 1) {
      signal?.throwIfAborted();
      const response = threadListSchema.parse(await appServer.request('thread/list', {
        cwd: directory,
        sourceKinds: LISTED_SOURCES,
        archived,
        limit: LIST_PAGE_SIZE,
        cursor,
      }));
      for (const raw of response.data) {
        const thread = threadSchema.safeParse(raw);
        if (thread.success && !HIDDEN_ORIGINATORS.has(thread.data.originator ?? '')) threads.push(thread.data);
      }
      if (!response.nextCursor) break;
      if (response.nextCursor === cursor) throw new Error('Codex session listing did not advance');
      cursor = response.nextCursor;
    }
    return threads;
  };

  const listRootSessions = async (directory?: string, options?: CodexListThreadsOptions): Promise<ReturnType<typeof buildSessionRecord>[]> => {
    const unconfirmedFilter = directory !== undefined
      ? { backend: 'codex' as const, directory }
      : { backend: 'codex' as const };
    const [active, archived, unconfirmed] = await Promise.all([
      listThreads(directory, false, options),
      listThreads(directory, true, options),
      registry.unconfirmedSessions(unconfirmedFilter),
    ]);
    const records = [
      ...active.map((thread) => sessionRecord(thread, directory ?? thread.cwd, { archived: false })),
      ...archived.map((thread) => sessionRecord(thread, directory ?? thread.cwd, { archived: true })),
    ];
    const listed = new Set(records.map((record) => record.id));
    for (const entry of unconfirmed) {
      if (listed.has(entry.sessionId)) continue;
      const unconfirmedRecord = unconfirmedCodexRecord(entry);
      if (unconfirmedRecord) records.push(unconfirmedRecord);
    }
    return records;
  };

  const threadIdOf = (sessionId: string): string => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') throw invalidRequestError(`Not a Codex session: ${sessionId}`);
    return decoded.threadId;
  };

  const unconfirmedEntry = async (sessionId: string): Promise<CodexStoreRegistryEntry | null> => (
    (await registry.unconfirmedSessions({ sessionId }))[0] ?? null
  );

  const readThread = async (threadId: string): Promise<CodexThread | null> => {
    try {
      return threadReadSchema.parse(await appServer.request('thread/read', { threadId, includeTurns: false })).thread;
    } catch (error) {
      if (error instanceof JsonRpcError && error.code === -32600 && MISSING_THREAD_MESSAGE.test(error.message)) return null;
      throw error;
    }
  };

  const readTurnDetails = async (sessionId: string, turnId: string): Promise<CodexTurnDetails | null> => {
    const threadId = threadIdOf(sessionId);
    const thread = await readThread(threadId);
    if (!thread?.path) return null;
    return (await readCodexHistoryDetails(thread.path, threadId)).get(turnId) ?? null;
  };

  const readTurnItems = async (threadId: string, turnId: string, signal?: AbortSignal): Promise<JsonValue[]> => {
    const items: JsonValue[] = [];
    let cursor: string | null = null;
    do {
      signal?.throwIfAborted();
      const page = itemsPageSchema.parse(await appServer.request('thread/items/list', {
        threadId,
        turnId,
        sortDirection: 'asc',
        limit: ITEM_PAGE_SIZE,
        cursor,
      }));
      for (const entry of page.data) {
        if (entry.turnId !== turnId) throw new Error('Codex returned an item from another turn');
        items.push(entry.item);
      }
      cursor = page.nextCursor ?? null;
    } while (cursor !== null);
    return items;
  };

  const readAllTurns = async (threadId: string, statistics = false, signal?: AbortSignal): Promise<JsonValue[]> => {
    const turns: JsonValue[] = [];
    let cursor: string | null = null;
    do {
      signal?.throwIfAborted();
      const page = turnsPageSchema.parse(await appServer.request('thread/turns/list', {
        threadId,
        itemsView: 'notLoaded',
        sortDirection: 'asc',
        limit: TURN_PAGE_SIZE,
        cursor,
      }));
      for (const raw of page.data) {
        const turn = turnItemsSchema.parse(raw);
        turn.items = await readTurnItems(threadId, turn.id, signal);
        if (!statistics) {
          turns.push(turn);
          continue;
        }
        const snapshot = statisticsTurnSchema.parse(turn);
        const summaryTurn: StatisticsTurnSummary = {
          ...snapshot,
          items: snapshot.items.map((item): StatisticsTurnItemSummary => {
            const summary: StatisticsTurnItemSummary = {
              ...item,
              text: '',
              summary: [],
              changes: [],
              arguments: {},
              aggregatedOutput: '',
              commandActions: item.commandActions?.map((action) => ({ type: action.type, path: action.path ?? undefined })),
            };
            if (item.type !== 'userMessage') summary.content = [];
            return summary;
          }),
        };
        turns.push(summaryTurn);
      }
      cursor = page.nextCursor ?? null;
    } while (cursor !== null);
    return turns;
  };

  const latestPlan = async (sessionId: string): Promise<CodexLatestPlan | null> => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') return null;
    const turns = await readAllTurns(decoded.threadId);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turnItemsSchema.safeParse(turns[index]);
      if (!turn.success) continue;
      for (let item = turn.data.items.length - 1; item >= 0; item -= 1) {
        const plan = codexPlanItemSchema.safeParse(turn.data.items[item]);
        if (!plan.success || plan.data.text.trim() === '') continue;
        return plan.data.text.length > MAX_PLAN_CHARS
          ? { text: plan.data.text.slice(0, MAX_PLAN_CHARS), truncated: true, turnId: turn.data.id }
          : { text: plan.data.text, truncated: false, turnId: turn.data.id };
      }
    }
    return null;
  };

  const loadHistory = async (sessionId: string, directory: string, { statistics = false, signal }: CodexLoadHistoryOptions = {}): Promise<CodexHistorySnapshot | null> => {
    signal?.throwIfAborted();
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') return null;
    const thread = await readThread(decoded.threadId);
    if (!thread) return (await unconfirmedEntry(sessionId)) ? { records: [], childSessions: [] } : null;
    const [turns, sendRecords, details] = await Promise.all([
      readAllTurns(decoded.threadId, statistics, signal),
      registry.sendRecords(sessionId),
      readCodexHistoryDetails(thread.path, decoded.threadId).catch(() => null),
    ]);
    signal?.throwIfAborted();
    const records = projectCodexTurns({
      sessionId,
      threadId: decoded.threadId,
      cwd: directory,
      turns,
      threadModel: '',
      sendRecordFor: (messageId) => sendRecords.get(messageId) ?? null,
      itemTimes: details ? codexItemTimes(details) : undefined,
      details,
      statistics,
    });
    const childIds = new Set<string>();
    for (const record of records) {
      for (const part of record.parts) {
        const sessionIdOfTask = isCodexToolPart(part) && part.tool === 'task'
          ? z.object({ sessionId: z.string() }).safeParse(part.state.metadata).data?.sessionId
          : undefined;
        if (sessionIdOfTask) childIds.add(sessionIdOfTask);
      }
    }
    const children = await Promise.all(Array.from(childIds, async (childId) => {
      const child = decodeNativeSessionId(childId);
      const childThread = child?.backend === 'codex' ? await readThread(child.threadId) : null;
      return childThread ? sessionRecord(childThread, directory, { archived: false, parentID: sessionId }) : null;
    }));
    if (statistics) {
      const times = codexItemTimes(details);
      for (const record of records) for (const part of record.parts) {
        if (isCodexToolPart(part) && !times.get(part.callID)?.end && 'end' in part.state.time) delete part.state.time.end;
      }
    }
    const snapshot: CodexHistorySnapshot = {
      records,
      childSessions: children.filter((child): child is ReturnType<typeof buildSessionRecord> => child !== null),
      metadataComplete: details !== null,
    };
    if (statistics) snapshot.complete = details !== null;
    return snapshot;
  };

  const getSession = async (sessionId: string, directory?: string): Promise<ReturnType<typeof buildSessionRecord> | null> => {
    void directory;
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') return null;
    const thread = await readThread(decoded.threadId);
    if (!thread) {
      const entry = await unconfirmedEntry(sessionId);
      return entry ? unconfirmedCodexRecord(entry) : null;
    }
    if (!thread.cwd) throw new Error('Codex did not report this session’s working directory');
    return sessionRecord(thread, thread.cwd, {
      archived: ARCHIVED_ROLLOUT.test(thread.path ?? ''),
      parentID: thread.parentThreadId ? encodeCodexSessionId(thread.parentThreadId) : null,
    });
  };

  const sessionExists = async (sessionId: string): Promise<boolean> => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') return false;
    if ((await readThread(decoded.threadId)) !== null) return true;
    return (await unconfirmedEntry(sessionId)) !== null;
  };

  const rewindTarget = async (sessionId: string, messageId: string): Promise<CodexRewindTarget> => {
    const threadId = threadIdOf(sessionId);
    const messages = codexUserMessages({ threadId, turns: await readAllTurns(threadId) });
    const index = messages.findIndex((message) => message.messageId === messageId);
    const target = index === -1 ? undefined : messages[index];
    if (!target) throw messageNotFoundError(messageId);
    if (!target.startsTurn) throw revertMidTurnError();
    return {
      beforeTurnId: target.turnId,
      messageIds: messages.slice(index).map((message) => message.messageId),
    };
  };

  const fork = async (sessionId: string, directory: string, beforeTurnId?: string | undefined): Promise<string> => {
    const threadId = threadIdOf(sessionId);
    const source = await readThread(threadId);
    const forked = forkedThreadSchema.parse(await appServer.request('thread/fork', {
      threadId,
      beforeTurnId,
      cwd: directory,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      excludeTurns: true,
      developerInstructions: (await readGlobalInstructions()) ?? undefined,
    }));
    if (source) {
      await appServer.request('thread/name/set', { threadId: forked.thread.id, name: forkTitleOf(source) }).catch((error) => {
        console.warn('[native-agents] could not name the forked Codex thread:', forked.thread.id, error instanceof Error ? error.message : error);
      });
    }
    return forked.thread.id;
  };

  const rename = (sessionId: string, name: string): Promise<void> => writeTitle(sessionId, async () => {
    await appServer.request('thread/name/set', { threadId: threadIdOf(sessionId), name });
  });

  const initialTitleTurn = async (sessionId: string, directory: string, turnId: string, itemsView: 'full' | 'notLoaded'): Promise<z.infer<typeof titleTurnSchema> | null> => {
    const threadId = threadIdOf(sessionId);
    const thread = await readThread(threadId);
    if (!thread || thread.name || thread.parentThreadId || ARCHIVED_ROLLOUT.test(thread.path ?? '')
      || !await sameDirectory(thread.cwd, directory)) return null;
    const page = turnsPageSchema.parse(await appServer.request('thread/turns/list', {
      threadId,
      sortDirection: 'asc',
      limit: 1,
      itemsView: 'notLoaded',
    }));
    const firstTurn = page.data[0];
    if (!firstTurn) return null;
    const turn = titleTurnSchema.parse(firstTurn);
    if (turn.id !== turnId || turn.status !== 'completed') return null;
    if (itemsView === 'full') turn.items = await readTurnItems(threadId, turn.id);
    return turn;
  };

  const renameInitialTurn = (sessionId: string, directory: string, turnId: string, name: string, signal: AbortSignal): Promise<boolean> => writeTitle(sessionId, async () => {
    signal.throwIfAborted();
    if (!await initialTitleTurn(sessionId, directory, turnId, 'notLoaded')) return false;
    signal.throwIfAborted();
    await appServer.request('thread/name/set', { threadId: threadIdOf(sessionId), name });
    return true;
  });

  const setArchived = async (sessionId: string, archived: boolean): Promise<void> => {
    await appServer.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: threadIdOf(sessionId) });
  };

  const deleteThread = async (sessionId: string): Promise<boolean> => {
    try {
      await appServer.request('thread/delete', { threadId: threadIdOf(sessionId) });
      return true;
    } catch (error) {
      if (error instanceof JsonRpcError && error.code === -32600 && NO_ROLLOUT_MESSAGE.test(error.message)) return false;
      if (error instanceof JsonRpcError && FORKED_SOURCE_MESSAGE.test(error.message)) throw deleteForkSourceError();
      throw error;
    }
  };

  return {
    listRootSessions,
    listStatisticsSessions: (signal?: AbortSignal) => listRootSessions(undefined, { statistics: true, signal }),
    loadStatistics: (sessionId: string, directory: string, options?: CodexLoadHistoryOptions) => loadHistory(sessionId, directory, { ...options, statistics: true }),
    getSession,
    loadHistory,
    readTurnDetails,
    latestPlan,
    sessionExists,
    rewindTarget,
    fork,
    rename,
    initialTitleTurn,
    renameInitialTurn,
    setArchived,
    deleteThread,
  };
};
