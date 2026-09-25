// Reads Codex's own thread store through the shared app-server and projects
// it for OpenChamber.
//
// Listing shows interactive threads (the Codex TUI, Codex Desktop, IDE
// extensions, and OpenChamber itself). Threads the old OpenCode plugin created
// stay hidden: its SDK path is the `exec` source, which is never requested,
// and its app-server client is recognizable by originator. Subagent threads
// are returned with their parent's history rather than listed.
//
// Codex archives a thread by moving its rollout into `archived_sessions/`.
// Listing asks for archived threads separately; a single read has no archive
// flag, so it goes by that rollout path.

import fs from 'node:fs/promises';
import { z } from 'zod';

import { deleteForkSourceError, invalidRequestError, messageNotFoundError, revertMidTurnError } from '../errors.js';
import { decodeNativeSessionId, encodeCodexSessionId } from '../ids.js';
import { buildSessionRecord, unconfirmedSessionRecord } from '../records.js';
import { codexUserMessages, projectCodexTurns } from './projector.js';
import { JsonRpcError } from './rpc.js';

const LISTED_SOURCES = ['cli', 'vscode'];
const HIDDEN_ORIGINATORS = new Set(['openchamber_codex']);
const MAX_TITLE_LENGTH = 100;
const FORK_SUFFIX = ' (fork)';
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 20;
const TURN_PAGE_SIZE = 100;
const MISSING_THREAD_MESSAGE = /^(thread not loaded|invalid thread id)/;
const NO_ROLLOUT_MESSAGE = /^no rollout found/;
const FORKED_SOURCE_MESSAGE = /forked history still references it/;
const ARCHIVED_ROLLOUT = /[\\/]archived_sessions[\\/]/;
const missingDirectory = z.object({ code: z.enum(['ENOENT', 'ENOTDIR']) });

const sameDirectory = async (left, right) => {
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

const threadListSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
}).passthrough();

const threadReadSchema = z.object({ thread: threadSchema }).passthrough();
const forkedThreadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() }).passthrough();

const turnsPageSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
}).passthrough();
const titleTurnSchema = z.object({ id: z.string(), status: z.string(), items: z.array(z.unknown()) });

const fitTitle = (title, length) => (title.length > length ? `${title.slice(0, length - 1)}…` : title);
const fullTitleOf = (thread) => thread.name || thread.preview.split('\n')[0] || 'Codex session';
const titleOf = (thread) => fitTitle(fullTitleOf(thread), MAX_TITLE_LENGTH);
// Named the way Claude Code names forks; the mark survives shortening.
const forkTitleOf = (thread) => `${fitTitle(fullTitleOf(thread), MAX_TITLE_LENGTH - FORK_SUFFIX.length)}${FORK_SUFFIX}`;

/**
 * @param {object} options
 * @param {{ request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }} options.appServer
 * @param {ReturnType<typeof import('../registry.js').createNativeRegistry>} options.registry
 */
