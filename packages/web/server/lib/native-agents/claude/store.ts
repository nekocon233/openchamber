import type { ForkSessionOptions, GetSessionMessagesOptions, ListSessionsOptions, SessionMessage, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { invalidRequestError, messageNotFoundError, rewindBeforeCompactionError } from '../errors.js';
import { claudeModelContextWindow } from '../catalog.js';
import {
  claudeEntryUuidOfUserMessageId,
  claudeAssistantMessageId,
  claudeUserMessageId,
  decodeNativeSessionId,
  encodeClaudeChildSessionId,
  encodeClaudeSessionId,
} from '../ids.js';
import { buildSessionRecord, unconfirmedSessionRecord } from '../records.js';
import type { NativeMessageRecord, NativeSessionRecord } from '../records.js';
import type { NativeRegistry, RegistrySessionEntry } from '../registry.js';
import type { ClaudeConnections } from './connections.js';
import {
  addFailedCompactions,
  compactionBoundaryUuid,
  emptyFailedCompactions,
  isCompactCommandEntry,
  readEarlierCompactionEntries,
  withFailedCompactions,
} from './compaction.js';
import type { FailedCompactionIndex } from './compaction.js';
import { createClaudeProjection } from './projector.js';
import type { ClaudeRawEntry, ClaudeSendRecord } from './projector.js';
import type { ClaudeSdkModule } from './sdk.js';
import { slimToolResult, UNFINISHED_TOOL_ERROR } from './tools.js';
import type { SlimClaudeToolResult } from './tools.js';

const MAX_TITLE_LENGTH = 100;
const DEFAULT_HISTORY_CACHE_BYTES = 128 * 1024 * 1024;
const opaqueJson = z.custom<JsonValue>(() => true);

const REMOVED_PLAN_REPLAY_PREFIX = 'openchamber-responses:';
const removedPlanReplayBlock = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string().startsWith(REMOVED_PLAN_REPLAY_PREFIX),
});

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
  message: z.object({ content: opaqueJson.optional() }).passthrough().optional(),
}).passthrough();

const chainEntrySchema = z.object({ type: z.string(), uuid: z.string() }).passthrough();
const forkResultSchema = z.object({ sessionId: z.string() }).passthrough();

const replayEntrySchema = z.object({
  isSidechain: z.boolean().optional(),
  message: z.object({ content: opaqueJson.optional() }).passthrough().optional(),
}).passthrough();
const contentBlockSchema = z.object({
  type: z.string(),
  tool_name: opaqueJson.optional(),
  content: opaqueJson.optional(),
}).passthrough();

const SUPPLEMENTED_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'AskUserQuestion']);
const STRUCTURED_RESULT_TOOLS = new Set([...SUPPLEMENTED_TOOLS, 'Bash']);

const assistantToolUsesSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.object({ type: z.string(), name: z.string().optional() }).passthrough()),
  }).passthrough(),
}).passthrough();

const rawToolResultEntrySchema = z.object({
  uuid: z.string(),
  toolUseResult: opaqueJson.optional(),
});

type StatisticsContent =
  | { kind: 'text'; text: string }
  | { kind: 'blocks'; blocks: JsonValue[] };

const statisticsEntrySchema = z.object({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string(),
  timestamp: z.string().optional(),
  isCompactSummary: z.boolean().optional(),
  is_meta: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isSynthetic: z.boolean().optional(),
  isCompletedLocalCommand: z.boolean().optional(),
  origin: z.object({ kind: z.string() }).optional(),
  subtype: z.string().optional(),
  message: z.object({
    id: z.string().optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    stop_reason: z.string().nullish(),
    usage: opaqueJson.optional(),
    content: z.union([
      z.string().transform((text): StatisticsContent => ({ kind: 'text', text })),
      z.array(opaqueJson).transform((blocks): StatisticsContent => ({ kind: 'blocks', blocks })),
    ]),
  }).nullish(),
});
const statisticsBlockSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  text: z.string().optional(),
});
const statisticsUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
});
const statisticsBaseUsageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number() });

const toolMessageSchema = z.object({
  type: z.enum(['user', 'assistant']),
  message: z.object({
    content: z.array(z.object({
      type: z.string(),
      id: z.string().optional(),
      tool_use_id: z.string().optional(),
    })),
  }),
});

type ParsedSessionInfo = z.infer<typeof sessionInfoSchema>;
type ParsedChainEntry = z.infer<typeof chainEntrySchema>;

type EarlierProjection = {
  boundaryUuid: string;
  records: NativeMessageRecord[];
  uuids: Set<string>;
};

type CachedHistoryValue = {
  records: NativeMessageRecord[];
  childSessions: NativeSessionRecord[];
  earlier: EarlierProjection | null;
};

type CachedHistoryEntry = {
  fingerprint: string;
  bytes: number;
  value: CachedHistoryValue;
};

