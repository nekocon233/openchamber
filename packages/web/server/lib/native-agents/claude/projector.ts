import type { SDKMessage, SDKResultMessage, SessionMessage, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import {
  blockPartId,
  claudeAssistantMessageId,
  claudeUserMessageId,
  NATIVE_PROVIDER_CLAUDE,
  toolPartId,
  userFilePartId,
  userTextPartId,
} from '../ids.js';
import {
  buildAssistantMessage,
  buildCompactionMessage,
  buildCompactionPart,
  buildFilePart,
  buildReasoningPart,
  buildTextPart,
  buildToolPart,
  buildUserMessage,
  EMPTY_TOKENS,
  stoppedError,
  unknownError,
} from '../records.js';
import type {
  NativeAssistantMessage,
  NativeCompactionMessage,
  NativeErrorInfo,
  NativeMessageInfo,
  NativeMessageRecord,
  NativePart,
  NativeTokenUsage,
  NativeToolPart,
  NativeUserMessage,
} from '../records.js';
import { mapClaudeToolResult, mapClaudeToolUse } from './tools.js';
import type { SlimClaudeToolResult } from './tools.js';
import { promptTextAttachmentFile, readPromptTextBlock } from '../prompt-parts.js';
import type { ClaudePromptBlock } from '../prompt-parts.js';
import { buildSkillReadPart } from '../skill-records.js';

const DEFAULT_AGENT = 'build';
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

const opaqueJson = z.custom<JsonValue>(() => true);

const entrySchema = z.object({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string(),
  timestamp: z.string().optional(),
  message: opaqueJson.optional(),
  isCompactSummary: z.boolean().optional(),
  is_meta: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isSynthetic: z.boolean().optional(),
  isCompletedLocalCommand: z.boolean().optional(),
  tool_use_result: opaqueJson.optional(),
  toolUseResult: opaqueJson.optional(),
  origin: z.object({ kind: z.string() }).passthrough().optional().catch(undefined),
  subtype: z.string().optional(),
  compactMetadata: z.object({ trigger: z.string() }).passthrough().optional().catch(undefined),
  compact_metadata: z.object({ trigger: z.string() }).passthrough().optional().catch(undefined),
}).passthrough();

const usageSchema = z.object({
  input_tokens: z.number().catch(0),
  output_tokens: z.number().catch(0),
  cache_read_input_tokens: z.number().nullish().transform((value) => value ?? 0),
  cache_creation_input_tokens: z.number().nullish().transform((value) => value ?? 0),
}).passthrough();

const resultMetadataSchema = z.object({
  usage: z.object({
    iterations: z.array(usageSchema).catch([]),
  }).passthrough().nullish(),
  modelUsage: z.record(z.string(), z.object({
    contextWindow: z.number().positive().optional(),
    canonicalModel: z.string().optional(),
  }).passthrough()).nullish(),
}).passthrough();

const assistantMessageSchema = z.object({
  id: z.string(),
  model: z.string().catch(''),
  content: z.array(opaqueJson),
  stop_reason: z.string().nullish(),
  usage: usageSchema.nullish(),
}).passthrough();

export type ClaudePromptContent =
  | { kind: 'text'; text: string }
  | { kind: 'blocks'; blocks: ReadonlyArray<JsonValue | ClaudePromptBlock> };

const userMessageSchema = z.object({
  content: z.union([
    z.string().transform((text): ClaudePromptContent => ({ kind: 'text', text })),
    z.array(opaqueJson).transform((blocks): ClaudePromptContent => ({ kind: 'blocks', blocks })),
  ]),
}).passthrough();

const thinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough();
const redactedThinkingBlock = z.object({ type: z.literal('redacted_thinking') }).passthrough();
const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), opaqueJson.optional()).catch({}),
}).passthrough();
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: opaqueJson.optional(),
  is_error: z.boolean().nullish(),
}).passthrough();
const imageBlock = z.object({
  type: z.literal('image'),
  source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }).passthrough(),
}).passthrough();
const documentBlock = z.object({
  type: z.literal('document'),
  source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }).passthrough(),
  title: z.string().optional(),
}).passthrough();

const streamFrameSchema = z.object({
  type: z.literal('stream_event'),
  parent_tool_use_id: z.string().nullish(),
  event: z.object({ type: z.string() }).passthrough(),
}).passthrough();
const contentBlockStartSchema = z.object({
  index: z.number(),
  content_block: z.object({ type: z.string() }).passthrough(),
}).passthrough();
const contentBlockDeltaSchema = z.object({
  index: z.number(),
  delta: z.union([
    z.object({ type: z.literal('text_delta'), text: z.string() }).passthrough(),
    z.object({ type: z.literal('thinking_delta'), thinking: z.string() }).passthrough(),
    z.object({ type: z.string() }).passthrough(),
  ]),
}).passthrough();
const messageDeltaSchema = z.object({
  delta: z.object({ stop_reason: z.string().nullish() }).passthrough(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }).passthrough().nullish(),
}).passthrough();

