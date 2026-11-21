import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { attachExtensionQuotaProvider, detachExtensionQuotaProvider } from './extension-registry.js';
import { QuotaRouteError } from './route-error.js';
import { registerQuotaRoutes } from './routes.js';

const createExternalApp = () => {
  const app = express();
  const getQuotaProviders = vi.fn(async () => ({
    listConfiguredQuotaProviders: vi.fn(),
    fetchQuotaForProvider: vi.fn(),
  }));
  registerQuotaRoutes(app, {
    getQuotaProviders,
    isExternalOpenCode: () => true,
  });
  return { app, getQuotaProviders };
};

describe('external OpenCode quota ownership', () => {
  it('reads a server-owned Antigravity CLI quota independently of external OpenCode', async () => {
    const app = express();
    const result = { providerId: 'antigravity-cli', providerName: 'Antigravity CLI', ok: true, configured: true, usage: { windows: {} }, fetchedAt: 1 };
    const getQuotaProviders = vi.fn();
    const nativeAntigravity = vi.fn(async () => result);
    registerQuotaRoutes(app, { getQuotaProviders, isExternalOpenCode: () => true, nativeAntigravity });
    expect((await request(app).get('/api/quota/antigravity-cli').expect(200)).body).toEqual(result);
    expect(nativeAntigravity).toHaveBeenCalledOnce();
    expect(getQuotaProviders).not.toHaveBeenCalled();
  });
  it('does not inspect host credentials while listing providers', async () => {
    const { app, getQuotaProviders } = createExternalApp();

    const response = await request(app).get('/api/quota/providers').expect(200);

    expect(response.body).toEqual({ providers: [], availability: 'unsupported' });
    expect(getQuotaProviders).not.toHaveBeenCalled();
  });

  it('returns an explicit unsupported result without loading a provider', async () => {
    const { app, getQuotaProviders } = createExternalApp();

    const response = await request(app).get('/api/quota/claude').expect(200);

    expect(response.body).toMatchObject({
      providerId: 'claude',
      ok: false,
      configured: false,
      usage: null,
      availability: 'unsupported',
    });
    expect(getQuotaProviders).not.toHaveBeenCalled();
  });
});

it('passes the serving instance scope and refresh metadata through the quota route', async () => {
  const app = express();
  const quota = {
    providerId: 'claude', providerName: 'Claude', configured: true, ok: false, usage: null, fetchedAt: 123,
    refresh: { state: 'rate-limited', sampledAt: null, nextAttemptAt: 300_123 },
  };
  const fetchQuotaForProvider = vi.fn(async () => quota);
  registerQuotaRoutes(app, { getQuotaProviders: async () => ({ fetchQuotaForProvider }) });
  const response = await request(app).get('/api/quota/claude').expect(200);
  expect(response.body).toEqual(quota);
  expect(fetchQuotaForProvider).toHaveBeenCalledWith('claude', {
    claudeCacheScope: expect.stringMatching(/^(web:\d+|desktop)$/),
  });
});

it('reads only the stored Claude result, including when no sample exists', async () => {
  const app = express();
  const readCachedClaudeQuota = vi.fn(async () => null);
  const fetchQuotaForProvider = vi.fn();
  registerQuotaRoutes(app, { getQuotaProviders: async () => ({ readCachedClaudeQuota, fetchQuotaForProvider }) });
  const response = await request(app).get('/api/quota/claude/cached').expect(200);
  expect(response.body).toBeNull();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(readCachedClaudeQuota).toHaveBeenCalledWith(expect.stringMatching(/^(web:\d+|desktop)$/));
  expect(fetchQuotaForProvider).not.toHaveBeenCalled();
});

it('does not inspect host credentials for an unsupported external runtime cache', async () => {
  const { app, getQuotaProviders } = createExternalApp();
  const response = await request(app).get('/api/quota/claude/cached').expect(200);
  expect(response.body).toMatchObject({ providerId: 'claude', configured: false, availability: 'unsupported' });
  expect(getQuotaProviders).not.toHaveBeenCalled();
});

it('separates Magpie cache reads from explicit refresh without loading OpenCode credentials', async () => {
  const app = express();
  const quota = { providerId: 'magpie', ok: true, configured: true, usage: { windows: {}, accounts: [] }, fetchedAt: 1 };
  const magpieQuota = vi.fn(async () => quota);
  const getQuotaProviders = vi.fn();
  registerQuotaRoutes(app, { getQuotaProviders, magpieQuota });
  expect((await request(app).get('/api/quota/magpie').expect(200)).body).toEqual(quota);
  expect((await request(app).post('/api/quota/magpie/refresh').expect(200)).body).toEqual(quota);
  expect(magpieQuota.mock.calls).toEqual([[{ refresh: false }], [{ refresh: true }]]);
  expect(getQuotaProviders).not.toHaveBeenCalled();
});

