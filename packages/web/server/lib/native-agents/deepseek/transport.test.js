import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { spawnCliProcess } from '../process.js';
import { createDeepseekTransport } from './transport.js';
import { modelCatalog } from './protocol.js';
import { createDeepseekConfiguration } from './configuration.js';

const transports = [];
afterEach(async () => { for (const transport of transports.splice(0)) await transport.shutdown(); });
const setup = (overrides = {}) => {
  let starts = 0;
  const transport = createDeepseekTransport({
    resolveExecutable: async () => process.execPath,
    buildEnv: () => ({ ...process.env, DSH_TEST_DIRECTORY: '/workspace' }),
    enterpriseMode: () => false,
    spawnProcess: (executable, args, options) => {
      starts += 1;
      return spawnCliProcess(executable, [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), ...args], options);
    },
    ...overrides,
  });
  transports.push(transport);
  return { transport, starts: () => starts };
};

describe('DeepSeek process and protocol boundary', () => {
  it('gates remote configuration reads and writes before spawn and on policy changes', async () => {
    let blocked = true;
    const { transport, starts } = setup({ enterpriseMode: () => blocked });
    const configuration = createDeepseekConfiguration({ transport });
    const input = { revision: 0, baseURL: null, modelIDs: ['test-model'], apiKey: 'fixture-api-key' };
    await expect(configuration.read()).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    await expect(configuration.save(input)).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    expect(starts()).toBe(0);
    blocked = false;
    expect(await configuration.save(input)).toMatchObject({ status: 'saved' });
    blocked = true;
    await expect(configuration.read()).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    expect(starts()).toBe(1);
  });

  it('refuses enterprise mode and a missing CLI before spawning', async () => {
    const blocked = setup({ enterpriseMode: () => true });
    await expect(blocked.transport.request('session/modelCatalog', {}, modelCatalog)).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    expect(blocked.starts()).toBe(0);
    const missing = setup({ resolveExecutable: async () => null });
    await expect(missing.transport.request('session/modelCatalog', {}, modelCatalog)).rejects.toMatchObject({ status: 503, code: 'NATIVE_CLI_MISSING' });
    expect(missing.starts()).toBe(0);
  });

  it('starts once for concurrent reads and rejects malformed results as backend errors', async () => {
    const { transport, starts } = setup();
    await Promise.all([transport.request('session/modelCatalog', {}, modelCatalog), transport.request('session/modelCatalog', {}, modelCatalog)]);
    expect(starts()).toBe(1);
    await expect(transport.request('fixture/invalid', {}, modelCatalog)).rejects.toMatchObject({ status: 502, code: 'NATIVE_DEEPSEEK_PROTOCOL' });
    await expect(transport.request('fixture/held', {}, z.json())).rejects.toMatchObject({ status: 409, code: 'NATIVE_DEEPSEEK_WRITER_HELD' });
  });

  it('restarts only on the next request after process exit', async () => {
    let disconnected;
    const exited = new Promise((resolve) => { disconnected = resolve; });
    const { transport, starts } = setup({ onDisconnect: disconnected });
    await transport.request('fixture/exit', {}, z.boolean());
    await exited;
    expect(starts()).toBe(1);
    expect((await transport.request('session/modelCatalog', {}, modelCatalog)).groups).toHaveLength(1);
    expect(starts()).toBe(2);
  });

  it('ends its owned process when enterprise policy changes before another request', async () => {
    let blocked = false;
    let disconnected;
    const exited = new Promise((resolve) => { disconnected = resolve; });
    const { transport } = setup({ enterpriseMode: () => blocked, onDisconnect: disconnected });
    await transport.request('session/modelCatalog', {}, modelCatalog);
    blocked = true;
    await expect(transport.request('session/modelCatalog', {}, modelCatalog)).rejects.toMatchObject({ code: 'enterprise_mode' });
    await exited;
  });
});
