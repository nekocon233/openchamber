import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';
import { createResponsesReplayBlock, isResponsesReplayBlock, readResponsesReplay, reasoningItemSchema } from './responses-replay.js';

const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const textContent = z.union([z.string().transform((text) => [textBlock.parse({ type: 'text', text })]), z.array(textBlock)]);
const imageBlock = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'), media_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    data: z.base64().min(1),
  }),
});
const toolResultContent = z.union([
  z.string().transform((text) => [textBlock.parse({ type: 'text', text })]),
  z.array(z.discriminatedUnion('type', [textBlock, imageBlock])),
]);
const jsonObject = z.record(z.string(), z.json());
const blockSchema = z.discriminatedUnion('type', [
  textBlock,
  imageBlock,
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: jsonObject }),
  z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: toolResultContent.default([]), is_error: z.boolean().optional() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
]);
const messagesSchema = z.object({
  model: z.string().min(1), stream: z.boolean().default(false),
  system: textContent.transform((blocks) => blocks.map((block) => block.text).join('\n')).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system', 'developer']), content: z.union([z.string().transform((text) => [textBlock.parse({ type: 'text', text })]), z.array(blockSchema)]) })),
  tools: z.array(z.object({ name: z.string().min(1), description: z.string().default(''), input_schema: jsonObject, type: z.literal('custom').optional() })).default([]),
  tool_choice: z.object({ type: z.enum(['auto', 'any', 'tool', 'none']), name: z.string().optional(), disable_parallel_tool_use: z.boolean().optional() }).optional(),
  output_config: z.object({ effort: z.string().optional(), format: z.object({ type: z.literal('json_schema'), schema: jsonObject }).optional() }).optional(),
});
const unsupported = () => new NativeAgentError('This ChatGPT request contains unsupported content or tools', { status: 400, code: 'CHATGPT_UNSUPPORTED_REQUEST' });
const toolName = (name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : `oc_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;
const imageInput = (block, supportsImages) => {
  if (!supportsImages) throw new NativeAgentError('This ChatGPT model does not support image input', { status: 400, code: 'CHATGPT_IMAGE_UNSUPPORTED' });
  return { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}`, detail: 'auto' };
};