type SlimStatisticsEntry = JsonObject & {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  timestamp?: string;
  message?: (JsonObject & {
    id?: string;
    usage?: JsonValue;
  }) | null;
};

export type ClaudeHistoryResult = {
  records: NativeMessageRecord[];
  childSessions: NativeSessionRecord[];
  metadataComplete?: boolean;
};

export type ClaudeStatisticsResult = {
  records: NativeMessageRecord[];
  childSessions: NativeSessionRecord[];
  complete?: boolean;
  reasoningKnown?: boolean;
  tokensComplete?: boolean;
};

export type ClaudeReplayHistoryInspection = {
  toolReferences: string[];
  hasRemovedPlanReplayState: boolean;
};

export type ClaudeRewindTarget = {
  resumeAt: string | null;
  messageIds: string[];
};

export interface ClaudeSessionStoreOptions {
  loadSdk: () => Promise<ClaudeSdkModule>;
  registry: Pick<NativeRegistry, 'listSessions' | 'unconfirmedSessions' | 'sendRecords' | 'getSession'>;
  connections?: Pick<ClaudeConnections, 'catalog'> | null | undefined;
  historyCacheBytes?: number | undefined;
  isSessionRunning?: ((sessionId: string) => boolean) | undefined;
}

export interface ClaudeSessionStore {
  listRootSessions: (directory?: string) => Promise<NativeSessionRecord[]>;
  listStatisticsSessions: () => Promise<NativeSessionRecord[]>;
  loadStatistics: (sessionId: string, directory: string, options?: { signal?: AbortSignal | undefined }) => Promise<ClaudeStatisticsResult | null>;
  getSession: (sessionId: string, directory: string) => Promise<NativeSessionRecord | null>;
  loadHistory: (sessionId: string, directory: string) => Promise<ClaudeHistoryResult | null>;
  sessionExists: (sessionId: string, directory?: string) => Promise<boolean>;
  hasTranscript: (sessionUuid: string, directory: string) => Promise<boolean>;
  inspectReplayHistory: (sessionUuid: string, directory: string) => Promise<ClaudeReplayHistoryInspection>;
  rewindTarget: (sessionId: string, directory: string, messageId: string) => Promise<ClaudeRewindTarget>;
  chainHolds: (sessionId: string, directory: string, messageId: string) => Promise<boolean>;
  fork: (sessionId: string, directory: string, upToEntry?: string) => Promise<string>;
  rename: (sessionId: string, directory: string, title: string) => Promise<void>;
  deleteTranscript: (sessionId: string, directory: string) => Promise<boolean>;
}

const statisticsEntry = (raw: SessionMessage): SlimStatisticsEntry | null => {
  const entry = statisticsEntrySchema.safeParse(raw);
  if (!entry.success) return null;
  const value = entry.data;
  const base: SlimStatisticsEntry = { type: value.type, uuid: value.uuid };
  if (value.timestamp !== undefined) base.timestamp = value.timestamp;
  if (value.isCompactSummary !== undefined) base.isCompactSummary = value.isCompactSummary;
  if (value.is_meta !== undefined) base.is_meta = value.is_meta;
  if (value.isMeta !== undefined) base.isMeta = value.isMeta;
  if (value.isSynthetic !== undefined) base.isSynthetic = value.isSynthetic;
  if (value.isCompletedLocalCommand !== undefined) base.isCompletedLocalCommand = value.isCompletedLocalCommand;
  if (value.origin !== undefined) base.origin = value.origin;
  if (value.subtype !== undefined) base.subtype = value.subtype;
  if (!value.message) {
    if (value.message === null) base.message = null;
    return base;
  }
  if (value.type === 'assistant' && value.message.model === '<synthetic>') return null;
  const content: JsonValue = value.message.content.kind === 'text'
    ? value.message.content.text
    : value.message.content.blocks.flatMap((rawBlock): JsonObject[] => {
      const parsed = statisticsBlockSchema.safeParse(rawBlock);
      if (!parsed.success) return [];
      const block = parsed.data;
      if (block.type === 'tool_use') {
        const toolUse: JsonObject = { type: block.type, input: {} };
        if (block.id !== undefined) toolUse.id = block.id;
        if (block.name !== undefined) toolUse.name = block.name;
        return [toolUse];
      }
      if (block.type === 'tool_result') {
        const toolResult: JsonObject = { type: block.type, content: '' };
        if (block.tool_use_id !== undefined) toolResult.tool_use_id = block.tool_use_id;
        if (block.is_error !== undefined) toolResult.is_error = block.is_error;
        return [toolResult];
      }
      if (block.type === 'text') return [{ type: 'text', text: value.type === 'user' ? block.text ?? '' : 'reply' }];
      if (value.type === 'user' && ['image', 'document'].includes(block.type)) return [{ type: 'text', text: 'attachment' }];
      return [];
    });
  const slimMessage: JsonObject & { id?: string; usage?: JsonValue } = { content };
  if (value.message.id !== undefined) slimMessage.id = value.message.id;
  if (value.message.model !== undefined) slimMessage.model = value.message.model;
  if (value.message.role !== undefined) slimMessage.role = value.message.role;
  if (value.message.stop_reason !== undefined) slimMessage.stop_reason = value.message.stop_reason;
  if (value.message.usage !== undefined) slimMessage.usage = value.message.usage;
  base.message = slimMessage;
  return base;
};

