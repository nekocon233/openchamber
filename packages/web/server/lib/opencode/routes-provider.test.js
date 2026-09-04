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
    readClaudeCliAuthStatus: vi.fn(() => ({ status: 'connected', connected: true, reason: 'logged-in' })),
    isExternalOpenCode: () => false,
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('provider auth runtime ownership', () => {
  it('reports external Claude auth as unavailable without probing the host CLI', async () => {
    const { app, dependencies } = createApp({ isExternalOpenCode: () => true });

    const response = await request(app).get('/api/provider/claude-code/source').expect(200);

    expect(response.body.sources.auth).toEqual({
      exists: false,
      status: 'unavailable',
      canDisconnect: false,
    });
    expect(dependencies.readClaudeCliAuthStatus).not.toHaveBeenCalled();
  });

  it('preserves an unavailable local CLI probe instead of reporting logged out', async () => {
    const { app } = createApp({
      readClaudeCliAuthStatus: () => ({ status: 'unavailable', connected: false, reason: 'invalid-status' }),
    });

    const response = await request(app).get('/api/provider/claude-code/source').expect(200);

    expect(response.body.sources.auth).toEqual({
      exists: false,
      status: 'unavailable',
      canDisconnect: false,
    });
  });

  it('refuses host-side disconnect mutations for an external runtime', async () => {
    const { app, dependencies } = createApp({ isExternalOpenCode: () => true });

    const response = await request(app)
      .delete('/api/provider/claude-code/auth?scope=all')
      .expect(200);

    expect(response.body).toMatchObject({
      success: false,
      removed: false,
      capability: 'unavailable',
      code: 'PROVIDER_AUTH_RUNTIME_UNAVAILABLE',
    });
    expect(dependencies.removeProviderConfig).not.toHaveBeenCalled();
  });

  it('does not treat local OpenCode auth removal as a Claude CLI logout', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .delete('/api/provider/claude-code/auth?scope=all')
      .expect(200);

    expect(response.body).toMatchObject({
      success: false,
      removed: false,
      capability: 'cli-owned',
      code: 'PROVIDER_AUTH_CLI_OWNED',
    });
    expect(dependencies.removeProviderConfig).not.toHaveBeenCalled();
  });
});
