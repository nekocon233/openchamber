import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const createSources = () => ({
  sources: {
    auth: { exists: false },
    user: { exists: true, path: '/config/opencode.json' },
    project: { exists: false, path: null },
    custom: { exists: false, path: null },
  },
});

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    resolveProjectDirectory: vi.fn(async () => ({ directory: null, error: null })),
    getProviderSources: vi.fn(createSources),
    removeProviderConfig: vi.fn(() => true),
    isExternalOpenCode: () => false,
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('provider auth runtime ownership', () => {
  it('reports provider auth as unavailable for an external runtime', async () => {
    const { app } = createApp({ isExternalOpenCode: () => true });

    const response = await request(app).get('/api/provider/anthropic/source').expect(200);

    expect(response.body.sources.auth).toEqual({
      exists: false,
      status: 'unavailable',
      canDisconnect: false,
    });
  });

  it('refuses host-side disconnect mutations for an external runtime', async () => {
    const { app, dependencies } = createApp({ isExternalOpenCode: () => true });

    const response = await request(app)
      .delete('/api/provider/anthropic/auth?scope=all')
      .expect(200);

    expect(response.body).toMatchObject({
      success: false,
      removed: false,
      capability: 'unavailable',
      code: 'PROVIDER_AUTH_RUNTIME_UNAVAILABLE',
    });
    expect(dependencies.removeProviderConfig).not.toHaveBeenCalled();
  });
});
