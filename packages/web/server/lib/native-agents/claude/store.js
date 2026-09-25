// Reads Claude Code's own session store through the Agent SDK and projects it
// for OpenChamber.
//
// Listing shows what the terminal's /resume shows (non-programmatic sessions)
// plus the SDK-created sessions OpenChamber registered itself; sessions other
// SDK clients created, such as the old OpenCode plugin, stay hidden.
// Subagents are not listed: loading a parent's history returns its subagent
// sessions, which is the only place they can be opened from.
//
// Once a session has a transcript, its title is the CLI's (a rename is a
// custom-title entry the terminal shows too); the registry only adds the
// archive flag, which Claude Code does not have.

import { z } from 'zod';

import { invalidRequestError, messageNotFoundError, rewindBeforeCompactionError } from '../errors.js';
import {
  claudeEntryUuidOfUserMessageId,
  claudeUserMessageId,
  decodeNativeSessionId,
  encodeClaudeChildSessionId,
  encodeClaudeSessionId,
} from '../ids.js';
import { buildSessionRecord, unconfirmedSessionRecord } from '../records.js';
import { createClaudeProjection } from './projector.js';
import { slimFileEditResult } from './tools.js';

const MAX_TITLE_LENGTH = 100;
const DEFAULT_HISTORY_CACHE_BYTES = 128 * 1024 * 1024;

const sessionInfoSchema = z.object({
  sessionId: z.string(),
  summary: z.string().catch(''),
  lastModified: z.number(),
  fileSize: z.number().optional(),
  customTitle: z.string().optional(),
  firstPrompt: z.string().optional(),
  cwd: z.string().optional(),
  createdAt: z.number().optional(),
}).passthrough();

const subagentFirstMessageSchema = z.object({
  parent_tool_use_id: z.string().nullish(),
  timestamp: z.string().optional(),
  message: z.object({ content: z.unknown() }).passthrough().optional(),
}).passthrough();

const chainEntrySchema = z.object({ type: z.string(), uuid: z.string() }).passthrough();
const forkResultSchema = z.object({ sessionId: z.string() }).passthrough();

const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

const assistantToolUsesSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.object({ type: z.string(), name: z.string().optional() }).passthrough()),
  }).passthrough(),
}).passthrough();

const rawToolResultEntrySchema = z.object({
  uuid: z.string(),
  toolUseResult: z.unknown(),
}).passthrough();

// A raw transcript entry, as far as finding compaction boundaries needs it.
const rawChainEntrySchema = z.object({
  uuid: z.string(),
  type: z.string(),
  subtype: z.string().optional(),
}).passthrough();

const compactSummarySchema = z.object({ isCompactSummary: z.literal(true) }).passthrough();

const entryUuidOf = (entry) => {
  const parsed = chainEntrySchema.safeParse(entry);
  return parsed.success ? parsed.data.uuid : null;
};

// The compaction a history chain starts at: getSessionMessages begins after
// the last compaction with its boundary, and the compact summary follows it.
const compactionBoundaryUuid = (entries) => {
  const first = chainEntrySchema.safeParse(entries[0]);
  if (!first.success || first.data.type !== 'system') return null;
  return compactSummarySchema.safeParse(entries[1]).success ? first.data.uuid : null;
};

const usesFileEditTool = (entry) => {
  const parsed = assistantToolUsesSchema.safeParse(entry);
  return parsed.success && parsed.data.message.content.some((block) => (
    block.type === 'tool_use' && block.name !== undefined && FILE_EDIT_TOOLS.has(block.name)
  ));
};

const titleOf = (info) => {
  const title = info.customTitle || info.summary || info.firstPrompt || 'Claude Code session';
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
};

/**
 * @param {object} options
 * @param {() => Promise<import('@anthropic-ai/claude-agent-sdk')>} options.loadSdk
 * @param {ReturnType<typeof import('../registry.js').createNativeRegistry>} options.registry
 * @param {number} [options.historyCacheBytes] transcript bytes whose projections are kept in memory
 */