const entryUuidOf = (entry: ClaudeRawEntry | undefined): string | null => {
  const parsed = chainEntrySchema.safeParse(entry);
  return parsed.success ? parsed.data.uuid : null;
};

const usesToolIn = (tools: ReadonlySet<string>) => (entry: SessionMessage): boolean => {
  const parsed = assistantToolUsesSchema.safeParse(entry);
  return parsed.success && parsed.data.message.content.some((block) => (
    block.type === 'tool_use' && block.name !== undefined && tools.has(block.name)
  ));
};
const usesSupplementedTool = usesToolIn(SUPPLEMENTED_TOOLS);
const usesStructuredResultTool = usesToolIn(STRUCTURED_RESULT_TOOLS);

const missingToolResultIds = (entries: ReadonlyArray<SessionMessage>): Set<string> => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const entry of entries) {
    const parsed = toolMessageSchema.safeParse(entry);
    if (!parsed.success) continue;
    for (const block of parsed.data.message.content) {
      if (parsed.data.type === 'assistant' && block.type === 'tool_use' && block.id) calls.add(block.id);
      if (parsed.data.type === 'user' && block.type === 'tool_result' && block.tool_use_id) results.add(block.tool_use_id);
    }
  }
  return new Set([...calls].filter((id) => !results.has(id)));
};

const titleOf = (info: ParsedSessionInfo): string => {
  const title = info.customTitle || info.summary || info.firstPrompt || 'Claude Code session';
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
};

const transcriptHasConversation = async (sdk: ClaudeSdkModule, info: ParsedSessionInfo, directory?: string): Promise<boolean> => {
  if (info.createdAt !== undefined) return true;
  try {
    const options: GetSessionMessagesOptions = directory !== undefined ? { dir: directory, limit: 1 } : { limit: 1 };
    return (await sdk.getSessionMessages(info.sessionId, options)).length > 0;
  } catch {
    return true;
  }
};

