import type { SessionMessage, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { JsonObject } from '../../shared/json-values.js';
import { blockPartId, NATIVE_PROVIDER_CLAUDE, userTextPartId } from '../ids.js';
import type { ClaudePromptBlock } from '../prompt-parts.js';
import {
  buildAssistantMessage,
  buildCompactionMessage,
  buildCompactionPart,
  buildTextPart,
  EMPTY_TOKENS,
  unknownError,
} from '../records.js';
import type {
  NativeAssistantMessage,
  NativeCompactionMessage,
  NativeErrorInfo,
  NativePart,
} from '../records.js';
import type { ClaudeSdkModule } from './sdk.js';

export type CompactionRecord = {
  info: NativeCompactionMessage;
  parts: NativePart[];
};

export type PendingCompactionBoundary = {
  uuid: string;
  timestamp: string | undefined;
  trigger: string | null;
};

export type FailedCompactionRecord = JsonObject & {
  type: 'system';
  subtype: 'local_command';
  uuid: string;
  commandRun: { command: 'compact' };
  commandOutcome: { kind: 'failed' };
  timestamp?: string;
  content?: string;
};

export type FailedCompactionIndex = {
  byUuid: Map<string, FailedCompactionRecord>;
  byParentUuid: Map<string, FailedCompactionRecord>;
};

export const COMPACT_COMMAND = '/compact';

const LOCAL_COMMAND_STDERR = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/;
const LOCAL_COMMAND_STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const COMPACTION_CANCELED = /^Compaction canceled\.?$/i;
const COMPACT_COMMAND_TAG = /<command-name>\s*\/compact\s*<\/command-name>/;

const chainUuidSchema = z.object({ uuid: z.string() }).passthrough();
const chainTypedEntrySchema = z.object({ type: z.string(), uuid: z.string(), subtype: z.string().optional() }).passthrough();
const compactSummaryMarkerSchema = z.object({ isCompactSummary: z.literal(true) }).passthrough();

export const compactionBoundaryUuid = (entries: ReadonlyArray<SessionMessage>): string | null => {
  const first = chainTypedEntrySchema.safeParse(entries[0]);
  if (!first.success || first.data.type !== 'system') return null;
  return compactSummaryMarkerSchema.safeParse(entries[1]).success ? first.data.uuid : null;
};

export const readEarlierCompactionEntries = async (
  sdk: ClaudeSdkModule,
  sessionUuid: string,
  directory: string,
  raw: ReadonlyArray<SessionStoreEntry>,
  boundaryUuid: string,
): Promise<SessionMessage[]> => {
  const boundaries = new Map<string, z.infer<typeof chainTypedEntrySchema>>();
  const positions = new Map<string, number>();
  raw.forEach((value, index) => {
    const entry = chainTypedEntrySchema.safeParse(value);
    if (!entry.success) return;
    positions.set(entry.data.uuid, index);
    if (entry.data.type === 'system' && entry.data.subtype === 'compact_boundary') boundaries.set(entry.data.uuid, entry.data);
  });
  const segments: SessionMessage[][] = [];
  const visited = new Set<string>();
  let boundary = boundaries.get(boundaryUuid);
  while (boundary && !visited.has(boundary.uuid)) {
    visited.add(boundary.uuid);
    const cut = raw.slice(0, positions.get(boundary.uuid));
    const segment = await sdk.getSessionMessages(sessionUuid, {
      dir: directory,
      includeSystemMessages: true,
      sessionStore: { append: async () => {}, load: async () => cut },
    });
    segments.unshift(segment);
    const first = chainUuidSchema.safeParse(segment[0]);
    boundary = first.success ? boundaries.get(first.data.uuid) : undefined;
  }
  const seen = new Set<string>();
  const entries: SessionMessage[] = [];
  for (const entry of segments.flat()) {
    const parsed = chainUuidSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.uuid)) continue;
    seen.add(parsed.data.uuid);
    entries.push(entry);
  }
  return entries;
};

const userTextContentSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    content: z.union([
      z.string().transform((text) => text),
      z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough())
        .transform((blocks) => (blocks.length === 1 ? (blocks[0]?.text ?? '') : '')),
    ]),
  }).passthrough(),
}).passthrough();

const rawLocalCommandSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('local_command'),
  uuid: z.string(),
  parentUuid: z.string().nullish(),
  timestamp: z.string().optional(),
  content: z.string().optional(),
  commandRun: z.object({ command: z.string() }).passthrough().optional().catch(undefined),
  commandOutcome: z.object({ kind: z.string() }).passthrough().optional().catch(undefined),
}).passthrough();

