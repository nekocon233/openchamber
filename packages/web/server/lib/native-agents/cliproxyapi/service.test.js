import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliproxyapiService } from './service.js';
import { gatewayConfigPath } from './config.js';
import { createCliproxyapiStore } from './store.js';

const MANAGEMENT = '/v0/management/auth-files';
const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

const credential = { name: 'codex-user@example.com-pro.json', email: 'user@example.com', status: 'active', disabled: false, id_token: { plan_type: 'pro' } };

const fixture = async ({ adoptableKey = 'adopted-client-key', seedKeys = null, enabled = false, listening = false } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliproxyapi-service-'));
  directories.push(dataDir);
  const state = { listening, spawned: [], terminated: [], clientKeys: ['gateway-key'], configWrites: [], accounts: [credential], existingConnection: null, callbackBodies: [] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (!state.listening) throw new Error('connect ECONNREFUSED 127.0.0.1');
    if (target.includes('/v0/management/oauth-callback')) {
      state.callbackBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }
    if (target.includes(MANAGEMENT)) {
      if (options.method === 'DELETE') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      return new Response(JSON.stringify({ files: state.accounts }), { status: 200, headers: { 'content-type': 'application/json', 'x-cpa-version': '8.0.31' } });
    }
    if (target.endsWith('/v0/management/api-keys')) return new Response(JSON.stringify({ 'api-keys': state.clientKeys }), { status: 200 });
    if (target.endsWith('/v1/models')) {
      if (options.headers?.Authorization === undefined) return new Response(JSON.stringify({ error: 'missing api key' }), { status: 401 });
      return new Response(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-image-2' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/v8/management/config')) {
      state.clientKeys = JSON.parse(options.body).access['api-keys'];
      return new Response(JSON.stringify({ 'config-version': 8, status: 'ok' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'missing api key' }), { status: 401 });
  };
  const saved = [];
  const connections = {
    credentialKeyFor: async () => adoptableKey,
    connectionFor: async () => state.existingConnection,
    save: async (id, input) => {
      saved.push({ id, input });
      const { apiKey, ...rest } = input;
      return { id: id ?? randomUUID(), revision: 1, hasKey: apiKey.length > 0, quotaProviderId: null, ...rest };
    },
  };
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    state.spawned.push(child);
    state.listening = true;
    return child;
  };
  const terminateProcess = async (child) => {
    state.terminated.push(child);
    state.listening = false;
    child.emit('exit', 0);
  };
  if (seedKeys !== null) {
    const store = createCliproxyapiStore({ dataDir, homedir: path.join(dataDir, 'home') });
    await store.update((current) => ({ ...current, clientKeys: seedKeys, enabled }));
  }
  const service = createCliproxyapiService({
    dataDir,
    connections,
    fetchImpl,
    binaryManager: {
      version: '8.0.31',
      getPaths: () => ({ binaryPath: path.join(dataDir, 'managed', 'cli-proxy-api'), target: 'darwin-arm64' }),
      prepare: async () => ({ path: path.join(dataDir, 'managed', 'cli-proxy-api'), version: '8.0.31', target: 'darwin-arm64', source: 'installed' }),
    },
    buildEnv: () => ({}),
    spawnProcess,
    terminateProcess,
    readModelMetadata: async () => new Map([['gpt-6.1-sol', {
      name: 'GPT-6.1-Sol', contextWindow: 872000, outputLimit: 128000, image: true, efforts: ['low', 'max'],
    }]]),
  });
  return { dataDir, state, saved, service };
};

const model = () => ({
  id: randomUUID(), name: 'GPT-6.1-Sol', modelID: 'gpt-6.1-sol', contextWindow: 872000, outputLimit: 128000,
  input: { image: true, pdf: false }, efforts: ['low', 'max'],
});

