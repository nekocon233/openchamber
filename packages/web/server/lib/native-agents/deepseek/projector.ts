import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { NATIVE_PROVIDER_DEEPSEEK, isNativeClientUserMessageId, userFilePartId, userTextPartId } from '../ids.js';
import { isInstructionsBlock } from '../prompt-parts.js';
import type { NativeEventPublisher } from '../publisher.js';
import { buildAssistantMessage, buildCompactionMessage, buildFilePart, buildReasoningPart, buildTextPart, buildToolPart, buildUserMessage, stoppedError, unknownError } from '../records.js';
import type {
  NativeAssistantMessage,
  NativeCompactionMessage,
  NativeMessageModel,
  NativePart,
  NativeToolPart,
  NativeUserMessage,
} from '../records.js';
import { jsonObject, modelId, selection, sessionEvent } from './protocol.js';
import type { DeepseekSelection, DeepseekSessionEvent, DeepseekSnapshotFrame } from './protocol.js';

const key = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
const contentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), id: z.string(), name: z.string(), arguments: z.string() }),
  z.object({ type: z.literal('image'), attachment: z.object({ attachmentId: z.string(), name: z.string().optional(), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']) }) }),
  z.object({ type: z.literal('file'), attachment: z.object({ attachmentId: z.string(), name: z.string() }) }),
]);
const messageSchema = z.object({
  id: z.string(),
  content: z.array(contentBlock),
  source: z.object({
    kind: z.string(),
    rpcId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  }),
});
const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
});
const requestContext = selection.extend({ contextWindow: z.number().int().positive().optional() });
const assistantSchema = z.object({
  turn: z.number(),
  step: z.number(),
  message: messageSchema,
  interrupted: z.literal(true).optional(),
  usage: usageSchema.optional(),
  stream: z.array(z.json()).optional(),
});
const toolCallSchema = z.object({ turn: z.number(), step: z.number(), callId: z.string(), name: z.string(), arguments: z.string() });
const toolResultSchema = z.object({
  turn: z.number(),
  step: z.number(),
  message: z.object({
    toolCallId: z.string(),
    isError: z.boolean().optional(),
    content: z.array(contentBlock),
  }),
  meta: z.json().optional(),
  error: z.object({ reason: z.string().optional() }).optional(),
});
const stepSchema = z.object({ turn: z.number(), step: z.number() });
const turnEndSchema = z.object({
  turn: z.number(),
  reason: z.object({ kind: z.string(), error: z.object({ message: z.string() }).optional() }),
});
const compactionSchema = z.object({
  compactionId: z.string(),
  turn: z.number().nullable().optional(),
  summary: z.array(contentBlock).optional(),
  error: z.string().optional(),
});
const chunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block-start'), index: z.number(), blockType: z.string() }),
  z.object({ type: z.enum(['text-delta', 'reasoning-delta']), index: z.number(), text: z.string() }),
  z.object({ type: z.literal('tool-call-delta'), index: z.number(), id: z.string(), name: z.string().optional(), argumentsDelta: z.string() }),
  z.object({ type: z.literal('block-end'), index: z.number(), block: contentBlock }),
  z.object({ type: z.literal('usage'), usage: usageSchema }),
  z.object({ type: z.literal('finish'), reason: z.object({ kind: z.string() }) }),
]);
const compactChunk = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['text-chunks', 'reasoning-chunks']), index: z.number(), time0: z.number(), dt: z.array(z.number()), texts: z.array(z.string()) }),
  z.object({ type: z.literal('tool-call-chunks'), index: z.number(), time0: z.number(), dt: z.array(z.number()), id: z.string(), name: z.string().optional(), args: z.array(z.string()) }),
  z.object({ type: z.literal('chunk'), time: z.number(), chunk: z.json() }),
]);

type ParsedContentBlock = z.infer<typeof contentBlock>;
type ParsedRequestContext = z.infer<typeof requestContext>;

export type DeepseekTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
  total?: number;
};

export type DeepseekAssistantMessage = Omit<NativeAssistantMessage, 'tokens'> & {
  tokens?: DeepseekTokenUsage;
};

export type DeepseekMessageInfo = NativeUserMessage | NativeCompactionMessage | DeepseekAssistantMessage;