const INTERRUPT_MARKERS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

const NO_RESPONSE_NOTICE = 'No response requested.';

type ParsedEntry = z.infer<typeof entrySchema>;
type ParsedUsage = z.infer<typeof usageSchema>;
type ParsedAssistantMessage = z.infer<typeof assistantMessageSchema>;
type ParsedToolResultBlock = z.infer<typeof toolResultBlock>;
type ParsedStreamEvent = z.infer<typeof streamFrameSchema>['event'];

type PartialClaudeUsage = {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
  cache_creation_input_tokens?: number | undefined;
};

type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheComplete: boolean;
};

type TypedMessageRecord<Info extends NativeMessageInfo> = {
  info: Info;
  parts: NativePart[];
};

type UserOrCompactionRecord = TypedMessageRecord<NativeUserMessage | NativeCompactionMessage>;

type AssistantRecord = TypedMessageRecord<NativeAssistantMessage>;

type AssistantState = {
  record: AssistantRecord;
  apiMessageId: string;
  nextBlockIndex: number;
  finish: string | null;
  usage: UsageAccumulator;
};

type PendingCompactionBoundary = {
  uuid: string;
  timestamp: string | undefined;
  trigger: string | null;
};

export type ClaudeSendRecord = {
  modelID: string;
  variant?: string | undefined;
  agent: string;
};

export type ClaudeStreamDelta = {
  sessionID: string;
  messageID: string;
  partID: string;
  field: 'text';
  delta: string;
};

export type ClaudeStreamOutcome = {
  changed: string[];
  delta: ClaudeStreamDelta | null;
};

export type ClaudeRawEntry =
  | SDKMessage
  | SessionMessage
  | SessionStoreEntry
  | (SessionMessage & { tool_use_result?: SlimClaudeToolResult })
  | (SDKMessage & { isCompactSummary?: boolean })
  | JsonObject;

export type ClaudeResultMetadata = SDKResultMessage | JsonObject;

export interface ClaudeProjectionOptions {
  sessionId: string;
  cwd: string;
  sendRecordFor?: ((userMessageId: string) => ClaudeSendRecord | null) | undefined;
  childSessionIdForToolUse?: ((toolUseId: string) => string | null) | undefined;
  contextWindowFor?: ((modelID: string | null) => number) | undefined;
  live?: boolean | undefined;
  now?: (() => number) | undefined;
}

export interface ClaudeProjection {
  applyEntry: (rawEntry: ClaudeRawEntry) => string[];
  settleOpenTools: (reason: string) => string[];
  applyToolResults: (rawEntry: ClaudeRawEntry) => void;
  applyStreamEvent: (rawFrame: ClaudeRawEntry) => ClaudeStreamOutcome;
  applyResult: (rawMetadata: ClaudeResultMetadata) => string[];
  startUserPrompt: (messageId: string, content: ClaudePromptContent) => string[];
  finishTurn: (outcome: { error: NativeErrorInfo | null; planKept?: boolean | undefined }) => string[];
  record: (messageId: string) => NativeMessageRecord | null;
  openAssistantId: () => string | null;
  records: () => NativeMessageRecord[];
}

const isNoResponseNotice = (message: ParsedAssistantMessage): boolean => message.model === '<synthetic>'
  && message.content.length === 1
  && textBlock.safeParse(message.content[0]).data?.text.trim() === NO_RESPONSE_NOTICE;

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMPACT_COMMAND = '/compact';
const LOCAL_COMMAND_OUTPUT = /^\s*<local-command-std(?:out|err)>/;

const typedCommandOf = (text: string): string | null => {
  if (!text.trimStart().startsWith('<command-')) return null;
  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
  return args ? `${name} ${args}` : name;
};

const FINISH_BY_STOP_REASON = new Map<string, string>([
  ['end_turn', 'stop'],
  ['stop_sequence', 'stop'],
  ['tool_use', 'tool-calls'],
  ['max_tokens', 'length'],
  ['refusal', 'content-filter'],
]);

const normalizeClaudeModelId = (model: string): string => (model === '<synthetic>' ? '' : model.replace(/-\d{8}$/, ''));

const tokensFromUsage = (usage: ParsedUsage | null | undefined): NativeTokenUsage => {
  if (!usage) return EMPTY_TOKENS;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  return { total: input + output + read + write, input, output, reasoning: 0, cache: { read, write } };
};

