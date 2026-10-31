import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
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
