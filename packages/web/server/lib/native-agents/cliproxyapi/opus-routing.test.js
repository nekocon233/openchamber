import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeConnections } from '../claude/connections.js';
import { createCliproxyapiService } from './service.js';
import { createCliproxyapiStore } from './store.js';
import { CLAUDE_ROUTE_MODELS } from './claude-family-route.js';
const OPUS_ROUTE_MODEL = CLAUDE_ROUTE_MODELS.opus;
import { renderGatewayConfig } from './config.js';

const directories = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const definition = (id) => ({ id, context_length: 1000000, max_completion_tokens: 128000,
  supportedInputModalities: ['text', 'image'], thinking: { levels: efforts } });

const fixture = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-routing-'));
  directories.push(dataDir);
  const connections = createClaudeConnections({ dataDir });
  const saved = await connections.save(null, {
    name: 'Gateway', baseURL: 'http://127.0.0.1:8317', auth: 'api-key', apiKey: 'fixture-key',
    models: ['opus', 'sonnet'].map((family) => ({ id: randomUUID(), name: `${family === 'opus' ? 'Opus' : 'Sonnet'} 5.5 (agy)`,
      modelID: `claude-${family}-5-5-high`, followFamily: `antigravity-${family}`,
      contextWindow: 1000000, outputLimit: 128000, input: { image: true, pdf: false }, efforts })),
  });
  const state = {
    accounts: [{ name: 'primary.json', provider: 'claude', priority: null }, { name: 'backup.json', provider: 'antigravity', priority: 3 }],
    definitions: { claude: [definition('claude-opus-5-5'), { ...definition('claude-sonnet-5-5'), max_completion_tokens: 64000 }], antigravity: [definition('claude-opus-5-5-high'), definition('claude-sonnet-5-5-high')] },
    aliases: { claude: [{ name: 'claude-sonnet-5-5', alias: 'my-sonnet' }] }, rebind: 'any',
    failedConfig: false, failedPrimaryMetadata: false, reads: 0, events: 0, beforeConfig: null,
  };
  const service = createCliproxyapiService({ dataDir, connections, readModelMetadata: async () => new Map(),
    onModelsUpdated: () => { state.events += 1; },
    fetchImpl: async (url, options = {}) => {
      const endpoint = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      if (endpoint.pathname === '/v0/management/api-keys') return Response.json({ 'api-keys': ['fixture-key'] });
      if (endpoint.pathname === '/v1/models') {
        state.reads += 1;
        const providers = new Set(state.accounts.filter((account) => !account.disabled).map((account) => account.provider));
        return Response.json({ data: [...Object.entries(state.definitions).filter(([provider]) => providers.has(provider)).flatMap(([, models]) => models.map(({ id }) => ({ id }))),
          ...Object.entries(state.aliases).filter(([provider]) => providers.has(provider)).flatMap(([, aliases]) => aliases.map(({ alias }) => ({ id: alias })))] });
      }
      if (endpoint.pathname === '/v0/management/auth-files') {
        if (options.method === 'DELETE') state.accounts = state.accounts.filter((account) => account.name !== endpoint.searchParams.get('name'));
        return Response.json({ files: state.accounts });
      }
      if (endpoint.pathname.startsWith('/v8/management/routing/model-definitions/')) {
        if (state.failedPrimaryMetadata && endpoint.pathname.endsWith('/claude')) return Response.json({}, { status: 502 });
        return Response.json({ models: state.definitions[endpoint.pathname.split('/').at(-1)] });
      }
      if (endpoint.pathname === '/v8/management/credentials/models') {
        const account = state.accounts.find((entry) => entry.name === endpoint.searchParams.get('name'));
        return Response.json({ models: state.definitions[account.provider] });
      }
      if (endpoint.pathname === '/v8/management/config/oauth/model-alias') return Response.json(state.aliases);
      if (endpoint.pathname === '/v8/management/config/routing/session-affinity-rebind-on') return Response.json(state.rebind);
      if (endpoint.pathname === '/v8/management/config') {
        if (state.beforeConfig) await state.beforeConfig();
        if (state.failedConfig) { state.failedConfig = false; return Response.json({}, { status: 500 }); }
        state.aliases = body.oauth['model-alias']; state.rebind = body.routing['session-affinity-rebind-on'];
        return Response.json({ status: 'ok' });
      }
      if (endpoint.pathname === '/v8/management/credentials/fields') {
        state.accounts.find((account) => account.name === body.name).priority = body.priority;
        return Response.json({ status: 'ok' });
      }
      throw Error(`Unexpected fixture endpoint ${endpoint.pathname}`);
    },
  });
  const store = createCliproxyapiStore({ dataDir });
  await store.update((document) => ({ ...document, enabled: true, clientKeys: ['fixture-key'] }));
  const selected = `connection:${saved.id}:${saved.models[0].id}`;
  return { dataDir, connections, service, store, saved, state, selected };
};

