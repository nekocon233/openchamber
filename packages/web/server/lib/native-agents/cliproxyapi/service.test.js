import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliproxyapiService } from './service.js';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const credential = { name: 'codex-user@example.com-pro.json', email: 'user@example.com', status: 'active', disabled: false, id_token: { plan_type: 'pro' } };
const STORED_KEY = 'management-test-key';

/** A gateway that answers the measured shapes, checks its key and remembers its state. */
const createGateway = ({ clientKeys = ['gateway-existing-key'], accounts = [credential], expectedKey = STORED_KEY } = {}) => {
  const calls = [];
  const list = [...clientKeys];
  const state = { offline: false, management: 200 };
  const fetchImpl = async (url, options = {}) => {
    if (state.offline) throw new Error('connect ECONNREFUSED 127.0.0.1:8317');
    const { pathname, searchParams } = new URL(url);
    calls.push({ pathname, search: searchParams, options });
    if (pathname === '/v1/models') return json({ data: [] });
    if (state.management !== 200) return json({ error: 'no' }, state.management);
    if (options.headers?.Authorization !== `Bearer ${expectedKey}`) return json({ error: 'invalid api key' }, 401);
    if (pathname === '/v0/management/auth-files') {
      if (options.method === 'DELETE') return json({ status: 'ok' });
      return json({ files: accounts });
    }
    if (pathname === '/v0/management/api-keys') return json({ 'api-keys': list });
    if (pathname === '/v8/management/config') {
      list.splice(0, list.length, ...JSON.parse(options.body).access['api-keys']);
      return json({ 'config-version': 8, status: 'ok' });
    }
    return new Response(null, { status: 404 });
  };
  return { calls, list, state, fetchImpl };
};

const fixture = async (gateway = createGateway()) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliproxyapi-test-'));
  directories.push(dataDir);
  const saved = [];
  const connections = {
    save: async (id, input) => {
      saved.push({ id, input });
      const { apiKey, ...publicInput } = input;
      return { id: id ?? randomUUID(), revision: 1, hasKey: apiKey.length > 0, ...publicInput };
    },
  };
  const service = createCliproxyapiService({ dataDir, connections, fetchImpl: gateway.fetchImpl });
  return { dataDir, service, saved, gateway };
};

const storedKey = (baseURL = 'http://127.0.0.1:8317', managementKey = STORED_KEY) => ({ baseURL, managementKey });

const model = () => ({
  id: randomUUID(), name: 'GPT-6.1-Sol', modelID: 'gpt-6.1-sol', contextWindow: 872000, outputLimit: 128000,
  input: { image: true, pdf: false }, efforts: ['low', 'max'],
});