const rawCompactCommandSchema = z.object({
  type: z.literal('user'),
  uuid: z.string(),
  message: z.object({
    content: z.union([
      z.string().transform((text) => text),
      z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough())
        .transform((blocks) => (blocks.length === 1 ? (blocks[0]?.text ?? '') : '')),
    ]),
  }).passthrough(),
}).passthrough();

export const localCommandStderrText = (value: string | undefined): string => {
  if (!value) return '';
  const matched = LOCAL_COMMAND_STDERR.exec(value) ?? LOCAL_COMMAND_STDOUT.exec(value);
  return (matched?.[1] ?? value).trim();
};

const isCanceledCompactOutput = (value: string | undefined): boolean => (
  value !== undefined && LOCAL_COMMAND_STDOUT.test(value) && COMPACTION_CANCELED.test(localCommandStderrText(value))
);

export const isFailedCompactCommand = (
  run: { command: string } | undefined,
  outcome: { kind: string } | undefined,
): boolean => run?.command === 'compact' && outcome?.kind === 'failed';

export const isCompactPromptBlocks = (blocks: ReadonlyArray<ClaudePromptBlock>): boolean => (
  blocks.length === 1
  && blocks[0]?.type === 'text'
  && /^\/compact(?:\s|$)/.test(blocks[0].text.trim())
);

export const isCompactCommandEntry = (entry: SessionMessage): boolean => {
  const parsed = userTextContentSchema.safeParse(entry);
  return parsed.success && COMPACT_COMMAND_TAG.test(parsed.data.message.content);
};

export const emptyFailedCompactions = (): FailedCompactionIndex => ({
  byUuid: new Map(),
  byParentUuid: new Map(),
});

export const addFailedCompactions = (
  index: FailedCompactionIndex,
  rawEntries: ReadonlyArray<SessionStoreEntry>,
): FailedCompactionIndex => {
  const compactCommands = new Set<string>();
  for (const raw of rawEntries) {
    const cmd = rawCompactCommandSchema.safeParse(raw);
    if (cmd.success && COMPACT_COMMAND_TAG.test(cmd.data.message.content)) compactCommands.add(cmd.data.uuid);
  }
  for (const raw of rawEntries) {
    const entry = rawLocalCommandSchema.safeParse(raw);
    if (!entry.success) continue;
    const isFailed = isFailedCompactCommand(entry.data.commandRun, entry.data.commandOutcome);
    const isParentCompact = entry.data.parentUuid ? compactCommands.has(entry.data.parentUuid) : false;
    const isCanceledOrStderr = isParentCompact && (
      isCanceledCompactOutput(entry.data.content)
      || (entry.data.content !== undefined && LOCAL_COMMAND_STDERR.test(entry.data.content))
    );
    if (!isFailed && !isCanceledOrStderr) continue;
    const record: FailedCompactionRecord = {
      type: 'system',
      subtype: 'local_command',
      uuid: entry.data.uuid,
      commandRun: { command: 'compact' },
      commandOutcome: { kind: 'failed' },
    };
    if (entry.data.timestamp !== undefined) record.timestamp = entry.data.timestamp;
    if (entry.data.content !== undefined) record.content = entry.data.content;
    index.byUuid.set(entry.data.uuid, record);
    if (entry.data.parentUuid) index.byParentUuid.set(entry.data.parentUuid, record);
  }
  return index;
};

export const withFailedCompactions = <Entry>(
  entries: ReadonlyArray<Entry>,
  failedCompactions: FailedCompactionIndex,
): Array<Entry | FailedCompactionRecord> => {
  if (failedCompactions.byUuid.size === 0) return [...entries];
  const uuidOf = (entry: Entry): string | null => {
    const parsed = chainUuidSchema.safeParse(entry);
    return parsed.success ? parsed.data.uuid : null;
  };
  const presentUuids = new Set<string>();
  for (const entry of entries) {
    const uuid = uuidOf(entry);
    if (uuid !== null) presentUuids.add(uuid);
  }
  const emitted = new Set<string>();
  const out: Array<Entry | FailedCompactionRecord> = [];
  for (const entry of entries) {
    const uuid = uuidOf(entry);
    const replacement = uuid !== null ? failedCompactions.byUuid.get(uuid) : undefined;
    if (replacement && uuid !== null) {
      if (!emitted.has(uuid)) {
        emitted.add(uuid);
        out.push(replacement);
      }
      continue;
    }
    out.push(entry);
    const child = uuid !== null ? failedCompactions.byParentUuid.get(uuid) : undefined;
    if (child && !presentUuids.has(child.uuid) && !emitted.has(child.uuid)) {
      emitted.add(child.uuid);
      out.push(child);
    }
  }
  return out;
};

