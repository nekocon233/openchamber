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
