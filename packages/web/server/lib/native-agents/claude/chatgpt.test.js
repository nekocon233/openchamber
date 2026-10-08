import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatgptStore } from './chatgpt-store.js';
import { createChatgptConnections } from './chatgpt.js';
import { createClaudeConnections, prepareClaudeConnection } from './connections.js';
import { createClaudeUtility } from './utility.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-chatgpt-catalog-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const accounts = ['first', 'second'].map((name) => ({
    id: randomUUID(), clientId: name, subject: name, email: `${name}@example.test`, revision: 1,
    credentials: { accessToken: `fake-${name}`, refreshToken: 'fake-refresh', idToken: 'fake-id', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] },
    models: [{ slug: `gpt-${name}`, display_name: `GPT ${name}`, visibility: 'list' }], welcomed: true,
  }));
  const store = createChatgptStore({ dataDir });
  await store.transaction((document) => { document.hostId = `urn:uuid:${randomUUID()}`; document.accounts = accounts; });
  let failFirst = false;
  const requests = [];
  const chatgpt = createChatgptConnections({ dataDir, fetchImpl: async (url, options) => {
    if (url === 'https://api.openai.com/v1/responses') {
      requests.push(JSON.parse(options.body));
      const events = [
        { type: 'response.output_text.delta', item_id: 'reply', content_index: 0, delta: 'Done.' },
        { type: 'response.completed', response: { id: 'response', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    }
    expect(url).toBe('https://api.openai.com/v1/models');
    const selected = options.headers.Authorization === 'Bearer fake-first' ? accounts[0] : accounts[1];
    if (selected === accounts[0] && failFirst) throw new Error('Offline');
    return Response.json({ models: selected.models });
  } });
  cleanups.push(() => chatgpt.shutdown());
  return { chatgpt, accounts, store, requests, connections: createClaudeConnections({ dataDir, chatgpt }), fail: () => { failFirst = true; } };
};

const infer = (env) => fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY },
  body: JSON.stringify({ model: env.ANTHROPIC_MODEL, messages: [{ role: 'user', content: 'Hello' }], output_config: { effort: 'high' } }),
});