describe('unified Opus routing', () => {
  it('shares authorization and priorities while keeping the two family switches independent', async () => {
    const { service, connections, saved, state, store } = await fixture();
    await service.setOpusRoute({ enabled: true });
    expect((await service.setSonnetRoute({ enabled: true })).sonnetFailover).toEqual({ enabled: true, ready: true });
    expect((await service.resolveConnection('sonnet', 'max')).model).toBe(CLAUDE_ROUTE_MODELS.sonnet);
    const catalog = await service.catalog();
    expect(catalog.some((model) => model.id === 'opus' || model.id === 'sonnet')).toBe(false);
    const sonnet = catalog.find((model) => model.modelID === CLAUDE_ROUTE_MODELS.sonnet);
    expect(sonnet).toMatchObject({ name: 'Sonnet 5.5', outputLimit: 64000, aliases: [{ id: 'sonnet' }, { id: 'sonnet[1m]' }] });
    expect((await connections.list())[0].models.map((model) => model.id)).toEqual(saved.models.map((model) => model.id));
    await service.setSonnetRoute({ enabled: false });
    expect((await service.resolveConnection('opus')).model).toBe(CLAUDE_ROUTE_MODELS.opus);
    expect(state.accounts.map((account) => account.priority)).toEqual([100, 0]);
    expect(state.rebind).toBe('quota');
    expect(state.aliases.antigravity.some((entry) => entry.alias === CLAUDE_ROUTE_MODELS.sonnet)).toBe(false);
    await service.setSonnetRoute({ enabled: true });
    await service.setOpusRoute({ enabled: false });
    expect((await service.resolveConnection('sonnet')).model).toBe(CLAUDE_ROUTE_MODELS.sonnet);
    expect(state.accounts.map((account) => account.priority)).toEqual([100, 0]);
    expect((await store.read()).claudeRoutes.opus).toBeNull();
    await service.setSonnetRoute({ enabled: false });
    expect(state.accounts.map((account) => account.priority)).toEqual([null, 3]);
    expect(state.rebind).toBe('any');
    expect((await store.read()).claudeRoutes).toBeNull();
  });

  it('advances Sonnet independently without replacing an unchanged Opus query', async () => {
    const { service, state, selected } = await fixture();
    await service.setOpusRoute({ enabled: true });
    await service.setSonnetRoute({ enabled: true });
    const opus = await service.resolveConnection(selected);
    state.definitions.claude[1] = { ...definition('claude-sonnet-5-6'), max_completion_tokens: 64000 };
    const catalog = await service.catalog();
    expect(catalog.find((model) => model.modelID === CLAUDE_ROUTE_MODELS.sonnet)?.name).toBe('Sonnet (Claude 5.6 / agy 5.5)');
    expect(catalog.find((model) => model.id === selected)?.name).toBe('Opus 5.5');
    expect((await service.resolveConnection(selected)).key).toBe(opus.key);
    state.definitions.antigravity[1] = definition('claude-sonnet-5-6-high');
    expect((await service.catalog()).find((model) => model.modelID === CLAUDE_ROUTE_MODELS.sonnet)?.name).toBe('Sonnet 5.6');
  });

  it('retains an active Opus route when adding Sonnet fails', async () => {
    const { service, state, store, connections } = await fixture();
    await service.setOpusRoute({ enabled: true });
    const before = await store.read();
    const models = (await connections.list())[0].models;
    state.failedConfig = true;
    await expect(service.setSonnetRoute({ enabled: true })).rejects.toMatchObject({ code: 'CLIPROXYAPI_REQUEST_FAILED' });
    expect((await store.read()).claudeRoutes).toEqual(before.claudeRoutes);
    expect((await connections.list())[0].models).toEqual(models);
    expect((await service.resolveConnection('opus')).model).toBe(CLAUDE_ROUTE_MODELS.opus);
    expect(state.accounts.map((account) => account.priority)).toEqual([100, 0]);
  });

  it('keeps a pending Sonnet family separate from a healthy Opus upgrade', async () => {
    const { service, state } = await fixture();
    await service.setOpusRoute({ enabled: true });
    state.definitions.claude = [definition('claude-opus-5-6')];
    const status = await service.setSonnetRoute({ enabled: true });
    expect(status.sonnetFailover).toEqual({ enabled: true, ready: false });
    expect(status.opusFailover).toEqual({ enabled: true, ready: true });
    expect((await service.catalog()).find((model) => model.modelID === CLAUDE_ROUTE_MODELS.opus)?.name).toBe('Opus (Claude 5.6 / agy 5.5)');
    expect((await service.resolveConnection('sonnet')).model).toBe('sonnet[1m]');
    await service.setOpusRoute({ enabled: false });
    expect(state.accounts.map((account) => account.priority)).toEqual([null, 3]);
    state.definitions.claude.push({ ...definition('claude-sonnet-5-6'), max_completion_tokens: 64000 });
    await service.refreshFollowedModels();
    expect((await service.resolveConnection('sonnet')).model).toBe(CLAUDE_ROUTE_MODELS.sonnet);
    expect(state.accounts.map((account) => account.priority)).toEqual([100, 0]);
    await service.setSonnetRoute({ enabled: false });
    expect(state.accounts.map((account) => account.priority)).toEqual([null, 3]);
  });

  it('keeps one selectable Opus, routes legacy selections through the gateway, and preserves Sonnet launch state', async () => {
    const { connections, service, saved, selected, state, store } = await fixture();
    const sonnet = `connection:${saved.id}:${saved.models[1].id}`;
    const before = await service.resolveConnection(sonnet);
    await service.setOpusRoute({ enabled: true });
    const models = await service.catalog();
    expect(models.filter((model) => model.id === 'opus')).toEqual([]);
    expect(models.find((model) => model.id === selected)).toMatchObject({ name: 'Opus 5.5', efforts, aliases: [{ id: 'opus' }, { id: 'opus[1m]' }] });
    expect((await service.resolveConnection('opus', 'max')).model).toBe(OPUS_ROUTE_MODEL);
    expect((await service.resolveConnection(selected, 'low')).model).toBe(OPUS_ROUTE_MODEL);
    expect((await service.resolveConnection(sonnet)).key).toBe(before.key);
    expect(state.accounts.map((account) => account.priority)).toEqual([100, 0]);
    expect(state.aliases.claude).toContainEqual({ name: 'claude-sonnet-5-5', alias: 'my-sonnet' });
    expect(state.rebind).toBe('quota');
    const config = renderGatewayConfig(await store.read());
    expect(config).toContain('openchamber-opus');
    expect(config).toContain('claude-opus-5-5-high');
    expect((await connections.list())[0].models.find((model) => model.modelID === OPUS_ROUTE_MODEL).id).toBe(saved.models[0].id);
    expect(state.events).toBe(1);
  });

  it('follows each source independently, keeps names accurate, and uses common capabilities', async () => {
    const { service, state, selected } = await fixture();
    await service.setOpusRoute({ enabled: true });
    state.definitions.claude = [{ ...definition('claude-opus-5-6'), context_length: 2000000 }];
    const catalog = await service.catalog();
    expect(catalog.find((model) => model.id === selected)).toMatchObject({ name: 'Opus (Claude 5.6 / agy 5.5)', contextWindow: 1000000 });
    state.definitions.antigravity[0] = { ...definition('claude-opus-5-7-high'), thinking: { levels: ['low', 'high'] } };
    expect((await service.catalog()).find((model) => model.id === selected)).toMatchObject({ name: 'Opus (Claude 5.6 / agy 5.7)', efforts: ['low', 'high'] });
    state.definitions.claude = [];
    expect((await service.catalog()).find((model) => model.id === selected)?.name).toBe('Opus (Claude 5.6 / agy 5.7)');
  });

  it('waits for Claude authorization while preserving the working Antigravity entry', async () => {
    const { service, state, connections, store } = await fixture();
    state.accounts = state.accounts.filter((account) => account.provider !== 'claude');
    await service.setOpusRoute({ enabled: true });
    expect((await connections.list())[0].models[0].modelID).toBe('claude-opus-5-5-high');
    expect((await store.read()).claudeRoutes.opus.claude).toBeNull();
    expect(state.aliases.claude).toHaveLength(1);
    state.accounts.push({ name: 'new-primary.json', provider: 'claude', priority: null });
    await service.refreshFollowedModels();
    expect((await connections.list())[0].models[0].modelID).toBe(OPUS_ROUTE_MODEL);
  });

  it('restores the Antigravity row and original priorities when disabled', async () => {
    const { service, state, selected, connections, store } = await fixture();
    await service.setOpusRoute({ enabled: true });
    await service.setOpusRoute({ enabled: false });
    expect((await connections.list())[0].models[0]).toMatchObject({ modelID: 'claude-opus-5-5-high', followFamily: 'antigravity-opus' });
    expect((await service.resolveConnection(selected)).model).toBe('claude-opus-5-5-high');
    expect((await service.catalog()).some((model) => model.id === 'opus')).toBe(true);
    expect(state.accounts.map((account) => account.priority)).toEqual([null, 3]);
    expect(state.aliases.claude).toEqual([{ name: 'claude-sonnet-5-5', alias: 'my-sonnet' }]);
    expect(state.rebind).toBe('any');
    expect((await store.read()).claudeRoutes).toBeNull();
  });

  it('cleans up gateway aliases and priorities even after the user deletes the connection', async () => {
    const { service, connections, saved, state } = await fixture();
    await service.setOpusRoute({ enabled: true });
    await connections.remove(saved.id);
    await expect(service.resolveConnection('opus')).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_UNAVAILABLE' });
    await service.setOpusRoute({ enabled: false });
    expect(await connections.list()).toEqual([]);
    expect(state.accounts.map((account) => account.priority)).toEqual([null, 3]);
    expect(state.aliases.antigravity).toEqual([]);
    expect(state.rebind).toBe('any');
  });

  it('retains the unified row after one account leaves, then removes the route after the final logout', async () => {
    const { service, connections, saved, store } = await fixture();
    await service.setOpusRoute({ enabled: true });
    await service.removeAccount('primary.json');
    expect((await connections.list())[0].models[0]).toMatchObject({ id: saved.models[0].id, modelID: OPUS_ROUTE_MODEL });
    await service.removeAccount('backup.json');
    expect(await connections.list()).toEqual([]);
    expect((await store.read()).claudeRoutes).toBeNull();
    await service.refreshFollowedModels();
    expect(await connections.list()).toEqual([]);
  });

  it('rolls back changed priorities and keeps the working model if gateway configuration fails', async () => {
    const { service, connections, state, store } = await fixture();
    const before = await connections.list();
    state.failedConfig = true;
    await expect(service.setOpusRoute({ enabled: true })).rejects.toMatchObject({ code: 'CLIPROXYAPI_REQUEST_FAILED' });
    expect(await connections.list()).toEqual(before);
    expect(state.accounts.map((account) => account.priority)).toEqual([null, 3]);
    expect((await store.read()).claudeRoutes).toBeNull();
  });

  it('updates healthy Antigravity models while a Claude metadata request fails', async () => {
    const { service, connections, state, selected } = await fixture();
    await service.setOpusRoute({ enabled: true });
    state.failedPrimaryMetadata = true;
    state.definitions.antigravity = [definition('claude-opus-5-6-high'), definition('claude-sonnet-5-6-high')];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await service.catalog()).find((model) => model.id === selected)?.name).toBe('Opus (Claude 5.5 / agy 5.6)');
    expect((await connections.list())[0].models[1].modelID).toBe('claude-sonnet-5-6-high');
  });

  it('rejects a connection edit racing with gateway configuration instead of overwriting it', async () => {
    const { service, connections, state, saved } = await fixture();
    let once = true;
    state.beforeConfig = async () => { if (once) { once = false; await connections.save(saved.id, { ...saved, name: 'Edited' }); } };
    await expect(service.setOpusRoute({ enabled: true })).rejects.toMatchObject({ code: 'CLIPROXYAPI_OPUS_CHANGED' });
    expect((await connections.list())[0].name).toBe('Edited');
    expect((await connections.list())[0].models[0].modelID).toBe('claude-opus-5-5-high');
    expect(state.accounts.map((account) => account.priority)).toEqual([null, 3]);
  });

  it('refuses activation and unified launches under enterprise policy', async () => {
    const { service, selected } = await fixture();
    await service.setOpusRoute({ enabled: true });
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    await expect(service.setOpusRoute({ enabled: true })).rejects.toMatchObject({ code: 'enterprise_mode' });
    await expect(service.resolveConnection(selected)).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect((await service.resolveConnection('opus')).model).toBe('opus[1m]');
    expect((await service.catalog()).some((model) => model.modelID === OPUS_ROUTE_MODEL)).toBe(false);
    await service.setOpusRoute({ enabled: false });
    expect((await service.resolveConnection(selected)).model).toBe('claude-opus-5-5-high');
  });

  it('keeps one managed row on reimport and restores both files and gateway bindings after a failed save', async () => {
    const { service, state, connections, saved } = await fixture();
    await service.setOpusRoute({ enabled: true });
    await service.importModels();
    expect((await connections.list())[0].models.filter((model) => model.modelID === OPUS_ROUTE_MODEL)).toHaveLength(1);
    expect((await connections.list())[0].models.filter((model) => model.modelID.startsWith('claude-opus-'))).toHaveLength(0);
    expect((await connections.list())[0].models.find((model) => model.modelID === OPUS_ROUTE_MODEL).id).toBe(saved.models[0].id);
    const before = (await connections.list())[0].models;
    state.definitions.claude = [definition('claude-opus-5-6')];
    // The connection commit succeeds; the following gateway-store commit fails.
    const rename = fs.rename.bind(fs);
    const write = vi.spyOn(fs, 'rename');
    write.mockImplementationOnce(rename).mockImplementationOnce(async () => { throw new Error('fixture disk failure'); });
    await expect(service.refreshFollowedModels()).rejects.toThrow('fixture disk failure');
    expect((await connections.list())[0].models).toEqual(before);
    expect(state.aliases.claude).toContainEqual({ name: 'claude-opus-5-5', alias: OPUS_ROUTE_MODEL, fork: true });
  });
});
