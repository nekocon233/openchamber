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
  const bridge = createChatgptBridge({ auth: { accessToken: async (id) => `test-token-${id}` }, fetchImpl });
  bridges.push(bridge); return bridge;
};
const send = (grant, patch = {}, headers = {}) => fetch(`${grant.baseURL}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': grant.token, ...headers },
  body: JSON.stringify({ model: 'gpt-fixture', messages: [{ role: 'user', content: 'Hello' }], ...patch }),
});

describe('ChatGPT loopback bridge', () => {
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
});