it('refuses both Magpie operations for an external runtime before reading local state', async () => {
  const app = express();
  const magpieQuota = vi.fn();
  registerQuotaRoutes(app, { getQuotaProviders: vi.fn(), magpieQuota, isExternalOpenCode: () => true });
  for (const response of [await request(app).get('/api/quota/magpie'), await request(app).post('/api/quota/magpie/refresh')]) {
    expect(response.body).toMatchObject({ providerId: 'magpie', availability: 'unsupported', configured: false, usage: null });
  }
  expect(magpieQuota).not.toHaveBeenCalled();
});

const app = (providers) => {
  const server = express();
  registerQuotaRoutes(server, { getQuotaProviders: async () => providers });
  return server;
};

describe('quota routes with extension providers', () => {
  it('lists the extensions\' providers from memory, without the quota module or OpenCode', async () => {
    attachExtensionQuotaProvider({ providerId: 'ext-teapot-usage', providerName: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' });
    try {
      const server = express();
      const getQuotaProviders = vi.fn(async () => { throw new Error('OpenCode is not connected yet'); });
      registerQuotaRoutes(server, { getQuotaProviders });
      const response = await request(server).get('/api/quota/extensions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ extensions: [{ id: 'ext-teapot-usage', name: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' }] });
      expect(getQuotaProviders).not.toHaveBeenCalled();
    } finally {
      detachExtensionQuotaProvider('ext-teapot-usage');
    }
  });

  it('answers an extension\'s malformed answer with its own status and code, and anything else with 500', async () => {
    const malformed = await request(app({
      fetchQuotaForProvider: async () => { throw new QuotaRouteError(502, 'MALFORMED_PROVIDER_RESPONSE', 'Teapot Usage answered something OpenChamber cannot use: not JSON'); },
    })).get('/api/quota/ext-teapot-usage');
    expect(malformed.status).toBe(502);
    expect(malformed.body).toEqual({ code: 'MALFORMED_PROVIDER_RESPONSE', error: 'Teapot Usage answered something OpenChamber cannot use: not JSON' });

    // A built-in's error that happens to carry a status and a code stays 500: only the extension layer's branded error is answered as it is.
    const plain = await request(app({
      fetchQuotaForProvider: async () => { throw Object.assign(new Error('upstream said no'), { status: 401, code: 'UNAUTHORIZED' }); },
    })).get('/api/quota/codex');
    expect(plain.status).toBe(500);
    expect(plain.body).toEqual({ error: 'upstream said no' });
  });
});

describe('managed credential dictionary boundary', () => {
  it.each([
    ['missing-provider', 404, 'UNSUPPORTED_PROVIDER', 'Unsupported credential provider'],
    ['constructor', 404, 'UNSUPPORTED_PROVIDER', 'Unsupported credential provider'],
    ['__proto__', 404, 'UNSUPPORTED_PROVIDER', 'Unsupported credential provider'],
  ])('answers 404 for %s, which is not a credential provider', async (providerId, status, code, error) => {
    const server = app({});
    server.use((cause, _req, res, _next) => {
      res.status(500).json({ code: cause.name, error: cause.message });
    });

    const response = await request(server)
      .put(`/api/quota/credentials/${providerId}`)
      .send({ usageToken: 'test-token' });

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code, error });
  });
});

describe('z.ai gift reset activation route', () => {
  beforeEach(() => {
    configureOpenCodeCredentials({ list: async () => [{
      id: 'test-zai', integrationID: 'zai-coding-plan', label: 'default', active: true,
      value: { type: 'key', key: 'test-token' },
    }] });
  });

  afterEach(() => {
    configureOpenCodeCredentials(null);
    vi.unstubAllGlobals();
  });

  const activate = async (body) => {
    const upstream = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, msg: 'success', data: 1, success: true }),
    });
    vi.stubGlobal('fetch', upstream);
    const response = await request(app({})).post('/api/quota/zai-coding-plan/gift-reset/use').send(body);
    return { response, upstream };
  };

  it('sends GLOBAL upstream when the record carried no grantType', async () => {
    const { response, upstream } = await activate({ recordId: 462029, resetType: 'FIVE_HOUR' });

    expect(response.status).toBe(200);
    expect(JSON.parse(upstream.mock.calls[0][1].body).grantType).toBe('GLOBAL');
  });

  it('sends the record grantType upstream unchanged', async () => {
    const { response, upstream } = await activate({ recordId: 462029, resetType: 'WEEK', grantType: 'ACTIVITY' });

    expect(response.status).toBe(200);
    expect(JSON.parse(upstream.mock.calls[0][1].body).grantType).toBe('ACTIVITY');
  });

  it.each([[''], ['   '], [null], [7]])('answers 400 without calling upstream for grantType %j', async (grantType) => {
    const { response, upstream } = await activate({ recordId: 462029, resetType: 'WEEK', grantType });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST');
    expect(upstream).not.toHaveBeenCalled();
  });
});