describe('CLIProxyAPI service', () => {
  it('reports an unconfigured gateway that is up and waiting for a key', async () => {
    const { service } = await fixture();
    expect(await service.status()).toEqual({
      configured: false, baseURL: 'http://127.0.0.1:8317', reachable: true,
      managementEnabled: true, keyRejected: false, accounts: [], clientKeys: [],
    });
  });

  it('reports a gateway that is not running at all', async () => {
    const gateway = createGateway();
    gateway.state.offline = true;
    const { service } = await fixture(gateway);
    expect(await service.status()).toMatchObject({ reachable: false, managementEnabled: false });
  });

  it('stores a validated key with owner-only permissions and reports the gateway', async () => {
    const { dataDir, service } = await fixture();
    expect(await service.saveKey(storedKey())).toEqual({ baseURL: 'http://127.0.0.1:8317', managedClientKey: false });
    const status = await service.status();
    expect(status).toMatchObject({ configured: true, managementEnabled: true, keyRejected: false });
    expect(status.accounts).toEqual([{ name: 'codex-user@example.com-pro.json', email: 'user@example.com', planType: 'pro', activeUntil: null, status: 'active', disabled: false }]);
    expect(status.clientKeys).toEqual([{ hint: '-key', length: 'gateway-existing-key'.length }]);
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(dataDir, 'native-agents', 'cliproxyapi.json'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(dataDir, 'native-agents'))).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps a working key when a candidate is rejected, and names a stored key that stopped working', async () => {
    const gateway = createGateway();
    const { service } = await fixture(gateway);
    await service.saveKey(storedKey());
    await expect(service.saveKey({ baseURL: 'http://127.0.0.1:8317', managementKey: 'wrong-key' })).rejects.toMatchObject({ code: 'CLIPROXYAPI_KEY_REJECTED' });
    expect(await service.status()).toMatchObject({ configured: true, managementEnabled: true, keyRejected: false });
    gateway.state.management = 401;
    expect(await service.status()).toMatchObject({ configured: true, managementEnabled: true, keyRejected: true });
  });

  it('names a disabled management API before anything is stored', async () => {
    const gateway = createGateway();
    gateway.state.management = 404;
    const { service } = await fixture(gateway);
    expect(await service.status()).toMatchObject({ reachable: true, managementEnabled: false, configured: false });
  });

  it('adds a client key for the connection and takes it back when forgotten', async () => {
    const gateway = createGateway();
    const { service, dataDir, saved } = await fixture(gateway);
    await service.saveKey(storedKey());
    const connection = await service.saveConnection({ connectionId: null, name: 'CLIProxyAPI', models: [model()], clientKey: { source: 'added' } });
    expect(connection).not.toHaveProperty('apiKey');
    expect(saved[0].input).toMatchObject({ kind: 'anthropic', name: 'CLIProxyAPI', baseURL: 'http://127.0.0.1:8317', auth: 'api-key' });
    expect(saved[0].input.models[0].modelID).toBe('gpt-6.1-sol');
    const added = saved[0].input.apiKey;
    expect(gateway.list).toEqual(['gateway-existing-key', added]);

    expect(await service.forgetKey()).toEqual({ forgotten: true, clientKeyRemoved: true });
    expect(gateway.list).toEqual(['gateway-existing-key']);
    await expect(fs.stat(path.join(dataDir, 'native-agents', 'cliproxyapi.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.status()).resolves.toMatchObject({ configured: false });
  });

  it('keeps the stored key when the gateway refuses to take its client key back', async () => {
    const gateway = createGateway();
    const { service, dataDir } = await fixture(gateway);
    await service.saveKey(storedKey());
    await service.saveConnection({ connectionId: null, name: 'CLIProxyAPI', models: [model()], clientKey: { source: 'added' } });
    gateway.state.offline = true;
    await expect(service.forgetKey()).rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_REACHABLE' });
    expect(await fs.readFile(path.join(dataDir, 'native-agents', 'cliproxyapi.json'), 'utf8')).toContain(STORED_KEY);
  });

  it('reuses a listed key by position and refuses a position the gateway no longer has', async () => {
    const gateway = createGateway({ clientKeys: ['first-key', 'second-key'] });
    const { service, saved } = await fixture(gateway);
    await service.saveKey(storedKey());
    await service.saveConnection({ connectionId: null, name: 'CLIProxyAPI', models: [model()], clientKey: { source: 'existing', index: 1 } });
    expect(saved[0].input.apiKey).toBe('second-key');
    await expect(service.saveConnection({ connectionId: null, name: 'CLIProxyAPI', models: [model()], clientKey: { source: 'existing', index: 5 } }))
      .rejects.toMatchObject({ code: 'CLIPROXYAPI_CLIENT_KEY_UNKNOWN' });
  });

  it('uses a typed key without touching the gateway config', async () => {
    const gateway = createGateway();
    const { service, saved } = await fixture(gateway);
    await service.saveKey(storedKey());
    gateway.calls.length = 0;
    await service.saveConnection({ connectionId: null, name: 'CLIProxyAPI', models: [model()], clientKey: { source: 'typed', value: 'typed-key' } });
    expect(saved[0].input.apiKey).toBe('typed-key');
    expect(gateway.calls.map((call) => call.pathname)).toEqual([]);
  });

  it('removes only an account the gateway lists', async () => {
    const gateway = createGateway();
    const { service } = await fixture(gateway);
    await service.saveKey(storedKey());
    gateway.calls.length = 0;
    await expect(service.removeAccount('../../other.json')).rejects.toMatchObject({ code: 'CLIPROXYAPI_ACCOUNT_UNKNOWN' });
    await expect(service.removeAccount('someone-elses.json')).rejects.toMatchObject({ code: 'CLIPROXYAPI_ACCOUNT_UNKNOWN' });
    expect(gateway.calls.every((call) => call.options.method !== 'DELETE')).toBe(true);
    await service.removeAccount('codex-user@example.com-pro.json');
    expect(gateway.calls.at(-1)).toMatchObject({ pathname: '/v0/management/auth-files' });
    expect(gateway.calls.at(-1).options.method).toBe('DELETE');
  });

  it('refuses to act before a gateway is configured', async () => {
    const { service } = await fixture();
    await expect(service.beginLogin()).rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_CONFIGURED' });
    await expect(service.saveConnection({ connectionId: null, name: 'CLIProxyAPI', models: [model()], clientKey: { source: 'added' } })).rejects.toMatchObject({ code: 'CLIPROXYAPI_NOT_CONFIGURED' });
  });
});