const cacheUsagePresenceSchema = z.record(z.string(), opaqueJson.optional()).refine((usage) => (
  'cache_read_input_tokens' in usage && 'cache_creation_input_tokens' in usage
));

const hasCompleteCacheUsage = (usage: JsonValue | PartialClaudeUsage | null | undefined): boolean => cacheUsagePresenceSchema.safeParse(usage).success;

const usageCarrierSchema = z.object({ usage: opaqueJson.optional() }).passthrough();
const rawUsageOf = (message: JsonValue | undefined): JsonValue | null => usageCarrierSchema.safeParse(message).data?.usage ?? null;

const usageRecordSchema = z.record(z.string(), opaqueJson.optional());
const hasUsageField = (usage: JsonValue | null, key: string): boolean => {
  const parsed = usageRecordSchema.safeParse(usage);
  return parsed.success && key in parsed.data;
};

const liveUsageFromFrame = (rawUsage: JsonValue | null, usage: ParsedUsage | null | undefined): PartialClaudeUsage | null => (usage ? {
  input_tokens: hasUsageField(rawUsage, 'input_tokens') ? usage.input_tokens : undefined,
  output_tokens: hasUsageField(rawUsage, 'output_tokens') ? usage.output_tokens : undefined,
  cache_read_input_tokens: hasUsageField(rawUsage, 'cache_read_input_tokens') ? usage.cache_read_input_tokens : undefined,
  cache_creation_input_tokens: hasUsageField(rawUsage, 'cache_creation_input_tokens') ? usage.cache_creation_input_tokens : undefined,
} : null);

const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheComplete: false,
});

const mergeUsage = (target: UsageAccumulator, usage: PartialClaudeUsage | null | undefined, cacheComplete: boolean): void => {
  if (!usage) return;
  if (usage.input_tokens !== undefined) target.input = usage.input_tokens;
  if (usage.output_tokens !== undefined) target.output = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) target.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) target.cacheWrite = usage.cache_creation_input_tokens;
  if (cacheComplete) target.cacheComplete = true;
};

const tokensFromAccumulator = (usage: UsageAccumulator): NativeTokenUsage => tokensFromUsage({
  input_tokens: usage.input,
  output_tokens: usage.output,
  cache_read_input_tokens: usage.cacheRead,
  cache_creation_input_tokens: usage.cacheWrite,
});

const publishAccumulatedUsage = (state: AssistantState): boolean => {
  if (!state.usage.cacheComplete) return false;
  state.record.info.tokens = tokensFromAccumulator(state.usage);
  return true;
};

const byteLengthOfBase64 = (data: string): number => Math.floor((data.length * 3) / 4);

const messageStartEventSchema = z.object({ message: opaqueJson.optional() }).passthrough();

