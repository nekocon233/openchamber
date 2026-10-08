import { describe, expect, it } from 'vitest';
import { toResponsesRequest, readResponsesEvents, createAnthropicStream } from './responses-protocol.js';
import { claudePromptBlocks } from '../prompt-parts.js';

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
  it('preserves uploaded text and image order through native prompt conversion', () => {
    const first = 'data:image/png;base64,aW1hZ2U=';
    const second = 'data:image/jpeg;base64,c2Vjb25k';
    const content = claudePromptBlocks([
      { type: 'text', text: 'Compare these images.' },
      { type: 'file', mime: 'image/png', url: first },
      { type: 'text', text: 'The second image follows.' },
      { type: 'file', mime: 'image/jpeg', url: second },
    ]);
    const body = toResponsesRequest({ ...request(), messages: [{ role: 'user', content }] }, 'gpt-fixture', 'high', true).body;
    expect(body.input).toEqual([
      { role: 'user', content: 'Compare these images.' },
      { role: 'user', content: [{ type: 'input_image', image_url: first, detail: 'auto' }] },
      { role: 'user', content: 'The second image follows.' },
      { role: 'user', content: [{ type: 'input_image', image_url: second, detail: 'auto' }] },
    ]);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('preserves images and error text returned by a function tool', () => {
    const content = [
      { type: 'text', text: 'Screenshot of the failed page' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'aW1hZ2U=' } },
      { type: 'text', text: 'End of screenshot' },
    ];
    const input = { ...request(), messages: [
      request().messages[1], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content }] },
    ] };
    expect(toResponsesRequest(input, 'gpt-fixture', null, true).body.input.at(-1)).toEqual({
      type: 'function_call_output', call_id: 'call_1', output: [
        { type: 'input_text', text: 'Tool execution failed:' },
        { type: 'input_text', text: 'Screenshot of the failed page' },
        { type: 'input_image', image_url: 'data:image/webp;base64,aW1hZ2U=', detail: 'auto' },
        { type: 'input_text', text: 'End of screenshot' },
      ],
    });
    expect(() => toResponsesRequest(input, 'gpt-fixture')).toThrow('does not support image input');
  });

  it('rejects images for text-only models, invalid image sources and non-user image messages', () => {
    const source = { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' };
    const withImage = (imageSource, role = 'user') => ({ ...request(), messages: [{ role, content: [{ type: 'image', source: imageSource }] }] });
    expect(() => toResponsesRequest(withImage(source), 'gpt-fixture')).toThrow('does not support image input');
    for (const invalid of [
      { ...source, data: 'not@base64' }, { ...source, data: '' },
      { ...source, media_type: 'image/svg+xml' },
      { type: 'url', url: 'https://example.test/image.png' },
    ]) expect(() => toResponsesRequest(withImage(invalid), 'gpt-fixture', null, true)).toThrow('CHATGPT_UNSUPPORTED_REQUEST');
    for (const role of ['assistant', 'system', 'developer']) {
      expect(() => toResponsesRequest(withImage(source, role), 'gpt-fixture', null, true)).toThrow('unsupported content');
    }
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('sends the selected %s effort independently of Claude output settings', (effort) => {
    const input = { ...request(), output_config: { effort: 'high' } };
    expect(toResponsesRequest(input, 'gpt-fixture', effort).body.reasoning).toEqual({ effort });
    expect(toResponsesRequest(input, 'gpt-fixture').body).not.toHaveProperty('reasoning');
  });

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
