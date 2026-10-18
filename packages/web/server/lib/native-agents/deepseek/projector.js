import { createHash } from 'node:crypto';
import { z } from 'zod';

import { NATIVE_PROVIDER_DEEPSEEK, isNativeClientUserMessageId, userFilePartId, userTextPartId } from '../ids.js';
import { isInstructionsBlock } from '../prompt-parts.js';
import { buildAssistantMessage, buildCompactionMessage, buildFilePart, buildReasoningPart, buildTextPart, buildToolPart, buildUserMessage, stoppedError, unknownError } from '../records.js';
import { jsonObject, modelId, selection, sessionEvent } from './protocol.js';

const key = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const contentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), id: z.string(), name: z.string(), arguments: z.string() }),
  z.object({ type: z.literal('image'), attachment: z.object({ attachmentId: z.string(), name: z.string().optional(), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']) }) }),
  z.object({ type: z.literal('file'), attachment: z.object({ attachmentId: z.string(), name: z.string() }) }),
]);
const message = z.object({ id: z.string(), content: z.array(contentBlock), source: z.object({
  kind: z.string(), rpcId: z.string().optional(), provider: z.string().optional(), model: z.string().optional(),
}) });
const usage = z.object({
  inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number().optional(),
  reasoningTokens: z.number().optional(), cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional(),
});
const requestContext = selection.extend({ contextWindow: z.number().int().positive().optional() });
const assistant = z.object({ turn: z.number(), step: z.number(), message,
  interrupted: z.literal(true).optional(), usage: usage.optional(),
  stream: z.array(z.json()).optional(),
});
const toolCall = z.object({ turn: z.number(), step: z.number(), callId: z.string(), name: z.string(), arguments: z.string() });
const toolResult = z.object({ turn: z.number(), step: z.number(), message: z.object({
  toolCallId: z.string(), isError: z.boolean().optional(), content: z.array(contentBlock),
}), meta: z.json().optional(), error: z.object({ reason: z.string().optional() }).optional() });
const step = z.object({ turn: z.number(), step: z.number() });
const turnEnd = z.object({ turn: z.number(), reason: z.object({ kind: z.string(), error: z.object({ message: z.string() }).optional() }) });
const compaction = z.object({ compactionId: z.string(), turn: z.number().nullable().optional(), summary: z.string().optional(), error: z.string().optional() });
const chunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block-start'), index: z.number(), blockType: z.string() }),
  z.object({ type: z.enum(['text-delta', 'reasoning-delta']), index: z.number(), text: z.string() }),
  z.object({ type: z.literal('tool-call-delta'), index: z.number(), id: z.string(), name: z.string().optional(), argumentsDelta: z.string() }),
  z.object({ type: z.literal('block-end'), index: z.number(), block: contentBlock }),
  z.object({ type: z.literal('usage'), usage }),
  z.object({ type: z.literal('finish'), reason: z.object({ kind: z.string() }) }),
]);
const compactChunk = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['text-chunks', 'reasoning-chunks']), index: z.number(), time0: z.number(), dt: z.array(z.number()), texts: z.array(z.string()) }),
  z.object({ type: z.literal('tool-call-chunks'), index: z.number(), time0: z.number(), dt: z.array(z.number()), id: z.string(), name: z.string().optional(), args: z.array(z.string()) }),
  z.object({ type: z.literal('chunk'), time: z.number(), chunk: z.json() }),
]);
const nativeTools = { bash: 'bash', read_file: 'read', write_file: 'write', edit_file: 'edit', str_replace: 'edit', ask_user_question: 'question', exit_plan_mode: 'plan_exit', spawn_agent: 'task' };
const argumentsOf = (raw) => {
  try { return jsonObject.parse(JSON.parse(raw)); }
  catch { return { arguments: raw }; }
};

const blockKey = (block) => {
  if (block.type === 'text' || block.type === 'reasoning') return `${block.type}\0${block.text}`;
  if (block.type === 'tool-call') return `tool\0${block.id}`;
  return `${block.type}\0${block.attachment.attachmentId}`;
};

