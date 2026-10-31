import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeConnections } from '../claude/connections.js';
import { createCliproxyapiService } from './service.js';
import { createCliproxyapiStore } from './store.js';

const directories = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const savedModel = (family = 'opus', version = '5-5') => ({
  id: randomUUID(), name: `${family === 'opus' ? 'Opus' : 'Sonnet'} ${version.replace('-', '.')} (agy)`,
  modelID: `claude-${family}-${version}-high`, followFamily: `antigravity-${family}`,
  contextWindow: 1000000, outputLimit: 128000, input: { image: true, pdf: false }, efforts,
});
const definition = (id) => ({
  id, display_name: id, context_length: 1000000, max_completion_tokens: 128000,
  supportedInputModalities: ['text', 'image'], thinking: { min: 1024, max: 64000 },
});
const fixture = async (models = [savedModel()]) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-following-'));
  directories.push(dataDir);
  const connections = createClaudeConnections({ dataDir });
  const saved = await connections.save(null, {
    name: 'Gateway', baseURL: 'http://127.0.0.1:8317', auth: 'api-key', apiKey: 'fixture-client-key', models,
  });
  const store = createCliproxyapiStore({ dataDir, homedir: path.join(dataDir, 'home') });
  await store.update((current) => ({ ...current, enabled: true, clientKeys: ['fixture-client-key'] }));
  const state = {
    served: models.map((model) => model.modelID), definitions: models.map((model) => definition(model.modelID)),
    accountIds: null, accounts: [{ name: 'ag-fixture.json', provider: 'antigravity', disabled: false }],
    modelReads: 0, failure: false, waitForModels: null, servedAfterRemoval: [],
  };
  const service = createCliproxyapiService({
    dataDir, connections, readModelMetadata: async () => new Map(),
    fetchImpl: async (url, options = {}) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/v1/models') {
        state.modelReads += 1;
        if (state.waitForModels) await state.waitForModels(options.signal);
        return Response.json({ data: state.served.map((id) => ({ id })) }, { status: state.failure ? 502 : 200 });
      }
      if (endpoint.pathname === '/v0/management/auth-files') {
        if (options.method === 'DELETE') {
          state.accounts = state.accounts.filter((account) => account.name !== endpoint.searchParams.get('name'));
          state.served = state.servedAfterRemoval;
        }
        return Response.json({ files: state.accounts });
      }
      if (endpoint.pathname.startsWith('/v8/management/routing/model-definitions')) return Response.json({ models: state.definitions });
      if (endpoint.pathname === '/v8/management/credentials/models') return Response.json({ models: (state.accountIds ?? state.served).map((id) => ({ id })) });
      throw new Error(`Unexpected fixture endpoint ${endpoint.pathname}`);
    },
  });
  const offer = (...ids) => { state.served = ids; state.definitions = ids.map(definition); };
  const selected = `connection:${saved.id}:${models[0].id}`;
  return { dataDir, connections, service, store, saved, state, offer, selected };
};

