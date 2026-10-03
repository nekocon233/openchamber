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
  const chatgpt = createChatgptConnections({ dataDir, fetchImpl: async (url, options) => {
    expect(url).toBe('https://api.openai.com/v1/models');
    const selected = options.headers.Authorization === 'Bearer fake-first' ? accounts[0] : accounts[1];
    if (selected === accounts[0] && failFirst) throw new Error('Offline');
    return Response.json({ models: selected.models });
  } });
  cleanups.push(() => chatgpt.shutdown());
  return { chatgpt, accounts, store, connections: createClaudeConnections({ dataDir, chatgpt }), fail: () => { failFirst = true; } };
};

describe('ChatGPT Claude connections', () => {
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