// The durable content array can omit a failed/unfinished block. Join it to
// its recorded stream rather than assuming provider block indexes are dense.
const nativeBlockIndices = (content, stream) => {
  const blocks = new Map();
  const closed = new Set();
  for (const raw of stream ?? []) {
    const item = compactChunk.parse(raw);
    if (item.type === 'text-chunks' || item.type === 'reasoning-chunks') {
      if (closed.has(item.index)) continue;
      const previous = blocks.get(item.index);
      blocks.set(item.index, { type: item.type === 'text-chunks' ? 'text' : 'reasoning', text: (previous?.text ?? '') + item.texts.join('') });
    } else if (item.type === 'chunk') {
      const chunk = chunkSchema.parse(item.chunk);
      if (chunk.type === 'block-start' && !blocks.has(chunk.index)) {
        blocks.set(chunk.index, null);
      } else if (chunk.type === 'block-end') {
        blocks.set(chunk.index, chunk.block);
        closed.add(chunk.index);
      } else if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && !closed.has(chunk.index)) {
        const previous = blocks.get(chunk.index);
        blocks.set(chunk.index, { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: (previous?.text ?? '') + chunk.text });
      }
    }
  }
  const indices = new Map();
  for (const [index, block] of blocks) {
    if (!block) continue;
    const key = blockKey(block);
    const matches = indices.get(key) ?? [];
    matches.push(index);
    indices.set(key, matches);
  }
  return content.map((block, index) => indices.get(blockKey(block))?.shift() ?? index);
};