export const createCodexSessionStore = ({ appServer, registry, readGlobalInstructions = async () => null }) => {
  const titleWrites = new Map();
  const writeTitle = (sessionId, work) => {
    const previous = titleWrites.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    titleWrites.set(sessionId, next);
    void next.finally(() => {
      if (titleWrites.get(sessionId) === next) titleWrites.delete(sessionId);
    }).catch(() => undefined);
    return next;
  };
  const sessionRecord = (thread, directory, { archived, parentID = null }) => buildSessionRecord({
    id: encodeCodexSessionId(thread.id),
    backend: 'codex',
    directory,
    title: titleOf(thread),
    created: thread.createdAt * 1000,
    updated: thread.updatedAt * 1000,
    archived: archived ? thread.updatedAt * 1000 : null,
    parentID,
  });

  const listThreads = async (directory, archived) => {
    const threads = [];
    let cursor = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
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
      cursor = response.nextCursor;
    }
    return threads;
  };

  /**
   * Root threads of one directory, active first then archived. Throws when
   * Codex cannot be reached.
   * @param {string} directory
   */
  const listRootSessions = async (directory) => {
    const [active, archived, unconfirmed] = await Promise.all([
      listThreads(directory, false),
      listThreads(directory, true),
      registry.unconfirmedSessions({ backend: 'codex', directory }),
    ]);
    const records = [
      ...active.map((thread) => sessionRecord(thread, directory, { archived: false })),
      ...archived.map((thread) => sessionRecord(thread, directory, { archived: true })),
    ];
    const listed = new Set(records.map((record) => record.id));
    for (const entry of unconfirmed) {
      if (!listed.has(entry.sessionId)) records.push(unconfirmedSessionRecord(entry));
    }
    return records;
  };

  const threadIdOf = (sessionId) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') throw invalidRequestError(`Not a Codex session: ${sessionId}`);
    return decoded.threadId;
  };

  // A thread OpenChamber created stays readable before its first turn.
  const unconfirmedEntry = async (sessionId) => (await registry.unconfirmedSessions({ sessionId }))[0] ?? null;

  // Codex answers a read of a thread it has no rollout for with -32600
  // "thread not loaded" (or "invalid thread id"); only that means the thread
  // does not exist. Transport failures and timeouts are rethrown so they are
  // never mistaken for a deleted thread.
  const readThread = async (threadId) => {
    try {
      return threadReadSchema.parse(await appServer.request('thread/read', { threadId, includeTurns: false })).thread;
    } catch (error) {
      if (error instanceof JsonRpcError && error.code === -32600 && MISSING_THREAD_MESSAGE.test(error.message)) return null;
      throw error;
    }
  };

  const readAllTurns = async (threadId) => {
    const turns = [];
    let cursor = null;
    do {
      const page = turnsPageSchema.parse(await appServer.request('thread/turns/list', {
        threadId,
        itemsView: 'full',
        sortDirection: 'asc',
        limit: TURN_PAGE_SIZE,
        cursor,
      }));
      turns.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor !== null);
    return turns;
  };

  /**
   * The projected thread, plus the subagent threads its collab calls name.
   * @param {string} sessionId
   * @param {string} directory
   * @returns {Promise<{ records: Array<{ info: object, parts: object[] }>, childSessions: object[] } | null>}
   */
  const loadHistory = async (sessionId, directory) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') return null;
    const thread = await readThread(decoded.threadId);
    if (!thread) return (await unconfirmedEntry(sessionId)) ? { records: [], childSessions: [] } : null;
    const [turns, sendRecords] = await Promise.all([readAllTurns(decoded.threadId), registry.sendRecords(sessionId)]);
    const records = projectCodexTurns({
      sessionId,
      threadId: decoded.threadId,
      cwd: directory,
      turns,
      threadModel: thread.model ?? '',
      sendRecordFor: (messageId) => sendRecords.get(messageId) ?? null,
    });
    const childIds = new Set();
    for (const record of records) {
      for (const part of record.parts) {
        const sessionIdOfTask = part.type === 'tool' && part.tool === 'task' ? z.object({ sessionId: z.string() }).safeParse(part.state.metadata).data?.sessionId : undefined;
        if (sessionIdOfTask) childIds.add(sessionIdOfTask);
      }
    }
    const children = await Promise.all(Array.from(childIds, async (childId) => {
      const child = decodeNativeSessionId(childId);
      const childThread = child?.backend === 'codex' ? await readThread(child.threadId) : null;
      return childThread ? sessionRecord(childThread, directory, { archived: false, parentID: sessionId }) : null;
    }));
    return { records, childSessions: children.filter((child) => child !== null) };
  };

  /** One thread as a session record, or null when it does not exist. */
  const getSession = async (sessionId, directory) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') return null;
    const thread = await readThread(decoded.threadId);
    if (!thread) {
      const entry = await unconfirmedEntry(sessionId);
      return entry ? unconfirmedSessionRecord(entry) : null;
    }
    return sessionRecord(thread, directory, {
      archived: ARCHIVED_ROLLOUT.test(thread.path ?? ''),
      parentID: thread.parentThreadId ? encodeCodexSessionId(thread.parentThreadId) : null,
    });
  };

  /** @returns {Promise<boolean>} */
  const sessionExists = async (sessionId) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') return false;
    if ((await readThread(decoded.threadId)) !== null) return true;
    return (await unconfirmedEntry(sessionId)) !== null;
  };

  /**
   * Where a revert or fork of a user message rewinds the thread: before the
   * turn the message starts. Also returns the ids of that message and every
   * later user message. Codex rewinds whole turns, so a message steered into
   * a running turn cannot be the point.
   * @param {string} sessionId
   * @param {string} messageId
   */
  const rewindTarget = async (sessionId, messageId) => {
    const threadId = threadIdOf(sessionId);
    const messages = codexUserMessages({ threadId, turns: await readAllTurns(threadId) });
    const index = messages.findIndex((message) => message.messageId === messageId);
    if (index === -1) throw messageNotFoundError(messageId);
    if (!messages[index].startsTurn) throw revertMidTurnError();
    return {
      beforeTurnId: messages[index].turnId,
      messageIds: messages.slice(index).map((message) => message.messageId),
    };
  };

  /**
   * Copies the thread before `beforeTurnId` into a new thread, fully
   * auto-approved like every OpenChamber thread.
   * @returns {Promise<string>} the new thread's id
   */
  const fork = async (sessionId, directory, beforeTurnId) => {
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

  /** Names the thread; Codex shows the name in every client. */
  const rename = (sessionId, name) => writeTitle(sessionId, async () => {
    await appServer.request('thread/name/set', { threadId: threadIdOf(sessionId), name });
  });

  /** The requested first turn, only while this root thread remains unnamed. */
  const initialTitleTurn = async (sessionId, directory, turnId, itemsView) => {
    const threadId = threadIdOf(sessionId);
    const thread = await readThread(threadId);
    if (!thread || thread.name || thread.parentThreadId || ARCHIVED_ROLLOUT.test(thread.path ?? '')
      || !await sameDirectory(thread.cwd, directory)) return null;
    const page = turnsPageSchema.parse(await appServer.request('thread/turns/list', {
      threadId, sortDirection: 'asc', limit: 1, itemsView,
    }));
    if (!page.data.length) return null;
    const turn = titleTurnSchema.parse(page.data[0]);
    return turn.id === turnId && turn.status === 'completed' ? turn : null;
  };

  // The check shares ordering with manual renames, including one that was
  // already in flight before automatic generation started.
  const renameInitialTurn = (sessionId, directory, turnId, name, signal) => writeTitle(sessionId, async () => {
    signal.throwIfAborted();
    if (!await initialTitleTurn(sessionId, directory, turnId, 'notLoaded')) return false;
    signal.throwIfAborted();
    await appServer.request('thread/name/set', { threadId: threadIdOf(sessionId), name });
    return true;
  });

  const setArchived = async (sessionId, archived) => {
    await appServer.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: threadIdOf(sessionId) });
  };

  /**
   * Deletes the thread. A thread Codex has no rollout for is gone already.
   * Codex keeps a thread its forks still read from.
   * @returns {Promise<boolean>} false when there was nothing to delete
   */
  const deleteThread = async (sessionId) => {
    try {
      await appServer.request('thread/delete', { threadId: threadIdOf(sessionId) });
      return true;
    } catch (error) {
      if (error instanceof JsonRpcError && error.code === -32600 && NO_ROLLOUT_MESSAGE.test(error.message)) return false;
      if (error instanceof JsonRpcError && FORKED_SOURCE_MESSAGE.test(error.message)) throw deleteForkSourceError();
      throw error;
    }
  };

  return { listRootSessions, getSession, loadHistory, sessionExists, rewindTarget, fork, rename, initialTitleTurn, renameInitialTurn, setArchived, deleteThread };
};