export const createClaudeSessionStore = ({ loadSdk, registry, historyCacheBytes = DEFAULT_HISTORY_CACHE_BYTES }) => {
  // Projecting a large transcript costs about 100 ms (89 MB, 1,642 messages),
  // and the UI reads history a page at a time, so projections are reused
  // while the transcript is unchanged. Least recently used first out.
  const historyCache = new Map();
  let cachedBytes = 0;
  // Which tool call spawned a subagent never changes.
  const toolUseByAgent = new Map();

  const rememberHistory = (key, value) => {
    const previous = historyCache.get(key);
    if (previous) {
      historyCache.delete(key);
      cachedBytes -= previous.bytes;
    }
    historyCache.set(key, value);
    cachedBytes += value.bytes;
    for (const [oldestKey, oldest] of historyCache) {
      if (cachedBytes <= historyCacheBytes || oldestKey === key) break;
      historyCache.delete(oldestKey);
      cachedBytes -= oldest.bytes;
    }
  };

  const sessionRecord = (info, directory, registryEntry) => buildSessionRecord({
    id: encodeClaudeSessionId(info.sessionId),
    backend: 'claude',
    directory,
    title: titleOf(info),
    created: info.createdAt ?? info.lastModified,
    updated: info.lastModified,
    archived: registryEntry?.archivedAt ?? null,
  });

  /**
   * Root sessions for one directory. Throws when the store cannot be read.
   * @param {string} directory
   */
  const listRootSessions = async (directory) => {
    const sdk = await loadSdk();
    const [interactive, registered, unconfirmed] = await Promise.all([
      sdk.listSessions({ dir: directory, includeProgrammatic: false, includeWorktrees: false }),
      registry.listSessions({ backend: 'claude', directory }),
      registry.unconfirmedSessions({ backend: 'claude', directory }),
    ]);
    const registryByUuid = new Map(registered.map((entry) => [entry.nativeId, entry]));
    const infos = new Map();
    for (const raw of interactive) {
      const info = sessionInfoSchema.safeParse(raw);
      if (info.success) infos.set(info.data.sessionId, info.data);
    }
    const missing = registered.filter((entry) => !infos.has(entry.nativeId));
    const registeredInfos = await Promise.all(missing.map((entry) => sdk.getSessionInfo(entry.nativeId, { dir: directory })));
    for (const raw of registeredInfos) {
      const info = sessionInfoSchema.safeParse(raw);
      if (info.success) infos.set(info.data.sessionId, info.data);
    }
    const records = Array.from(infos.values(), (info) => sessionRecord(info, directory, registryByUuid.get(info.sessionId)));
    const listed = new Set(records.map((record) => record.id));
    for (const entry of unconfirmed) {
      if (!listed.has(entry.sessionId)) records.push(unconfirmedSessionRecord(entry));
    }
    return records;
  };

  const unconfirmedEntry = async (sessionId) => (await registry.unconfirmedSessions({ sessionId }))[0] ?? null;

  const findSessionInfo = async (sdk, sessionUuid, directory) => {
    const info = sessionInfoSchema.safeParse(await sdk.getSessionInfo(sessionUuid, { dir: directory }));
    return info.success ? info.data : null;
  };

  const toolUseIdOfAgent = async (sdk, sessionUuid, agentId, directory) => {
    const key = `${sessionUuid}\n${agentId}`;
    if (toolUseByAgent.has(key)) return toolUseByAgent.get(key);
    const [first] = await sdk.getSubagentMessages(sessionUuid, agentId, { dir: directory, limit: 1 });
    const parsed = subagentFirstMessageSchema.safeParse(first);
    const toolUseId = parsed.success ? parsed.data.parent_tool_use_id ?? null : null;
    if (toolUseId !== null) toolUseByAgent.set(key, toolUseId);
    return toolUseId;
  };

  /** Subagents of a session keyed by the tool call that spawned them. */
  const subagentsByToolUse = async (sdk, sessionUuid, directory) => {
    const agentIds = await sdk.listSubagents(sessionUuid, { dir: directory });
    const entries = await Promise.all(agentIds.map(async (agentId) => [await toolUseIdOfAgent(sdk, sessionUuid, agentId, directory), agentId]));
    return new Map(entries.filter(([toolUseId]) => toolUseId !== null));
  };

  // History reads drop the structured tool results the diff renderers need.
  // The raw transcript keeps them, and importing it into a throwaway store is
  // the SDK's way to read it. Only transcripts that edit files pay for the
  // second read, and a failure costs the diffs, never the history.
  const fileEditResults = async (sdk, entries, sessionUuid, directory, includeSubagents) => {
    const results = new Map();
    if (!entries.some(usesFileEditTool)) return results;
    try {
      await sdk.importSessionToStore(sessionUuid, {
        append: async (_key, rawEntries) => {
          addEditResults(results, rawEntries);
        },
        load: async () => null,
      }, { dir: directory, includeSubagents });
    } catch (error) {
      console.warn('[native-agents] Claude edit diffs unavailable for session', sessionUuid, error);
    }
    return results;
  };

  // The diff fields of the raw entries that carry an edit result, by entry uuid.
  const addEditResults = (results, rawEntries) => {
    for (const raw of rawEntries) {
      const entry = rawToolResultEntrySchema.safeParse(raw);
      const slim = entry.success ? slimFileEditResult(entry.data.toolUseResult) : null;
      if (slim) results.set(entry.data.uuid, slim);
    }
    return results;
  };

  // A root session's raw transcript in file order, or null when it cannot be read.
  const readRawTranscript = async (sdk, sessionUuid, directory) => {
    const raw = [];
    try {
      await sdk.importSessionToStore(sessionUuid, {
        append: async (_key, rawEntries) => {
          for (const entry of rawEntries) raw.push(entry);
        },
        load: async () => null,
      }, { dir: directory, includeSubagents: false });
      return raw;
    } catch (error) {
      console.warn('[native-agents] Claude transcript unavailable for session', sessionUuid, error);
      return null;
    }
  };

  const withFileEditResults = (entries, results) => (results.size === 0 ? entries : entries.map((entry) => {
    const result = results.get(entry.uuid);
    return result && entry.tool_use_result === undefined ? { ...entry, tool_use_result: result } : entry;
  }));

  const project = ({ sessionId, directory, entries, sendRecords, subagents }) => {
    const decoded = decodeNativeSessionId(sessionId);
    const projection = createClaudeProjection({
      sessionId,
      cwd: directory,
      sendRecordFor: (messageId) => sendRecords.get(messageId) ?? null,
      childSessionIdForToolUse: (toolUseId) => (subagents.has(toolUseId) && decoded
        ? encodeClaudeChildSessionId(decoded.sessionUuid, toolUseId)
        : null),
    });
    for (const entry of entries) projection.applyEntry(entry);
    projection.settleOpenTools('The turn ended before this tool finished.');
    return projection.records();
  };

  const childSessionRecords = (parent, records, subagents, sessionUuid, directory) => {
    const children = [];
    for (const record of records) {
      for (const part of record.parts) {
        if (part.type !== 'tool' || part.tool !== 'task' || !subagents.has(part.callID)) continue;
        const input = z.object({ description: z.string().optional(), subagent_type: z.string().optional() }).passthrough().safeParse(part.state.input);
        children.push(buildSessionRecord({
          id: encodeClaudeChildSessionId(sessionUuid, part.callID),
          backend: 'claude',
          directory,
          title: input.data?.description ?? input.data?.subagent_type ?? 'Subagent',
          created: part.state.time.start,
          updated: part.state.time.end ?? part.state.time.start,
          parentID: parent,
        }));
      }
    }
    return children;
  };

  // Subagent sessions live in their parent's transcript and follow its
  // archive flag, which can change without the transcript changing.
  const withParentArchive = async (sessionId, childSessions) => {
    const archivedAt = (await registry.getSession(sessionId))?.archivedAt;
    if (archivedAt === undefined) return childSessions;
    return childSessions.map((child) => ({ ...child, time: { ...child.time, archived: archivedAt } }));
  };

  // The conversation before the last compaction, oldest first. The SDK reads
  // only the chain after the last compaction, so each earlier segment comes
  // from handing the SDK the raw transcript cut just before a compaction: it
  // then returns, by its own chain rules, the chain from the compaction before
  // (or the start) up to there. Messages a compaction carried over also open
  // the chain after it; they stay in the segment they were written in.
  const earlierEntries = async (sdk, sessionUuid, directory, raw, boundaryUuid) => {
    const boundaries = new Map();
    const positions = new Map();
    raw.forEach((value, index) => {
      const entry = rawChainEntrySchema.safeParse(value);
      if (!entry.success) return;
      positions.set(entry.data.uuid, index);
      if (entry.data.type === 'system' && entry.data.subtype === 'compact_boundary') boundaries.set(entry.data.uuid, entry.data);
    });
    const segments = [];
    const visited = new Set();
    let boundary = boundaries.get(boundaryUuid);
    while (boundary && !visited.has(boundary.uuid)) {
      visited.add(boundary.uuid);
      // The transcript as it stood just before this compaction. The boundary's
      // logicalParentUuid is no guide: the CLI can name an entry it writes
      // after the boundary.
      const cut = raw.slice(0, positions.get(boundary.uuid));
      const segment = await sdk.getSessionMessages(sessionUuid, {
        dir: directory,
        includeSystemMessages: true,
        sessionStore: { append: async () => {}, load: async () => cut },
      });
      segments.unshift(segment);
      boundary = boundaries.get(entryUuidOf(segment[0]));
    }
    const seen = new Set();
    const entries = [];
    for (const entry of segments.flat()) {
      const uuid = entryUuidOf(entry);
      if (uuid === null || seen.has(uuid)) continue;
      seen.add(uuid);
      entries.push(entry);
    }
    return entries;
  };

  // The earlier segments projected on their own, with the entry uuids they
  // hold. They never change while their last compaction stays the last one.
  // A failure leaves them out; the chain after the compaction still shows.
  const projectEarlier = async ({ sdk, sessionId, sessionUuid, directory, raw, boundaryUuid, editResults, sendRecords, subagents }) => {
    try {
      const entries = await earlierEntries(sdk, sessionUuid, directory, raw, boundaryUuid);
      return {
        boundaryUuid,
        records: project({ sessionId, directory, entries: withFileEditResults(entries, editResults), sendRecords, subagents }),
        uuids: new Set(entries.map(entryUuidOf)),
      };
    } catch (error) {
      console.warn('[native-agents] Claude history before the last compaction unavailable for session', sessionUuid, error);
      return null;
    }
  };

  /**
   * The whole projected conversation of a root or subagent session, plus the
   * subagent sessions a root session links to.
   * @param {string} sessionId
   * @param {string} directory
   * @returns {Promise<{ records: Array<{ info: object, parts: object[] }>, childSessions: object[] } | null>}
   *   null when the session does not exist
   */
  const loadHistory = async (sessionId, directory) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude') return null;
    const sdk = await loadSdk();
    const info = await findSessionInfo(sdk, decoded.sessionUuid, directory);
    if (!info) {
      const unconfirmed = decoded.toolUseId === null && (await unconfirmedEntry(sessionId)) !== null;
      return unconfirmed ? { records: [], childSessions: [] } : null;
    }

    if (decoded.toolUseId === null) {
      const cacheKey = sessionId;
      const fingerprint = `${info.fileSize ?? 0}:${info.lastModified}`;
      const cached = historyCache.get(cacheKey);
      if (cached && cached.fingerprint === fingerprint) {
        rememberHistory(cacheKey, cached);
        return { records: cached.value.records, childSessions: await withParentArchive(sessionId, cached.value.childSessions) };
      }
      const [entries, sendRecords, subagents] = await Promise.all([
        sdk.getSessionMessages(decoded.sessionUuid, { dir: directory, includeSystemMessages: true }),
        registry.sendRecords(sessionId),
        subagentsByToolUse(sdk, decoded.sessionUuid, directory),
      ]);
      // A compacted conversation also shows what came before its last
      // compaction. Those segments are reused while that compaction stays the
      // last one; building them reads the raw transcript, which then gives the
      // edit diffs too.
      const boundaryUuid = compactionBoundaryUuid(entries);
      const reusable = boundaryUuid !== null && cached?.value.earlier?.boundaryUuid === boundaryUuid ? cached.value.earlier : null;
      const raw = boundaryUuid !== null && reusable === null ? await readRawTranscript(sdk, decoded.sessionUuid, directory) : null;
      const editResults = raw === null
        ? await fileEditResults(sdk, entries, decoded.sessionUuid, directory, false)
        : addEditResults(new Map(), raw);
      const earlier = reusable ?? (raw === null ? null : await projectEarlier({
        sdk, sessionId, sessionUuid: decoded.sessionUuid, directory, raw, boundaryUuid, editResults, sendRecords, subagents,
      }));
      const current = earlier === null ? entries : entries.filter((entry) => !earlier.uuids.has(entryUuidOf(entry)));
      const records = [
        ...(earlier?.records ?? []),
        ...project({ sessionId, directory, entries: withFileEditResults(current, editResults), sendRecords, subagents }),
      ];
      const value = { records, childSessions: childSessionRecords(sessionId, records, subagents, decoded.sessionUuid, directory), earlier };
      rememberHistory(cacheKey, { fingerprint, bytes: info.fileSize ?? 0, value });
      return { records, childSessions: await withParentArchive(sessionId, value.childSessions) };
    }

    // A subagent transcript is read fresh: it changes while the subagent runs
    // without touching the parent transcript the cache is keyed on.
    const subagents = await subagentsByToolUse(sdk, decoded.sessionUuid, directory);
    const agentId = subagents.get(decoded.toolUseId);
    if (!agentId) return null;
    const entries = await sdk.getSubagentMessages(decoded.sessionUuid, agentId, { dir: directory });
    const editResults = await fileEditResults(sdk, entries, decoded.sessionUuid, directory, true);
    return {
      records: project({ sessionId, directory, entries: withFileEditResults(entries, editResults), sendRecords: new Map(), subagents: new Map() }),
      childSessions: [],
    };
  };

  /**
   * One session record, or null when it does not exist. A subagent session is
   * found through its parent's history.
   */
  const getSession = async (sessionId, directory) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude') return null;
    if (decoded.toolUseId !== null) {
      const parent = await loadHistory(encodeClaudeSessionId(decoded.sessionUuid), directory);
      return parent?.childSessions.find((child) => child.id === sessionId) ?? null;
    }
    const sdk = await loadSdk();
    const info = await findSessionInfo(sdk, decoded.sessionUuid, directory);
    if (!info) {
      const entry = await unconfirmedEntry(sessionId);
      return entry ? unconfirmedSessionRecord(entry) : null;
    }
    return sessionRecord(info, directory, await registry.getSession(sessionId));
  };

  /** @returns {Promise<boolean>} */
  const sessionExists = async (sessionId, directory) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude') return false;
    const sdk = await loadSdk();
    if ((await findSessionInfo(sdk, decoded.sessionUuid, directory)) !== null) return true;
    return decoded.toolUseId === null && (await unconfirmedEntry(sessionId)) !== null;
  };

  /** Whether the CLI has a transcript for the session, so a query resumes it. */
  const hasTranscript = async (sessionUuid, directory) => {
    const sdk = await loadSdk();
    return (await findSessionInfo(sdk, sessionUuid, directory)) !== null;
  };

  // Revert, fork, rename and delete act on a whole transcript, which only a
  // root session has.
  const rootUuidOf = (sessionId) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude' || decoded.toolUseId !== null) {
      throw invalidRequestError(`Not a Claude Code root session: ${sessionId}`);
    }
    return decoded.sessionUuid;
  };

  // The conversation chain of a root session as the CLI resumes it: entry
  // uuids and types, oldest first.
  const chainOf = async (sessionId, directory) => {
    const sdk = await loadSdk();
    const entries = await sdk.getSessionMessages(rootUuidOf(sessionId), { dir: directory, includeSystemMessages: true });
    return entries.map((entry) => chainEntrySchema.safeParse(entry)).filter((entry) => entry.success).map((entry) => entry.data);
  };

  /**
   * Where a revert or fork of a prompt rewinds the conversation: the last
   * chain entry before the prompt (null when the prompt is the first entry).
   * Also returns the ids of that prompt and every later user entry.
   * @param {string} sessionId
   * @param {string} directory
   * @param {string} messageId
   */
  const rewindTarget = async (sessionId, directory, messageId) => {
    const entryUuid = claudeEntryUuidOfUserMessageId(messageId);
    if (!entryUuid) throw invalidRequestError(`Not a Claude Code prompt: ${messageId}`);
    const chain = await chainOf(sessionId, directory);
    const index = chain.findIndex((entry) => entry.uuid === entryUuid);
    if (index === -1) {
      // The history also shows the messages before the last compaction, and
      // the CLI cannot resume at those.
      await loadHistory(sessionId, directory);
      if (historyCache.get(sessionId)?.value.earlier?.uuids.has(entryUuid)) throw rewindBeforeCompactionError();
      throw messageNotFoundError(messageId);
    }
    return {
      resumeAt: index === 0 ? null : chain[index - 1].uuid,
      messageIds: chain.slice(index).filter((entry) => entry.type === 'user').map((entry) => claudeUserMessageId(entry.uuid)),
    };
  };

  /** Whether the conversation the CLI resumes still holds a user message. */
  const chainHolds = async (sessionId, directory, messageId) => {
    const entryUuid = claudeEntryUuidOfUserMessageId(messageId);
    return (await chainOf(sessionId, directory)).some((entry) => entry.uuid === entryUuid);
  };

  /** Sets the session's title in its transcript, where the terminal reads it too. */
  const rename = async (sessionId, directory, title) => {
    const sdk = await loadSdk();
    await sdk.renameSession(rootUuidOf(sessionId), title, { dir: directory });
  };

  /**
   * Deletes the transcript and its subagent transcripts, as the SDK does.
   * @returns {Promise<boolean>} false when there was no transcript to delete
   */
  const deleteTranscript = async (sessionId, directory) => {
    const sessionUuid = rootUuidOf(sessionId);
    const sdk = await loadSdk();
    if ((await findSessionInfo(sdk, sessionUuid, directory)) === null) return false;
    await sdk.deleteSession(sessionUuid, { dir: directory });
    historyCache.delete(sessionId);
    return true;
  };

  /**
   * Copies the conversation up to and including a chain entry into a new
   * session. The copy's title is the original's with " (fork)".
   * @returns {Promise<string>} the new session's uuid
   */
  const fork = async (sessionId, directory, upToEntry) => {
    const sdk = await loadSdk();
    return forkResultSchema.parse(await sdk.forkSession(rootUuidOf(sessionId), { dir: directory, upToMessageId: upToEntry })).sessionId;
  };

  return {
    listRootSessions,
    getSession,
    loadHistory,
    sessionExists,
    hasTranscript,
    rewindTarget,
    chainHolds,
    fork,
    rename,
    deleteTranscript,
  };
};
