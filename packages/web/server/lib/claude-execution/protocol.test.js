import { describe, expect, it } from 'vitest';
import { messagesRequestSchema, toLanguageModelCall, cleanSourceCall, EXECUTION_HEADER, CONTEXT_HEADER } from './protocol.js';
import { translateModelStream } from './gateway.js';
import { createExecutionHooks, wrapModels } from './hooks.js';
import { LoggedInProviderExecution } from './provider-plugin.js';

const usage = { inputTokens: { total: 12, noCache: 10, cacheRead: 2 }, outputTokens: { total: 3 } };
const stream = (parts) => new ReadableStream({ start(controller) { parts.forEach((part) => controller.enqueue(part)); controller.close(); } });

describe('Claude Code model protocol', () => {
  it('replaces the old OpenCode Responses instructions with the Claude runtime prompt', () => {
    const call = toLanguageModelCall({
      system: 'Claude Code instructions with project rules',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }],
      tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      max_tokens: 100,
    }, { openai: { instructions: 'Old OpenCode instructions', reasoningEffort: 'high' } }, undefined, new Map(), 'responses');
    expect(call.providerOptions.openai).toEqual({ instructions: 'Claude Code instructions with project rules', reasoningEffort: 'high' });
    expect(call.prompt).toEqual([{ role: 'user', content: [{ type: 'text', text: 'task' }] }]);
    expect(call.tools[0].strict).toBe(false);
  });
  it('preserves tool IDs, tool failures, system instructions and image bytes', () => {
    const request = messagesRequestSchema.parse({
      model: 'gateway', stream: true, max_tokens: 100,
      system: [{ type: 'text', text: 'project instructions' }],
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'denied', is_error: true }] },
      ],
      tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    });
    const call = toLanguageModelCall(request, {}, new AbortController().signal);
    expect(call.prompt[0]).toEqual({ role: 'system', content: 'project instructions' });
    expect(call.prompt[1].content[0].data.toString()).toBe('hello');
    expect(call.prompt[3]).toEqual({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read', output: { type: 'error-text', value: 'denied' } }] });
    expect(call.tools[0].inputSchema.required).toEqual(['path']);
  });

  it('streams interleaved tools exactly once and requires an authoritative finish', async () => {
    const emitted = [];
    const parts = [
      { type: 'tool-input-start', id: 'call_1', toolName: 'read' },
      { type: 'tool-input-start', id: 'call_2', toolName: 'glob' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"path":' },
      { type: 'tool-input-delta', id: 'call_2', delta: '{}' },
      { type: 'tool-input-delta', id: 'call_1', delta: '"file"}' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'read', input: '{"path":"file"}' },
      { type: 'tool-call', toolCallId: 'call_2', toolName: 'glob', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls' }, usage },
    ];
    await translateModelStream(stream(parts), { emit: async (event) => emitted.push(event), modelID: 'source-model', reasoningHistory: new Map() });
    expect(emitted.filter((event) => event.type === 'content_block_start')).toHaveLength(2);
    expect(emitted.filter((event) => event.type === 'content_block_stop')).toHaveLength(2);
    expect(emitted.at(-2).delta.stop_reason).toBe('tool_use');
    expect(emitted.at(-2).usage.input_tokens).toBe(10);
    await expect(translateModelStream(stream(parts.slice(0, -1)), { emit: async () => {}, modelID: 'm', reasoningHistory: new Map() })).rejects.toThrow('without a completion');
  });

  it('preserves mid-conversation system messages and images in tool results', () => {
    const request = messagesRequestSchema.parse({ model: 'source', stream: true, max_tokens: 50, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'image_1', name: 'read', input: {} }] },
      { role: 'system', content: [{ type: 'text', text: 'Current workspace instructions' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }] },
    ] });
    const call = toLanguageModelCall(request, {}, undefined);
    expect(call.prompt[1]).toEqual({ role: 'system', content: 'Current workspace instructions' });
    expect(call.prompt[2].content[0].output).toEqual({ type: 'content', value: [{ type: 'image-data', data: 'aGVsbG8=', mediaType: 'image/png' }] });
  });

  it('keeps encrypted reasoning on the source side without inventing Claude signatures', async () => {
    const history = new Map();
    const emitted = [];
    const metadata = { openai: { reasoningEncryptedContent: 'opaque-state' } };
    await translateModelStream(stream([
      { type: 'reasoning-start', id: 'r1' }, { type: 'reasoning-delta', id: 'r1', delta: 'summary' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: metadata },
      { type: 'finish', finishReason: { unified: 'stop' }, usage },
    ]), { emit: async (event) => emitted.push(event), modelID: 'gpt', reasoningHistory: history });
    expect(emitted.some((event) => event.delta?.type === 'signature_delta')).toBe(false);
    const call = toLanguageModelCall({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'summary' }] }], max_tokens: 50 }, {}, undefined, history);
    expect(call.prompt[0].content[0].providerOptions).toEqual(metadata);
  });

  it('removes internal headers and keeps native provider options and stateless reasoning', () => {
    const call = cleanSourceCall({
      headers: { [EXECUTION_HEADER]: 'enabled', [CONTEXT_HEADER]: 'private-directory', 'x-custom': 'value' },
      providerOptions: { openai: { reasoningEffort: 'high' } },
      prompt: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'summary', providerOptions: { openai: { itemId: 'old-id', reasoningEncryptedContent: 'opaque' } } }] }],
    }, 'responses', 'openai');
    expect(call.headers).toEqual({ 'x-custom': 'value' });
    expect(call.providerOptions.openai).toMatchObject({ store: false, forceReasoning: true, reasoningEffort: 'high' });
    expect(call.prompt[0].content[0].providerOptions.openai).toEqual({ reasoningEncryptedContent: 'opaque' });
  });
});

