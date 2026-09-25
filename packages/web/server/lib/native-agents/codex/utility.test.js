import { describe, expect, it, vi } from 'vitest';

import { codexModels } from '../catalog.js';
import { createCodexUtility } from './utility.js';

const MODEL = 'gpt-5.6-luna';
const deferred = () => Promise.withResolvers();

const fixture = ({ startThread, startTurn, account = { type: 'chatgpt' } } = {}) => {
  const calls = [];
  let nextThread = 0;
  const utility = createCodexUtility({
    catalog: async () => codexModels({
      data: [{ id: MODEL, displayName: 'Luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
    }, new Map([[MODEL, 828_400]])),
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'account/read') return { account, requiresOpenaiAuth: true };
      if (method === 'config/read') return { config: { mcp_servers: { external: { command: 'external-mcp' } } } };
      if (method === 'thread/start') return startThread ? startThread() : { thread: { id: 'utility-' + ++nextThread } };
      if (method === 'turn/start') return startTurn ? startTurn(params, utility) : { turn: { id: 'turn-' + params.threadId } };
      return {};
    },
  });
  const finish = (threadId, text = 'Generated text', status = 'completed') => {
    utility.handleNotification('item/completed', { threadId, item: { type: 'agentMessage', id: 'answer', text, phase: 'final_answer' } });
    utility.handleNotification('turn/completed', { threadId, turn: { id: 'turn-' + threadId, status } });
  };
  return { utility, calls, finish };
};

const generate = (utility, overrides = {}) => utility.generate({ modelID: MODEL, effort: 'low', prompt: 'Summarize the supplied text', ...overrides });
const waitForTurn = (calls, count = 1) => vi.waitFor(() => expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(count));

describe('Codex utility calls', () => {
  it('uses Codex account and catalog state without requiring an OpenCode provider', async () => {
    const { utility } = fixture();
    expect(await utility.available()).toBe(true);
    expect(await utility.describe(MODEL)).toMatchObject({ id: MODEL, hasLogin: true, effort: 'low', contextWindow: 828_400 });
    await expect(utility.describe('missing')).rejects.toMatchObject({ code: 'codex-model-unavailable' });
    expect(await fixture({ account: null }).utility.available()).toBe(false);
  });

  it('returns only final text from an ephemeral thread with tools disabled', async () => {
    const { utility, calls, finish } = fixture();
    const result = generate(utility, { system: 'Return a short title', maxOutputTokens: 100 });
    await waitForTurn(calls);
    utility.handleNotification('item/completed', { threadId: 'utility-1', item: { type: 'agentMessage', id: 'progress', text: 'Thinking', phase: 'commentary' } });
    finish('utility-1', '  A short title  ');
    expect(await result).toBe('A short title');
    expect(calls.find((call) => call.method === 'thread/start').params).toMatchObject({
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      environments: [],
      config: {
        project_doc_max_bytes: 0,
        web_search: 'disabled',
        features: { shell_tool: false, multi_agent: false, plugins: false, apps: false, hooks: false },
        mcp_servers: { external: { enabled: false } },
      },
    });
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ method: 'thread/unsubscribe', params: { threadId: 'utility-1' } }));
    expect(utility.ownsRequest({ threadId: 'utility-1' })).toBe(false);
  });

  it('accepts a completion arriving before the turn/start reply and forwards the output schema', async () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
    const { utility, calls } = fixture({
      startTurn: (params, active) => {
        active.handleNotification('item/completed', { threadId: params.threadId, item: { type: 'agentMessage', id: 'answer', text: '{"title":"Example"}' } });
        active.handleNotification('turn/completed', { threadId: params.threadId, turn: { status: 'completed' } });
        return { turn: { id: 'turn-1' } };
      },
    });
    expect(JSON.parse(await generate(utility, { responseSchema: schema }))).toEqual({ title: 'Example' });
    expect(calls.find((call) => call.method === 'turn/start').params.outputSchema).toEqual(schema);
  });

  it('keeps concurrent requests and unrelated chat notifications independent', async () => {
    const { utility, calls, finish } = fixture();
    const first = generate(utility);
    const second = generate(utility);
    await waitForTurn(calls, 2);
    for (let i = 0; i < 1_000; i += 1) {
      expect(utility.handleNotification('item/agentMessage/delta', { threadId: 'chat-' + i, delta: 'text' })).toBe(false);
    }
    expect(utility.ownsRequest({ threadId: 'utility-1' })).toBe(true);
    expect(utility.ownsRequest({ threadId: 'chat-1' })).toBe(false);
    finish('utility-2', 'Second');
    finish('utility-1', 'First');
    expect(await Promise.all([first, second])).toEqual(['First', 'Second']);
  });

  it('does not start a request whose signal is already aborted', async () => {
    const { utility, calls } = fixture();
    await expect(generate(utility, { signal: AbortSignal.abort(new Error('Cancelled')) })).rejects.toThrow('Cancelled');
    expect(calls).toEqual([]);
  });

  it('returns at the deadline and releases a thread that starts afterward', async () => {
    const started = deferred();
    const { utility, calls } = fixture({ startThread: () => started.promise });
    const result = generate(utility, { timeoutMs: 20 });
    await expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    started.resolve({ thread: { id: 'late-thread' } });
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ method: 'thread/unsubscribe', params: { threadId: 'late-thread' } }));
    expect(calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('interrupts a turn whose start reply arrives after cancellation', async () => {
    const turn = deferred();
    const abort = new AbortController();
    const { utility, calls } = fixture({ startTurn: () => turn.promise });
    const result = generate(utility, { signal: abort.signal });
    const rejected = expect(result).rejects.toThrow('Cancelled');
    await waitForTurn(calls);
    abort.abort(new Error('Cancelled'));
    await rejected;
    turn.resolve({ turn: { id: 'late-turn' } });
    await vi.waitFor(() => expect(calls.at(-1)?.method).toBe('thread/unsubscribe'));
    expect(calls).toContainEqual({ method: 'turn/interrupt', params: { threadId: 'utility-1', turnId: 'late-turn' } });
  });

  it.each([
    ['failed', 'Some partial text', 'did not complete'],
    ['completed', '', 'no utility text'],
  ])('rejects %s output instead of returning an empty or partial success', async (status, text, message) => {
    const { utility, calls, finish } = fixture();
    const result = generate(utility);
    const rejected = expect(result).rejects.toThrow(message);
    await waitForTurn(calls);
    finish('utility-1', text, status);
    await rejected;
    await vi.waitFor(() => expect(calls.at(-1)?.method).toBe('thread/unsubscribe'));
  });

  it('rejects every running request when the app-server exits without restarting it for cleanup', async () => {
    const { utility, calls } = fixture();
    const results = Promise.allSettled([generate(utility), generate(utility)]);
    await waitForTurn(calls, 2);
    const count = calls.length;
    utility.handleExit(new Error('Connection closed'));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toHaveLength(count);
  });
});