export const createClaudeSessionStore = ({
  loadSdk,
  registry,
  connections = null,
  historyCacheBytes = DEFAULT_HISTORY_CACHE_BYTES,
  isSessionRunning = () => false,
}: ClaudeSessionStoreOptions): ClaudeSessionStore => {
  const historyCache = new Map<string, CachedHistoryEntry>();
  let cachedBytes = 0;
  const toolUseByAgent = new Map<string, string>();

  const rememberHistory = (key: string, value: CachedHistoryEntry): void => {
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

  const sessionRecord = (
    info: ParsedSessionInfo,
    directory: string,
    registryEntry: Pick<RegistrySessionEntry, 'archivedAt'> | null | undefined,
  ): NativeSessionRecord => buildSessionRecord({
    id: encodeClaudeSessionId(info.sessionId),
    backend: 'claude',
    directory,
    title: titleOf(info),
    created: info.createdAt ?? info.lastModified,
    updated: info.lastModified,
    archived: registryEntry?.archivedAt ?? null,
  });

  const listRootSessions = async (directory?: string): Promise<NativeSessionRecord[]> => {
    const sdk = await loadSdk();
    const listOptions: ListSessionsOptions = directory !== undefined
      ? { dir: directory, includeProgrammatic: false, includeWorktrees: false }
      : { includeProgrammatic: false, includeWorktrees: false };
    const [interactive, registered, unconfirmed] = await Promise.all([
      sdk.listSessions(listOptions),
      registry.listSessions({ backend: 'claude', directory }),
      registry.unconfirmedSessions({ backend: 'claude', directory }),
    ]);
    const registryByUuid = new Map(registered.map((entry) => [entry.nativeId, entry]));
    const infos = new Map<string, ParsedSessionInfo>();
    for (const raw of interactive) {
      const info = sessionInfoSchema.safeParse(raw);
      if (info.success) infos.set(info.data.sessionId, info.data);
    }
    const missing = registered.filter((entry) => !infos.has(entry.nativeId));
    const infoOptions = directory !== undefined ? { dir: directory } : undefined;
    const registeredInfos = await Promise.all(missing.map((entry) => sdk.getSessionInfo(entry.nativeId, infoOptions)));
    for (const raw of registeredInfos) {
      const info = sessionInfoSchema.safeParse(raw);
      if (info.success) infos.set(info.data.sessionId, info.data);
    }
    const recordFor = async (info: ParsedSessionInfo): Promise<NativeSessionRecord | null> => {
      const target = directory ?? info.cwd ?? registryByUuid.get(info.sessionId)?.directory;
      return await transcriptHasConversation(sdk, info, target)
        ? sessionRecord(info, target ?? '', registryByUuid.get(info.sessionId))
        : null;
    };
    const records = (await Promise.all(Array.from(infos.values(), recordFor))).filter((record) => record !== null);
    const listed = new Set(records.map((record) => record.id));
    for (const entry of unconfirmed) {
      if (!listed.has(entry.sessionId)) records.push(unconfirmedSessionRecord(entry));
    }
    return records;
  };

  const unconfirmedEntry = async (sessionId: string) => (await registry.unconfirmedSessions({ sessionId }))[0] ?? null;

  const findSessionInfo = async (sdk: ClaudeSdkModule, sessionUuid: string, directory?: string): Promise<ParsedSessionInfo | null> => {
    const info = sessionInfoSchema.safeParse(await sdk.getSessionInfo(sessionUuid, directory ? { dir: directory } : {}));
    return info.success ? info.data : null;
  };

  const toolUseIdOfAgent = async (sdk: ClaudeSdkModule, sessionUuid: string, agentId: string, directory: string): Promise<string | null> => {
    const key = `${sessionUuid}\n${agentId}`;
    const cached = toolUseByAgent.get(key);
    if (cached !== undefined) return cached;
    const [first] = await sdk.getSubagentMessages(sessionUuid, agentId, { dir: directory, limit: 1 });
    const parsed = subagentFirstMessageSchema.safeParse(first);
    const toolUseId = parsed.success ? parsed.data.parent_tool_use_id ?? null : null;
    if (toolUseId !== null) toolUseByAgent.set(key, toolUseId);
    return toolUseId;
  };

  const subagentsByToolUse = async (sdk: ClaudeSdkModule, sessionUuid: string, directory: string): Promise<Map<string, string>> => {
    const agentIds = await sdk.listSubagents(sessionUuid, { dir: directory });
    const entries = await Promise.all(agentIds.map(async (agentId): Promise<[string | null, string]> => [
      await toolUseIdOfAgent(sdk, sessionUuid, agentId, directory),
      agentId,
    ]));
    const subagents = new Map<string, string>();
    for (const [toolUseId, agentId] of entries) {
      if (toolUseId !== null) subagents.set(toolUseId, agentId);
    }
    return subagents;
  };

  const addStructuredResults = (
    results: Map<string, SlimClaudeToolResult>,
    rawEntries: ReadonlyArray<SessionStoreEntry>,
  ): Map<string, SlimClaudeToolResult> => {
    for (const raw of rawEntries) {
      const entry = rawToolResultEntrySchema.safeParse(raw);
      if (!entry.success || entry.data.toolUseResult === undefined) continue;
      const slim = slimToolResult(entry.data.toolUseResult);
      if (slim) results.set(entry.data.uuid, slim);
    }
    return results;
  };

  const transcriptSupplement = async (
    sdk: ClaudeSdkModule,
    entries: ReadonlyArray<SessionMessage>,
    sessionUuid: string,
    directory: string,
    includeSubagents: boolean,
  ): Promise<{ results: Map<string, SlimClaudeToolResult>; failedCompactions: FailedCompactionIndex; complete: boolean }> => {
    const results = new Map<string, SlimClaudeToolResult>();
    const failedCompactions = emptyFailedCompactions();
    const needsToolResults = entries.some(usesStructuredResultTool);
    const needsCompactOutcomes = entries.some(isCompactCommandEntry);
    if (!needsToolResults && !needsCompactOutcomes) return { results, failedCompactions, complete: true };
    try {
      await sdk.importSessionToStore(sessionUuid, {
        append: async (_key, rawEntries) => {
          if (needsToolResults) addStructuredResults(results, rawEntries);
          if (needsCompactOutcomes) addFailedCompactions(failedCompactions, rawEntries);
        },
        load: async () => null,
      }, { dir: directory, includeSubagents });
    } catch (error) {
      console.warn('[native-agents] Claude supplemental transcript data unavailable for session', sessionUuid, error);
      return { results, failedCompactions, complete: false };
    }
    return { results, failedCompactions, complete: true };
  };

  const readRawTranscript = async (sdk: ClaudeSdkModule, sessionUuid: string, directory: string): Promise<SessionStoreEntry[] | null> => {
    const raw: SessionStoreEntry[] = [];
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

  const withStructuredResults = (
    entries: ReadonlyArray<SessionMessage>,
    results: ReadonlyMap<string, SlimClaudeToolResult>,
  ): ClaudeRawEntry[] => (results.size === 0 ? [...entries] : entries.map((entry) => {
    const result = results.get(entry.uuid);
    return result && !('tool_use_result' in entry && entry.tool_use_result !== undefined)
      ? { ...entry, tool_use_result: result }
      : entry;
  }));

  const readContextWindowFor = async (): Promise<(modelID: string | null) => number> => {
    if (!connections) return claudeModelContextWindow;
    try {
      const byModelId = new Map<string, number>();
      for (const model of await connections.catalog()) {
        if ((model.contextWindow ?? 0) <= 0) continue;
        byModelId.set(model.id, model.contextWindow);
        if (model.modelID) byModelId.set(model.modelID, model.contextWindow);
      }
      return (modelID) => (modelID !== null ? byModelId.get(modelID) : undefined) ?? claudeModelContextWindow(modelID);
    } catch {
      return claudeModelContextWindow;
    }
  };

  const project = ({
    sessionId,
    directory,
    entries,
    sendRecords,
    subagents,
    recoveredResults = [],
    contextWindowFor,
    settle = true,
  }: {
    sessionId: string;
    directory: string;
    entries: ReadonlyArray<ClaudeRawEntry>;
    sendRecords: ReadonlyMap<string, ClaudeSendRecord>;
    subagents: ReadonlyMap<string, string>;
    recoveredResults?: ReadonlyArray<ClaudeRawEntry> | undefined;
    contextWindowFor?: ((modelID: string | null) => number) | undefined;
    settle?: boolean | 'earlier-turns' | undefined;
  }): NativeMessageRecord[] => {
    const decoded = decodeNativeSessionId(sessionId);
    const claudeRef = decoded?.backend === 'claude' ? decoded : null;
    const projection = createClaudeProjection({
      sessionId,
      cwd: directory,
      sendRecordFor: (messageId) => sendRecords.get(messageId) ?? null,
      childSessionIdForToolUse: (toolUseId) => (subagents.has(toolUseId) && claudeRef
        ? encodeClaudeChildSessionId(claudeRef.sessionUuid, toolUseId)
        : null),
      contextWindowFor: contextWindowFor ?? claudeModelContextWindow,
    });
    for (const entry of entries) projection.applyEntry(entry);
    for (const entry of recoveredResults) projection.applyToolResults(entry);
    if (settle) projection.settleOpenTools(UNFINISHED_TOOL_ERROR, { keepCurrentTurn: settle === 'earlier-turns' });
    return projection.records();
  };

  const subagentToolResults = async (
    sdk: ClaudeSdkModule,
    sessionUuid: string,
    agentId: string,
    directory: string,
    entries: ReadonlyArray<SessionMessage>,
  ): Promise<{ edits: Map<string, SlimClaudeToolResult>; recoveredResults: SessionStoreEntry[]; complete: boolean }> => {
    const edits = new Map<string, SlimClaudeToolResult>();
    const recoveredResults: SessionStoreEntry[] = [];
    const missing = missingToolResultIds(entries);
    if (missing.size === 0 && !entries.some(usesSupplementedTool)) return { edits, recoveredResults, complete: true };
    let found = false;
    try {
      await sdk.importSessionToStore(sessionUuid, {
        append: async (key, rawEntries) => {
          if (key.subpath?.split('/').at(-1) !== `agent-${agentId}`) return;
          found = true;
          addStructuredResults(edits, rawEntries);
          for (const entry of rawEntries) {
            const parsed = toolMessageSchema.safeParse(entry);
            if (parsed.success && parsed.data.type === 'user' && parsed.data.message.content.some((block) => (
              block.type === 'tool_result' && block.tool_use_id !== undefined && missing.has(block.tool_use_id)
            ))) recoveredResults.push(entry);
          }
        },
        load: async () => null,
      }, { dir: directory, includeSubagents: true });
      if (!found) throw new Error('Subagent transcript is unavailable');
    } catch (error) {
      if (missing.size > 0) throw error;
      console.warn('[native-agents] Claude subagent edit diffs unavailable');
      return { edits, recoveredResults, complete: false };
    }
    return { edits, recoveredResults, complete: true };
  };

  const childSessionRecords = (
    parent: string,
    records: ReadonlyArray<NativeMessageRecord>,
    subagents: ReadonlyMap<string, string>,
    sessionUuid: string,
    directory: string,
  ): NativeSessionRecord[] => {
    const children: NativeSessionRecord[] = [];
    for (const record of records) {
      for (const part of record.parts) {
        if (part.type !== 'tool' || part.tool !== 'task' || !subagents.has(part.callID)) continue;
        const input = z.object({ description: z.string().optional(), subagent_type: z.string().optional() }).passthrough().safeParse(part.state.input);
        const end = 'end' in part.state.time ? part.state.time.end : part.state.time.start;
        children.push(buildSessionRecord({
          id: encodeClaudeChildSessionId(sessionUuid, part.callID),
          backend: 'claude',
          directory,
          title: input.data?.description ?? input.data?.subagent_type ?? 'Subagent',
          created: part.state.time.start,
          updated: end,
          parentID: parent,
        }));
      }
    }
    return children;
  };

  const withParentArchive = async (sessionId: string, childSessions: NativeSessionRecord[]): Promise<NativeSessionRecord[]> => {
    const archivedAt = (await registry.getSession(sessionId))?.archivedAt;
    if (archivedAt === undefined) return childSessions;
    return childSessions.map((child) => ({ ...child, time: { ...child.time, archived: archivedAt } }));
  };

  const projectEarlier = async ({
    sdk,
    sessionId,
    sessionUuid,
    directory,
    raw,
    boundaryUuid,
    editResults,
    failedCompactions,
    sendRecords,
    subagents,
    contextWindowFor,
  }: {
    sdk: ClaudeSdkModule;
    sessionId: string;
    sessionUuid: string;
    directory: string;
    raw: ReadonlyArray<SessionStoreEntry>;
    boundaryUuid: string;
    editResults: ReadonlyMap<string, SlimClaudeToolResult>;
    failedCompactions: FailedCompactionIndex;
    sendRecords: ReadonlyMap<string, ClaudeSendRecord>;
    subagents: ReadonlyMap<string, string>;
    contextWindowFor: (modelID: string | null) => number;
  }): Promise<EarlierProjection | null> => {
    try {
      const entries = withFailedCompactions(
        withStructuredResults(await readEarlierCompactionEntries(sdk, sessionUuid, directory, raw, boundaryUuid), editResults),
        failedCompactions,
      );
      const uuids = new Set<string>();
      for (const entry of entries) {
        const uuid = entryUuidOf(entry);
        if (uuid !== null) uuids.add(uuid);
      }
      return {
        boundaryUuid,
        records: project({ sessionId, directory, entries, sendRecords, subagents, contextWindowFor }),
        uuids,
      };
    } catch (error) {
      console.warn('[native-agents] Claude history before the last compaction unavailable for session', sessionUuid, error);
      return null;
    }
  };

  const loadHistory = async (sessionId: string, directory: string): Promise<ClaudeHistoryResult | null> => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude') return null;
    const sdk = await loadSdk();
    const info = await findSessionInfo(sdk, decoded.sessionUuid, directory);
    if (!info) {
      const unconfirmed = decoded.toolUseId === null && (await unconfirmedEntry(sessionId)) !== null;
      return unconfirmed ? { records: [], childSessions: [] } : null;
    }

    if (decoded.toolUseId === null) {
      const runningAtStart = isSessionRunning(sessionId);
      const cacheKey = sessionId;
      const fingerprint = `${info.fileSize ?? 0}:${info.lastModified}:${runningAtStart ? 'running' : 'idle'}`;
      const cached = historyCache.get(cacheKey);
      if (cached && cached.fingerprint === fingerprint) {
        rememberHistory(cacheKey, cached);
        return { records: cached.value.records, childSessions: await withParentArchive(sessionId, cached.value.childSessions) };
      }
      const [entries, sendRecords, subagents, contextWindowFor] = await Promise.all([
        sdk.getSessionMessages(decoded.sessionUuid, { dir: directory, includeSystemMessages: true }),
        registry.sendRecords(sessionId),
        subagentsByToolUse(sdk, decoded.sessionUuid, directory),
        readContextWindowFor(),
      ]);
      const boundaryUuid = compactionBoundaryUuid(entries);
      const reusable = boundaryUuid !== null && cached?.value.earlier?.boundaryUuid === boundaryUuid ? cached.value.earlier : null;
      const raw = boundaryUuid !== null && reusable === null ? await readRawTranscript(sdk, decoded.sessionUuid, directory) : null;
      const rawSupplement = raw === null ? null : {
        results: addStructuredResults(new Map(), raw),
        failedCompactions: addFailedCompactions(emptyFailedCompactions(), raw),
        complete: true,
      };
      const earlier = reusable ?? (raw === null || rawSupplement === null || boundaryUuid === null ? null : await projectEarlier({
        sdk,
        sessionId,
        sessionUuid: decoded.sessionUuid,
        directory,
        raw,
        boundaryUuid,
        editResults: rawSupplement.results,
        failedCompactions: rawSupplement.failedCompactions,
        sendRecords,
        subagents,
        contextWindowFor,
      }));
      const currentEntries = earlier === null ? entries : entries.filter((entry) => {
        const uuid = entryUuidOf(entry);
        return uuid === null || !earlier.uuids.has(uuid);
      });
      const supplement = rawSupplement ?? await transcriptSupplement(sdk, currentEntries, decoded.sessionUuid, directory, false);
      const current = withFailedCompactions(withStructuredResults(currentEntries, supplement.results), supplement.failedCompactions);
      const running = isSessionRunning(sessionId);
      const records = [
        ...(earlier?.records ?? []),
        ...project({ sessionId, directory, entries: current, sendRecords, subagents, contextWindowFor, settle: running ? 'earlier-turns' : true }),
      ];
      const value: CachedHistoryValue = {
        records,
        childSessions: childSessionRecords(sessionId, records, subagents, decoded.sessionUuid, directory),
        earlier,
      };
      if (supplement.complete && running === runningAtStart) rememberHistory(cacheKey, { fingerprint, bytes: info.fileSize ?? 0, value });
      const result: ClaudeHistoryResult = { records, childSessions: await withParentArchive(sessionId, value.childSessions) };
      if (!supplement.complete) result.metadataComplete = false;
      return result;
    }

    const subagents = await subagentsByToolUse(sdk, decoded.sessionUuid, directory);
    const agentId = subagents.get(decoded.toolUseId);
    if (!agentId) return null;
    const entries = await sdk.getSubagentMessages(decoded.sessionUuid, agentId, { dir: directory });
    const { edits, recoveredResults, complete } = await subagentToolResults(sdk, decoded.sessionUuid, agentId, directory, entries);
    const contextWindowFor = await readContextWindowFor();
    const result: ClaudeHistoryResult = {
      records: project({ sessionId, directory, entries: withStructuredResults(entries, edits), sendRecords: new Map(), subagents: new Map(), recoveredResults, contextWindowFor, settle: isSessionRunning(sessionId) ? 'earlier-turns' : true }),
      childSessions: [],
    };
    if (!complete) result.metadataComplete = false;
    return result;
  };

  const loadStatistics = async (
    sessionId: string,
    directory: string,
    { signal }: { signal?: AbortSignal | undefined } = {},
  ): Promise<ClaudeStatisticsResult | null> => {
    signal?.throwIfAborted();
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude') return null;
    const sdk = await loadSdk();
    let entries: SessionMessage[];
    let subagents = new Map<string, string>();
    let complete = true;
    if (decoded.toolUseId === null) {
      const info = await findSessionInfo(sdk, decoded.sessionUuid, directory);
      if (!info) return (await unconfirmedEntry(sessionId)) ? { records: [], childSessions: [] } : null;
      [entries, subagents] = await Promise.all([
        sdk.getSessionMessages(decoded.sessionUuid, { dir: directory, includeSystemMessages: true }),
        subagentsByToolUse(sdk, decoded.sessionUuid, directory),
      ]);
      const boundary = compactionBoundaryUuid(entries);
      if (boundary) {
        const raw = await readRawTranscript(sdk, decoded.sessionUuid, directory);
        if (raw === null) complete = false;
        else {
          const earlier = await readEarlierCompactionEntries(sdk, decoded.sessionUuid, directory, raw, boundary);
          const seen = new Set<string>();
          for (const entry of earlier) {
            const uuid = entryUuidOf(entry);
            if (uuid !== null) seen.add(uuid);
          }
          entries = [...earlier, ...entries.filter((entry) => {
            const uuid = entryUuidOf(entry);
            return uuid === null || !seen.has(uuid);
          })];
        }
      }
    } else {
      subagents = await subagentsByToolUse(sdk, decoded.sessionUuid, directory);
      const agentId = subagents.get(decoded.toolUseId);
      if (!agentId) return null;
      entries = await sdk.getSubagentMessages(decoded.sessionUuid, agentId, { dir: directory });
    }
    signal?.throwIfAborted();
    const slim = entries.map(statisticsEntry).filter((entry) => entry !== null);
    const knownTokens = new Set<string>();
    const createdTimes = new Map<string, number>();
    let tokensComplete = true;
    for (const entry of slim) {
      const id = entry.type === 'user'
        ? claudeUserMessageId(entry.uuid)
        : entry.type === 'assistant' && entry.message?.id
          ? claudeAssistantMessageId(sessionId, entry.message.id)
          : null;
      if (id === null) continue;
      const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
      if (Number.isFinite(at)) createdTimes.set(id, Math.min(createdTimes.get(id) ?? at, at));
      if (entry.type === 'assistant') {
        if (statisticsBaseUsageSchema.safeParse(entry.message?.usage).success) knownTokens.add(id);
        if (entry.message?.usage && !statisticsUsageSchema.safeParse(entry.message.usage).success) tokensComplete = false;
      }
    }
    const records = project({ sessionId, directory, entries: slim, sendRecords: await registry.sendRecords(sessionId), subagents, contextWindowFor: () => 0, settle: false });
    for (const record of records) {
      if (record.info.role === 'assistant' && !knownTokens.has(record.info.id)) delete record.info.tokens;
      if (record.info.role !== 'compaction') record.info.time.created = createdTimes.get(record.info.id) ?? 0;
    }
    return {
      records,
      childSessions: decoded.toolUseId === null ? childSessionRecords(sessionId, records, subagents, decoded.sessionUuid, directory) : [],
      complete,
      reasoningKnown: false,
      tokensComplete,
    };
  };

  const getSession = async (sessionId: string, directory: string): Promise<NativeSessionRecord | null> => {
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

  const sessionExists = async (sessionId: string, directory?: string): Promise<boolean> => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude') return false;
    const sdk = await loadSdk();
    if ((await findSessionInfo(sdk, decoded.sessionUuid, directory)) !== null) return true;
    return decoded.toolUseId === null && (await unconfirmedEntry(sessionId)) !== null;
  };

  const hasTranscript = async (sessionUuid: string, directory: string): Promise<boolean> => {
    const sdk = await loadSdk();
    return (await findSessionInfo(sdk, sessionUuid, directory)) !== null;
  };

  const rootUuidOf = (sessionId: string): string => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'claude' || decoded.toolUseId !== null) {
      throw invalidRequestError(`Not a Claude Code root session: ${sessionId}`);
    }
    return decoded.sessionUuid;
  };

  const chainOf = async (sessionId: string, directory: string): Promise<ParsedChainEntry[]> => {
    const sdk = await loadSdk();
    const entries = await sdk.getSessionMessages(rootUuidOf(sessionId), { dir: directory, includeSystemMessages: true });
    return entries.map((entry) => chainEntrySchema.safeParse(entry)).filter((entry) => entry.success).map((entry) => entry.data);
  };

  const inspectReplayHistory = async (sessionUuid: string, directory: string): Promise<ClaudeReplayHistoryInspection> => {
    const sdk = await loadSdk();
    const entries = await sdk.getSessionMessages(sessionUuid, { dir: directory, includeSystemMessages: true });
    const names = new Set<string>();
    let hasRemovedPlanReplayState = false;
    const visit = (content: JsonValue | undefined): void => {
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const parsed = contentBlockSchema.safeParse(block);
        if (!parsed.success) continue;
        if (removedPlanReplayBlock.safeParse(block).success) hasRemovedPlanReplayState = true;
        if (parsed.data.type === 'tool_reference') {
          const toolName = z.string().safeParse(parsed.data.tool_name);
          names.add(toolName.success ? toolName.data : 'unknown');
        } else if (parsed.data.type === 'tool_result') {
          visit(parsed.data.content);
        }
      }
    };
    for (const entry of entries) {
      const parsed = replayEntrySchema.safeParse(entry);
      if (!parsed.success || parsed.data.isSidechain) continue;
      visit(parsed.data.message?.content);
    }
    return { toolReferences: [...names], hasRemovedPlanReplayState };
  };

  const rewindTarget = async (sessionId: string, directory: string, messageId: string): Promise<ClaudeRewindTarget> => {
    const entryUuid = claudeEntryUuidOfUserMessageId(messageId);
    if (!entryUuid) throw invalidRequestError(`Not a Claude Code prompt: ${messageId}`);
    const chain = await chainOf(sessionId, directory);
    const index = chain.findIndex((entry) => entry.uuid === entryUuid);
    if (index === -1) {
      await loadHistory(sessionId, directory);
      if (historyCache.get(sessionId)?.value.earlier?.uuids.has(entryUuid)) throw rewindBeforeCompactionError();
      throw messageNotFoundError(messageId);
    }
    const previous = index === 0 ? undefined : chain[index - 1];
    return {
      resumeAt: previous ? previous.uuid : null,
      messageIds: chain.slice(index).filter((entry) => entry.type === 'user').map((entry) => claudeUserMessageId(entry.uuid)),
    };
  };

  const chainHolds = async (sessionId: string, directory: string, messageId: string): Promise<boolean> => {
    const entryUuid = claudeEntryUuidOfUserMessageId(messageId);
    return (await chainOf(sessionId, directory)).some((entry) => entry.uuid === entryUuid);
  };

  const rename = async (sessionId: string, directory: string, title: string): Promise<void> => {
    const sdk = await loadSdk();
    await sdk.renameSession(rootUuidOf(sessionId), title, { dir: directory });
  };

  const deleteTranscript = async (sessionId: string, directory: string): Promise<boolean> => {
    const sessionUuid = rootUuidOf(sessionId);
    const sdk = await loadSdk();
    if ((await findSessionInfo(sdk, sessionUuid, directory)) === null) return false;
    await sdk.deleteSession(sessionUuid, { dir: directory });
    historyCache.delete(sessionId);
    return true;
  };

  const fork = async (sessionId: string, directory: string, upToEntry?: string): Promise<string> => {
    const sdk = await loadSdk();
    const forkOptions: ForkSessionOptions = upToEntry !== undefined ? { dir: directory, upToMessageId: upToEntry } : { dir: directory };
    return forkResultSchema.parse(await sdk.forkSession(rootUuidOf(sessionId), forkOptions)).sessionId;
  };

  return {
    listRootSessions,
    listStatisticsSessions: () => listRootSessions(undefined),
    loadStatistics,
    getSession,
    loadHistory,
    sessionExists,
    hasTranscript,
    inspectReplayHistory,
    rewindTarget,
    chainHolds,
    fork,
    rename,
    deleteTranscript,
  };
};
