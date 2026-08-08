import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };
type ClientConfig = { baseUrl?: string; directory?: string; fetch?: unknown };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;
const createdClientConfigs: ClientConfig[] = [];
const callOrder: string[] = [];
const promptAsyncCalls: unknown[][] = [];
const promptAsyncResults: unknown[] = [];
const switchAgentCalls: unknown[][] = [];
const switchAgentResults: unknown[] = [];
const switchModelCalls: unknown[][] = [];
const switchModelResults: unknown[] = [];
const durablePromptCalls: unknown[][] = [];
const durablePromptResults: unknown[] = [];
const historyCalls: unknown[][] = [];
const historyResults: unknown[] = [];
const nextMessagesCalls: unknown[][] = [];
const nextMessagesResults: unknown[] = [];
const sessionStatusCalls: unknown[][] = [];
let sessionStatusResult: unknown = { data: {} };
const sessionActiveCalls: unknown[][] = [];
let sessionActiveResult: unknown = { data: { data: {} } };

const nextResult = (results: unknown[], fallback: unknown): unknown => {
  const next = results.shift();
  if (next instanceof Error) throw next;
  return next ?? fallback;
};

const configuredResult = (result: unknown, args: unknown[]): unknown => (
  typeof result === 'function' ? (result as (...input: unknown[]) => unknown)(...args) : result
);

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const promptAsyncMock = mock(async (...args: unknown[]) => {
  callOrder.push('promptAsync');
  promptAsyncCalls.push(args);
  return nextResult(promptAsyncResults, { response: new Response(null, { status: 200 }) });
});

const switchAgentMock = mock(async (...args: unknown[]) => {
  callOrder.push('switchAgent');
  switchAgentCalls.push(args);
  return nextResult(switchAgentResults, { response: new Response(null, { status: 204 }) });
});

const switchModelMock = mock(async (...args: unknown[]) => {
  callOrder.push('switchModel');
  switchModelCalls.push(args);
  return nextResult(switchModelResults, { response: new Response(null, { status: 204 }) });
});

const durablePromptMock = mock(async (...args: unknown[]) => {
  callOrder.push('prompt');
  durablePromptCalls.push(args);
  const request = args[0] as {
    sessionID?: string;
    id?: string;
    prompt?: unknown;
    delivery?: 'steer' | 'queue';
  };
  return nextResult(durablePromptResults, {
    data: {
      data: {
        admittedSeq: 1,
        id: request.id,
        sessionID: request.sessionID,
        prompt: request.prompt,
        delivery: request.delivery,
        timeCreated: 1,
      },
    },
  });
});

const historyMock = mock(async (...args: unknown[]) => {
  callOrder.push('history');
  historyCalls.push(args);
  return nextResult(historyResults, {
    data: {
      data: [],
      hasMore: false,
    },
  });
});

const nextMessagesMock = mock(async (...args: unknown[]) => {
  callOrder.push('nextMessages');
  nextMessagesCalls.push(args);
  return nextResult(nextMessagesResults, {
    data: {
      data: [],
      cursor: {},
    },
  });
});

const sessionActiveMock = mock(async (...args: unknown[]) => {
  sessionActiveCalls.push(args);
  return configuredResult(sessionActiveResult, args);
});