export interface ClaudeCompactionAssistantEntry {
  uuid: string;
  timestamp?: string | undefined;
  local_command_run?: { command: string } | undefined;
  local_command_outcome?: { kind: string } | undefined;
  local_command_source?: string | undefined;
}

export interface ClaudeCompactionSystemEntry {
  uuid: string;
  timestamp?: string | undefined;
  message?: unknown;
  subtype?: string | undefined;
  status?: string | null | undefined;
  compact_result?: string | undefined;
  compact_error?: string | undefined;
  content?: string | undefined;
  commandRun?: { command: string } | undefined;
  commandOutcome?: { kind: string } | undefined;
  compactMetadata?: { trigger: string } | undefined;
  compact_metadata?: { trigger: string } | undefined;
}

export interface ClaudeCompactionTrackerOptions {
  sessionId: string;
  cwd: string;
  defaultAgent: string;
  live: boolean;
  hasRecord: (id: string) => boolean;
  addRecord: (info: NativeCompactionMessage) => CompactionRecord;
  addAssistantRecord: (info: NativeAssistantMessage) => { info: NativeAssistantMessage; parts: NativePart[] };
  removeRecord: (id: string) => boolean;
  upsertPart: (record: { info: NativeCompactionMessage | NativeAssistantMessage; parts: NativePart[] }, part: NativePart) => void;
  createdAfterPrevious: (time: number) => number;
  monotonicTime: (timestamp?: string) => number;
  liveTime: () => number;
  openCompletedAnchor: (info: NativeCompactionMessage) => CompactionRecord;
}