/** One incremental projection shared by history and live session following. */
export const createDeepseekProjection = ({ sessionId, directory, publisher = null, identityScope = () => sessionId }) => {
  const records = new Map();
  const positions = new Map();
  const calls = new Map();
  const assistantTurns = new Map();
  let parent = null;
  let currentModel = { provider: '', model: '' };
  let requestModel = { provider: '', model: '' };
  let agent = 'build';
  let lastCreated = 0;
  let currentAttempt = null;
  let seenSeq = -1;
  let scope = identityScope(0);

  const publish = (record) => publisher?.records(directory, sessionId, [record]);
  const created = (time) => { lastCreated = Math.max(time, lastCreated + 1); return lastCreated; };
  const assistantId = (turn, stepIndex) => `ndh_a_${key(scope)}_${turn}_${stepIndex}`;
  const ensureAssistant = (turn, stepIndex, time) => {
    const id = assistantId(turn, stepIndex);
    let record = records.get(id);
    if (record) return record;
    if (!parent) {
      parent = `ndh_u_${key(scope)}_context`;
      const context = { info: buildUserMessage({ id: parent, sessionID: sessionId, created: created(time - 1), agent,
        model: { providerID: NATIVE_PROVIDER_DEEPSEEK, modelID: modelId(currentModel.provider, currentModel.model) } }), parts: [] };
      records.set(parent, context);
      publish(context);
    }
    const model = requestModel.model ? requestModel : currentModel;
    record = { info: buildAssistantMessage({ id, sessionID: sessionId, parentID: parent, created: created(time), completed: null,
      providerID: NATIVE_PROVIDER_DEEPSEEK, modelID: model.model ? modelId(model.provider, model.model) : '', contextWindow: requestModel.contextWindow, agent, cwd: directory }), parts: [] };
    records.set(id, record);
    assistantTurns.set(id, { turn, step: stepIndex });
    return record;
  };
  const partFrom = (record, block, index, time, complete, end = time) => {
    const common = { id: `${record.info.id}_b${index}`, sessionID: sessionId, messageID: record.info.id, text: block.text ?? '', start: time, end: complete ? Math.max(time, end) : null };
    if (block.type === 'text') return buildTextPart(common);
    if (block.type === 'reasoning') return buildReasoningPart(common);
    if (block.type === 'tool-call') {
      const input = argumentsOf(block.arguments);
      const part = buildToolPart({ id: `${record.info.id}_t_${key(block.id)}`, sessionID: sessionId, messageID: record.info.id,
        callID: block.id, tool: nativeTools[block.name] ?? block.name, input,
        title: block.name, start: time, metadata: {}, result: null });
      calls.set(block.id, { record, part });
      return part;
    }
    return buildTextPart({ ...common, text: `Attached file: ${block.attachment.name ?? block.type}` });
  };

  const apply = (raw, { live = false } = {}) => {
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
      const data = compaction.parse(event.data);
      const id = `ndh_k_${key(`${scope}:${data.compactionId}`)}`;
      let record = records.get(id);
      if (!record) {
        record = { info: buildCompactionMessage({ id, sessionID: sessionId, created: created(event.time), status: 'running', auto: data.turn != null }), parts: [] };
        records.set(id, record);
        positions.set(id, event.seq);
      }
      if (data.summary !== undefined) record.info.summary = data.summary;
      if (event.type === 'compaction/end') {
        record.info.status = data.error ? 'failed' : 'completed';
        if (data.error) record.info.error = unknownError(data.error);
      }
      if (live) publish(record);
      return;
    }
    if (event.type === 'user/message') {
      const data = message.parse(event.data);
      if (data.source.kind !== 'user') return;
      const rpcId = data.source.rpcId;
      const id = rpcId?.startsWith(`ndh_u_${sessionId.slice(4, 28)}_`) && isNativeClientUserMessageId(rpcId) ? rpcId : `ndh_u_${key(`${scope}:${data.id}`)}`;
      const previous = records.get(id);
      const time = previous?.info.time.created ?? created(event.time);
      const model = { providerID: NATIVE_PROVIDER_DEEPSEEK, modelID: currentModel.model ? modelId(currentModel.provider, currentModel.model) : '' };
      if (currentModel.reasoningEffort) model.variant = currentModel.reasoningEffort;
      const record = { info: buildUserMessage({ id, sessionID: sessionId, created: time, agent,
        model }),
        parts: [] };
      let textIndex = 0;
      let fileIndex = 0;
      for (const block of data.content) {
        if (block.type === 'text' && isInstructionsBlock(block.text)) continue;
        if (block.type === 'image' || block.type === 'file') {
          record.parts.push(buildFilePart({ id: userFilePartId(id, fileIndex), sessionID: sessionId, messageID: id,
            mime: block.type === 'image' ? block.attachment.mediaType : 'application/octet-stream', url: '',
            filename: block.attachment.name ?? `image-${fileIndex + 1}` }));
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
      const data = assistant.parse(event.data);
      const record = ensureAssistant(data.turn, data.step, event.time);
      const indices = nativeBlockIndices(data.message.content, data.stream);
      record.info.modelID = data.message.source.model ? modelId(data.message.source.provider ?? '', data.message.source.model) : record.info.modelID;
      record.info.time.completed = Math.max(event.time, record.info.time.created);
      record.parts = data.message.content.map((block, index) => {
        const nativeIndex = indices[index];
        const old = record.parts.find((part) => part.id === `${record.info.id}_b${nativeIndex}`);
        return partFrom(record, block, nativeIndex, old?.time?.start ?? record.info.time.created, true, event.time);
      });
      const prompt = records.get(record.info.parentID);
      if (prompt?.info.role === 'user' && !prompt.info.model.modelID && data.message.source.model) {
        prompt.info.model.modelID = record.info.modelID;
        if (live) publish(prompt);
      }
      if (data.interrupted) record.info.error = stoppedError();
      if (data.usage) record.info.tokens = {
        input: data.usage.inputTokens, output: data.usage.outputTokens, reasoning: data.usage.reasoningTokens ?? 0,
        cache: { read: data.usage.cacheReadTokens ?? 0, write: data.usage.cacheWriteTokens ?? 0 },
      };
      if (data.usage?.totalTokens !== undefined) record.info.tokens.total = data.usage.totalTokens;
      positions.set(record.info.id, event.seq);
      if (live) publish(record);
      return;
    }
    if (event.type === 'tool/call') {
      const data = toolCall.parse(event.data);
      if (calls.has(data.callId)) return;
      const record = ensureAssistant(data.turn, data.step, event.time);
      record.parts.push(partFrom(record, { type: 'tool-call', id: data.callId, name: data.name, arguments: data.arguments }, record.parts.length, event.time, false));
      if (live) publish(record);
      return;
    }
    if (event.type === 'tool/result') {
      const data = toolResult.parse(event.data);
      const call = calls.get(data.message.toolCallId);
      if (!call) return;
      const output = data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      const metadata = { ...call.part.state.metadata, ...(jsonObject.safeParse(data.meta).data ?? (data.meta === undefined ? {} : { nativeResult: data.meta })) };
      const end = Math.max(call.part.state.time.start, event.time);
      call.part.state = data.message.isError
        ? { status: 'error', input: call.part.state.input, error: data.error?.reason ?? output, metadata, time: { start: call.part.state.time.start, end } }
        : { status: 'completed', input: call.part.state.input, title: call.part.state.title ?? call.part.tool, output, metadata, time: { start: call.part.state.time.start, end } };
      call.record.info.time.completed = Math.max(call.record.info.time.completed ?? 0, end);
      if (live) publish(call.record);
      return;
    }
    if (event.type === 'step/end' || event.type === 'turn/end') {
      const data = event.type === 'step/end' ? step.parse(event.data) : turnEnd.parse(event.data);
      for (const record of records.values()) {
        const identity = assistantTurns.get(record.info.id);
        if (record.info.role !== 'assistant' || identity?.turn !== data.turn) continue;
        if (event.type === 'step/end' && identity.step !== data.step) continue;
        record.info.time.completed = Math.max(record.info.time.completed ?? 0, event.time);
        for (const part of record.parts) {
          if (part.type === 'text' || part.type === 'reasoning') part.time.end ??= event.time;
          if (event.type === 'turn/end' && part.type === 'tool' && part.state.status === 'running') part.state = {
            status: 'error', input: part.state.input, error: 'Interrupted', time: { start: part.state.time.start, end: event.time },
          };
        }
        if (event.type === 'turn/end' && ['aborted', 'interrupted'].includes(data.reason.kind)) record.info.error = stoppedError();
        if (event.type === 'turn/end' && data.reason.kind === 'error') record.info.error = unknownError(data.reason.error?.message ?? 'DeepSeek Harness turn failed');
        if (live) publish(record);
      }
    }
  };

  const chunk = (raw, time, { publishDelta = true } = {}) => {
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
      if (part.time.end !== undefined) return;
      part.text += data.text;
      if (publishDelta) publisher?.delta(directory, { sessionID: sessionId, messageID: record.info.id, partID: id, field: 'text', delta: data.text });
    } else if (data.type === 'block-end') {
      const previous = record.parts.find((part) => part.id === `${record.info.id}_b${data.index}`);
      const part = partFrom(record, data.block, data.index, previous?.time?.start ?? time, true, time);
      const index = record.parts.findIndex((candidate) => candidate.id === part.id);
      if (index < 0) record.parts.push(part);
      else record.parts[index] = part;
      if (publishDelta) publish(record);
    }
  };

  const begin = (attempt) => {
    scope = identityScope(attempt.startedAfterSeq + 1);
    const id = assistantId(attempt.turn, attempt.step);
    if (currentAttempt?.attemptId !== attempt.attemptId && records.has(id)) {
      records.delete(id);
      publisher?.emit(directory, 'message.removed', { sessionID: sessionId, messageID: id });
      publisher?.forget(sessionId);
    }
    currentAttempt = attempt;
  };
  const restoreStream = (baseline) => {
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
    apply, begin, chunk, restoreStream,
    records: () => Array.from(records.values()),
    position: (id) => positions.get(id),
    publishAll: () => { for (const record of records.values()) publish(record); },
    interrupt(time) {
      for (const record of records.values()) if (record.info.role === 'assistant' && record.info.time.completed === undefined) {
        record.info.time.completed = time;
        record.info.error = stoppedError();
        publish(record);
      }
    },
  };
};