export const createClaudeProjection = ({
  sessionId,
  cwd,
  sendRecordFor = () => null,
  childSessionIdForToolUse = () => null,
  contextWindowFor = () => 0,
  live = false,
  now = Date.now,
}: ClaudeProjectionOptions): ClaudeProjection => {
  const records: NativeMessageRecord[] = [];
  const recordById = new Map<string, NativeMessageRecord>();
  const assistantRecordById = new Map<string, AssistantRecord>();
  const toolParts = new Map<string, { record: AssistantRecord; part: NativeToolPart }>();
  const turnAssistants: AssistantState[] = [];
  let currentUser: UserOrCompactionRecord | null = null;
  let currentAssistant: AssistantState | null = null;
  let lastCreated = 0;
  let lastEntryTime = live ? now() : 0;
  let pendingBoundary: PendingCompactionBoundary | null = null;

  const monotonicTime = (timestamp?: string): number => {
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
    const value = Number.isFinite(parsed) ? parsed : lastEntryTime;
    lastEntryTime = Math.max(lastEntryTime, value);
    return value;
  };

  const liveTime = (): number => {
    lastEntryTime = Math.max(lastEntryTime, now());
    return lastEntryTime;
  };

  const createdAfterPrevious = (time: number): number => {
    lastCreated = Math.max(lastCreated + 1, time);
    return lastCreated;
  };

  const addRecord = <Info extends NativeMessageInfo>(info: Info): TypedMessageRecord<Info> => {
    const parts: NativePart[] = [];
    const record = { info, parts };
    records.push(record);
    recordById.set(info.id, record);
    return record;
  };

  const addAssistantRecord = (info: NativeAssistantMessage): AssistantRecord => {
    const record = addRecord(info);
    assistantRecordById.set(info.id, record);
    return record;
  };

  const upsertPart = <Part extends NativePart>(record: NativeMessageRecord, part: Part): Part => {
    const index = record.parts.findIndex((existing) => existing.id === part.id);
    if (index === -1) record.parts.push(part);
    else record.parts[index] = part;
    return part;
  };

  const startUserMessage = (messageId: string, time: number): UserOrCompactionRecord => {
    const sent = sendRecordFor(messageId);
    const info = buildUserMessage({
      id: messageId,
      sessionID: sessionId,
      created: createdAfterPrevious(time),
      agent: sent?.agent ?? DEFAULT_AGENT,
      model: sent?.variant === undefined
        ? { providerID: NATIVE_PROVIDER_CLAUDE, modelID: sent?.modelID ?? '' }
        : { providerID: NATIVE_PROVIDER_CLAUDE, modelID: sent.modelID, variant: sent.variant },
    });
    const record: UserOrCompactionRecord = addRecord(info);
    currentUser = record;
    currentAssistant = null;
    return record;
  };

  const ensureUserParent = (time: number, anchorId: string): UserOrCompactionRecord => {
    if (currentUser) return currentUser;
    const record = startUserMessage(`${anchorId}_u`, time);
    upsertPart(record, buildTextPart({
      id: userTextPartId(record.info.id, 0),
      sessionID: sessionId,
      messageID: record.info.id,
      text: '',
      start: time,
      end: time,
      synthetic: true,
    }));
    return record;
  };

  const applyUserContent = (record: NativeMessageRecord, content: ClaudePromptContent, time: number): void => {
    let textIndex = 0;
    let fileIndex = 0;
    const identity = { sessionID: sessionId, messageID: record.info.id };
    const isBlocks = content.kind === 'blocks';
    const blocks = isBlocks ? content.blocks : [{ type: 'text', text: content.text }];
    const allowLegacy = isBlocks && sendRecordFor(record.info.id) !== null;
    for (const block of blocks) {
      const text = textBlock.safeParse(block).data?.text;
      if (text !== undefined) {
        const part = isBlocks ? readPromptTextBlock(text, allowLegacy) : { type: 'text' as const, text };
        if (part === null) continue;
        if (part.type === 'file') {
          const id = userFilePartId(identity.messageID, fileIndex++);
          upsertPart(record, buildFilePart({ ...identity, ...promptTextAttachmentFile(part), id }));
          continue;
        }
        upsertPart(record, buildTextPart({
          ...identity,
          id: userTextPartId(identity.messageID, textIndex++),
          text: part.text,
          start: time,
          end: time,
        }));
        continue;
      }
      const media = imageBlock.safeParse(block).data ?? documentBlock.safeParse(block).data;
      if (!media) continue;
      const tooLarge = byteLengthOfBase64(media.source.data) > MAX_INLINE_IMAGE_BYTES;
      upsertPart(record, buildFilePart({
        ...identity,
        id: userFilePartId(identity.messageID, fileIndex),
        mime: media.source.media_type,
        url: tooLarge ? '' : `data:${media.source.media_type};base64,${media.source.data}`,
        filename: media.type === 'document' ? (media.title ?? 'document') : `image-${fileIndex + 1}`,
      }));
      fileIndex += 1;
    }
  };

  const finishToolPart = (
    block: ParsedToolResultBlock,
    toolUseResult: JsonValue | undefined,
    time: number,
  ): { record: AssistantRecord; part: NativeToolPart } | null => {
    const entry = toolParts.get(block.tool_use_id);
    if (!entry) return null;
    const { record, part } = entry;
    const { output, metadata } = mapClaudeToolResult(part.tool, block.content, toolUseResult);
    const state = part.state;
    const finished = buildToolPart({
      id: part.id,
      sessionID: sessionId,
      messageID: part.messageID,
      callID: part.callID,
      tool: part.tool,
      input: state.input,
      title: 'title' in state ? state.title : part.tool,
      start: state.time.start,
      metadata: { ...state.metadata, ...metadata },
      result: block.is_error === true
        ? { status: 'error', error: output || 'Tool failed', end: time }
        : { status: 'completed', output, end: time },
    });
    toolParts.delete(block.tool_use_id);
    const filePath = state.input.filePath;
    if (part.tool === 'read' && block.is_error !== true && isString(filePath) && filePath) {
      const skill = buildSkillReadPart({
        id: `${part.id}_skill`,
        sessionID: sessionId,
        messageID: record.info.id,
        filePath,
        cwd,
        start: state.time.start,
        end: time,
      });
      if (skill) upsertPart(record, skill);
    }
    const completed = record.info.time.completed;
    record.info.time = {
      created: record.info.time.created,
      completed: Math.max(completed ?? 0, time),
    };
    return { record, part: upsertPart(record, finished) };
  };

  const applyUserEntry = (entry: ParsedEntry, changed: string[]): void => {
    const time = monotonicTime(entry.timestamp);
    const message = userMessageSchema.safeParse(entry.message);
    if (!message.success) return;
    const content = message.data.content;

    if (entry.isCompactSummary === true) {
      const boundary = currentUser;
      if (!boundary) return;
      const created = createdAfterPrevious(time);
      const summary = addAssistantRecord(buildAssistantMessage({
        id: `${boundary.info.id}_summary`,
        sessionID: sessionId,
        parentID: boundary.info.id,
        created,
        completed: created,
        providerID: NATIVE_PROVIDER_CLAUDE,
        modelID: '',
        agent: DEFAULT_AGENT,
        cwd,
        tokens: EMPTY_TOKENS,
        finish: 'stop',
        summary: true,
      }));
      const text = content.kind === 'text'
        ? content.text
        : content.blocks.map((block) => textBlock.safeParse(block).data?.text ?? '').join('\n');
      upsertPart(summary, buildTextPart({
        id: blockPartId(summary.info.id, 0),
        sessionID: sessionId,
        messageID: summary.info.id,
        text,
        start: time,
        end: time,
      }));
      changed.push(summary.info.id);
      return;
    }

    if (content.kind === 'blocks') {
      const results = content.blocks.map((block) => toolResultBlock.safeParse(block)).filter((parsed) => parsed.success);
      if (results.length > 0) {
        for (const result of results) {
          const finished = finishToolPart(result.data, entry.tool_use_result, time);
          if (finished) changed.push(finished.record.info.id);
        }
        return;
      }
    }

    if (entry.is_meta === true || entry.isMeta === true || entry.isSynthetic === true) return;
    if (entry.origin?.kind === 'task-notification') return;
    const soleText = content.kind === 'text'
      ? content.text
      : content.blocks.length === 1 ? textBlock.safeParse(content.blocks[0]).data?.text : undefined;
    const command = soleText === undefined ? null : typedCommandOf(soleText);
    if (command !== null) {
      if (entry.isCompletedLocalCommand !== true) return;
      if (command.split(' ')[0] === COMPACT_COMMAND) return;
      const record = startUserMessage(claudeUserMessageId(entry.uuid), time);
      applyUserContent(record, { kind: 'text', text: command }, time);
      changed.push(record.info.id);
      return;
    }
    if (entry.isCompletedLocalCommand === true) return;
    if (soleText !== undefined && (INTERRUPT_MARKERS.has(soleText.trim()) || LOCAL_COMMAND_OUTPUT.test(soleText))) return;

    const record = startUserMessage(claudeUserMessageId(entry.uuid), time);
    applyUserContent(record, content, time);
    changed.push(record.info.id);
  };

  const ensureAssistant = (message: ParsedAssistantMessage, time: number): AssistantState => {
    if (currentAssistant?.apiMessageId === message.id) return currentAssistant;
    const messageId = claudeAssistantMessageId(sessionId, message.id);
    const parent = ensureUserParent(time, messageId);
    const sent = sendRecordFor(parent.info.id);
    const previousModelID = currentAssistant?.record.info.parentID === parent.info.id
      ? currentAssistant.record.info.modelID
      : '';
    const modelID = sent?.modelID?.startsWith('connection:')
      ? sent.modelID
      : normalizeClaudeModelId(message.model) || previousModelID || sent?.modelID || '';
    const record = assistantRecordById.get(messageId) ?? addAssistantRecord(buildAssistantMessage({
      id: messageId,
      sessionID: sessionId,
      parentID: parent.info.id,
      created: createdAfterPrevious(time),
      completed: null,
      providerID: NATIVE_PROVIDER_CLAUDE,
      modelID,
      agent: sent?.agent ?? DEFAULT_AGENT,
      cwd,
      contextWindow: contextWindowFor(sent?.modelID ?? (modelID || null)),
      variant: sent?.variant ?? null,
    }));
    const state: AssistantState = {
      record,
      apiMessageId: message.id,
      nextBlockIndex: 0,
      finish: null,
      usage: createUsageAccumulator(),
    };
    currentAssistant = state;
    turnAssistants.push(state);
    return state;
  };

  const startOf = (record: NativeMessageRecord, partId: string, time: number): number => {
    const existing = record.parts.find((part) => part.id === partId);
    return existing && (existing.type === 'text' || existing.type === 'reasoning') ? existing.time.start : time;
  };

  const applyAssistantEntry = (entry: ParsedEntry, changed: string[]): void => {
    const parsed = assistantMessageSchema.safeParse(entry.message);
    if (!parsed.success) return;
    const message = parsed.data;
    if (isNoResponseNotice(message)) return;
    const time = monotonicTime(entry.timestamp);
    const assistant = ensureAssistant(message, time);
    if (message.stop_reason) assistant.finish = FINISH_BY_STOP_REASON.get(message.stop_reason) ?? 'other';

    const { record } = assistant;
    for (const block of message.content) {
      const index = assistant.nextBlockIndex;
      assistant.nextBlockIndex += 1;
      const partId = blockPartId(record.info.id, index);
      const thinking = thinkingBlock.safeParse(block);
      if (thinking.success) {
        upsertPart(record, buildReasoningPart({
          id: partId,
          sessionID: sessionId,
          messageID: record.info.id,
          text: thinking.data.thinking,
          start: startOf(record, partId, time),
          end: time,
        }));
        continue;
      }
      if (redactedThinkingBlock.safeParse(block).success) continue;
      const text = textBlock.safeParse(block);
      if (text.success) {
        upsertPart(record, buildTextPart({
          id: partId,
          sessionID: sessionId,
          messageID: record.info.id,
          text: text.data.text,
          start: startOf(record, partId, time),
          end: time,
        }));
        continue;
      }
      const toolUse = toolUseBlock.safeParse(block);
      if (toolUse.success) {
        const mapped = mapClaudeToolUse(toolUse.data.name, toolUse.data.input);
        const childSessionId = mapped.tool === 'task' ? childSessionIdForToolUse(toolUse.data.id) : null;
        const metadata: JsonObject = childSessionId === null ? (mapped.metadata ?? {}) : { ...mapped.metadata, sessionId: childSessionId };
        const part = buildToolPart({
          id: toolPartId(record.info.id, toolUse.data.id),
          sessionID: sessionId,
          messageID: record.info.id,
          callID: toolUse.data.id,
          tool: mapped.tool,
          input: mapped.input,
          title: mapped.title,
          start: time,
          metadata,
          result: null,
        });
        upsertPart(record, part);
        toolParts.set(toolUse.data.id, { record, part });
      }
    }

    const info = record.info;
    const rawUsage = rawUsageOf(entry.message);
    if (live) {
      mergeUsage(assistant.usage, liveUsageFromFrame(rawUsage, message.usage), hasCompleteCacheUsage(rawUsage));
      publishAccumulatedUsage(assistant);
    } else if (message.usage) {
      info.tokens = tokensFromUsage(message.usage);
    }
    const modelID = normalizeClaudeModelId(message.model);
    if (modelID) info.modelID = modelID;
    const sent = sendRecordFor(info.parentID ?? '');
    const contextWindow = contextWindowFor(sent?.modelID ?? (modelID || info.modelID || null));
    if (contextWindow > 0) info.contextWindow = contextWindow;
    if (!live) {
      info.time = { created: info.time.created, completed: Math.max(info.time.created, time) };
      const finish = message.stop_reason ? FINISH_BY_STOP_REASON.get(message.stop_reason) ?? 'other' : null;
      if (finish !== null) info.finish = finish;
    }
    changed.push(info.id);
  };

  const streamedPart = (index: number): NativePart | null => {
    const assistant = currentAssistant;
    if (!assistant) return null;
    const partId = blockPartId(assistant.record.info.id, index);
    return assistant.record.parts.find((part) => part.id === partId) ?? null;
  };

  const applyStreamEvent = (event: ParsedStreamEvent, time: number): ClaudeStreamOutcome => {
    const none: ClaudeStreamOutcome = { changed: [], delta: null };
    if (event.type === 'message_start') {
      const startMessage = messageStartEventSchema.safeParse(event).data?.message;
      const rawUsage = rawUsageOf(startMessage);
      const message = assistantMessageSchema.safeParse(startMessage);
      if (!message.success) return none;
      const assistant = ensureAssistant(message.data, time);
      mergeUsage(assistant.usage, liveUsageFromFrame(rawUsage, message.data.usage), hasCompleteCacheUsage(rawUsage));
      publishAccumulatedUsage(assistant);
      return { changed: [assistant.record.info.id], delta: null };
    }
    if (!currentAssistant) return none;
    const { record } = currentAssistant;
    const messageID = record.info.id;
    if (event.type === 'content_block_start') {
      const start = contentBlockStartSchema.safeParse(event);
      if (!start.success) return none;
      const id = blockPartId(messageID, start.data.index);
      const type = start.data.content_block.type;
      if (type === 'text') {
        upsertPart(record, buildTextPart({ id, sessionID: sessionId, messageID, text: '', start: time, end: null }));
      } else if (type === 'thinking') {
        upsertPart(record, buildReasoningPart({ id, sessionID: sessionId, messageID, text: '', start: time, end: null }));
      } else {
        return none;
      }
      return { changed: [messageID], delta: null };
    }
    if (event.type === 'content_block_delta') {
      const parsed = contentBlockDeltaSchema.safeParse(event);
      if (!parsed.success) return none;
      const { delta } = parsed.data;
      const text = delta.type === 'text_delta'
        ? ('text' in delta && isString(delta.text) ? delta.text : null)
        : delta.type === 'thinking_delta'
          ? ('thinking' in delta && isString(delta.thinking) ? delta.thinking : null)
          : null;
      const part = streamedPart(parsed.data.index);
      if (text === null || !part || (part.type !== 'text' && part.type !== 'reasoning')) return none;
      part.text += text;
      return { changed: [], delta: { sessionID: sessionId, messageID, partID: part.id, field: 'text', delta: text } };
    }
    if (event.type === 'message_delta') {
      const parsed = messageDeltaSchema.safeParse(event);
      if (!parsed.success) return none;
      const stopReason = parsed.data.delta.stop_reason;
      if (stopReason) record.info.finish = FINISH_BY_STOP_REASON.get(stopReason) ?? 'other';
      if (parsed.data.usage) {
        mergeUsage(currentAssistant.usage, parsed.data.usage, hasCompleteCacheUsage(parsed.data.usage));
        publishAccumulatedUsage(currentAssistant);
      }
      return { changed: [messageID], delta: null };
    }
    if (event.type === 'message_stop') {
      record.info.time = { created: record.info.time.created, completed: Math.max(record.info.time.created, time) };
      return { changed: [messageID], delta: null };
    }
    return none;
  };

  const openCompaction = ({ uuid, timestamp, trigger }: PendingCompactionBoundary, changed: string[]): void => {
    const record = startUserMessage(`ncl_k_${uuid}`, monotonicTime(timestamp));
    record.info = buildCompactionMessage({
      id: record.info.id,
      sessionID: sessionId,
      created: record.info.time.created,
      status: 'completed',
      auto: trigger === 'auto',
    });
    upsertPart(record, buildCompactionPart({
      id: userTextPartId(record.info.id, 0),
      sessionID: sessionId,
      messageID: record.info.id,
      auto: trigger === 'auto',
    }));
    changed.push(record.info.id);
  };

  const applySystemEntry = (entry: ParsedEntry, changed: string[]): void => {
    if (entry.message !== undefined && entry.message !== null) return;
    if (entry.subtype === undefined) {
      pendingBoundary = { uuid: entry.uuid, timestamp: entry.timestamp, trigger: null };
      return;
    }
    if (entry.subtype !== 'compact_boundary') return;
    const trigger = (entry.compactMetadata ?? entry.compact_metadata)?.trigger ?? null;
    openCompaction({ uuid: entry.uuid, timestamp: entry.timestamp, trigger }, changed);
  };

  const settleTools = (reason: string): string[] => {
    const changed: string[] = [];
    for (const [toolUseId, { record, part }] of toolParts) {
      upsertPart(record, buildToolPart({
        id: part.id,
        sessionID: sessionId,
        messageID: part.messageID,
        callID: part.callID,
        tool: part.tool,
        input: part.state.input,
        title: 'title' in part.state ? part.state.title : part.tool,
        start: part.state.time.start,
        metadata: part.state.metadata ?? {},
        result: { status: 'error', error: reason, end: lastEntryTime },
      }));
      toolParts.delete(toolUseId);
      changed.push(record.info.id);
    }
    return changed;
  };

  const applyResultMetadata = (rawMetadata: ClaudeResultMetadata): string[] => {
    const parsed = resultMetadataSchema.safeParse(rawMetadata);
    if (!parsed.success) return [];
    const changed = new Set<string>();
    const iterations = parsed.data.usage?.iterations ?? [];
    const lastAssistant = turnAssistants.at(-1);
    const lastIteration = iterations.at(-1);
    if (turnAssistants.length > 0 && iterations.length > 0 && lastAssistant && lastIteration) {
      const positional = iterations.length === turnAssistants.length;
      const states = positional ? turnAssistants : [lastAssistant];
      const usages = positional ? iterations : [lastIteration];
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index];
        const usage = usages[index];
        if (!state || !usage) continue;
        state.usage = createUsageAccumulator();
        mergeUsage(state.usage, usage, true);
        publishAccumulatedUsage(state);
        changed.add(state.record.info.id);
      }
    }

    const modelUsage = Object.entries(parsed.data.modelUsage ?? {})
      .filter((entry) => (entry[1].contextWindow ?? 0) > 0);
    const singleUsage = modelUsage.length === 1 ? modelUsage[0] : undefined;
    if (singleUsage && singleUsage[1].contextWindow !== undefined) {
      const contextWindow = singleUsage[1].contextWindow;
      for (const state of turnAssistants) {
        if (state.record.info.contextWindow === contextWindow) continue;
        state.record.info.contextWindow = contextWindow;
        changed.add(state.record.info.id);
      }
    } else if (modelUsage.length > 1) {
      for (const state of turnAssistants) {
        const modelID = state.record.info.modelID;
        const match = modelUsage.find(([id, usage]) => normalizeClaudeModelId(id) === modelID || usage.canonicalModel === modelID);
        const contextWindow = match?.[1].contextWindow ?? 0;
        if (contextWindow <= 0 || state.record.info.contextWindow === contextWindow) continue;
        state.record.info.contextWindow = contextWindow;
        changed.add(state.record.info.id);
      }
    }
    return [...changed];
  };

  return {
    applyEntry(rawEntry) {
      const parsed = entrySchema.safeParse(rawEntry);
      if (!parsed.success) return [];
      const entry = parsed.data;
      const changed: string[] = [];
      const boundary = pendingBoundary;
      pendingBoundary = null;
      if (boundary && entry.type === 'user' && entry.isCompactSummary === true) openCompaction(boundary, changed);
      if (entry.type === 'user') applyUserEntry(entry, changed);
      else if (entry.type === 'assistant') applyAssistantEntry(entry, changed);
      else applySystemEntry(entry, changed);
      return changed;
    },

    settleOpenTools(reason) {
      return settleTools(reason);
    },

    applyToolResults(rawEntry) {
      const parsed = entrySchema.safeParse(rawEntry);
      if (!parsed.success || parsed.data.type !== 'user') return;
      const entry = parsed.data;
      const message = userMessageSchema.safeParse(entry.message);
      if (!message.success || message.data.content.kind !== 'blocks') return;
      for (const block of message.data.content.blocks) {
        const result = toolResultBlock.safeParse(block);
        if (!result.success || !toolParts.has(result.data.tool_use_id)) continue;
        finishToolPart(result.data, entry.tool_use_result ?? entry.toolUseResult, monotonicTime(entry.timestamp));
      }
    },

    applyStreamEvent(rawFrame) {
      const parsed = streamFrameSchema.safeParse(rawFrame);
      if (!parsed.success || parsed.data.parent_tool_use_id) return { changed: [], delta: null };
      return applyStreamEvent(parsed.data.event, liveTime());
    },

    applyResult(rawMetadata) {
      return applyResultMetadata(rawMetadata);
    },

    startUserPrompt(messageId, content) {
      const time = liveTime();
      const streaming = currentAssistant;
      const record = startUserMessage(messageId, time);
      currentAssistant = streaming;
      applyUserContent(record, content, time);
      return [record.info.id];
    },

    finishTurn({ error, planKept = false }) {
      const time = liveTime();
      const changed = error === null ? [] : settleTools(error.name === 'MessageAbortedError' ? 'Interrupted' : error.data.message);
      const messageError = planKept && error?.name === 'MessageAbortedError' ? null : error;
      if (currentAssistant) {
        const info = currentAssistant.record.info;
        if (info.finish === undefined && currentAssistant.finish !== null) info.finish = currentAssistant.finish;
        if (info.time.completed === undefined) info.time = { created: info.time.created, completed: Math.max(info.time.created, time) };
        if (messageError !== null && info.error === undefined) info.error = messageError;
        changed.push(info.id);
      } else if (messageError !== null && currentUser) {
        let record = recordById.get(`${currentUser.info.id}_error`);
        if (!record) {
          const created = createdAfterPrevious(time);
          record = addAssistantRecord(buildAssistantMessage({
            id: `${currentUser.info.id}_error`,
            sessionID: sessionId,
            parentID: currentUser.info.id,
            created,
            completed: created,
            providerID: NATIVE_PROVIDER_CLAUDE,
            modelID: currentUser.info.role === 'user' ? currentUser.info.model.modelID : '',
            agent: currentUser.info.role === 'user' ? currentUser.info.agent : DEFAULT_AGENT,
            cwd,
            tokens: EMPTY_TOKENS,
            error: messageError,
          }));
        }
        changed.push(record.info.id);
      }
      currentAssistant = null;
      turnAssistants.length = 0;
      return changed;
    },

    record(messageId) {
      return recordById.get(messageId) ?? null;
    },

    openAssistantId() {
      return currentAssistant?.record.info.id ?? null;
    },

    records() {
      return records;
    },
  };
};

export const claudeAbortedError = (): NativeErrorInfo => stoppedError();
export const claudeTurnError = (message: string): NativeErrorInfo => unknownError(message);