describe('ChatGPT Claude connections', () => {
  it('uses account context limits and image capabilities for both display and Claude launch', async () => {
    const f = await fixture();
    Object.assign(f.accounts[0].models[0], {
      slug: 'gpt-6.1-sol', context_window: 272_000, max_context_window: 872_000, input_modalities: ['text', 'image'],
    });
    const model = (await f.connections.catalog()).find((entry) => entry.id.startsWith('chatgpt:'));
    expect(model).toMatchObject({ contextWindow: 872_000, outputLimit: 128_000, input: { image: true, pdf: false } });
    const launch = await f.connections.resolve(model.id);
    expect(launch.descriptor).toEqual(model);
    const connection = await prepareClaudeConnection(launch, {});
    try {
      expect(connection.env).toMatchObject({
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '872000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '872000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
      });
      const result = await fetch(`${connection.env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': connection.env.ANTHROPIC_API_KEY },
        body: JSON.stringify({ model: connection.env.ANTHROPIC_MODEL, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
        ] }] }),
      });
      expect(result.status).toBe(200);
      expect(f.requests[0].input[0].content[0].type).toBe('input_image');
    } finally { await connection.dispose(); }
    f.fail();
    expect((await f.connections.catalog()).find((entry) => entry.id === model.id)).toEqual(model);
    expect((await f.chatgpt.auth.cachedModels(f.accounts[0].id))[0]).toMatchObject({
      context_window: 272_000, max_context_window: 872_000, input_modalities: ['text', 'image'],
    });
  });

  it('uses the default context when no maximum is supplied and changes launch identity with capabilities', async () => {
    const f = await fixture();
    Object.assign(f.accounts[0].models[0], { context_window: 200_000, input_modalities: ['text'] });
    const models = (await f.connections.catalog()).filter((entry) => entry.id.startsWith('chatgpt:'));
    expect(models[0]).toMatchObject({ contextWindow: 200_000, outputLimit: null, input: { image: false, pdf: false } });
    expect(models[1]).toMatchObject({ contextWindow: null, outputLimit: null, input: { image: false, pdf: false } });
    const before = await f.connections.resolve(models[0].id);
    Object.assign(f.accounts[0].models[0], { max_context_window: 100_000, input_modalities: ['text', 'image'] });
    const refreshed = (await f.connections.catalog()).find((entry) => entry.id === models[0].id);
    const after = await f.connections.resolve(models[0].id);
    expect(after.key).not.toBe(before.key);
    expect(after.descriptor).toEqual(refreshed);
    expect(after.descriptor).toMatchObject({ contextWindow: 100_000, input: { image: true } });
  });

  it('discovers supported Responses efforts and preserves them when the catalog is offline', async () => {
    const f = await fixture();
    const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    Object.assign(f.accounts[0].models[0], {
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [...efforts, 'ultra', 'future-mode', 'low'].map((effort) => ({ effort })),
    });
    const models = (await f.connections.catalog()).filter((model) => model.id.startsWith('chatgpt:'));
    expect(models[0]).toMatchObject({ efforts, defaultEffort: 'medium' });
    expect(models[1]).toMatchObject({ efforts: [], defaultEffort: null });
    expect((await f.chatgpt.auth.cachedModels(f.accounts[0].id))[0].supported_reasoning_levels).toEqual(f.accounts[0].models[0].supported_reasoning_levels);
    f.fail();
    expect((await f.connections.catalog()).filter((model) => model.id.startsWith('chatgpt:'))).toEqual(models);
    await expect(f.connections.resolve(models[0].id, 'ultra')).rejects.toMatchObject({ code: 'CHATGPT_UNSUPPORTED_EFFORT', status: 400 });
    await expect(f.connections.resolve(models[1].id, 'high')).rejects.toMatchObject({ code: 'CHATGPT_UNSUPPORTED_EFFORT', status: 400 });
  });

  it('binds each request to the selected effort and restores Default without carrying over a previous choice', async () => {
    const f = await fixture();
    Object.assign(f.accounts[0].models[0], {
      default_reasoning_level: 'high', supported_reasoning_levels: ['none', 'low', 'max'].map((effort) => ({ effort })),
    });
    const model = (await f.connections.catalog()).find((entry) => entry.id.startsWith('chatgpt:'));
    expect(model.defaultEffort).toBeNull();
    const launches = await Promise.all(['max', 'none', null].map((effort) => f.connections.resolve(model.id, effort)));
    expect(new Set(launches.map((launch) => launch.key)).size).toBe(3);
    expect(launches.every((launch) => launch.descriptor.id === model.id)).toBe(true);
    const connections = await Promise.all(launches.map((launch) => prepareClaudeConnection(launch, {})));
    try {
      for (const connection of connections) expect((await infer(connection.env)).status).toBe(200);
      expect((await infer(connections[0].env)).status).toBe(200);
      expect(f.requests.map((request) => request.reasoning)).toEqual([{ effort: 'max' }, { effort: 'none' }, undefined, { effort: 'max' }]);
    } finally { await Promise.all(connections.map((connection) => connection.dispose())); }
  });

  it('uses the same effort binding for utility queries without giving GPT levels to Claude', async () => {
    const f = await fixture();
    Object.assign(f.accounts[0].models[0], { supported_reasoning_levels: [{ effort: 'minimal' }, { effort: 'max' }] });
    const model = (await f.connections.catalog()).find((entry) => entry.id.startsWith('chatgpt:'));
    const utility = createClaudeUtility({
      connections: f.connections, launchableExecutable: async () => '/usr/bin/claude', buildEnv: () => ({}),
      loadSdk: async () => ({ query: async function* ({ options }) {
        expect(options).not.toHaveProperty('effort');
        const result = await infer(options.env);
        expect(result.status).toBe(200);
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.' };
      } }),
    });
    for (const effort of ['minimal', 'max', null]) {
      expect(await utility.generate({ modelID: model.id, effort, prompt: 'Hello' })).toBe('Done.');
    }
    expect(f.requests.map((request) => request.reasoning)).toEqual([{ effort: 'minimal' }, { effort: 'max' }, undefined]);
    await utility.shutdown();
  });

  it('disambiguates duplicate and missing emails without changing saved accounts', async () => {
    const f = await fixture();
    const saved = await f.store.read();
    expect((await f.chatgpt.accounts()).map((account) => account.label)).toEqual(['first@example.test', 'second@example.test']);
    expect(await f.store.read()).toEqual(saved);

    await f.store.transaction((document) => { document.accounts[1].email = document.accounts[0].email; });
    const duplicates = await f.chatgpt.auth.accounts();
    expect(duplicates.map((account) => account.label)).toEqual(f.accounts.map((account) => `first@example.test · ${account.id.slice(0, 8)}`));
    for (const account of duplicates) expect(await f.chatgpt.auth.getAccount(account.id)).toEqual(account);

    await f.store.transaction((document) => { document.accounts[0].email = ''; });
    expect((await f.chatgpt.accounts()).map((account) => account.label)).toEqual([
      `ChatGPT · ${f.accounts[0].id.slice(0, 8)}`, 'first@example.test',
    ]);
  });

  it('keeps model identities when account status changes shorten their names', async () => {
    const f = await fixture();
    f.accounts[1].models = [...f.accounts[0].models];
    const models = (await f.connections.catalog()).filter((model) => model.id.startsWith('chatgpt:'));
    expect(models.map((model) => model.name)).toEqual(['GPT first / first@example.test', 'GPT first / second@example.test']);
    expect(new Set(models.map((model) => model.id)).size).toBe(2);
    for (const model of models) expect((await f.connections.resolve(model.id)).descriptor).toEqual(model);
    const originalLaunch = await f.connections.resolve(models[0].id);

    await f.store.transaction((document) => { document.accounts[1].credentials.scopes = []; });
    const singleAccountModels = (await f.connections.catalog()).filter((model) => model.id.startsWith('chatgpt:'));
    expect(singleAccountModels).toEqual([{ ...models[0], name: 'GPT first' }]);
    const currentLaunch = await f.connections.resolve(models[0].id);
    expect(currentLaunch.key).toBe(originalLaunch.key);
    expect(currentLaunch.descriptor).toEqual(singleAccountModels[0]);
    await expect(f.connections.resolve(models[1].id)).rejects.toMatchObject({ code: 'CHATGPT_REAUTH_REQUIRED' });

    await f.store.transaction((document) => { document.accounts[1].credentials = null; });
    expect((await f.connections.catalog()).filter((model) => model.id.startsWith('chatgpt:'))).toEqual(singleAccountModels);
    await f.store.transaction((document) => { document.accounts[1].credentials = f.accounts[1].credentials; });
    expect((await f.connections.catalog()).filter((model) => model.id.startsWith('chatgpt:'))).toEqual(models);
    await expect(f.connections.resolve(`chatgpt:${randomUUID()}:missing`)).rejects.toMatchObject({ code: 'CHATGPT_ACCOUNT_NOT_FOUND', status: 404 });
  });

  it('preserves other connections and reports stale account models when one catalog fails', async () => {
    const f = await fixture(); f.fail();
    const catalog = await f.connections.catalog();
    expect(catalog.find((model) => model.id === 'opus')).toBeDefined();
    expect(catalog.filter((model) => model.id.startsWith('chatgpt:'))).toHaveLength(2);
    expect((await f.chatgpt.accounts()).map((account) => account.catalogUnavailable)).toEqual([true, false]);
    await f.store.transaction((document) => { document.accounts[0].credentials = null; });
    expect((await f.connections.catalog()).filter((model) => model.id.startsWith('chatgpt:'))).toHaveLength(1);
  });

  it('opens a disposable local grant without putting OAuth tokens in the CLI environment', async () => {
    const f = await fixture();
    const model = (await f.connections.catalog()).find((entry) => entry.id.startsWith('chatgpt:'));
    const launch = await f.connections.resolve(model.id);
    expect(launch.env).toBeNull();
    const connection = await prepareClaudeConnection(launch, { PATH: '/usr/bin' });
    const contents = await fs.readFile(connection.settings, 'utf8');
    expect(contents).not.toMatch(/fake-first|fake-refresh|fake-id/);
    expect(connection.env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(connection.env.ANTHROPIC_MODEL).toBe('gpt-first');
    expect(connection.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const endpoint = `${connection.env.ANTHROPIC_BASE_URL}/v1/messages/count_tokens`;
    await connection.dispose();
    const rejected = await fetch(endpoint, { method: 'POST', headers: { 'x-api-key': connection.env.ANTHROPIC_API_KEY } });
    expect(rejected.status).toBe(401);
    await expect(fs.stat(connection.settings)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('describes utility availability from ChatGPT credentials without an Anthropic login', async () => {
    const f = await fixture();
    const utility = createClaudeUtility({
      connections: f.connections,
      launchableExecutable: async () => '/usr/bin/claude',
      buildEnv: () => ({}), loadSdk: async () => { throw new Error('No query expected'); },
      runCli: async () => { throw new Error('Must not require Anthropic login'); },
    });
    expect(await utility.available()).toBe(true);
    const model = (await f.connections.catalog()).find((entry) => entry.id.startsWith('chatgpt:'));
    expect(await utility.describe(model.id)).toMatchObject({ hasLogin: true, contextWindow: null, outputLimit: null });
  });
});
