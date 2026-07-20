import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTunnelAuth } from './tunnel-auth.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';
import { registerOpenCodeRoutes } from './routes.js';
import {
  createClientNotificationAuth,
  subscribeNotificationAuthInvalidation,
} from '../notifications/auth-runtime.js';

describe('core-routes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call gracefulShutdown with exitProcess: true on /api/system/shutdown', async () => {
    const app = express();
    let shutdownOpts = null;
    const dependencies = {
      gracefulShutdown: vi.fn(async (opts) => {
        shutdownOpts = opts;
      }),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app).post('/api/system/shutdown');

    expect(dependencies.gracefulShutdown).toHaveBeenCalled();
    expect(shutdownOpts).toEqual({ exitProcess: true });
  });

  it('should require UI auth before /api/system/shutdown when auth is configured', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Unauthorized' });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('should allow authenticated /api/system/shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, _res, next) => next()),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(200, { ok: true });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).toHaveBeenCalledWith({ exitProcess: true });
  });

  it('should reject passwordless tunneled shutdown requests without a tunnel session or client bearer', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        getTunnelSessionFromRequest: vi.fn(() => null),
      },
      uiAuthController: {
        enabled: false,
        requireAuth: vi.fn((_req, _res, next) => next()),
        requireClientAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Client authentication required' })),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Client authentication required' });

    expect(dependencies.tunnelAuthController.getTunnelSessionFromRequest).toHaveBeenCalledTimes(1);
    expect(dependencies.uiAuthController.requireAuth).not.toHaveBeenCalled();
    expect(dependencies.uiAuthController.requireClientAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('should accept a tunnel session for tunneled shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        getTunnelSessionFromRequest: vi.fn(() => ({ sessionId: 'tunnel-session' })),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'UI auth required' })),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(200, { ok: true });

    expect(dependencies.tunnelAuthController.getTunnelSessionFromRequest).toHaveBeenCalledTimes(1);
    expect(dependencies.uiAuthController.requireAuth).not.toHaveBeenCalled();
    expect(dependencies.gracefulShutdown).toHaveBeenCalledWith({ exitProcess: true });
  });

  it('protects status-owned API routes from passwordless public requests', async () => {
    const app = express();
    const requireClientAuth = vi.fn((req, res, next) => {
      if (req.headers.authorization === 'Bearer valid-client') return next();
      return res.status(401).json({ error: 'Client authentication required' });
    });
    registerServerStatusRoutes(app, {
      express,
      process,
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({}),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      serverStartedAt: 123,
      tunnelAuthController: {
        classifyRequestScope: () => 'unknown-public',
        getTunnelSessionFromRequest: () => null,
      },
      uiAuthController: {
        enabled: false,
        requireAuth: vi.fn((_req, _res, next) => next()),
        requireClientAuth,
      },
    });

    await request(app).get('/api/system/info').expect(401, { error: 'Client authentication required' });
    await request(app)
      .get('/api/system/info')
      .set('Authorization', 'Bearer valid-client')
      .expect(200);

    expect(requireClientAuth).toHaveBeenCalledTimes(2);
  });

  it('should allow UI password auth for tunnel-scoped browser sessions and APIs', async () => {
    const app = express();
    const dependencies = {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        getTunnelSessionFromRequest: vi.fn(() => null),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        enabled: true,
        requireAuth: vi.fn((_req, _res, next) => next()),
        handleSessionStatus: vi.fn((_req, res) => res.status(401).json({ authenticated: false, locked: true })),
        handleSessionCreate: vi.fn((_req, res) => res.json({ authenticated: true })),
        handlePasskeyStatus: vi.fn((_req, res) => res.json({ enabled: false })),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    };

    registerAuthAndAccessRoutes(app, dependencies);
    app.get('/api/private-test', (_req, res) => res.json({ ok: true }));

    await request(app)
      .get('/auth/session')
      .expect(401, { authenticated: false, locked: true });

    await request(app)
      .post('/auth/session')
      .send({ password: 'test-password' })
      .expect(200, { authenticated: true });

    await request(app)
      .get('/api/private-test')
      .expect(200, { ok: true });

    expect(dependencies.uiAuthController.handleSessionStatus).toHaveBeenCalledTimes(1);
    expect(dependencies.uiAuthController.handleSessionCreate).toHaveBeenCalledTimes(1);
    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
  });

  it('requires explicit client auth for passwordless managed/public API requests but preserves local trust', async () => {
    const app = express();
    let requestScope = 'unknown-public';
    const requireAuth = vi.fn((_req, _res, next) => next());
    const requireClientAuth = vi.fn((req, res, next) => {
      if (req.headers.authorization === 'Bearer valid-client') return next();
      return res.status(401).json({ error: 'Client authentication required' });
    });
    const dependencies = {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => requestScope,
        getTunnelSessionFromRequest: vi.fn(() => null),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        enabled: false,
        requireAuth,
        requireClientAuth,
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handleUrlAuthToken: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    };
    registerAuthAndAccessRoutes(app, dependencies);
    app.get('/api/private-test', (_req, res) => res.json({ ok: true }));

    await request(app).get('/api/private-test').expect(401, { error: 'Client authentication required' });
    await request(app)
      .get('/api/private-test')
      .set('Authorization', 'Bearer valid-client')
      .expect(200, { ok: true });

    requestScope = 'local';
    await request(app).get('/api/private-test').expect(200, { ok: true });

    expect(requireClientAuth).toHaveBeenCalledTimes(2);
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('requires a valid client bearer for relay-marked requests but keeps direct loopback passwordless', async () => {
    const app = express();
    const requireClientAuth = vi.fn((req, res, next) => {
      if (req.headers.authorization === 'Bearer valid-client') return next();
      return res.status(401).json({ error: 'Client authentication required' });
    });
    const requireAuth = vi.fn((_req, _res, next) => next());
    const uiAuthController = {
      requireAuth,
      requireClientAuth,
      handleSessionStatus: vi.fn(),
      handleSessionCreate: vi.fn(),
      handleUrlAuthToken: vi.fn(),
      handlePasskeyStatus: vi.fn(),
      handlePasskeyAuthenticationOptions: vi.fn(),
      handlePasskeyAuthenticationVerify: vi.fn(),
      handlePasskeyRegistrationOptions: vi.fn(),
      handlePasskeyRegistrationVerify: vi.fn(),
      handlePasskeyList: vi.fn(),
      handlePasskeyRevoke: vi.fn(),
      handleResetAuth: vi.fn(),
    };
    const tunnelAuthController = {
      classifyRequestScope: () => 'local',
      getTunnelSessionFromRequest: () => null,
      exchangeBootstrapToken: vi.fn(),
    };
    registerServerStatusRoutes(app, {
      express,
      process,
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      serverStartedAt: Date.now(),
      gracefulShutdown: vi.fn(),
      getHealthSnapshot: () => ({}),
      tunnelAuthController,
      uiAuthController,
    });
    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime: { listClients: vi.fn(async () => []) },
      clientPairingRuntime: {},
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });
    app.get('/api/private-test', (_req, res) => res.json({ ok: true }));

    const missing = await request(app)
      .get('/api/private-test')
      .set('X-OpenChamber-Relay-Connection', 'relay-connection')
      .expect(401, { error: 'Client authentication required' });
    expect(missing.headers['set-cookie']).toBeUndefined();

    const invalid = await request(app)
      .get('/api/private-test')
      .set('X-OpenChamber-Relay-Connection', 'relay-connection')
      .set('Authorization', 'Bearer invalid-client')
      .expect(401, { error: 'Client authentication required' });
    expect(invalid.headers['set-cookie']).toBeUndefined();

    await request(app)
      .get('/api/private-test')
      .set('X-OpenChamber-Relay-Connection', 'relay-connection')
      .set('Authorization', 'Bearer valid-client')
      .expect(200, { ok: true });

    await request(app)
      .get('/api/private-test')
      .expect(200, { ok: true });

    expect(requireClientAuth).toHaveBeenCalledTimes(3);
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('should mint short-lived URL auth for an authenticated tunnel session', async () => {
    const app = express();
    const tunnelSession = { sessionId: 'tunnel-session' };
    const issueUrlAuthTokenForSession = vi.fn(() => ({ token: 'url-token', expiresAt: 1234 }));
    const handleUrlAuthToken = vi.fn();

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        getTunnelSessionFromRequest: vi.fn(() => tunnelSession),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        issueUrlAuthTokenForSession,
        handleUrlAuthToken,
        requireAuth: vi.fn(),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    const response = await request(app)
      .post('/auth/url-token')
      .expect(200, { token: 'url-token', expiresAt: 1234 });

    expect(response.headers['cache-control']).toBe('no-store');
    expect(issueUrlAuthTokenForSession).toHaveBeenCalledWith(
      'tunnel:tunnel-session',
      expect.objectContaining({ kind: 'tunnel-session', identity: expect.stringMatching(/^notify:tunnel:/) }),
    );
    expect(handleUrlAuthToken).not.toHaveBeenCalled();
  });

  it('should parse JSON bodies for snippet config routes', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/config/snippets/example', (req, res) => {
      res.json({ body: req.body });
    });

    const response = await request(app)
      .post('/api/config/snippets/example')
      .send({ content: 'Snippet body' })
      .expect(200);

    expect(response.body).toEqual({ body: { content: 'Snippet body' } });
  });

  it('should require API auth before probing loopback preview URLs', async () => {
    const app = express();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth: (_req, res) => res.status(401).json({ error: 'Unauthorized' }),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    try {
      await request(app)
        .post('/api/system/probe-url')
        .send({ url: 'http://127.0.0.1:5173/' })
        .expect(401);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should probe loopback preview URLs and return ok: true for status codes 200-599', async () => {
    const app = express();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth: (_req, _res, next) => next(),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    try {
      const testCases = [
        { status: 200, expectedOk: true },
        { status: 302, expectedOk: true },
        { status: 404, expectedOk: true },
        { status: 500, expectedOk: true },
        { status: 600, expectedOk: false },
      ];

      for (const { status, expectedOk } of testCases) {
        fetchMock.mockResolvedValueOnce({
          status,
          ok: status >= 200 && status < 300,
        });

        const response = await request(app)
          .post('/api/system/probe-url')
          .send({ url: 'http://127.0.0.1:5173/' })
          .expect(200);

        expect(response.body).toEqual({ ok: expectedOk, status });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const createPairingRouteApp = (overrides = {}) => {
    const app = express();
    const dependencies = {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'session-token' })),
        requireAuth: vi.fn((_req, _res, next) => next()),
        requireSessionAuth: vi.fn((_req, _res, next) => next()),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handleUrlAuthToken: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      remoteClientAuthRuntime: {
        listClients: vi.fn(async () => []),
        createClient: vi.fn(),
        revokeClient: vi.fn(),
        purgeRevokedClients: vi.fn(),
      },
      clientPairingRuntime: {
        createPairingSession: vi.fn(async () => ({ pairing: { id: 'pair_1', secret: 'secret', expiresAt: '2099-01-01T00:00:00.000Z', fingerprint: 'ABCD-1234' } })),
        cancelPairingSession: vi.fn(async () => ({ cancelled: true })),
        redeemPairingSession: vi.fn(async () => ({
          pairing: { fingerprint: 'ABCD-1234' },
          client: { id: 'client-1', label: 'Phone', authMethod: 'pairing' },
          token: 'oc_client_token',
        })),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
      ...overrides,
    };
    registerAuthAndAccessRoutes(app, dependencies);
    return { app, dependencies };
  };

  it('creates pairing sessions behind owner auth and returns no-store payload data', async () => {
    const { app, dependencies } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', allowedClientKinds: ['mobile'] })
      .expect(201);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.pairing).toMatchObject({ id: 'pair_1', secret: 'secret' });
    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: 'http://runtime.example', priority: 10 }]);
    expect(dependencies.clientPairingRuntime.createPairingSession).toHaveBeenCalledWith({
      label: 'Pair phone',
      allowedClientKinds: ['mobile'],
      createdByClientId: null,
      usesRelay: false,
    });
  });

  it('advertises the caller-supplied serverUrl as the direct candidate over the request origin', async () => {
    const { app } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', serverUrl: 'http://192.168.1.20:2606' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:2606', priority: 10 },
    ]);
  });

  it('folds in a relay candidate when the host relay is enabled', async () => {
    const relayCandidate = {
      type: 'relay',
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv_1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' },
      priority: 30,
    };
    const { app } = createPairingRouteApp({ getRelayPairingCandidate: vi.fn(async () => relayCandidate) });

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://runtime.example', priority: 10 },
      relayCandidate,
    ]);
  });

  it('still returns the direct candidate when the relay candidate lookup throws', async () => {
    const { app } = createPairingRouteApp({
      getRelayPairingCandidate: vi.fn(async () => { throw new Error('relay status read failed'); }),
    });

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: 'http://runtime.example', priority: 10 }]);
  });

  it('requires owner auth before creating or cancelling pairing sessions', async () => {
    const { app, dependencies } = createPairingRouteApp({
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => null),
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
        requireSessionAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
      },
    });

    await request(app).post('/api/client-auth/pairing/sessions').send({}).expect(401);
    await request(app).delete('/api/client-auth/pairing/sessions/pair_1').expect(401);
    expect(dependencies.clientPairingRuntime.createPairingSession).not.toHaveBeenCalled();
    expect(dependencies.clientPairingRuntime.cancelPairingSession).not.toHaveBeenCalled();
  });

  it('redeems pairing sessions with no-store response and generic errors', async () => {
    const { app, dependencies } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('Host', 'runtime.example')
      .send({ pairingId: 'pair_1', secret: 'secret', clientKind: 'mobile', deviceName: 'Phone' })
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      ok: true,
      server: { label: 'OpenChamber', url: 'http://runtime.example', fingerprint: 'ABCD-1234' },
      client: { id: 'client-1', authMethod: 'pairing' },
      clientToken: 'oc_client_token',
    });
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledWith(expect.objectContaining({
      pairingId: 'pair_1',
      secret: 'secret',
      clientKind: 'mobile',
      deviceName: 'Phone',
    }));

    dependencies.clientPairingRuntime.redeemPairingSession.mockRejectedValueOnce(new Error('Invalid or expired pairing session'));
    await request(app)
      .post('/api/client-auth/pairing/redeem')
      .send({ pairingId: 'pair_2', secret: 'wrong' })
      .expect(400, { error: 'Invalid or expired pairing session' });
  });

  it('rate limits pairing redeem attempts by socket address and pairingId, then resets after the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { app, dependencies } = createPairingRouteApp();
    app.set('trust proxy', true);
    dependencies.clientPairingRuntime.redeemPairingSession.mockRejectedValue(new Error('Invalid or expired pairing session'));

    // The X-Forwarded-For headers below are deliberate spoof attempts: the rate
    // limiter buckets by socket address (not forwarded headers), so rotating the
    // header must NOT reset the counter or evade the lockout.
    for (let index = 0; index < 10; index += 1) {
      await request(app)
        .post('/api/client-auth/pairing/redeem')
        .set('X-Forwarded-For', `203.0.113.${index}`)
        .send({ pairingId: 'pair_rate', secret: `wrong-${index}` })
        .expect(400, { error: 'Invalid or expired pairing session' });
    }

    const locked = await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ pairingId: 'pair_rate', secret: 'wrong-locked' })
      .expect(429, { error: 'Invalid or expired pairing session' });
    expect(locked.headers['retry-after']).toBe('300');
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledTimes(10);

    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ pairingId: 'pair_rate', secret: 'wrong-after-reset' })
      .expect(400, { error: 'Invalid or expired pairing session' });
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledTimes(11);
  });

  it('should let preview proxy credentials reach preview proxy validation', async () => {
    const app = express();
    const requireAuth = vi.fn((_req, res) => res.status(401).type('text/plain').send('Authentication required'));

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth,
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    app.use('/api/preview/proxy', (_req, res) => res.json({ reached: true }));

    await request(app)
      .get('/api/preview/proxy/abc123/?oc_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .set('Cookie', 'oc_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .expect(401, 'Authentication required');

    expect(requireAuth).toHaveBeenCalledTimes(1);
  });
});