export const createClaudeCompactionTracker = ({
  sessionId,
  cwd,
  defaultAgent,
  live,
  hasRecord,
  addRecord,
  addAssistantRecord,
  removeRecord,
  upsertPart,
  createdAfterPrevious,
  monotonicTime,
  liveTime,
  openCompletedAnchor,
}: ClaudeCompactionTrackerOptions) => {
  let pendingBoundary: PendingCompactionBoundary | null = null;
  let liveCompaction: CompactionRecord | null = null;
  let expectSummary = false;
  let pendingManualCompacts = 0;
  let turnHasNonCompactActivity = false;

  const createRecord = ({
    id,
    time,
    status,
    auto,
    error = null,
  }: {
    id: string;
    time: number;
    status: 'running' | 'failed';
    auto: boolean;
    error?: NativeErrorInfo | null | undefined;
  }): CompactionRecord => {
    const record = addRecord(buildCompactionMessage({
      id,
      sessionID: sessionId,
      created: createdAfterPrevious(time),
      status,
      auto,
      error,
    }));
    upsertPart(record, buildCompactionPart({
      id: userTextPartId(record.info.id, 0),
      sessionID: sessionId,
      messageID: record.info.id,
      auto,
    }));
    return record;
  };

  const dropLive = (changed: string[], predicate: (record: CompactionRecord) => boolean): void => {
    if (!liveCompaction || !predicate(liveCompaction)) return;
    const id = liveCompaction.info.id;
    liveCompaction = null;
    if (removeRecord(id)) changed.push(id);
  };

  const openCompleted = ({ uuid, timestamp, trigger }: PendingCompactionBoundary, changed: string[]): void => {
    dropLive(changed, (record) => record.info.status === 'running');
    const id = `ncl_k_${uuid}`;
    const auto = trigger === 'auto';
    const time = monotonicTime(timestamp);
    const info = buildCompactionMessage({ id, sessionID: sessionId, created: time, status: 'completed', auto });
    const record = openCompletedAnchor(info);
    upsertPart(record, buildCompactionPart({ id: userTextPartId(record.info.id, 0), sessionID: sessionId, messageID: record.info.id, auto }));
    if (live) expectSummary = true;
    changed.push(record.info.id);
  };

  const recordFailedCommand = (
    { uuid, timestamp, error }: { uuid: string; timestamp: string | undefined; error: NativeErrorInfo },
    changed: string[],
  ): void => {
    dropLive(changed, () => true);
    const id = `ncl_k_${uuid}`;
    if (hasRecord(id)) return;
    const record = createRecord({ id, time: monotonicTime(timestamp), status: 'failed', auto: false, error });
    changed.push(record.info.id);
  };

  const applyStatus = (
    { uuid, status, compactResult, compactError }: {
      uuid: string;
      status: string | null | undefined;
      compactResult: string | undefined;
      compactError: string | undefined;
    },
    changed: string[],
  ): void => {
    if (!live) return;
    const auto = !(pendingManualCompacts > 0 && !turnHasNonCompactActivity);
    if (status === 'compacting') {
      if (liveCompaction?.info.status === 'running') return;
      const id = `ncl_k_${uuid}`;
      if (hasRecord(id)) return;
      liveCompaction = createRecord({ id, time: liveTime(), status: 'running', auto });
      changed.push(liveCompaction.info.id);
      return;
    }
    if (compactResult !== 'failed') return;
    const error = unknownError(compactError?.trim() || 'Compaction failed');
    if (liveCompaction?.info.status === 'running') {
      liveCompaction.info.status = 'failed';
      liveCompaction.info.reason = auto ? 'auto' : 'manual';
      liveCompaction.info.error = error;
      changed.push(liveCompaction.info.id);
      return;
    }
    const id = `ncl_k_${uuid}`;
    if (hasRecord(id)) return;
    liveCompaction = createRecord({ id, time: liveTime(), status: 'failed', auto, error });
    changed.push(liveCompaction.info.id);
  };

  return {
    queueTurn(blocks: ReadonlyArray<ClaudePromptBlock>): void {
      if (isCompactPromptBlocks(blocks)) pendingManualCompacts += 1;
    },
    noteTurnActivity(): void {
      turnHasNonCompactActivity = true;
    },
    takePendingBoundary(): PendingCompactionBoundary | null {
      const boundary = pendingBoundary;
      pendingBoundary = null;
      return boundary;
    },
    consumeSyntheticSummary(isSyntheticUser: boolean): boolean {
      const matched = live && expectSummary && isSyntheticUser;
      expectSummary = false;
      return matched;
    },
    clearFailedLive(): void {
      if (liveCompaction?.info.status === 'failed') liveCompaction = null;
    },
    openCompleted,
    tryFailedAssistantCommand(entry: ClaudeCompactionAssistantEntry, fallbackText: string, changed: string[]): boolean {
      const failed = isFailedCompactCommand(entry.local_command_run, entry.local_command_outcome)
        || isCanceledCompactOutput(entry.local_command_source);
      if (!failed) return false;
      const errorText = localCommandStderrText(entry.local_command_source) || fallbackText || 'Compaction failed';
      recordFailedCommand({ uuid: entry.uuid, timestamp: entry.timestamp, error: unknownError(errorText) }, changed);
      return true;
    },
    recordSummary(boundaryId: string, text: string, time: number, changed: string[]): void {
      const created = createdAfterPrevious(time);
      const summary = addAssistantRecord(buildAssistantMessage({
        id: `${boundaryId}_summary`,
        sessionID: sessionId,
        parentID: boundaryId,
        created,
        completed: created,
        providerID: NATIVE_PROVIDER_CLAUDE,
        modelID: '',
        agent: defaultAgent,
        cwd,
        tokens: EMPTY_TOKENS,
        finish: 'stop',
        summary: true,
      }));
      upsertPart(summary, buildTextPart({
        id: blockPartId(summary.info.id, 0),
        sessionID: sessionId,
        messageID: summary.info.id,
        text,
        start: time,
        end: time,
      }));
      changed.push(summary.info.id);
    },
    applySystemEntry(entry: ClaudeCompactionSystemEntry, changed: string[]): void {
      if (entry.message !== undefined && entry.message !== null) return;
      if (entry.subtype === undefined) {
        pendingBoundary = { uuid: entry.uuid, timestamp: entry.timestamp, trigger: null };
        return;
      }
      if (entry.subtype === 'status') {
        applyStatus({
          uuid: entry.uuid,
          status: entry.status,
          compactResult: entry.compact_result,
          compactError: entry.compact_error,
        }, changed);
        return;
      }
      if (entry.subtype === 'compact_boundary') {
        const trigger = (entry.compactMetadata ?? entry.compact_metadata)?.trigger ?? null;
        openCompleted({ uuid: entry.uuid, timestamp: entry.timestamp, trigger }, changed);
        return;
      }
      if (entry.subtype === 'local_command' && isFailedCompactCommand(entry.commandRun, entry.commandOutcome)) {
        recordFailedCommand({
          uuid: entry.uuid,
          timestamp: entry.timestamp,
          error: unknownError(localCommandStderrText(entry.content) || 'Compaction failed'),
        }, changed);
      }
    },
    finishTurn(error: NativeErrorInfo | null, queuedTurns: number, localCommand: string | undefined, changed: string[]): boolean {
      if (localCommand === 'compact' && pendingManualCompacts > 0) pendingManualCompacts -= 1;
      if (queuedTurns <= 0) pendingManualCompacts = 0;
      turnHasNonCompactActivity = false;
      const running = liveCompaction?.info.status === 'running' ? liveCompaction : null;
      liveCompaction = null;
      if (!running) return false;
      running.info.status = 'failed';
      running.info.error = error ?? unknownError('Compaction did not complete');
      changed.push(running.info.id);
      return true;
    },
  };
};