export type DeepseekMessageRecord = {
  info: DeepseekMessageInfo;
  parts: NativePart[];
};

type AssistantRecord = {
  info: DeepseekAssistantMessage;
  parts: NativePart[];
};

type CompactionRecord = {
  info: NativeCompactionMessage;
  parts: NativePart[];
};

type UserRecord = {
  info: NativeUserMessage;
  parts: NativePart[];
};

export type DeepseekAttemptInfo = {
  attemptId: string;
  startedAfterSeq?: number | undefined;
  turn: number;
  step: number;
};

export type DeepseekStreamBaseline = DeepseekSnapshotFrame['assistantStream'];

export interface DeepseekProjectionOptions {
  sessionId: string;
  directory: string;
  publisher?: Pick<NativeEventPublisher, 'records' | 'delta' | 'emit' | 'forget'> | null | undefined;
  identityScope?: ((seq: number) => string) | undefined;
}

export interface DeepseekProjection {
  apply: (raw: DeepseekSessionEvent | JsonObject, options?: { live?: boolean | undefined }) => void;
  begin: (attempt: DeepseekAttemptInfo) => void;
  chunk: (raw: JsonValue, time: number, options?: { publishDelta?: boolean | undefined }) => void;
  restoreStream: (baseline?: DeepseekStreamBaseline) => void;
  records: () => DeepseekMessageRecord[];
  position: (id: string) => number | undefined;
  publishAll: () => void;
  interrupt: (time: number) => void;
}

const compactionSummaryText = (blocks: ReadonlyArray<ParsedContentBlock> = []): string => blocks
  .filter((block): block is Extract<ParsedContentBlock, { type: 'text' }> => block.type === 'text')
  .map((block) => block.text)
  .join('\n')
  .trim();

const nativeTools = new Map<string, string>([
  ['bash', 'bash'],
  ['read_file', 'read'],
  ['write_file', 'write'],
  ['edit_file', 'edit'],
  ['str_replace', 'edit'],
  ['ask_user_question', 'question'],
  ['exit_plan_mode', 'plan_exit'],
  ['spawn_agent', 'task'],
]);

const argumentsOf = (raw: string): JsonObject => {
  try {
    return jsonObject.parse(JSON.parse(raw));
  } catch {
    return { arguments: raw };
  }
};

const blockKey = (block: ParsedContentBlock): string => {
  if (block.type === 'text' || block.type === 'reasoning') return `${block.type}\0${block.text}`;
  if (block.type === 'tool-call') return `tool\0${block.id}`;
  return `${block.type}\0${block.attachment.attachmentId}`;
};

const nativeBlockIndices = (content: ReadonlyArray<ParsedContentBlock>, stream?: ReadonlyArray<JsonValue>): number[] => {
  const blocks = new Map<number, ParsedContentBlock | null>();
  const closed = new Set<number>();
  for (const raw of stream ?? []) {
    const item = compactChunk.parse(raw);
    if (item.type === 'text-chunks' || item.type === 'reasoning-chunks') {
      if (closed.has(item.index)) continue;
      const previous = blocks.get(item.index);
      const previousText = previous && (previous.type === 'text' || previous.type === 'reasoning') ? previous.text : '';
      blocks.set(item.index, { type: item.type === 'text-chunks' ? 'text' : 'reasoning', text: previousText + item.texts.join('') });
    } else if (item.type === 'chunk') {
      const chunk = chunkSchema.parse(item.chunk);
      if (chunk.type === 'block-start' && !blocks.has(chunk.index)) {
        blocks.set(chunk.index, null);
      } else if (chunk.type === 'block-end') {
        blocks.set(chunk.index, chunk.block);
        closed.add(chunk.index);
      } else if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && !closed.has(chunk.index)) {
        const previous = blocks.get(chunk.index);
        const previousText = previous && (previous.type === 'text' || previous.type === 'reasoning') ? previous.text : '';
        blocks.set(chunk.index, { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: previousText + chunk.text });
      }
    }
  }
  const indices = new Map<string, number[]>();
  for (const [index, block] of blocks) {
    if (!block) continue;
    const keyValue = blockKey(block);
    const matches = indices.get(keyValue) ?? [];
    matches.push(index);
    indices.set(keyValue, matches);
  }
  return content.map((block, index) => indices.get(blockKey(block))?.shift() ?? index);
};