describe('client auth routes', () => {
  const createDependencies = (options = {}) => {
    const clients = [];
    const requireAuth = vi.fn((_req, _res, next) => next());
    const requireSessionAuth = vi.fn((_req, _res, next) => next());
    const resolveAuthContext = vi.fn(options.resolveAuthContext || (async () => ({ type: 'session' })));
    return {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        getTunnelSessionFromRequest: () => null,
        clearTunnelSessionCookie: () => {},
        requireTunnelSession: (_req, _res, next) => next(),
      },
      uiAuthController: {
        handleSessionStatus: (_req, res) => res.json({ authenticated: true }),
        handleSessionCreate: (_req, res) => res.json({ authenticated: true }),
        handlePasskeyStatus: (_req, res) => res.json({ enabled: false }),
        handlePasskeyAuthenticationOptions: (_req, res) => res.json({}),
        handlePasskeyAuthenticationVerify: (_req, res) => res.json({ authenticated: true }),
        requireAuth,
        requireSessionAuth,
        resolveAuthContext,
        handlePasskeyRegistrationOptions: (_req, res) => res.json({}),
        handlePasskeyRegistrationVerify: (_req, res) => res.json({}),
        handlePasskeyList: (_req, res) => res.json({ passkeys: [] }),
        handlePasskeyRevoke: (_req, res) => res.json({ revoked: true }),
        handleResetAuth: (_req, res) => res.json({ cleared: true }),
      },
      remoteClientAuthRuntime: {
        listClients: async () => clients,
        createClient: async ({ label, clientKind }) => {
          const client = {
            id: `client-${clients.length + 1}`,
            label: label || 'Remote client',
            createdAt: 'now',
            lastUsedAt: null,
            revokedAt: null,
            clientKind: clientKind || null,
          };
          clients.push(client);
          return { client, token: 'oc_client_secret' };
        },
        revokeClient: async (id) => {
          const client = clients.find((entry) => entry.id === id);
          if (!client) return { revoked: false };
          client.revokedAt = 'revoked';
          return { revoked: true, client };
        },
        purgeRevokedClients: async () => {
          const before = clients.length;
          for (let index = clients.length - 1; index >= 0; index -= 1) {
            if (clients[index].revokedAt) clients.splice(index, 1);
          }
          return { purged: before - clients.length };
        },
      },
      readSettingsFromDiskMigrated: async () => ({}),
      normalizeTunnelSessionTtlMs: () => 1000,
      testHooks: { clients, requireAuth, requireSessionAuth, resolveAuthContext },
    };
  };

  it('creates, lists, and revokes remote client tokens', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);
    const invalidations = [];
    const unsubscribeInvalidation = subscribeNotificationAuthInvalidation((selector) => {
      invalidations.push(selector);
    });

    const created = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Laptop' });
    expect(created.status).toBe(201);
    expect(created.body.token).toBe('oc_client_secret');
    expect(created.headers['cache-control']).toBe('no-store');

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toHaveLength(1);
    expect(listed.body.clients[0]).not.toHaveProperty('token');

    const revoked = await request(app).delete('/api/client-auth/clients/client-1');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(invalidations).toContainEqual({ identity: createClientNotificationAuth('client-1').identity });

    const purged = await request(app).delete('/api/client-auth/clients');
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(1);

    const listedAfterPurge = await request(app).get('/api/client-auth/clients');
    expect(listedAfterPurge.body.clients).toHaveLength(0);
    unsubscribeInvalidation();
  });

  it('reports current connection candidates with server identity for paired devices', async () => {
    const app = express();
    const relayCandidate = {
      type: 'relay',
      relayUrl: 'wss://relay.example/ws',
      serverId: 'server-abc',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      priority: 30,
    };
    const dependencies = {
      ...createDependencies({ resolveAuthContext: async () => ({ type: 'client', clientId: 'client-1' }) }),
      getDirectCandidateUrls: () => ['http://192.168.1.20:3000', 'http://10.0.0.5:3000', 'not-a-url'],
      getRelayPairingCandidate: async () => relayCandidate,
      getServerId: async () => 'server-abc',
      getServerLabel: () => 'my-host',
    };
    registerAuthAndAccessRoutes(app, dependencies);

    const response = await request(app).get('/api/client-auth/connection/candidates');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.serverId).toBe('server-abc');
    expect(response.body.label).toBe('my-host');
    expect(response.body.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:3000', priority: 10 },
      { type: 'lan', url: 'http://10.0.0.5:3000', priority: 10 },
      relayCandidate,
    ]);
  });

  it('omits serverId and relay candidate when unavailable and survives failures', async () => {
    const app = express();
    const dependencies = {
      ...createDependencies(),
      getDirectCandidateUrls: () => {
        throw new Error('scan failed');
      },
      getRelayPairingCandidate: async () => {
        throw new Error('relay status failed');
      },
      getServerId: async () => null,
    };
    registerAuthAndAccessRoutes(app, dependencies);

    const response = await request(app).get('/api/client-auth/connection/candidates');
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('serverId');
    expect(response.body.candidates).toEqual([]);
  });

  it('scopes non-desktop client credentials to list and revoke only themselves', async () => {
    const app = express();
    let authContext = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const current = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'OpenChamber Desktop', clientKind: 'desktop-local' });
    const other = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Other device' });

    // A regular (non-desktop-local) client token only sees and manages itself.
    authContext = { type: 'client', clientId: other.body.client.id, client: other.body.client };

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toEqual([other.body.client]);

    const denied = await request(app).delete(`/api/client-auth/clients/${current.body.client.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.revoked).toBe(false);

    const deniedPurge = await request(app).delete('/api/client-auth/clients');
    expect(deniedPurge.status).toBe(403);

    const revoked = await request(app).delete(`/api/client-auth/clients/${other.body.client.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.client.id).toBe(other.body.client.id);
  });

  it('lets the local desktop client list and revoke every device', async () => {
    const app = express();
    let authContext = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const desktop = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'OpenChamber Desktop', clientKind: 'desktop-local' });
    const other = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Other device' });

    // The trusted desktop shell client manages all devices like a UI session.
    authContext = { type: 'client', clientId: desktop.body.client.id, client: desktop.body.client };

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    const listedIds = listed.body.clients.map((client) => client.id).sort();
    expect(listedIds).toEqual([desktop.body.client.id, other.body.client.id].sort());

    const revoked = await request(app).delete(`/api/client-auth/clients/${other.body.client.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.client.id).toBe(other.body.client.id);

    const purged = await request(app).delete('/api/client-auth/clients');
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(1);
  });

  it('allows only the local desktop client token to create remote client tokens', async () => {
    const app = express();
    let authContext = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const desktop = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'OpenChamber Desktop', clientKind: 'desktop-local' });
    const remote = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Phone' });

    authContext = { type: 'client', clientId: remote.body.client.id, client: remote.body.client };
    const denied = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Another phone' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Client tokens cannot create remote clients');

    authContext = { type: 'client', clientId: desktop.body.client.id, client: desktop.body.client };
    const created = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Mobile' });
    expect(created.status).toBe(201);
    expect(created.body.client.label).toBe('Mobile');
  });

  it('requires UI-session auth for passkey registration management routes', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);

    await request(app).post('/auth/passkey/register/options').expect(200);
    await request(app).post('/auth/passkey/register/verify').expect(200);

    expect(dependencies.testHooks.requireSessionAuth).toHaveBeenCalledTimes(2);
    expect(dependencies.testHooks.requireAuth).not.toHaveBeenCalled();
  });

  it('treats private LAN hosts as local even when a tunnel is active', async () => {
    const app = express();
    const dependencies = createDependencies();
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://tunnel.example.com' });
    dependencies.tunnelAuthController = tunnelAuthController;
    dependencies.uiAuthController.handlePasskeyStatus = vi.fn((_req, res) => {
      res.json({ enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'example.com' });
    });

    registerAuthAndAccessRoutes(app, dependencies);

    await request(app)
      .get('/auth/passkey/status')
      .set('Host', '192.168.1.5:57123')
      .expect(200, { enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'example.com' });

    expect(dependencies.uiAuthController.handlePasskeyStatus).toHaveBeenCalledTimes(1);
  });

  it('does not trust a private Host header from a public socket peer', () => {
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://tunnel.example.com' });

    expect(tunnelAuthController.classifyRequestScope({
      headers: { host: '192.168.1.5:57123' },
      socket: { remoteAddress: '203.0.113.10' },
    })).toBe('unknown-public');
  });

  it('classifies a public peer as unknown-public even when no tunnel is active', () => {
    const tunnelAuthController = createTunnelAuth();

    expect(tunnelAuthController.classifyRequestScope({
      headers: { host: 'public.example.com' },
      socket: { remoteAddress: '203.0.113.10' },
    })).toBe('unknown-public');
  });

  it('allows tunnel management only from a direct loopback-local request', () => {
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://tunnel.example.com' });

    expect(tunnelAuthController.isLocalManagementRequest({
      headers: { host: '127.0.0.1:3000' },
      socket: { remoteAddress: '127.0.0.1' },
    })).toBe(true);
    expect(tunnelAuthController.isLocalManagementRequest({
      headers: { host: '192.168.1.5:3000' },
      socket: { remoteAddress: '192.168.1.20' },
    })).toBe(false);
    expect(tunnelAuthController.isLocalManagementRequest({
      headers: { host: 'tunnel.example.com' },
      socket: { remoteAddress: '127.0.0.1' },
    })).toBe(false);
    expect(tunnelAuthController.isLocalManagementRequest({
      headers: { host: '127.0.0.1:3000', 'x-openchamber-relay-connection': 'relay-1' },
      socket: { remoteAddress: '127.0.0.1' },
    })).toBe(false);
    expect(tunnelAuthController.isLocalManagementRequest({
      headers: { host: '127.0.0.1:3000' },
      socket: { remoteAddress: '127.0.0.1' },
      openchamberExternalAuthenticated: true,
    })).toBe(false);
  });

  it('rejects remote tunnel settings writes without blocking unrelated settings', async () => {
    const app = express();
    app.use(express.json());
    const persistSettings = vi.fn(async (changes) => changes);
    const assertSettingsWriteAllowed = vi.fn();
    registerOpenCodeRoutes(app, {
      persistSettings,
      sidebarStateRuntime: { assertSettingsWriteAllowed },
      isTunnelManagementAllowed: (req) => req.headers['x-host-local'] === '1',
    });

    await request(app)
      .put('/api/config/settings')
      .send({ frpcServerAddress: 'frps.example.com' })
      .expect(403, {
        error: 'Tunnel management is only available from the host machine',
        code: 'host_only',
      });
    await request(app)
      .put('/api/config/settings')
      .set('x-host-local', '1')
      .send({ frpcServerAddress: 'frps.example.com' })
      .expect(200, { frpcServerAddress: 'frps.example.com' });
    await request(app)
      .put('/api/config/settings')
      .send({ themeId: 'system' })
      .expect(200, { themeId: 'system' });

    expect(persistSettings).toHaveBeenCalledTimes(2);
    expect(assertSettingsWriteAllowed).toHaveBeenCalledTimes(2);
  });
});