describe('Antigravity family following', () => {
  it('updates an unversioned label without replacing the selected model or its query', async () => {
    const model = { ...savedModel(), name: 'Opus (agy)' };
    const { connections, service, selected } = await fixture([model]);
    const before = await connections.resolve(selected);
    expect(await service.refreshFollowedModels()).toBe(true);
    const after = await connections.resolve(selected);
    expect(after.key).toBe(before.key);
    expect(after.model).toBe(before.model);
    expect(after.descriptor).toMatchObject({ id: selected, name: 'Opus 5.5 (agy)', efforts });
    expect(await service.refreshFollowedModels()).toBe(false);
    expect((await connections.list())[0].revision).toBe(2);
  });

  it('upgrades the version and name while keeping the selected identity and credentials across restart', async () => {
    const { dataDir, connections, service, saved, offer, selected } = await fixture();
    const running = await service.resolveConnection(selected, 'max');
    offer('claude-opus-5-5-high', 'claude-opus-5-6-high');
    const next = await service.resolveConnection(selected, 'max');
    expect(running.model).toBe('claude-opus-5-5-high');
    expect(next.model).toBe('claude-opus-5-6-high');
    expect(next.key).not.toBe(running.key);
    expect(next.descriptor).toMatchObject({ id: selected, name: 'Opus 5.6 (agy)', efforts, followFamily: 'antigravity-opus' });
    expect(next.env.ANTHROPIC_API_KEY).toBe(running.env.ANTHROPIC_API_KEY);
    expect((await connections.list())[0]).toMatchObject({ id: saved.id, revision: 2 });
    const restored = await createClaudeConnections({ dataDir }).resolve(selected);
    expect(restored.model).toBe(next.model);
    expect(restored.key).toBe(next.key);
    expect(restored.descriptor.name).toBe('Opus 5.6 (agy)');
  });

  it('compares numeric versions, keeps the current effort slug when available, and excludes previews and unverified ids', async () => {
    const { connections, service, offer, state } = await fixture();
    offer('claude-opus-5-9-high', 'claude-opus-5-10-low', 'claude-opus-5-10-high', 'claude-opus-5-10-max',
      'claude-opus-6-preview', 'claude-opus-5-20261031', 'claude-sonnet-9-9-high', 'claude-opus-99-1-high');
    state.accountIds = state.served.filter((id) => !id.includes('99-1'));
    await service.refreshFollowedModels();
    expect((await connections.list())[0].models[0]).toMatchObject({ modelID: 'claude-opus-5-10-high', name: 'Opus 5.10 (agy)' });
    offer('claude-opus-6-high'); state.accountIds = null;
    await service.refreshFollowedModels();
    expect((await connections.list())[0].models[0]).toMatchObject({ modelID: 'claude-opus-6-high', name: 'Opus 6 (agy)' });
  });

  it('does not replace an unrelated family query when one model upgrades, while manual credential changes still invalidate it', async () => {
    const { connections, service, offer, saved } = await fixture([savedModel(), savedModel('sonnet')]);
    const sonnet = `connection:${saved.id}:${saved.models[1].id}`;
    const before = await service.resolveConnection(sonnet);
    offer('claude-opus-5-6-high', 'claude-sonnet-5-5-high');
    await service.refreshFollowedModels();
    expect((await service.resolveConnection(sonnet)).key).toBe(before.key);
    const updated = (await connections.list())[0];
    expect(updated).not.toHaveProperty('launchRevision');
    await connections.save(updated.id, { ...updated, apiKey: 'replacement-fixture-key' });
    expect((await service.resolveConnection(sonnet)).key).not.toBe(before.key);
  });

  it('does not downgrade, erase a missing family, or replace a good mapping after a discovery failure', async () => {
    const { connections, service, offer, state } = await fixture([savedModel('opus', '5-6')]);
    const before = await connections.list();
    offer('claude-opus-5-5-high');
    expect(await service.refreshFollowedModels()).toBe(false);
    offer();
    expect(await service.refreshFollowedModels()).toBe(false);
    state.failure = true;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await service.refreshFollowedModels()).toBe(false);
    expect(warning).toHaveBeenCalled();
    expect(await connections.list()).toEqual(before);
  });

  it('keeps incomplete Opus metadata while updating an independently valid Sonnet model', async () => {
    const { connections, service, offer, state, saved } = await fixture([savedModel(), savedModel('sonnet')]);
    offer('claude-opus-5-6-high', 'claude-sonnet-5-6-high');
    delete state.definitions[0].context_length;
    await service.refreshFollowedModels();
    const models = (await connections.list())[0].models;
    expect(models[0]).toEqual(saved.models[0]);
    expect(models[1]).toMatchObject({ id: saved.models[1].id, name: 'Sonnet 5.6 (agy)', modelID: 'claude-sonnet-5-6-high' });
  });

  it('coalesces concurrent checks and does not revise an unchanged connection', async () => {
    const { connections, service, offer, state } = await fixture();
    offer('claude-opus-5-6-high');
    await Promise.all([service.refreshFollowedModels(), service.refreshFollowedModels(), service.refreshFollowedModels()]);
    expect(state.modelReads).toBe(1);
    expect((await connections.list())[0].revision).toBe(2);
    expect(await service.refreshFollowedModels()).toBe(false);
    expect(state.modelReads).toBe(2);
    expect((await connections.list())[0].revision).toBe(2);
  });

  it('preserves a connection edit made during discovery, then upgrades on the next check', async () => {
    const { connections, service, offer, state, saved } = await fixture();
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    state.waitForModels = async () => { started(); await gate; };
    offer('claude-opus-5-6-high');
    const refresh = service.refreshFollowedModels();
    await reading;
    await connections.save(saved.id, { ...saved, name: 'My gateway' });
    release();
    expect(await refresh).toBe(false);
    expect((await connections.list())[0]).toMatchObject({ name: 'My gateway', models: [{ modelID: 'claude-opus-5-5-high' }] });
    await service.refreshFollowedModels();
    expect((await connections.list())[0]).toMatchObject({ name: 'My gateway', models: [{ name: 'Opus 5.6 (agy)', modelID: 'claude-opus-5-6-high' }] });
  });

  it('does not hide a failed save as a successful upgrade', async () => {
    const { connections, service, offer } = await fixture();
    offer('claude-opus-5-6-high');
    const before = await connections.list();
    vi.spyOn(connections, 'refreshModelBindings').mockRejectedValue(new Error('fixture disk failure'));
    await expect(service.refreshFollowedModels()).rejects.toThrow('fixture disk failure');
    expect(await connections.list()).toEqual(before);
  });

  it('bounds automatic discovery so an unresponsive model endpoint keeps the last binding', async () => {
    const { connections, service, state, saved } = await fixture();
    let aborted = false;
    state.waitForModels = (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await service.refreshFollowedModels()).toBe(false);
    expect(aborted).toBe(true);
    expect(state.modelReads).toBe(1);
    expect((await connections.list())[0]).toEqual(saved);
  });

  it('reimports one row per followed family with its versioned name and original selectable id', async () => {
    const { connections, service, offer, saved } = await fixture([savedModel(), savedModel('sonnet')]);
    offer('claude-opus-5-5-high', 'claude-opus-5-6-low', 'claude-opus-5-6-high', 'claude-sonnet-5-6-high');
    expect(await service.importModels()).toMatchObject({ imported: 2, skipped: 0 });
    const models = (await connections.list())[0].models;
    expect(models.map((model) => [model.id, model.followFamily])).toEqual(saved.models.map((model) => [model.id, model.followFamily]));
    expect(models.map((model) => model.name)).toEqual(['Opus 5.6 (agy)', 'Sonnet 5.6 (agy)']);
    expect(models.map((model) => model.modelID)).toEqual(['claude-opus-5-6-high', 'claude-sonnet-5-6-high']);
    await service.importModels();
    expect((await connections.list())[0].models).toEqual(models);
  });

  it('retains an explicitly pinned old release alongside the followed family during import', async () => {
    const followed = savedModel();
    const pinned = { ...followed, id: randomUUID(), name: 'Pinned Opus' }; delete pinned.followFamily;
    const { connections, service, offer } = await fixture([followed, pinned]);
    offer('claude-opus-5-5-high', 'claude-opus-5-6-high');
    await service.importModels();
    expect((await connections.list())[0].models).toMatchObject([
      { id: followed.id, name: 'Opus 5.6 (agy)', modelID: 'claude-opus-5-6-high', followFamily: 'antigravity-opus' },
      { id: pinned.id, modelID: 'claude-opus-5-5-high' },
    ]);
    expect((await connections.list())[0].models[1].followFamily).toBeUndefined();
  });

  it('does not refresh pinned rows, disabled gateways, or models outside the managed endpoint', async () => {
    const pinned = savedModel(); delete pinned.followFamily;
    const plain = await fixture([pinned]);
    await plain.service.refreshFollowedModels();
    await plain.service.resolveConnection(plain.selected);
    expect(plain.state.modelReads).toBe(0);
    const tracked = await fixture();
    await tracked.store.update((document) => ({ ...document, enabled: false }));
    await tracked.service.refreshFollowedModels();
    expect(tracked.state.modelReads).toBe(0);
    await tracked.connections.save(tracked.saved.id, { ...tracked.saved, baseURL: 'https://other.example.test' });
    await tracked.service.resolveConnection(tracked.selected);
    expect(tracked.state.modelReads).toBe(0);
  });

  it('never upgrades through another provider or a disabled Antigravity account', async () => {
    const { connections, service, offer, state, saved } = await fixture();
    offer('claude-opus-5-6-high');
    state.accounts[0].provider = 'claude';
    await service.refreshFollowedModels();
    expect((await connections.list())[0]).toEqual(saved);
    state.accounts[0].provider = 'antigravity'; state.accounts[0].disabled = true;
    await service.refreshFollowedModels();
    expect((await connections.list())[0]).toEqual(saved);
  });

  it('refuses automatic updates under enterprise policy before discovery', async () => {
    const { service, state } = await fixture();
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    expect(await service.refreshFollowedModels()).toBe(false);
    expect(state.modelReads).toBe(0);
  });

  it('rechecks enterprise policy before persisting a discovery started while updates were allowed', async () => {
    const { connections, service, offer, state, saved } = await fixture();
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    state.waitForModels = async () => { started(); await gate; };
    offer('claude-opus-5-6-high');
    const refresh = service.refreshFollowedModels();
    await reading;
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    release();
    await expect(refresh).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    expect((await connections.list())[0]).toEqual(saved);
  });

  it('keeps a followed family supplied by a remaining account when its old concrete id disappears', async () => {
    const { connections, service, offer, state, saved } = await fixture();
    offer('claude-opus-5-6-high');
    state.accounts.push({ name: 'ag-second.json', provider: 'antigravity', disabled: false });
    state.servedAfterRemoval = [...state.served];
    await service.removeAccount('ag-fixture.json');
    expect((await connections.list())[0].models[0].id).toBe(saved.models[0].id);
    await service.refreshFollowedModels();
    expect((await connections.list())[0].models[0]).toMatchObject({ name: 'Opus 5.6 (agy)', modelID: 'claude-opus-5-6-high' });
  });

  it('logout after an upgrade removes the account models and a later check cannot recreate them', async () => {
    const { connections, service, offer } = await fixture();
    offer('claude-opus-5-6-high');
    await Promise.all([service.refreshFollowedModels(), service.removeAccount('ag-fixture.json')]);
    expect(await connections.list()).toEqual([]);
    await service.refreshFollowedModels();
    expect(await connections.list()).toEqual([]);
  });
});
