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
const sessionStatusCalls: unknown[][] = [];
let sessionStatusResult: unknown = { data: {} };

const nextResult = (results: unknown[], fallback: unknown): unknown => {
  const next = results.shift();
  if (next instanceof Error) throw next;
  return next ?? fallback;
};

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
        return sessionStatusResult;
      }),
    },
    v2: {
      session: {
        switchAgent: switchAgentMock,
        switchModel: switchModelMock,
        prompt: durablePromptMock,
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
  sessionStatusCalls.length = 0;
  sessionStatusResult = { data: {} };
  opencodeClient.clearConfigCache();
});

describe('opencodeClient session status', () => {
  test('forwards directory and abort signal through the SDK', async () => {
    const controller = new AbortController();

    await opencodeClient.getSessionStatusForDirectory('/workspace/project', { signal: controller.signal });

    expect(sessionStatusCalls).toEqual([
      [{ directory: '/workspace/project' }, { signal: controller.signal }],
    ]);
  });

  test('rejects malformed payloads instead of treating them as authoritative empty state', async () => {
    sessionStatusResult = { data: [] };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();

    sessionStatusResult = { data: { error: { message: 'upstream failed' } } };
    expect(await opencodeClient.getSessionStatusForDirectory('/workspace/project')).toBeNull();

    sessionStatusResult = { data: { ses_retry: { type: 'retry', attempt: '1' } } };
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

describe('opencodeClient official follow-up delivery', () => {
  test('serializes queued delivery after switching the selected agent and model', async () => {
    const messageId = await opencodeClient.sendMessage({
      id: 'ses_queue',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      variant: 'high',
      agent: 'build',
      text: 'primary',
      files: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==', filename: 'one.png' }],
      additionalParts: [{
        text: 'follow-up body',
        files: [{ type: 'file', mime: 'text/plain', url: 'file:///workspace/two.txt', filename: 'two.txt' }],
      }],
      agentMentions: [{ name: 'explore', source: { value: '@explore', start: 0, end: 8 } }],
      messageId: 'msg_queue',
      delivery: 'queue',
    });

    expect(messageId).toBe('msg_queue');
    expect(callOrder).toEqual(['switchAgent', 'switchModel', 'prompt']);
    expect(switchAgentCalls).toEqual([[{ sessionID: 'ses_queue', agent: 'build' }]]);
    expect(switchModelCalls).toEqual([[
      {
        sessionID: 'ses_queue',
        model: { id: 'claude-sonnet', providerID: 'anthropic', variant: 'high' },
      },
    ]]);
    expect(durablePromptCalls).toEqual([[
      {
        sessionID: 'ses_queue',
        id: 'msg_queue',
        prompt: {
          text: 'primary\n\nfollow-up body',
          files: [
            { uri: 'data:image/png;base64,AA==', name: 'one.png' },
            { uri: 'file:///workspace/two.txt', name: 'two.txt' },
          ],
          agents: [{
            name: 'explore',
            source: { text: '@explore', start: 0, end: 8 },
          }],
        },
        delivery: 'queue',
      },
    ]]);
    expect(promptAsyncCalls).toHaveLength(0);
  });

  test('serializes steer delivery through a directory-scoped SDK client', async () => {
    await opencodeClient.sendMessage({
      id: 'ses_steer',
      providerID: 'openai',
      modelID: 'gpt-5',
      text: 'redirect now',
      messageId: 'msg_steer',
      delivery: 'steer',
      directory: 'd:\\workspace\\project\\',
    });

    expect(createdClientConfigs).toHaveLength(1);
    expect(createdClientConfigs[0]?.directory).toBe('D:/workspace/project');
    expect(callOrder).toEqual(['switchModel', 'prompt']);
    expect(durablePromptCalls[0]?.[0]).toEqual({
      sessionID: 'ses_steer',
      id: 'msg_steer',
      prompt: { text: 'redirect now' },
      delivery: 'steer',
    });
  });

  test('rejects structured format and synthetic text before switching session configuration', async () => {
    await expect(opencodeClient.sendMessage({
      id: 'ses_format',
      providerID: 'anthropic-format',
      modelID: 'claude-sonnet',
      text: 'hello',
      delivery: 'queue',
      format: { type: 'json_schema', schema: { type: 'object' } },
    })).rejects.toThrow('does not support structured message format');

    await expect(opencodeClient.sendMessage({
      id: 'ses_synthetic',
      providerID: 'anthropic-synthetic',
      modelID: 'claude-sonnet',
      text: 'hello',
      delivery: 'steer',
      additionalParts: [{ text: 'hidden context', synthetic: true }],
    })).rejects.toThrow('does not support synthetic parts');

    await expect(opencodeClient.sendMessage({
      id: 'ses_synthetic_file',
      providerID: 'anthropic-synthetic-file',
      modelID: 'claude-sonnet',
      text: 'hello',
      delivery: 'queue',
      additionalParts: [{
        text: '',
        synthetic: true,
        files: [{ type: 'file', mime: 'text/plain', url: 'file:///workspace/context.txt' }],
      }],
    })).rejects.toThrow('does not support synthetic parts');

    expect(callOrder).toEqual([]);
  });

  test('preserves SDK transport error identity for ambiguous-send reconciliation', async () => {
    const transportError = new TypeError('Load failed');
    durablePromptResults.push({ error: transportError, response: undefined });

    let caught: unknown = null;
    try {
      await opencodeClient.sendMessage({
        id: 'ses_transport_failure',
        providerID: 'anthropic-durable-transport',
        modelID: 'claude-sonnet',
        text: 'hello',
        delivery: 'queue',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(transportError);
    expect(durablePromptCalls).toHaveLength(1);
  });

  test('marks a malformed successful admission as potentially accepted', async () => {
    durablePromptResults.push({ data: { data: { admitted: true } } });

    let caught: unknown = null;
    try {
      await opencodeClient.sendMessage({
        id: 'ses_malformed_admission',
        providerID: 'anthropic-malformed-admission',
        modelID: 'claude-sonnet',
        text: 'hello',
        delivery: 'queue',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { sendMayHaveBeenAccepted?: boolean }).sendMayHaveBeenAccepted).toBe(true);
  });

  test('serializes session configuration and admission for concurrent follow-ups', async () => {
    const firstSwitch = createDeferred<unknown>();
    switchModelResults.push(firstSwitch.promise);

    const first = opencodeClient.sendMessage({
      id: 'ses_serial',
      providerID: 'provider-first',
      modelID: 'model-first',
      text: 'first',
      delivery: 'queue',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchModelCalls).toHaveLength(1);

    const second = opencodeClient.sendMessage({
      id: 'ses_serial',
      providerID: 'provider-second',
      modelID: 'model-second',
      text: 'second',
      delivery: 'queue',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchModelCalls).toHaveLength(1);
    expect(durablePromptCalls).toHaveLength(0);

    firstSwitch.resolve({ response: new Response(null, { status: 204 }) });
    await Promise.all([first, second]);

    expect(callOrder).toEqual(['switchModel', 'prompt', 'switchModel', 'prompt']);
    expect(switchModelCalls.map((args) => args[0])).toEqual([
      { sessionID: 'ses_serial', model: { id: 'model-first', providerID: 'provider-first' } },
      { sessionID: 'ses_serial', model: { id: 'model-second', providerID: 'provider-second' } },
    ]);
  });

  test('stops a durable sequence before prompt admission when the runtime changes', async () => {
    const modelSwitch = createDeferred<unknown>();
    switchModelResults.push(modelSwitch.promise);

    const send = opencodeClient.sendMessage({
      id: 'ses_runtime_change',
      providerID: 'provider-runtime-change',
      modelID: 'model-runtime-change',
      text: 'hello',
      delivery: 'steer',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchModelCalls).toHaveLength(1);

    runtimeGeneration += 1;
    modelSwitch.resolve({ response: new Response(null, { status: 204 }) });

    await expect(send).rejects.toThrow('Runtime changed before operation dispatch');
    expect(durablePromptCalls).toHaveLength(0);
  });

  test('does not retry an ambiguous durable prompt failure', async () => {
    durablePromptResults.push({
      error: { _tag: 'ServiceUnavailableError', message: 'starting' },
      response: { status: 503 },
    });

    await expect(opencodeClient.sendMessage({
      id: 'ses_failure',
      providerID: 'anthropic-durable-503',
      modelID: 'claude-sonnet',
      agent: 'build',
      text: 'hello',
      delivery: 'queue',
    })).rejects.toThrow('v2.session.prompt failed (503)');

    expect(switchAgentCalls).toHaveLength(1);
    expect(switchModelCalls).toHaveLength(1);
    expect(durablePromptCalls).toHaveLength(1);
    expect(callOrder).toEqual(['switchAgent', 'switchModel', 'prompt']);
  });

  test('stops after a switch failure and does not attempt or retry the prompt', async () => {
    switchModelResults.push(new TypeError('Failed to fetch'));

    await expect(opencodeClient.sendMessage({
      id: 'ses_switch_failure',
      providerID: 'openai-switch-failure',
      modelID: 'gpt-5',
      text: 'hello',
      delivery: 'steer',
    })).rejects.toThrow('Failed to fetch');

    expect(switchModelCalls).toHaveLength(1);
    expect(durablePromptCalls).toHaveLength(0);
    expect(callOrder).toEqual(['switchModel']);
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
});
