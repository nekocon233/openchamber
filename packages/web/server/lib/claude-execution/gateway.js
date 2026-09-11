import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { messagesRequestSchema, toLanguageModelCall } from './protocol.js';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

async function readRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('Claude Code model request is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return messagesRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

const sendJson = (response, status, message) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
};

export async function startModelGateway({ model, modelID, providerOptions, format = 'anthropic', headers, maxOutputTokens, signal }) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const reasoningHistory = new Map();
  const controllers = new Set();
  const server = createServer(async (request, response) => {
    const debug = (stage) => { if (process.env.OPENCHAMBER_CLAUDE_EXECUTION_DEBUG === '1') console.error('[claude-gateway]', stage); };
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      debug('unauthorized');
      sendJson(response, 401, 'Invalid model gateway credential');
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'POST' || pathname !== '/v1/messages') {
      sendJson(response, 404, 'Unsupported model gateway operation');
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnected);
    let heartbeat;
    try {
      const payload = await readRequest(request);
      debug('request.parsed');
      const call = toLanguageModelCall(payload, providerOptions, AbortSignal.any([controller.signal, signal]), reasoningHistory, format);
      // OpenCode omits this limit for ChatGPT subscription endpoints, which
      // reject max_output_tokens. Claude's required max_tokens must not restore it.
      if (format === 'responses') call.maxOutputTokens = maxOutputTokens;
      call.headers = headers;
      const result = await model.doStream(call);
      debug('source.started');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const emit = async (event) => {
        if (response.destroyed) throw new Error('Model gateway disconnected');
        if (!response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) await once(response, 'drain', { signal: controller.signal });
      };
      heartbeat = setInterval(() => { if (!response.destroyed) response.write('event: ping\ndata: {"type":"ping"}\n\n'); }, 5000);
      heartbeat.unref();
      await translateModelStream(result.stream, { emit, modelID, reasoningHistory });
      response.end();
    } catch (error) {
      debug(error instanceof z.ZodError ? JSON.stringify(error.issues.map((issue) => ({ code: issue.code, path: issue.path }))) : `failure.${error.name}`);
      if (response.destroyed) return;
      // Error bodies may contain provider credentials or user content. Only
      // protocol status and a fixed explanation cross this process boundary.
      const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400 : Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      if (!response.headersSent) sendJson(response, status, `Model request failed (${status})`);
      else response.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Model stream failed before completion' } })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      response.off('close', disconnected);
      controller.abort();
      controllers.delete(controller);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    token,
    close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      server.close();
      reasoningHistory.clear();
    },
  };
}

export async function translateModelStream(stream, { emit, modelID, reasoningHistory }) {
  await emit({ type: 'message_start', message: {
    id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: modelID,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
  } });
  const blocks = new Map();
  let index = 0;
  let finished = false;
  const start = async (id, kind, block) => {
    const state = { index: index++, kind, text: '', complete: false };
    blocks.set(id, state);
    await emit({ type: 'content_block_start', index: state.index, content_block: block });
    return state;
  };
  const stop = async (state) => {
    if (!state || state.complete) return;
    state.complete = true;
    await emit({ type: 'content_block_stop', index: state.index });
  };
  for await (const part of stream) {
    switch (part.type) {
      case 'text-start': await start(part.id, 'text', { type: 'text', text: '' }); break;
      case 'reasoning-start': await start(part.id, 'reasoning', { type: 'thinking', thinking: '' }); break;
      case 'text-delta':
      case 'reasoning-delta': {
        const reasoning = part.type === 'reasoning-delta';
        const state = blocks.get(part.id) ?? await start(part.id, reasoning ? 'reasoning' : 'text', reasoning ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' });
        state.text += part.delta;
        await emit({ type: 'content_block_delta', index: state.index, delta: reasoning ? { type: 'thinking_delta', thinking: part.delta } : { type: 'text_delta', text: part.delta } });
        break;
      }
      case 'reasoning-end': {
        const state = blocks.get(part.id);
        if (state && part.providerMetadata) reasoningHistory.set(state.text, part.providerMetadata);
        const signature = part.providerMetadata?.anthropic?.signature;
        if (state && signature) await emit({ type: 'content_block_delta', index: state.index, delta: { type: 'signature_delta', signature } });
        await stop(state);
        break;
      }
      case 'text-end': await stop(blocks.get(part.id)); break;
      case 'tool-input-start': await start(part.id, 'tool', { type: 'tool_use', id: part.id, name: part.toolName, input: {} }); break;
      case 'tool-input-delta': {
        const state = blocks.get(part.id);
        if (!state) throw new Error('Tool arguments arrived before the tool call');
        state.text += part.delta;
        await emit({ type: 'content_block_delta', index: state.index, delta: { type: 'input_json_delta', partial_json: part.delta } });
        break;
      }
      case 'tool-input-end': await stop(blocks.get(part.id)); break;
      case 'tool-call': {
        if (part.providerExecuted) throw new Error('Provider-executed tools cannot be bridged through Claude Code');
        let state = blocks.get(part.toolCallId);
        if (!state) {
          state = await start(part.toolCallId, 'tool', { type: 'tool_use', id: part.toolCallId, name: part.toolName, input: {} });
          await emit({ type: 'content_block_delta', index: state.index, delta: { type: 'input_json_delta', partial_json: part.input } });
        }
        await stop(state);
        break;
      }
      case 'error': throw part.error;
      case 'finish': {
        if (!['stop', 'tool-calls', 'length'].includes(part.finishReason.unified)) throw Object.assign(new Error('Source model did not complete normally'), { statusCode: 422 });
        for (const block of blocks.values()) await stop(block);
        const hasTools = [...blocks.values()].some((b) => b.kind === 'tool');
        await emit({ type: 'message_delta', delta: {
          stop_reason: hasTools ? 'tool_use' : part.finishReason.unified === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null,
        }, usage: {
          input_tokens: part.usage.inputTokens.noCache ?? part.usage.inputTokens.total ?? 0,
          cache_read_input_tokens: part.usage.inputTokens.cacheRead ?? 0,
          cache_creation_input_tokens: part.usage.inputTokens.cacheWrite ?? 0,
          output_tokens: part.usage.outputTokens.total ?? 0,
        } });
        await emit({ type: 'message_stop' });
        finished = true;
        break;
      }
    }
  }
  if (!finished) throw new Error('Source model stream ended without a completion event');
}