const createOpencodeClientMock = mock((config: ClientConfig) => {
  createdClientConfigs.push(config);
  return {
    config: {
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    session: {
      promptAsync: promptAsyncMock,
      status: mock(async (...args: unknown[]) => {
        sessionStatusCalls.push(args);
        return configuredResult(sessionStatusResult, args);
      }),
    },
    v2: {
      session: {
        switchAgent: switchAgentMock,
        switchModel: switchModelMock,
        prompt: durablePromptMock,
        history: historyMock,
        messages: nextMessagesMock,
        active: sessionActiveMock,
      },
    },
  };
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

let runtimeKey = 'test-runtime';
let runtimeGeneration = 0;
class TestRuntimeContextChangedError extends Error {
  constructor() {
    super('Runtime changed before operation dispatch');
    this.name = 'RuntimeContextChangedError';
  }
}

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeEndpointGeneration: mock(() => runtimeGeneration),
  getRuntimeKey: mock(() => runtimeKey),
  RuntimeContextChangedError: TestRuntimeContextChangedError,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  runtimeKey = 'test-runtime';
  runtimeGeneration = 0;
  configCalls = 0;
  configResolvers.length = 0;
  createdClientConfigs.length = 0;
  callOrder.length = 0;
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
  switchAgentCalls.length = 0;
  switchAgentResults.length = 0;
  switchModelCalls.length = 0;
  switchModelResults.length = 0;
  durablePromptCalls.length = 0;
  durablePromptResults.length = 0;
  historyCalls.length = 0;
  historyResults.length = 0;
  nextMessagesCalls.length = 0;
  nextMessagesResults.length = 0;
  sessionStatusCalls.length = 0;
  sessionStatusResult = { data: {} };
  sessionActiveCalls.length = 0;
  sessionActiveResult = { data: { data: {} } };
  opencodeClient.clearConfigCache();
});

describe('opencodeClient session status', () => {
  test('forwards the directory and one bounded signal to both status endpoints', async () => {
    const controller = new AbortController();

    await opencodeClient.getSessionStatusForDirectory('/workspace/project', { signal: controller.signal });

    const legacySignal = (sessionStatusCalls[0]?.[1] as { signal?: AbortSignal })?.signal;
    const activeSignal = (sessionActiveCalls[0]?.[0] as { signal?: AbortSignal })?.signal;
    expect(sessionStatusCalls[0]?.[0]).toEqual({ directory: '/workspace/project' });
    expect(legacySignal).toBeInstanceOf(AbortSignal);
    expect(activeSignal).toBe(legacySignal);
    expect(legacySignal).not.toBe(controller.signal);
  });

  test('returns unknown after the bounded status request aborts a half-open endpoint', async () => {
    let observedSignal: AbortSignal | undefined;
    sessionStatusResult = (...args: unknown[]) => new Promise((resolve) => {
      observedSignal = (args[1] as { signal?: AbortSignal })?.signal;
      const finish = () => resolve({ error: new Error('aborted') });
      if (observedSignal?.aborted) finish();
      else observedSignal?.addEventListener('abort', finish, { once: true });
    });

    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project', { timeoutMs: 5 })).toBeNull();
    expect(observedSignal?.aborted).toBe(true);
  });

  test('aborts the sibling status request when one endpoint rejects immediately', async () => {
    let siblingSignal: AbortSignal | undefined;
    sessionStatusResult = () => {
      throw new Error('legacy rejected');
    };
    sessionActiveResult = (...args: unknown[]) => new Promise((resolve) => {
      siblingSignal = (args[0] as { signal?: AbortSignal })?.signal;
      const finish = () => resolve({ error: new Error('aborted') });
      if (siblingSignal?.aborted) finish();
      else siblingSignal?.addEventListener('abort', finish, { once: true });
    });

    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();
    expect(siblingSignal?.aborted).toBe(true);
  });

  test('merges live V2 running sessions with legacy status while preserving retry details', async () => {
    sessionStatusResult = {
      data: {
        ses_idle: { type: 'idle' },
        ses_retry: { type: 'retry', attempt: 2, message: 'waiting', next: 123 },
      },
    };
    sessionActiveResult = {
      data: {
        data: {
          ses_idle: { type: 'running' },
          ses_retry: { type: 'running' },
          ses_v2: { type: 'running' },
        },
      },
    };

    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toEqual({
      ses_idle: { type: 'busy' },
      ses_retry: { type: 'retry', attempt: 2, message: 'waiting', next: 123 },
      ses_v2: { type: 'busy' },
    });
  });

  test('rejects malformed payloads instead of treating them as authoritative empty state', async () => {
    sessionStatusResult = { data: [] };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();

    sessionStatusResult = { data: { error: { message: 'upstream failed' } } };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();

    sessionStatusResult = { data: { ses_retry: { type: 'retry', attempt: '1' } } };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();

    sessionStatusResult = { data: {} };
    sessionActiveResult = { data: { data: { ses_bad: { type: 'stale' } } } };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();
  });

  test('preserves prior authority when either live status endpoint fails', async () => {
    sessionActiveResult = { error: { message: 'unavailable' }, response: { status: 503 } };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();

    sessionActiveResult = { data: { data: {} } };
    sessionStatusResult = { error: { message: 'unavailable' }, response: { status: 503 } };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();
  });
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('opencodeClient session input history', () => {
  const durableEvent = (input: {
    type: 'session.next.prompt.admitted' | 'session.next.prompted';
    seq: number;
    messageID: string;
    text: string;
  }) => ({
    type: input.type,
    durable: { aggregateID: 'ses_history', seq: input.seq, version: 1 },
    data: {
      timestamp: input.seq * 1000,
      sessionID: 'ses_history',
      messageID: input.messageID,
      prompt: { text: input.text },
      delivery: 'queue',
    },
  });

  test('pages admission history and marks promoted inputs without treating gaps as empty success', async () => {
    historyResults.push(
      {
        data: {
          data: [
            durableEvent({ type: 'session.next.prompt.admitted', seq: 10, messageID: 'msg-a', text: 'first' }),
            durableEvent({ type: 'session.next.prompted', seq: 20, messageID: 'msg-a', text: 'first' }),
            durableEvent({ type: 'session.next.prompt.admitted', seq: 30, messageID: 'msg-b', text: 'second' }),
          ],
          hasMore: true,
        },
      },
      {
        data: {
          data: [
            durableEvent({ type: 'session.next.prompted', seq: 40, messageID: 'msg-b', text: 'second' }),
            durableEvent({ type: 'session.next.prompt.admitted', seq: 50, messageID: 'msg-c', text: 'third' }),
          ],
          hasMore: false,
        },
      },
    );

    const result = await opencodeClient.loadSessionInputAdmissionHistory({
      sessionID: 'ses_history',
      directory: '/workspace/history',
      limit: 100,
    });

    expect(result.complete).toBe(true);
    expect(result.admissions).toEqual([
      {
        admittedSeq: 10,
        id: 'msg-a',
        sessionID: 'ses_history',
        prompt: { text: 'first' },
        delivery: 'queue',
        timeCreated: 10_000,
        promotedSeq: 20,
      },
      {
        admittedSeq: 30,
        id: 'msg-b',
        sessionID: 'ses_history',
        prompt: { text: 'second' },
        delivery: 'queue',
        timeCreated: 30_000,
        promotedSeq: 40,
      },
      {
        admittedSeq: 50,
        id: 'msg-c',
        sessionID: 'ses_history',
        prompt: { text: 'third' },
        delivery: 'queue',
        timeCreated: 50_000,
      },
    ]);
    expect(historyCalls).toEqual([
      [{ sessionID: 'ses_history', limit: 100 }],
      [{ sessionID: 'ses_history', limit: 100, after: 30 }],
    ]);
    expect(createdClientConfigs[0]?.directory).toBe('/workspace/history');
  });

  test('loads the projected V2 tail newest-first request and returns it chronologically', async () => {
    nextMessagesResults.push({
      data: {
        data: [
          {
            id: 'msg-new',
            type: 'user',
            text: 'newest',
            time: { created: 2000 },
          },
          {
            id: 'msg-old',
            type: 'user',
            text: 'oldest',
            time: { created: 1000 },
          },
        ],
        cursor: {},
      },
    });

    const page = await opencodeClient.loadSessionNextMessages({
      sessionID: 'ses_history',
      directory: '/workspace/history',
      limit: 50,
    });

    expect(nextMessagesCalls).toEqual([[{ sessionID: 'ses_history', limit: 50, order: 'desc' }]]);
    expect(page.messages.map((message: { id: string }) => message.id)).toEqual(['msg-old', 'msg-new']);
    expect(page.cursor).toBe(undefined);
  });

  test('returns cursor.next so the shared loader can page without repeating order', async () => {
    const shared = { id: 'msg-shared', type: 'user', text: 'shared', time: { created: 2000 } };
    nextMessagesResults.push(
      {
        data: {
          data: [
            { id: 'msg-new', type: 'user', text: 'new', time: { created: 3000 } },
            shared,
          ],
          cursor: { next: 'cursor-older' },
        },
      },
      {
        data: {
          data: [
            shared,
            { id: 'msg-old', type: 'user', text: 'old', time: { created: 1000 } },
          ],
          cursor: {},
        },
      },
    );

    const first = await opencodeClient.loadSessionNextMessages({
      sessionID: 'ses_history',
      directory: '/workspace/history',
      limit: 4,
    });
    const second = await opencodeClient.loadSessionNextMessages({
      sessionID: 'ses_history',
      directory: '/workspace/history',
      limit: 4,
      cursor: first.cursor,
    });

    expect(nextMessagesCalls).toEqual([
      [{ sessionID: 'ses_history', limit: 4, order: 'desc' }],
      [{ sessionID: 'ses_history', limit: 4, cursor: 'cursor-older' }],
    ]);
    expect(first.messages.map((message: { id: string }) => message.id)).toEqual(['msg-shared', 'msg-new']);
    expect(first.cursor).toBe('cursor-older');
    expect(second.messages.map((message: { id: string }) => message.id)).toEqual(['msg-old', 'msg-shared']);
    expect(second.cursor).toBe(undefined);
  });

  test('clamps each V2 messages page to the official 200-record limit', async () => {
    nextMessagesResults.push({ data: { data: [], cursor: {} } });

    await opencodeClient.loadSessionNextMessages({
      sessionID: 'ses_history',
      limit: 500,
    });

    expect(nextMessagesCalls).toEqual([[{ sessionID: 'ses_history', limit: 200, order: 'desc' }]]);
  });

  test('rejects a cursor that points back to the same V2 page', async () => {
    nextMessagesResults.push({
      data: {
        data: [{ id: 'msg-old', type: 'user', text: 'old', time: { created: 1000 } }],
        cursor: { next: 'cursor-repeat' },
      },
    });

    await expect(opencodeClient.loadSessionNextMessages({
      sessionID: 'ses_history',
      cursor: 'cursor-repeat',
    })).rejects.toThrow('invalid pagination cursor');
    expect(nextMessagesCalls).toHaveLength(1);
  });

  test('returns an incomplete projection instead of pretending a bounded scan is authoritative empty', async () => {
    historyResults.push({
      data: {
        data: [durableEvent({ type: 'session.next.prompt.admitted', seq: 10, messageID: 'msg-a', text: 'first' })],
        hasMore: true,
      },
    });

    const result = await opencodeClient.loadSessionInputAdmissionHistory({
      sessionID: 'ses_history',
      maxPages: 1,
    });

    expect(result.complete).toBe(false);
    expect(result.admissions.map((admission: { id: string }) => admission.id)).toEqual(['msg-a']);
  });
});

describe('opencodeClient follow-up delivery', () => {
  test('rejects queue delivery before touching either OpenCode execution engine', async () => {
    await expect(opencodeClient.sendMessage({
      id: 'ses_queue',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      text: 'queue this',
      delivery: 'queue',
    })).rejects.toThrow('Queue delivery must be handled by the OpenChamber follow-up queue');

    expect(callOrder).toEqual([]);
    expect(promptAsyncCalls).toHaveLength(0);
    expect(switchAgentCalls).toHaveLength(0);
    expect(switchModelCalls).toHaveLength(0);
    expect(durablePromptCalls).toHaveLength(0);
  });

  test('routes steer through ordinary promptAsync with the normalized directory and body', async () => {
    await opencodeClient.sendMessage({
      id: 'ses_steer',
      providerID: 'openai',
      modelID: 'gpt-5',
      agent: 'build',
      variant: 'high',
      text: 'redirect now',
      messageId: 'msg_steer',
      delivery: 'steer',
      directory: 'd:\\workspace\\project\\',
    });

    expect(callOrder).toEqual(['promptAsync']);
    expect(promptAsyncCalls).toEqual([[
      {
        sessionID: 'ses_steer',
        directory: 'D:/workspace/project',
        model: { providerID: 'openai', modelID: 'gpt-5' },
        agent: 'build',
        variant: 'high',
        messageID: 'msg_steer',
        parts: [{ type: 'text', text: 'redirect now' }],
      },
    ]]);
    expect(switchAgentCalls).toHaveLength(0);
    expect(switchModelCalls).toHaveLength(0);
    expect(durablePromptCalls).toHaveLength(0);
  });

  test('keeps steer structured and synthetic payload semantics identical to ordinary sends', async () => {
    await opencodeClient.sendMessage({
      id: 'ses_steer_body',
      providerID: 'openai-steer-body',
      modelID: 'gpt-5',
      text: 'visible',
      prefaceText: 'synthetic context',
      messageId: 'msg_steer_body',
      delivery: 'steer',
      format: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(promptAsyncCalls[0]?.[0]).toEqual({
      sessionID: 'ses_steer_body',
      model: { providerID: 'openai-steer-body', modelID: 'gpt-5' },
      agent: undefined,
      variant: undefined,
      messageID: 'msg_steer_body',
      format: { type: 'json_schema', schema: { type: 'object' } },
      parts: [
        { type: 'text', text: 'synthetic context', synthetic: true },
        { type: 'text', text: 'visible' },
      ],
    });
    expect(durablePromptCalls).toHaveLength(0);
  });

  test('dispatches concurrent steer sends without the V2 delivery serialization queue', async () => {
    const firstResponse = createDeferred<unknown>();
    const secondResponse = createDeferred<unknown>();
    promptAsyncResults.push(firstResponse.promise, secondResponse.promise);

    const first = opencodeClient.sendMessage({
      id: 'ses_concurrent_steer',
      providerID: 'openai-steer-first',
      modelID: 'gpt-5',
      text: 'first',
      delivery: 'steer',
    });
    const second = opencodeClient.sendMessage({
      id: 'ses_concurrent_steer',
      providerID: 'openai-steer-second',
      modelID: 'gpt-5',
      text: 'second',
      delivery: 'steer',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promptAsyncCalls).toHaveLength(2);
    expect(switchModelCalls).toHaveLength(0);
    expect(durablePromptCalls).toHaveLength(0);

    firstResponse.resolve({ response: new Response(null, { status: 200 }) });
    secondResponse.resolve({ response: new Response(null, { status: 200 }) });
    await Promise.all([first, second]);
  });

  test('keeps steer promptAsync error semantics identical to ordinary sends', async () => {
    promptAsyncResults.push({ response: new Response('unavailable', { status: 503 }) });

    await expect(opencodeClient.sendMessage({
      id: 'ses_steer_failure',
      providerID: 'openai-steer-failure',
      modelID: 'gpt-5',
      text: 'hello',
      delivery: 'steer',
    })).rejects.toThrow('Failed to send message (503): unavailable');

    expect(promptAsyncCalls).toHaveLength(1);
    expect(durablePromptCalls).toHaveLength(0);
  });

});

describe('opencodeClient non-delivery promptAsync', () => {
  const sendPrompt = (providerID = 'anthropic') => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    agent: 'build',
    variant: 'high',
    text: 'hello',
    messageId: 'msg_async',
  });

  test('keeps ordinary sends on promptAsync with the existing payload', async () => {
    await sendPrompt();

    expect(promptAsyncCalls).toEqual([[
      {
        sessionID: 'ses_1',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
        agent: 'build',
        variant: 'high',
        messageID: 'msg_async',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]]);
    expect(switchAgentCalls).toHaveLength(0);
    expect(switchModelCalls).toHaveLength(0);
    expect(durablePromptCalls).toHaveLength(0);
  });

  test('does not retry 504 prompt responses because the POST may already be accepted', async () => {
    promptAsyncResults.push({ response: new Response('gateway timeout', { status: 504 }) });

    await expect(sendPrompt('anthropic-504')).rejects.toThrow('Failed to send message (504)');

    expect(promptAsyncCalls).toHaveLength(1);
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    promptAsyncResults.push(new TypeError('Failed to fetch'));

    await expect(sendPrompt('anthropic-network')).rejects.toThrow('Failed to fetch');

    expect(promptAsyncCalls).toHaveLength(1);
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure', async () => {
    promptAsyncResults.push({
      error: new TypeError('relay tunnel reset: plaintext frame on established channel'),
      response: undefined,
    });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls).toHaveLength(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('transport failure');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('records late failures against the runtime that dispatched the request', async () => {
    const providerID = 'anthropic-runtime-lane';
    const deferred = Array.from({ length: 3 }, () => createDeferred<unknown>());
    promptAsyncResults.push(...deferred.map((entry) => entry.promise));

    const sends = deferred.map(() => sendPrompt(providerID));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptAsyncCalls).toHaveLength(3);

    runtimeKey = 'runtime-b';
    runtimeGeneration += 1;
    for (const entry of deferred) {
      entry.resolve({ response: new Response('unavailable', { status: 503 }) });
    }
    await Promise.allSettled(sends);

    await sendPrompt(providerID);
    expect(promptAsyncCalls).toHaveLength(4);
  });

  test('does not dispatch after the runtime changes while preparing attachments', async () => {
    runtimeKey = 'runtime-a';
    const pending = opencodeClient.sendMessage({
      id: 'ses_runtime_race',
      providerID: 'runtime-race-provider',
      modelID: 'model-a',
      text: 'hello',
      runtimeKey: 'runtime-a',
      files: [{
        type: 'file',
        mime: 'text/markdown',
        filename: 'notes.md',
        url: 'data:text/markdown,hello',
      }],
    });

    runtimeKey = 'runtime-b';

    let error: unknown = null;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain('runtime changed');
    expect(promptAsyncCalls).toHaveLength(0);
  });
});
