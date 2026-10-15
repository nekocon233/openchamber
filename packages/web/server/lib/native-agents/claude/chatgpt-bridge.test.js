import { afterEach, describe, expect, it } from 'vitest';
import { createChatgptBridge } from './chatgpt-bridge.js';

const bridges = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.shutdown(); });
const response = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const events = [
  { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'Hello' },
  { type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } } },
];
const create = (fetchImpl) => {
  const bridge = createChatgptBridge({ auth: { accessToken: async (id) => `test-token-${id}` }, fetchImpl, retryDelay: () => 1 });
  bridges.push(bridge); return bridge;
};
const send = (grant, patch = {}, headers = {}) => fetch(`${grant.baseURL}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': grant.token, ...headers },
  body: JSON.stringify({ model: 'gpt-fixture', messages: [{ role: 'user', content: 'Hello' }], ...patch }),
});
const replayEvents = (label) => {
  const output = [
    { type: 'reasoning', id: `rs-${label}`, encrypted_content: `encrypted-${label}`, summary: [] },
    { type: 'message', id: `m-${label}`, phase: 'final_answer', content: [{ type: 'output_text', text: label }] },
  ];
  return [
    ...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
    { type: 'response.completed', response: { id: `r-${label}`, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } } },
  ];
};

describe('ChatGPT loopback bridge', () => {
  it.each([false, true])('restores state on a new bridge and grant from a %s streaming reply', async (streaming) => {
    const calls = [];
    const fetchImpl = async (_url, options) => { calls.push(JSON.parse(options.body)); return response(replayEvents('Hello')); };
    const first = create(fetchImpl);
    const grant = await first.acquire('account', 'gpt-fixture');
    const result = await send(grant, { stream: streaming });
    let content;
    if (streaming) {
      const frames = (await result.text()).split(/\r?\n\r?\n/).filter(Boolean).map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith('data:')).slice(5)));
      const carrier = frames.find((frame) => frame.content_block?.type === 'redacted_thinking').content_block;
      content = [{ type: 'text', text: frames.filter((frame) => frame.delta?.type === 'text_delta').map((frame) => frame.delta.text).join('') }, carrier];
    } else content = (await result.json()).content;
    grant.dispose();
    await first.shutdown();
    const next = await create(fetchImpl).acquire('account', 'gpt-fixture');
    expect((await send(next, { messages: [{ role: 'assistant', content }, { role: 'user', content: 'Continue.' }] })).status).toBe(200);
    expect(calls[1].input.slice(0, 2)).toEqual([
      replayEvents('Hello')[0].item,
      { type: 'message', role: 'assistant', id: 'm-Hello', phase: 'final_answer', content: [{ type: 'output_text', text: 'Hello' }] },
    ]);
    expect(calls[1].include).toContain('reasoning.encrypted_content');
  });

  it('keeps simultaneous parent and child histories independent on the same grant', async () => {
    const calls = [];
    const bridge = create(async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const prompt = body.input.find((item) => item.role === 'user');
      return response(replayEvents(prompt.content));
    });
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const labels = ['parent', 'child'];
    const replies = await Promise.all(labels.map(async (label) => (await (await send(grant, { messages: [{ role: 'user', content: label }] })).json()).content));
    await Promise.all(labels.map((label, i) => send(grant, { messages: [{ role: 'user', content: label }, { role: 'assistant', content: replies[i] }] })));
    for (const call of calls.slice(2)) {
      const label = call.input[0].content;
      expect(call.input.filter((item) => item.type === 'reasoning').map((item) => item.id)).toEqual([`rs-${label}`]);
    }
  });

  it('permits image input only when the grant carries the model capability', async () => {
    const requests = [];
    const bridge = create(async (_url, options) => { requests.push(JSON.parse(options.body)); return response(events); });
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'aW1hZ2U=' } };
    const messages = [{ role: 'user', content: [image] }];
    const visual = await bridge.acquire('account', 'gpt-fixture', 'max', true);
    const textOnly = await bridge.acquire('account', 'gpt-fixture', 'max');
    expect((await send(textOnly, { messages, supportsImages: true })).status).toBe(400);
    expect(requests).toHaveLength(0);
    expect((await send(visual, { messages })).status).toBe(200);
    expect(requests[0]).toMatchObject({
      reasoning: { effort: 'max' },
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/gif;base64,aW1hZ2U=', detail: 'auto' }] }],
    });
    expect(requests[0]).not.toHaveProperty('max_output_tokens');
    visual.dispose();
    expect((await send(visual, { messages })).status).toBe(401);
  });

  it('keeps effort choices isolated per grant and omits reasoning for Default', async () => {
    const requests = [];
    const bridge = create(async (_url, options) => { requests.push(JSON.parse(options.body)); return response(events); });
    const grants = await Promise.all(['max', 'low', null].map((effort) => bridge.acquire('account', 'gpt-fixture', effort)));
    for (const grant of grants) expect((await send(grant, { output_config: { effort: 'high' } })).status).toBe(200);
    expect((await send(grants[0], { output_config: { effort: 'low' } })).status).toBe(200);
    expect(requests.map((request) => request.reasoning)).toEqual([{ effort: 'max' }, { effort: 'low' }, undefined, { effort: 'max' }]);
  });

  it('keeps account credentials on the upstream side and supports non-streaming callers', async () => {
    const calls = [];
    const bridge = create(async (url, options) => { calls.push({ url, options }); return response(events); });
    const first = await bridge.acquire('first', 'gpt-fixture');
    const second = await bridge.acquire('second', 'gpt-fixture');
    const results = await Promise.all([send(first), send(second)]);
    expect((await results[0].json()).content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(calls.map((call) => call.options.headers.Authorization)).toEqual(['Bearer test-token-first', 'Bearer test-token-second']);
    expect(calls.every((call) => call.url === 'https://api.openai.com/v1/responses')).toBe(true);
    expect(first.token).not.toContain('test-token');
    expect(JSON.parse(calls[0].options.body)).toMatchObject({ store: false, stream: true });
    first.dispose();
    expect((await send(first)).status).toBe(401);
    expect((await send(second)).status).toBe(200);
  });

  it('normalizes cached usage for JSON and SSE callers', async () => {
    const cachedEvents = [events[0], {
      type: 'response.completed',
      response: { id: 'r', status: 'completed', usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } } },
    }];
    const bridge = create(async () => response(cachedEvents));
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const expected = { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 };
    expect((await (await send(grant)).json()).usage).toEqual(expected);
    const text = await (await send(grant, { stream: true })).text();
    const frame = text.split(/\r?\n\r?\n/).find((entry) => entry.startsWith('event: message_delta'));
    const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:')).slice(5).trimStart();
    expect(JSON.parse(data).usage).toEqual(expected);
  });

  it('rejects browser origins, model changes, missing grants and unsupported token counting', async () => {
    const bridge = create(async () => response(events));
    const grant = await bridge.acquire('account', 'gpt-fixture');
    expect((await send(grant, {}, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send(grant, { model: 'other' })).status).toBe(403);
    expect((await send(grant, {}, { 'x-api-key': 'wrong' })).status).toBe(401);
    expect((await fetch(`${grant.baseURL}/v1/messages/count_tokens`, { method: 'POST', headers: { 'x-api-key': grant.token } })).status).toBe(404);
  });

  it('sends an SSE error for an upstream failure after partial output, never message_stop', async () => {
    const bridge = create(async () => response([events[0], { type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]));
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const text = await (await send(grant, { stream: true })).text();
    expect(text).toContain('subscription_sharing_usage_limit_exceeded');
    expect(text).not.toContain('message_stop');
  });

  it('aborts active upstream requests on sign-out and leaves unrelated grants usable', async () => {
    let signal;
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const bridge = create(async (_url, options) => {
      signal = options.signal; ready();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted');
    });
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const pending = send(grant).catch(() => null);
    await started;
    bridge.revoke('account');
    expect(signal.aborted).toBe(true);
    await pending;
    expect((await send(grant)).status).toBe(401);
  });

  it('does not forward upstream error bodies that might echo a token', async () => {
    const bridge = create(async () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible', message: 'Rejected test-token-account' } }), { status: 403 }));
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const result = await send(grant);
    expect(result.status).toBe(403);
    const body = await result.text();
    expect(body).toContain('subscription_sharing_user_not_eligible');
    expect(body).not.toContain('test-token-account');
  });

  it('recovers from a transient rejection within the same send', async () => {
    let calls = 0;
    const bridge = create(async () => { calls += 1; return calls === 1 ? new Response('overloaded', { status: 507 }) : response(events); });
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const result = await send(grant);
    expect(result.status).toBe(200);
    expect((await result.json()).content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(calls).toBe(2);
  });

  it('retries a failed fetch, then gives up on the third transient failure with its status and request id', async () => {
    let calls = 0;
    const bridge = create(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response('{}', { status: 503, headers: { 'x-request-id': 'req-fixture', 'retry-after': '30' } });
    });
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const result = await send(grant);
    expect(result.status).toBe(503);
    expect(await result.text()).toContain('CHATGPT_UPSTREAM_REJECTED');
    expect(result.headers.get('x-request-id')).toBe('req-fixture');
    expect(calls).toBe(3);
  });

  it('does not retry rejections retrying cannot fix', async () => {
    let calls = 0;
    const bridge = create(async () => { calls += 1; return new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 }); });
    const grant = await bridge.acquire('account', 'gpt-fixture');
    const result = await send(grant);
    expect(result.status).toBe(400);
    expect(await result.text()).toContain('context_length_exceeded');
    expect(calls).toBe(1);
  });
});