/** Translate the caller's full history; the bridge neither executes tools nor stores conversations. */
export const toResponsesRequest = (raw, selectedModel, effort = null, supportsImages = false, accountId = null) => {
  const parsed = messagesSchema.safeParse(raw);
  if (!parsed.success) throw new NativeAgentError(`CHATGPT_UNSUPPORTED_REQUEST: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, { status: 400, code: 'CHATGPT_UNSUPPORTED_REQUEST' });
  const request = parsed.data;
  if (request.model !== selectedModel) throw new NativeAgentError('The bridge credential belongs to another model', { status: 403, code: 'CHATGPT_MODEL_MISMATCH' });
  const names = new Map(request.tools.map((tool) => [toolName(tool.name), tool.name]));
  if (names.size !== request.tools.length) throw unsupported();
  const input = [];
  const appendBlocks = (role, blocks) => {
    for (const block of blocks) {
      if (block.type === 'text') {
        input.push({ role: role === 'system' ? 'developer' : role, content: block.text });
      } else if (block.type === 'image') {
        if (role !== 'user') throw unsupported();
        input.push({ role: 'user', content: [imageInput(block, supportsImages)] });
      } else if (block.type === 'tool_use') {
        if (role !== 'assistant') throw unsupported();
        input.push({ type: 'function_call', call_id: block.id, namespace: 'claude', name: toolName(block.name), arguments: JSON.stringify(block.input) });
      } else if (block.type === 'tool_result') {
        if (role !== 'user') throw unsupported();
        if (block.content.some((part) => part.type === 'image')) {
          const output = block.content.map((part) => part.type === 'image'
            ? imageInput(part, supportsImages) : { type: 'input_text', text: part.text });
          if (block.is_error) output.unshift({ type: 'input_text', text: 'Tool execution failed:' });
          input.push({ type: 'function_call_output', call_id: block.tool_use_id, output });
        } else {
          const output = block.content.map((part) => part.text).join('\n');
          input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.is_error ? `Tool execution failed:\n${output}` : output });
        }
      }
      // Foreign provider thinking/signatures are not portable model history.
    }
  };
  for (const message of request.messages) {
    if (message.role !== 'assistant') { appendBlocks(message.role, message.content); continue; }
    const carriers = message.content.filter(isResponsesReplayBlock);
    const blocks = message.content.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking');
    let cursor = 0;
    for (const block of carriers) {
      const replay = readResponsesReplay({ block, blocks: blocks.slice(cursor), accountId, model: selectedModel });
      if (replay === null) continue;
      appendBlocks('assistant', blocks.slice(cursor, cursor + replay.offset));
      const segment = replay.blocks;
      for (const item of replay.entries) {
        if (item.type === 'reasoning') input.push(item);
        else if (item.type === 'message') {
          const restored = {
            type: 'message', role: 'assistant', id: item.id,
            content: item.parts.map((part) => ({ type: part.type, [part.type === 'refusal' ? 'refusal' : 'text']: segment[part.blockIndex].text })),
          };
          if (item.phase != null) restored.phase = item.phase;
          input.push(restored);
        } else appendBlocks('assistant', [segment[item.blockIndex]]);
      }
      cursor += replay.offset + segment.length;
    }
    appendBlocks('assistant', blocks.slice(cursor));
  }
  const body = { model: selectedModel, input, store: false, stream: true, include: ['reasoning.encrypted_content'] };
  if (request.system !== undefined) body.instructions = request.system;
  if (request.tools.length) body.tools = [{ type: 'namespace', name: 'claude', description: 'Tools executed by Claude Code on behalf of the user.', tools: request.tools.map((tool) => ({ type: 'function', name: toolName(tool.name), description: tool.description, parameters: tool.input_schema, strict: false })) }];
  const choice = request.tool_choice;
  if (choice?.type === 'tool') {
    if (!request.tools.some((tool) => tool.name === choice.name)) throw unsupported();
    body.tool_choice = { type: 'function', namespace: 'claude', name: toolName(choice.name) };
  } else if (choice) body.tool_choice = choice.type === 'any' ? 'required' : choice.type;
  if (choice?.disable_parallel_tool_use !== undefined) body.parallel_tool_calls = !choice.disable_parallel_tool_use;
  if (request.output_config?.format) body.text = { format: { type: 'json_schema', name: 'claude_output', schema: request.output_config.format.schema, strict: true } };
  // The grant captures the user's selection. Claude's effort can be clamped
  // for an unfamiliar model, so its output_config.effort is not authoritative.
  if (effort !== null) body.reasoning = { effort };
  return { body, names, stream: request.stream };
};

const functionCall = z.object({ type: z.literal('function_call'), id: z.string(), call_id: z.string(), name: z.string(), namespace: z.string().optional(), arguments: z.string().default('') });
const messageItem = z.object({ type: z.literal('message'), id: z.string(), phase: z.enum(['commentary', 'final_answer']).nullish(), content: z.array(z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() })).default([]) });
const outputItem = z.union([functionCall, messageItem, reasoningItemSchema]);
const tokenCount = z.number().int().nonnegative();
const usageSchema = z.object({
  input_tokens: tokenCount, output_tokens: tokenCount,
  input_tokens_details: z.object({ cached_tokens: tokenCount.optional(), cache_write_tokens: tokenCount.optional() }).optional(),
}).superRefine((usage, context) => {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const written = usage.input_tokens_details?.cache_write_tokens ?? 0;
  if (cached + written > usage.input_tokens) context.addIssue({ code: 'custom', message: 'Cached tokens exceed input tokens' });
});
const anthropicUsage = (usage) => {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const written = usage.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input_tokens: usage.input_tokens - cached - written,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
};
const responseSchema = z.object({
  id: z.string(), status: z.string(), usage: usageSchema.nullish(),
  output: z.array(outputItem).optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullish(),
});
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('response.created'), response: responseSchema }),
  z.object({ type: z.literal('response.output_item.added'), output_index: z.number().int().nonnegative(), item: outputItem }),
  z.object({ type: z.literal('response.output_text.delta'), item_id: z.string(), content_index: z.number(), delta: z.string() }),
  z.object({ type: z.literal('response.refusal.delta'), item_id: z.string(), content_index: z.number(), delta: z.string() }),
  z.object({ type: z.literal('response.function_call_arguments.delta'), item_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal('response.output_item.done'), output_index: z.number().int().nonnegative().optional(), item: outputItem }),
  z.object({ type: z.literal('response.completed'), response: responseSchema }),
  z.object({ type: z.literal('response.failed'), response: responseSchema }),
  z.object({ type: z.literal('response.incomplete'), response: responseSchema }),
  z.object({ type: z.literal('error'), code: z.string().optional(), message: z.string().optional() }),
]);

const HANDLED_EVENTS = new Set(['response.created', 'response.output_item.added', 'response.output_text.delta', 'response.refusal.delta', 'response.function_call_arguments.delta', 'response.output_item.done', 'response.completed', 'response.failed', 'response.incomplete', 'error']);

/** Bound the unfinished SSE frame, including fragmented UTF-8 and CRLF boundaries. */
export async function* readResponsesEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 8 * 1024 * 1024) throw new Error('CHATGPT_STREAM_FRAME_TOO_LARGE');
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      const raw = JSON.parse(data);
      const type = z.object({ type: z.string() }).parse(raw).type;
      // Known lifecycle events must parse; unhandled content types fail at item boundaries.
      if (HANDLED_EVENTS.has(type)) yield eventSchema.parse(raw);
    }
  }
}

/** Emit Claude-compatible blocks once each; an unfinished stream never emits success. */
export const createAnthropicStream = ({ model, names, accountId = null }) => {
  const id = `msg_${randomUUID().replaceAll('-', '')}`;
  const blocks = [];
  const items = new Map();
  const finishedItems = new Map();
  const positions = new Map();
  let started = false;
  let completed = false;
  let hasTools = false;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const start = () => {
    if (started) return [];
    started = true;
    return [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  };
  const addText = (key) => {
    if (items.has(key)) return [];
    const index = blocks.length;
    const block = { type: 'text', text: '' };
    blocks.push(block); items.set(key, { index, block, closed: false });
    return [{ type: 'content_block_start', index, content_block: { ...block } }];
  };
  return {
    push(event) {
      if (completed) throw new Error('CHATGPT_STREAM_AFTER_COMPLETION');
      const output = start();
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        if (!positions.has(event.item.id) || event.output_index !== undefined) positions.set(event.item.id, event.output_index ?? positions.size);
        if (event.type === 'response.output_item.done') finishedItems.set(event.item.id, event.item);
      }
      if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        if (event.item.namespace && event.item.namespace !== 'claude') throw unsupported();
        const name = names.get(event.item.name);
        if (!name) throw unsupported();
        const index = blocks.length;
        const block = { type: 'tool_use', id: event.item.call_id, name, input: {} };
        blocks.push(block); items.set(event.item.id, { index, block, arguments: '', closed: false });
        hasTools = true;
        output.push({ type: 'content_block_start', index, content_block: block });
      } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        const key = `${event.item_id}:${event.content_index}`;
        output.push(...addText(key));
        const item = items.get(key);
        if (item.closed) throw new Error('CHATGPT_INVALID_STREAM_ORDER');
        item.block.text += event.delta;
        output.push({ type: 'content_block_delta', index: item.index, delta: { type: 'text_delta', text: event.delta } });
      } else if (event.type === 'response.function_call_arguments.delta') {
        const item = items.get(event.item_id);
        if (!item || item.closed || item.block.type !== 'tool_use') throw new Error('CHATGPT_INVALID_TOOL_STREAM');
        item.arguments += event.delta;
        if (item.arguments.length > 8 * 1024 * 1024) throw new Error('CHATGPT_TOOL_ARGUMENTS_TOO_LARGE');
        output.push({ type: 'content_block_delta', index: item.index, delta: { type: 'input_json_delta', partial_json: event.delta } });
      } else if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
        const item = items.get(event.item.id);
        if (!item || item.closed) throw new Error('CHATGPT_INVALID_TOOL_STREAM');
        if (!item.arguments) {
          item.arguments = event.item.arguments;
          output.push({ type: 'content_block_delta', index: item.index, delta: { type: 'input_json_delta', partial_json: item.arguments } });
        }
        item.block.input = jsonObject.parse(JSON.parse(item.arguments));
        item.closed = true;
        output.push({ type: 'content_block_stop', index: item.index });
      } else if (event.type === 'response.output_item.done' && event.item.type === 'message') {
        for (const [index, part] of event.item.content.entries()) {
          if (part.type !== 'output_text' && part.type !== 'refusal') throw unsupported();
          const key = `${event.item.id}:${index}`;
          if (!items.has(key)) {
            output.push(...addText(key));
            const text = part.text ?? part.refusal ?? '';
            items.get(key).block.text = text;
            output.push({ type: 'content_block_delta', index: items.get(key).index, delta: { type: 'text_delta', text } });
          }
          const item = items.get(key);
          if (!item.closed) { item.closed = true; output.push({ type: 'content_block_stop', index: item.index }); }
        }
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
        const code = event.type === 'error' ? event.code : event.response.error?.code;
        throw new NativeAgentError(code ?? 'CHATGPT_INFERENCE_FAILED', { code: code ?? 'CHATGPT_INFERENCE_FAILED', status: 502 });
      } else if (event.type === 'response.completed') {
        if (blocks.length === 0) throw new Error('CHATGPT_EMPTY_RESPONSE');
        if (event.response.status !== 'completed') throw new Error('CHATGPT_INFERENCE_INCOMPLETE');
        for (const item of items.values()) {
          if (item.block.type === 'tool_use' && !item.closed) throw new Error('CHATGPT_INCOMPLETE_TOOL_CALL');
          if (!item.closed) { item.closed = true; output.push({ type: 'content_block_stop', index: item.index }); }
        }
        const ordered = event.response.output ?? [...finishedItems.values()].sort((a, b) => positions.get(a.id) - positions.get(b.id));
        const entries = ordered.map((item) => {
          if (item.type === 'reasoning') {
            if (!item.encrypted_content) throw new Error('CHATGPT_REASONING_STATE_UNAVAILABLE');
            return item;
          }
          if (item.type === 'message') {
            const entry = {
              type: 'message', id: item.id,
              parts: item.content.map((part, index) => {
                const block = items.get(`${item.id}:${index}`);
                if (!block || block.block.type !== 'text') throw new Error('CHATGPT_REPLAY_CONTENT_MISSING');
                return { blockIndex: block.index, type: part.type };
              }),
            };
            if (item.phase != null) entry.phase = item.phase;
            return entry;
          }
          const block = items.get(item.id);
          if (!block || block.block.type !== 'tool_use') throw new Error('CHATGPT_REPLAY_CONTENT_MISSING');
          return { type: 'function_call', blockIndex: block.index };
        });
        const replayBlock = createResponsesReplayBlock({ accountId, model, blocks, entries });
        if (replayBlock !== null) {
          const index = blocks.length;
          blocks.push(replayBlock);
          output.push({ type: 'content_block_start', index, content_block: replayBlock }, { type: 'content_block_stop', index });
        }
        if (event.response.usage) usage = anthropicUsage(event.response.usage);
        output.push({ type: 'message_delta', delta: { stop_reason: hasTools ? 'tool_use' : 'end_turn', stop_sequence: null }, usage });
        output.push({ type: 'message_stop' });
        completed = true;
      }
      return output;
    },
    result() {
      if (!completed) throw new Error('CHATGPT_STREAM_INTERRUPTED');
      return { id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: hasTools ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
    },
  };
};