describe('CLIProxyAPI managed gateway service', () => {
  it('reports a stopped gateway with its pinned version and no accounts', async () => {
    const { service } = await fixture();
    expect(await service.status()).toMatchObject({
      configured: true, enabled: false, running: false, ready: false, port: 8317,
      baseURL: 'http://127.0.0.1:8317', upstreamProxy: null, installedVersion: null,
      install: { supported: true, prepared: false, version: '8.0.31' },
      managementEnabled: false, keyRejected: false, accounts: [], clientKeys: [], restarting: false,
    });
  });

  it('adopts the key of the connection that already points at the gateway', async () => {
    const { state, service } = await fixture({ adoptableKey: 'adopted-client-key' });
    const status = await service.start();
    expect(status).toMatchObject({ running: true, ready: true, enabled: true, managementEnabled: true, installedVersion: '8.0.31', runningVersion: '8.0.31' });
    expect(status.accounts).toHaveLength(1);
    // The gateway is told to serve the adopted key before anything uses it.
    expect(state.clientKeys).toEqual(['adopted-client-key']);
    expect(status.clientKeys).toEqual([{ hint: '-key', length: 'adopted-client-key'.length }]);
  });

  it('generates a key when no connection points at the gateway', async () => {
    const { state, service } = await fixture({ adoptableKey: null });
    const status = await service.start();
    expect(status.clientKeys).toHaveLength(1);
    expect(status.clientKeys[0].length).toBe(64);
    expect(state.clientKeys).toHaveLength(1);
    expect(state.clientKeys[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('stops the gateway and remembers that it should stay stopped', async () => {
    const { state, service } = await fixture();
    await service.start();
    const stopped = await service.stop();
    expect(stopped).toMatchObject({ running: false, enabled: false });
    expect(state.terminated).toHaveLength(1);
    expect(await service.resume()).toMatchObject({ running: false });
  });

  it('keeps the gateway enabled for the next boot when the host shuts down', async () => {
    const { state, service } = await fixture({ seedKeys: ['gateway-key'] });
    await service.start();
    await service.shutdown();
    expect(state.terminated).toHaveLength(1);
    expect(await service.resume()).toMatchObject({ running: true });
    expect(state.spawned).toHaveLength(2);
  });

  it('restarts a running gateway when the upstream proxy changes', async () => {
    const { dataDir, state, service } = await fixture();
    await service.start();
    const updated = await service.setUpstreamProxy({ upstreamProxy: 'http://127.0.0.1:7890' });
    expect(updated).toMatchObject({ upstreamProxy: 'http://127.0.0.1:7890', running: true, restarting: false });
    expect(state.spawned).toHaveLength(2);
    expect(state.terminated).toHaveLength(1);
    expect(await fs.readFile(gatewayConfigPath(dataDir), 'utf8')).toContain('proxy-url: "http://127.0.0.1:7890"');
    expect(await service.setUpstreamProxy({ upstreamProxy: null })).toMatchObject({ upstreamProxy: null });
  });

  it('creates the connection from the stored key and never returns it', async () => {
    const { saved, service } = await fixture({ adoptableKey: 'adopted-client-key' });
    await service.start();
    const connection = await service.saveConnection({ connectionId: null, name: 'CLIProxyAPI', models: [model()] });
    expect(connection).not.toHaveProperty('apiKey');
    expect(saved[0].input).toMatchObject({
      kind: 'anthropic', name: 'CLIProxyAPI', baseURL: 'http://127.0.0.1:8317', auth: 'api-key', apiKey: 'adopted-client-key',
    });
    expect(saved[0].input.models[0].modelID).toBe('gpt-6.1-sol');
  });

  it('removes only an account the gateway lists', async () => {
    const { service } = await fixture();
    await service.start();
    await expect(service.removeAccount('someone-elses.json')).rejects.toMatchObject({ code: 'CLIPROXYAPI_ACCOUNT_UNKNOWN' });
    await expect(service.removeAccount('codex-user@example.com-pro.json')).resolves.toBeUndefined();
  });

  it('lists only the gateway models this computer has metadata for', async () => {
    const { service } = await fixture({ seedKeys: ['gateway-key'], listening: true });
    expect(await service.listModels()).toEqual({
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 872000, outputLimit: 128000, image: true, efforts: ['low', 'max'] }],
      unknown: ['gpt-image-2'],
    });
  });

  it('imports every known model into a new connection', async () => {
    const { saved, service } = await fixture({ seedKeys: ['gateway-key'], listening: true });
    const result = await service.importModels({ connectionId: null });
    expect(result).toMatchObject({ imported: 1, skipped: 1 });
    expect(result.connection).not.toHaveProperty('apiKey');
    expect(saved[0].id).toBeNull();
    expect(saved[0].input.models[0]).toMatchObject({ modelID: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 872000 });
  });

  it('replaces the models of the connection that already points at the gateway', async () => {
    const { state, saved, service } = await fixture({ seedKeys: ['gateway-key'], listening: true });
    state.existingConnection = { id: randomUUID(), name: 'CLIProxyAPI / ChatGPT' };
    const result = await service.importModels({ connectionId: null });
    expect(saved[0].id).toBe(state.existingConnection.id);
    expect(saved[0].input.name).toBe('CLIProxyAPI / ChatGPT');
  });

  it('refuses to write a connection when nothing can be imported', async () => {
    const empty = createCliproxyapiService({
      dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'cliproxyapi-empty-')),
      connections: { credentialKeyFor: async () => null, connectionFor: async () => null, save: async () => { throw new Error('must not save'); } },
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      binaryManager: { version: '8.0.31', getPaths: () => ({ binaryPath: '/x', target: 'darwin-arm64' }), prepare: async () => ({ path: '/x', version: '8.0.31', target: 'darwin-arm64', source: 'installed' }) },
      buildEnv: () => ({}),
      spawnProcess: () => { throw new Error('must not spawn'); },
      terminateProcess: async () => undefined,
      readModelMetadata: async () => new Map(),
    });
    await expect(empty.importModels({ connectionId: null })).rejects.toMatchObject({ code: 'CLIPROXYAPI_NO_MODELS' });
  });

  it('refuses to start a login while the gateway is not running', async () => {
    const { service } = await fixture();
    await expect(service.beginLogin()).rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_INSTALLED' });
  });

  it('hands the code inside a pasted callback address to the gateway', async () => {
    const { state, service } = await fixture({ seedKeys: ['gateway-key'], listening: true });
    await expect(service.submitLoginCallback('abc123', { url: 'http://localhost:1455/auth/callback?code=a%2Fb%2Bc&state=abc123' }))
      .resolves.toEqual({ accepted: true });
    expect(state.callbackBodies).toEqual([{ provider: 'codex', state: 'abc123', code: 'a/b+c' }]);
  });

  it('refuses a pasted address that is not this attempt\'s callback, without reaching the gateway', async () => {
    const { state, service } = await fixture({ seedKeys: ['gateway-key'], listening: true });
    await expect(service.submitLoginCallback('abc123', { url: 'http://localhost:1455/auth/callback?code=x&state=other' }))
      .rejects.toMatchObject({ code: 'CLIPROXYAPI_LOGIN_CALLBACK_MISMATCH' });
    for (const url of [
      'http://localhost:1455/auth/callback?state=abc123',
      'http://localhost:1455/auth/callback?error=access_denied&state=abc123',
      'http://localhost:1455/auth/callback?code=&state=abc123',
      'not a url',
      'localhost:1455/auth/callback?code=x&state=abc123',
    ]) {
      await expect(service.submitLoginCallback('abc123', { url }))
        .rejects.toMatchObject({ code: 'CLIPROXYAPI_LOGIN_CALLBACK_INVALID' });
    }
    expect(state.callbackBodies).toEqual([]);
  });

  it('reads a stopped gateway as unreachable when a callback is submitted', async () => {
    const { service } = await fixture();
    await expect(service.submitLoginCallback('abc123', { url: 'http://localhost:1455/auth/callback?code=x&state=abc123' }))
      .rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_REACHABLE' });
  });
});
