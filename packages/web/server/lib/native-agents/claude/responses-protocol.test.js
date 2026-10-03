import { describe, expect, it } from 'vitest';
import { toResponsesRequest, readResponsesEvents, createAnthropicStream } from './responses-protocol.js';

const request = () => ({
  model: 'gpt-fixture', stream: true, system: [{ type: 'text', text: 'Follow the project rules.', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: 'Read the file.' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning', signature: 'opaque' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/tmp/example' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'file text' }] }] },
  ],
  tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  max_tokens: 1000, temperature: 1, thinking: { type: 'adaptive' },
});
const done = (status = 'completed') => ({ type: `response.${status}`, response: { id: 'resp_1', status, usage: { input_tokens: 10, output_tokens: 4 } } });

describe('Responses translation', () => {
  it('sends stateless plan requests with namespace tools and complete tool history', () => {
    const { body, names } = toResponsesRequest(request(), 'gpt-fixture');
    expect(body).toMatchObject({ model: 'gpt-fixture', store: false, stream: true, instructions: 'Follow the project rules.' });
    expect(body.tools[0].type).toBe('namespace');
    const name = body.tools[0].tools[0].name;
    expect(names.get(name)).toBe('Read');
    expect(body.input).toEqual([
      { role: 'user', content: 'Read the file.' },
      { type: 'function_call', call_id: 'call_1', namespace: 'claude', name, arguments: '{"file_path":"/tmp/example"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
    ]);
    for (const field of ['max_tokens', 'max_output_tokens', 'temperature', 'previous_response_id', 'thinking']) expect(body).not.toHaveProperty(field);
    expect(JSON.stringify(body)).not.toContain('Private reasoning');
  });

  it('maps inline Claude system messages to developer messages', () => {
    const input = { ...request(), messages: [{ role: 'user', content: 'Hello' }, { role: 'system', content: [{ type: 'text', text: 'CLI instructions' }] }] };
    expect(toResponsesRequest(input, 'gpt-fixture').body.input).toEqual([
      { role: 'user', content: 'Hello' }, { role: 'developer', content: 'CLI instructions' },
    ]);
  });

  it('rejects unsupported attachments, hosted tools and a different selected model', () => {
    expect(() => toResponsesRequest({ ...request(), tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'gpt-fixture')).toThrow();
    expect(() => toResponsesRequest({ ...request(), messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }, 'gpt-fixture')).toThrow();
    expect(() => toResponsesRequest(request(), 'another-model')).toThrow();
  });

  it('streams text and multiple tool calls with stable IDs and no duplicate arguments', () => {
    const { body, names } = toResponsesRequest(request(), 'gpt-fixture');
    const name = body.tools[0].tools[0].name;
    const stream = createAnthropicStream({ model: 'gpt-fixture', names });
    const frames = [];
    frames.push(...stream.push({ type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: 'Reading.' }));
    frames.push(...stream.push({ type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Reading.' }] } }));
    for (const index of [1, 2]) {
      const item = { type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name, arguments: '{"file_path":"a"}' };
      frames.push(...stream.push({ type: 'response.output_item.added', output_index: index, item }));
      frames.push(...stream.push({ type: 'response.function_call_arguments.delta', item_id: item.id, delta: '{"file_path":' }));
      frames.push(...stream.push({ type: 'response.function_call_arguments.delta', item_id: item.id, delta: '"a"}' }));
      frames.push(...stream.push({ type: 'response.output_item.done', item }));
    }
    frames.push(...stream.push(done()));
    expect(frames.filter((frame) => frame.type === 'message_start')).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'content_block_stop')).toHaveLength(3);
    expect(frames.filter((frame) => frame.delta?.type === 'input_json_delta')).toHaveLength(4);
    expect(stream.result()).toMatchObject({ stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 } });
    expect(stream.result().content[1]).toEqual({ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a' } });
  });

  it('does not complete on interrupted streams, failed responses or unfinished tool arguments', () => {
    const { body, names } = toResponsesRequest(request(), 'gpt-fixture');
    const stream = createAnthropicStream({ model: 'gpt-fixture', names });
    stream.push({ type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Partial' });
    expect(() => stream.result()).toThrow('CHATGPT_STREAM_INTERRUPTED');
    expect(() => stream.push({ type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } } })).toThrow('subscription_sharing_usage_limit_exceeded');
    const incomplete = createAnthropicStream({ model: 'gpt-fixture', names });
    incomplete.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'f', call_id: 'c', name: body.tools[0].tools[0].name, arguments: '' } });
    expect(() => incomplete.push(done())).toThrow('CHATGPT_INCOMPLETE_TOOL_CALL');
  });

  it('parses fragmented UTF-8 and CRLF events and rejects malformed recognized events', async () => {
    const events = [{ type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: '你好' }, done()];
    const bytes = Buffer.from(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
    const chunks = async function* () { for (let index = 0; index < bytes.length; index++) yield bytes.subarray(index, index + 1); };
    const parsed = []; for await (const event of readResponsesEvents(chunks())) parsed.push(event);
    expect(parsed).toEqual(events);
    const malformed = async function* () { yield Buffer.from('data: {"type":"response.completed"}\n\n'); };
    await expect(async () => { for await (const event of readResponsesEvents(malformed())) void event; }).rejects.toThrow();
  });
});