export const createDeepseekProjection = ({
  sessionId,
  directory,
  publisher = null,
  identityScope = () => sessionId,
}: DeepseekProjectionOptions): DeepseekProjection => {
  const records = new Map<string, DeepseekMessageRecord>();
  const positions = new Map<string, number>();
  const calls = new Map<string, { record: AssistantRecord; part: NativeToolPart }>();
  const assistantTurns = new Map<string, { turn: number; step: number }>();
  let parent: string | null = null;
  let currentModel: DeepseekSelection = { provider: '', model: '' };
  let requestModel: ParsedRequestContext = { provider: '', model: '' };
  let agent = 'build';
  let lastCreated = 0;
  let currentAttempt: DeepseekAttemptInfo | null = null;
  let seenSeq = -1;
  let scope = identityScope(0);

  const publish = (record: DeepseekMessageRecord): void => publisher?.records(directory, sessionId, [record]);
  const created = (time: number): number => {
    lastCreated = Math.max(time, lastCreated + 1);
    return lastCreated;
  };
  const assistantId = (turn: number, stepIndex: number): string => `ndh_a_${key(scope)}_${turn}_${stepIndex}`;

  const isAssistantRecord = (record: DeepseekMessageRecord | undefined): record is AssistantRecord => record?.info.role === 'assistant';
  const isCompactionRecord = (record: DeepseekMessageRecord | undefined): record is CompactionRecord => record?.info.role === 'compaction';

  const ensureAssistant = (turn: number, stepIndex: number, time: number): AssistantRecord => {
    const id = assistantId(turn, stepIndex);
    const existing = records.get(id);
    if (isAssistantRecord(existing)) return existing;
    if (!parent) {
      parent = `ndh_u_${key(scope)}_context`;
      const context: UserRecord = {
        info: buildUserMessage({
          id: parent,
          sessionID: sessionId,
          created: created(time - 1),
          agent,
          model: { providerID: NATIVE_PROVIDER_DEEPSEEK, modelID: modelId(currentModel.provider, currentModel.model) },
        }),
        parts: [],
      };
      records.set(parent, context);
      publish(context);
    }
    const model = requestModel.model ? requestModel : currentModel;
    const record: AssistantRecord = {
      info: buildAssistantMessage({
        id,
        sessionID: sessionId,
        parentID: parent,
        created: created(time),
        completed: null,
        providerID: NATIVE_PROVIDER_DEEPSEEK,
        modelID: model.model ? modelId(model.provider, model.model) : '',
        contextWindow: requestModel.contextWindow,
        agent,
        cwd: directory,
      }),
      parts: [],
    };
    records.set(id, record);
    assistantTurns.set(id, { turn, step: stepIndex });
    return record;
  };

  const partFrom = (
    record: DeepseekMessageRecord,
    block: ParsedContentBlock,
    index: number,
    time: number,
    complete: boolean,
    end = time,
  ): NativePart => {
    const text = block.type === 'text' || block.type === 'reasoning' ? block.text : '';
    const common = {
      id: `${record.info.id}_b${index}`,
      sessionID: sessionId,
      messageID: record.info.id,
      text,
      start: time,
      end: complete ? Math.max(time, end) : null,
    };
    if (block.type === 'text') return buildTextPart(common);
    if (block.type === 'reasoning') return buildReasoningPart(common);
    if (block.type === 'tool-call') {
      const input = argumentsOf(block.arguments);
      const part = buildToolPart({
        id: `${record.info.id}_t_${key(block.id)}`,
        sessionID: sessionId,
        messageID: record.info.id,
        callID: block.id,
        tool: nativeTools.get(block.name) ?? block.name,
        input,
        title: block.name,
        start: time,
        metadata: {},
        result: null,
      });
      if (isAssistantRecord(record)) calls.set(block.id, { record, part });
      return part;
    }
    return buildTextPart({ ...common, text: `Attached file: ${block.attachment.name ?? block.type}` });
  };

  const apply = (raw: DeepseekSessionEvent | JsonObject, { live = false }: { live?: boolean | undefined } = {}): void => {
    const event = sessionEvent.parse(raw);
    scope = identityScope(event.seq);
    if (event.seq <= seenSeq) return;
    seenSeq = event.seq;
    if (event.type === 'model/selection') {
      currentModel = selection.parse(event.data);
      return;
    }
    if (event.type === 'request/context') {
      requestModel = requestContext.parse(event.data);
      if (!currentModel.model) currentModel = requestModel;
      return;
    }
    if (event.type === 'plan/mode') {
      agent = z.object({ active: z.boolean() }).parse(event.data).active ? 'plan' : 'build';
      return;
    }
    if (['compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type)) {
      const data = compactionSchema.parse(event.data);
      const id = `ndh_k_${key(`${scope}:${data.compactionId}`)}`;
      const existing = records.get(id);
      let record: CompactionRecord;
      if (isCompactionRecord(existing)) {
        record = existing;
      } else {
        record = {
          info: buildCompactionMessage({ id, sessionID: sessionId, created: created(event.time), status: 'running', auto: data.turn != null }),
          parts: [],
        };
        records.set(id, record);
        positions.set(id, event.seq);
      }
      if (data.summary !== undefined) record.info.summary = compactionSummaryText(data.summary);
      if (event.type === 'compaction/end') {
        record.info.status = data.error ? 'failed' : 'completed';
        if (data.error) record.info.error = unknownError(data.error);
      }
      if (live) publish(record);
      return;
    }
    if (event.type === 'user/message') {
      const data = messageSchema.parse(event.data);
      if (data.source.kind !== 'user') return;
      const rpcId = data.source.rpcId;
      const id = rpcId?.startsWith(`ndh_u_${sessionId.slice(4, 28)}_`) && isNativeClientUserMessageId(rpcId)
        ? rpcId
        : `ndh_u_${key(`${scope}:${data.id}`)}`;
      const previous = records.get(id);
      const time = previous?.info.time.created ?? created(event.time);
      const model: NativeMessageModel = {
        providerID: NATIVE_PROVIDER_DEEPSEEK,
        modelID: currentModel.model ? modelId(currentModel.provider, currentModel.model) : '',
      };
      if (currentModel.reasoningEffort) model.variant = currentModel.reasoningEffort;
      const record: UserRecord = {
        info: buildUserMessage({ id, sessionID: sessionId, created: time, agent, model }),
        parts: [],
      };
      let textIndex = 0;
      let fileIndex = 0;
      for (const block of data.content) {
        if (block.type === 'text' && isInstructionsBlock(block.text)) continue;
        if (block.type === 'image' || block.type === 'file') {
          record.parts.push(buildFilePart({
            id: userFilePartId(id, fileIndex),
            sessionID: sessionId,
            messageID: id,
            mime: block.type === 'image' ? block.attachment.mediaType : 'application/octet-stream',
            url: '',
            filename: block.attachment.name ?? `image-${fileIndex + 1}`,
          }));
          fileIndex += 1;
        } else {
          const part = partFrom(record, block, textIndex, time, true);
          part.id = userTextPartId(id, textIndex);
          record.parts.push(part);
          textIndex += 1;
        }
      }
      records.set(id, record);
      positions.set(id, event.seq);
      parent = id;
      if (live) publish(record);
      return;
    }
    if (event.type === 'assistant/message') {
      const data = assistantSchema.parse(event.data);
      const record = ensureAssistant(data.turn, data.step, event.time);
      const indices = nativeBlockIndices(data.message.content, data.stream);
      record.info.modelID = data.message.source.model
        ? modelId(data.message.source.provider ?? '', data.message.source.model)
        : record.info.modelID;
      record.info.time.completed = Math.max(event.time, record.info.time.created);
      record.parts = data.message.content.map((block, index) => {
        const nativeIndex = indices[index] ?? index;
        const old = record.parts.find((part) => part.id === `${record.info.id}_b${nativeIndex}`);
        const start = old && (old.type === 'text' || old.type === 'reasoning') ? old.time.start : record.info.time.created;
        return partFrom(record, block, nativeIndex, start, true, event.time);
      });
      const prompt = records.get(record.info.parentID);
      if (prompt?.info.role === 'user' && !prompt.info.model.modelID && data.message.source.model) {
        prompt.info.model.modelID = record.info.modelID;
        if (live) publish(prompt);
      }
      if (data.interrupted) record.info.error = stoppedError();
      if (data.usage) {
        const tokens: DeepseekTokenUsage = {
          input: data.usage.inputTokens,
          output: data.usage.outputTokens,
          reasoning: data.usage.reasoningTokens ?? 0,
          cache: { read: data.usage.cacheReadTokens ?? 0, write: data.usage.cacheWriteTokens ?? 0 },
        };
        if (data.usage.totalTokens !== undefined) tokens.total = data.usage.totalTokens;
        record.info.tokens = tokens;
      }
      positions.set(record.info.id, event.seq);
      if (live) publish(record);
      return;
    }
    if (event.type === 'tool/call') {
      const data = toolCallSchema.parse(event.data);
      const known = calls.get(data.callId);
      if (known) {
        const state = known.part.state;
        const end = 'end' in state.time ? state.time.end : undefined;
        if (state.time.start !== event.time && (end === undefined || event.time <= end)) {
          if (state.status === 'running') {
            known.part.state = { ...state, time: { start: event.time } };
          } else {
            known.part.state = { ...state, time: { ...state.time, start: event.time } };
          }
          if (live) publish(known.record);
        }
        return;
      }
      const record = ensureAssistant(data.turn, data.step, event.time);
      record.parts.push(partFrom(record, { type: 'tool-call', id: data.callId, name: data.name, arguments: data.arguments }, record.parts.length, event.time, false));
      if (!positions.has(record.info.id)) positions.set(record.info.id, event.seq);
      if (live) publish(record);
      return;
    }
    if (event.type === 'tool/result') {
      const data = toolResultSchema.parse(event.data);
      const call = calls.get(data.message.toolCallId);
      if (!call) return;
      const output = data.message.content
        .filter((block): block is Extract<ParsedContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const metadata: JsonObject = { ...call.part.state.metadata };
      const parsedMeta = jsonObject.safeParse(data.meta);
      if (parsedMeta.success) Object.assign(metadata, parsedMeta.data);
      else if (data.meta !== undefined) metadata.nativeResult = data.meta;
      const end = Math.max(call.part.state.time.start, event.time);
      call.part.state = data.message.isError
        ? { status: 'error', input: call.part.state.input, error: data.error?.reason ?? output, metadata, time: { start: call.part.state.time.start, end } }
        : { status: 'completed', input: call.part.state.input, title: 'title' in call.part.state ? call.part.state.title : call.part.tool, output, metadata, time: { start: call.part.state.time.start, end } };
      call.record.info.time.completed = Math.max(call.record.info.time.completed ?? 0, end);
      if (live) publish(call.record);
      return;
    }
    if (event.type === 'step/end') {
      const data = stepSchema.parse(event.data);
      const record = records.get(assistantId(data.turn, data.step));
      if (!isAssistantRecord(record)) return;
      record.info.time.completed = Math.max(record.info.time.completed ?? 0, event.time);
      for (const part of record.parts) if (part.type === 'text' || part.type === 'reasoning') part.time.end ??= Math.max(part.time.start, event.time);
      if (live) publish(record);
      return;
    }
    if (event.type === 'turn/end') {
      const data = turnEndSchema.parse(event.data);
      const turnRecords = Array.from(records.values()).filter(
        (record): record is AssistantRecord => record.info.role === 'assistant' && assistantTurns.get(record.info.id)?.turn === data.turn,
      );
      const lastRecord = turnRecords.at(-1);
      const answerRecord = turnRecords.findLast((record) => record.parts.some((part) => part.type === 'text' && part.text.trim()));
      const turnError = ['aborted', 'interrupted'].includes(data.reason.kind)
        ? stoppedError()
        : data.reason.kind === 'error'
          ? unknownError(data.reason.error?.message ?? 'DeepSeek Harness turn failed')
          : null;
      for (const record of turnRecords) {
        let changed = false;
        let settledPart = false;
        for (const part of record.parts) {
          if ((part.type === 'text' || part.type === 'reasoning') && part.time.end === undefined) {
            part.time.end = Math.max(part.time.start, event.time);
            settledPart = true;
            changed = true;
          }
          if (part.type === 'tool' && part.state.status === 'running') {
            part.state = {
              status: 'error',
              input: part.state.input,
              error: 'Interrupted',
              metadata: part.state.metadata,
              time: { start: part.state.time.start, end: Math.max(part.state.time.start, event.time) },
            };
            settledPart = true;
            changed = true;
          }
        }
        if (record.info.time.completed === undefined || settledPart) {
          record.info.time.completed = Math.max(record.info.time.completed ?? record.info.time.created, event.time);
          changed = true;
        }
        if (turnError && (record === lastRecord || settledPart)) {
          record.info.error = turnError;
          changed = true;
        }
        if (record === answerRecord) {
          const finish = turnError ? 'error' : 'stop';
          if (record.info.finish !== finish) {
            record.info.finish = finish;
            changed = true;
          }
        }
        if (changed && live) publish(record);
      }
    }
  };

  const chunk = (raw: JsonValue, time: number, { publishDelta = true }: { publishDelta?: boolean | undefined } = {}): void => {
    if (!currentAttempt) return;
    const data = chunkSchema.parse(raw);
    const record = ensureAssistant(currentAttempt.turn, currentAttempt.step, time);
    if (data.type === 'text-delta' || data.type === 'reasoning-delta') {
      const id = `${record.info.id}_b${data.index}`;
      let part = record.parts.find((candidate) => candidate.id === id);
      if (!part) {
        part = partFrom(record, { type: data.type === 'text-delta' ? 'text' : 'reasoning', text: '' }, data.index, time, false);
        record.parts.push(part);
        if (publishDelta) publish(record);
      }
      if ((part.type !== 'text' && part.type !== 'reasoning') || part.time.end !== undefined) return;
      part.text += data.text;
      if (publishDelta) publisher?.delta(directory, { sessionID: sessionId, messageID: record.info.id, partID: id, field: 'text', delta: data.text });
    } else if (data.type === 'block-end') {
      const previous = record.parts.find((part) => part.id === `${record.info.id}_b${data.index}`);
      const start = previous && (previous.type === 'text' || previous.type === 'reasoning') ? previous.time.start : time;
      const part = partFrom(record, data.block, data.index, start, true, time);
      const index = record.parts.findIndex((candidate) => candidate.id === part.id);
      if (index < 0) record.parts.push(part);
      else record.parts[index] = part;
      if (publishDelta) publish(record);
    }
  };

  const begin = (attempt: DeepseekAttemptInfo): void => {
    scope = identityScope((attempt.startedAfterSeq ?? Number.NaN) + 1);
    const id = assistantId(attempt.turn, attempt.step);
    if (currentAttempt?.attemptId !== attempt.attemptId && records.has(id)) {
      records.delete(id);
      publisher?.emit(directory, 'message.removed', { sessionID: sessionId, messageID: id });
      publisher?.forget(sessionId);
    }
    currentAttempt = attempt;
  };

  const restoreStream = (baseline?: DeepseekStreamBaseline): void => {
    const attempt = baseline?.activeAttempt;
    if (!attempt) return;
    begin(attempt);
    for (const raw of attempt.stream) {
      const item = compactChunk.parse(raw);
      if (item.type === 'chunk') chunk(item.chunk, item.time, { publishDelta: false });
      else if (item.type !== 'tool-call-chunks') {
        let time = item.time0;
        item.texts.forEach((text, index) => {
          time += item.dt[index] ?? 0;
          chunk({ type: item.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: item.index, text }, time, { publishDelta: false });
        });
      }
    }
  };

  return {
    apply,
    begin,
    chunk,
    restoreStream,
    records: () => Array.from(records.values()),
    position: (id) => positions.get(id),
    publishAll: () => {
      for (const record of records.values()) publish(record);
    },
    interrupt(time) {
      for (const record of records.values()) {
        if (record.info.role === 'assistant' && record.info.time.completed === undefined) {
          record.info.time.completed = time;
          record.info.error = stoppedError();
          publish(record);
        }
      }
    },
  };
};