describe('execution routing hooks', () => {
  const model = { providerID: 'openai', id: 'gpt', api: { id: 'gpt', npm: '@ai-sdk/openai' }, options: {}, limit: { context: 100000 } };

  it('preserves model identity and captures the switch once per submitted message', async () => {
    let enabled = true;
    let reads = 0;
    const hooks = createExecutionHooks({ directory: '/project' }, { readEnabled: async () => { reads++; return enabled; }, onStop: async () => {} });
    const wrapped = wrapModels({ models: { gpt: model } }).gpt;
    expect(wrapped.id).toBe('gpt');
    expect(wrapped.api.npm).toContain('openai-provider.js');
    const input = { sessionID: 's1', agent: 'build', message: { id: 'm1' }, model: wrapped };
    const first = { headers: {} };
    await hooks['chat.headers'](input, first);
    enabled = false;
    const continuation = { headers: {} };
    await hooks['chat.headers'](input, continuation);
    expect(continuation.headers[EXECUTION_HEADER]).toBe('enabled');
    expect(reads).toBe(1);
    const next = { headers: {} };
    await hooks['chat.headers']({ ...input, message: { id: 'm2' } }, next);
    expect(next.headers[EXECUTION_HEADER]).toBe('disabled');
  });

  it('wraps a logged-in provider by its model protocol instead of its provider name', async () => {
    const plugin = await LoggedInProviderExecution({}, { providerID: 'zai-coding-plan' });
    const models = await plugin.provider.models({
      models: {
        glm: { ...model, providerID: 'zai-coding-plan', id: 'glm', api: { id: 'glm', npm: '@ai-sdk/openai-compatible' } },
      },
    });
    expect(plugin.provider.id).toBe('zai-coding-plan');
    expect(models.glm.api.npm).toContain('compatible-provider.js');
  });

  it('fails closed for unsupported providers and for failed setting reads', async () => {
    const hooks = createExecutionHooks({ directory: '/project' }, { readEnabled: async () => true });
    await expect(hooks['chat.headers']({ sessionID: 's', message: { id: 'm' }, model: { ...model, api: { npm: 'unsupported-sdk' } } }, { headers: {} })).rejects.toThrow('not supported');
    const failed = createExecutionHooks({ directory: '/project' }, { readEnabled: async () => { throw new Error('read failed'); } });
    await expect(failed['chat.headers']({ sessionID: 's', message: { id: 'm' } }, { headers: {} })).rejects.toThrow('read failed');
  });

  it('cleans only the session whose authoritative status becomes idle', async () => {
    const stopped = [];
    const hooks = createExecutionHooks({ directory: '/project' }, { onStop: async (id) => stopped.push(id) });
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'a', status: { type: 'busy' } } } });
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'b', status: { type: 'idle' } } } });
    expect(stopped).toEqual(['b']);
  });
});
