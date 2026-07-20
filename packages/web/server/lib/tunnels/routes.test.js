import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';

import { createTunnelRoutesRuntime } from './routes.js';
import {
  normalizeFrpcCustomDomain,
  normalizeFrpcPublicHostname,
  normalizeFrpcPublicUrl,
} from './frpc-client.js';
import {
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_FRPC,
  TunnelServiceError,
  normalizeTunnelMode,
  normalizeTunnelProvider,
} from './types.js';

const createApp = () => {
  const handlers = { get: new Map(), post: new Map(), put: new Map() };
  return {
    handlers,
    get: (route, handler) => handlers.get.set(route, handler),
    post: (route, handler) => handlers.post.set(route, handler),
    put: (route, handler) => handlers.put.set(route, handler),
  };
};

const invoke = async (handler, req = {}) => {
  const result = { status: 200, body: null };
  const res = {
    status: (status) => {
      result.status = status;
      return res;
    },
    json: (body) => {
      result.body = body;
      return body;
    },
  };
  await handler({ query: {}, body: {}, ...req }, res);
  return result;
};

const createRuntime = ({
  tunnelService,
  upsertFrpcTunnelConfig,
  tunnelAuthController,
  settings = {
    tunnelProvider: TUNNEL_PROVIDER_FRPC,
    tunnelMode: TUNNEL_MODE_MANAGED_REMOTE,
    frpcServerAddress: '203.0.113.10',
    frpcServerPort: 7000,
    frpcTrustedCaFile: '/home/openchamber/frp/ca.crt',
    frpcProxyType: 'tcp',
    frpcRemotePort: 18080,
    frpcPublicUrl: 'https://app.example.com:18080',
  },
  frpcConfig = null,
  frpcConfigReadError = null,
  readManagedRemoteTunnelConfigFromDisk = async () => ({ tunnels: [] }),
  getActiveTunnelController = () => null,
  isLocalManagementRequest = () => true,
}) => {
  const provider = {
    capabilities: {
      provider: TUNNEL_PROVIDER_FRPC,
      defaults: { mode: TUNNEL_MODE_MANAGED_REMOTE },
      modes: [{
        key: TUNNEL_MODE_MANAGED_REMOTE,
        requires: ['serverAddress', 'serverPort', 'trustedCaFile', 'token'],
      }],
    },
  };
  return createTunnelRoutesRuntime({
    crypto: { randomUUID: () => 'tunnel-id' },
    URL,
    tunnelService,
    tunnelProviderRegistry: {
      get: (id) => id === TUNNEL_PROVIDER_FRPC ? provider : null,
      listCapabilities: () => [provider.capabilities],
    },
    tunnelAuthController: {
      ...tunnelAuthController,
      isLocalManagementRequest,
    },
    readSettingsFromDiskMigrated: async () => settings,
    readManagedRemoteTunnelConfigFromDisk,
    readFrpcTunnelConfigFromDisk: async () => {
      if (frpcConfigReadError) throw frpcConfigReadError;
      return frpcConfig;
    },
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.trim() || undefined : undefined,
    normalizeFrpcCustomDomain,
    normalizeFrpcPublicHostname,
    normalizeFrpcPublicUrl,
    normalizeTunnelBootstrapTtlMs: (value) => value ?? 600000,
    normalizeTunnelSessionTtlMs: (value) => value ?? 86400000,
    isSupportedTunnelMode: (mode) => mode === TUNNEL_MODE_MANAGED_REMOTE,
    upsertManagedRemoteTunnelToken: async () => undefined,
    resolveManagedRemoteTunnelToken: async () => '',
    upsertFrpcTunnelConfig,
    resolveFrpcTunnelToken: async () => '',
    TUNNEL_MODE_QUICK: 'quick',
    TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TUNNEL_PROVIDER_FRPC,
    TunnelServiceError,
    getActivePort: () => 3000,
    getRuntimeManagedRemoteTunnelHostname: () => '',
    setRuntimeManagedRemoteTunnelHostname: () => undefined,
    getRuntimeManagedRemoteTunnelToken: () => '',
    setRuntimeManagedRemoteTunnelToken: () => undefined,
    getActiveTunnelController,
  });
};

describe('FRPC tunnel routes', () => {
  it('exposes only public status and rejects tunnel management away from the host', async () => {
    let stopCalls = 0;
    let checkCalls = 0;
    const tunnelService = {
      stop: async () => { stopCalls += 1; },
      resolveActiveMode: () => TUNNEL_MODE_MANAGED_REMOTE,
      resolveActiveProvider: () => TUNNEL_PROVIDER_FRPC,
      getPublicUrl: () => 'https://app.example.com',
      getProviderMetadata: () => ({ trustedCaFile: '/private/ca.crt' }),
      checkAvailability: async () => { checkCalls += 1; return { available: true }; },
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => 'tunnel-1',
      getActiveTunnelMode: () => TUNNEL_MODE_MANAGED_REMOTE,
      getActiveTunnelHost: () => 'app.example.com',
      setActiveTunnel: () => undefined,
      getBootstrapStatus: () => ({ hasBootstrapToken: true, bootstrapExpiresAt: 123 }),
      listTunnelSessions: () => [{ sessionId: 'sensitive-session-token' }],
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
      isLocalManagementRequest: () => false,
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const check = await invoke(app.handlers.get.get('/api/openchamber/tunnel/check'));
    const providers = await invoke(app.handlers.get.get('/api/openchamber/tunnel/providers'));
    const status = await invoke(app.handlers.get.get('/api/openchamber/tunnel/status'));
    const doctor = await invoke(app.handlers.get.get('/api/openchamber/tunnel/doctor'));
    const tokenWrite = await invoke(app.handlers.put.get('/api/openchamber/tunnel/managed-remote-token'));
    const start = await invoke(app.handlers.post.get('/api/openchamber/tunnel/start'));
    const stop = await invoke(app.handlers.post.get('/api/openchamber/tunnel/stop'));

    expect(check.body).toMatchObject({ available: false, managementAllowed: false });
    expect(providers.body).toEqual({ providers: [], managementAllowed: false });
    expect(status.body).toEqual({
      active: true,
      url: 'https://app.example.com',
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      provider: TUNNEL_PROVIDER_FRPC,
      managementAllowed: false,
      policy: 'host-only-management',
      activeTunnelMode: TUNNEL_MODE_MANAGED_REMOTE,
      activeSessions: [],
    });
    expect(JSON.stringify(status.body)).not.toContain('sensitive-session-token');
    expect(JSON.stringify(status.body)).not.toContain('/private/ca.crt');
    for (const response of [doctor, tokenWrite, start, stop]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ ok: false, code: 'host_only' });
    }
    expect(checkCalls).toBe(0);
    expect(stopCalls).toBe(0);
  });

  it('reports the last successful private endpoint ahead of stale draft settings', async () => {
    const tunnelService = {
      stop: () => false,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      setActiveTunnel: () => undefined,
      getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
      listTunnelSessions: () => [],
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
      frpcConfig: {
        version: 2,
        serverAddress: '203.0.113.10',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        proxyType: 'tcp',
        remotePort: 20000,
        publicUrl: 'https://private.example.com:20000',
        token: 'private-token',
      },
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const response = await invoke(app.handlers.get.get('/api/openchamber/tunnel/status'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      active: false,
      frpcServerAddress: '203.0.113.10',
      frpcServerPort: 7000,
      frpcTrustedCaFile: '/home/openchamber/frp/ca.crt',
      frpcRemotePort: 20000,
      frpcPublicUrl: 'https://private.example.com:20000',
      frpcProxyType: 'tcp',
      frpcCustomDomain: null,
      frpcPublicHostname: null,
      hasFrpcTunnelToken: true,
      frpcConfigStatus: 'ready',
    });
    expect(JSON.stringify(response.body)).not.toContain('private-token');
  });

  it('reports a private HTTP endpoint atomically ahead of stale TCP settings', async () => {
    const tunnelService = {
      stop: () => false,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      setActiveTunnel: () => undefined,
      getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
      listTunnelSessions: () => [],
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
      frpcConfig: {
        version: 2,
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        proxyType: 'http',
        customDomain: 'route.example.com',
        hostname: 'public.example.com',
        token: 'private-http-token',
      },
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const response = await invoke(app.handlers.get.get('/api/openchamber/tunnel/status'));

    expect(response.body).toMatchObject({
      active: false,
      hasFrpcTunnelToken: true,
      frpcServerAddress: 'frps.example.com',
      frpcServerPort: 7000,
      frpcTrustedCaFile: '/home/openchamber/frp/ca.crt',
      frpcProxyType: 'http',
      frpcRemotePort: null,
      frpcCustomDomain: 'route.example.com',
      frpcPublicHostname: 'public.example.com',
    });
    expect(JSON.stringify(response.body)).not.toContain('private-http-token');
  });

  it('starts a TCP mapping, persists the private token after readiness, and never returns it', async () => {
    const secret = 'frpc-secret-SHOULD-NOT-LEAK';
    let startRequest;
    let persisted;
    const tunnelService = {
      start: async (request) => {
        startRequest = request;
        return {
          publicUrl: request.publicUrl,
          request,
          activeMode: request.mode,
          provider: request.provider,
          providerMetadata: {
            serverAddress: request.serverAddress,
            serverPort: request.serverPort,
            trustedCaFile: request.trustedCaFile,
            proxyType: request.proxyType,
            remotePort: request.remotePort,
            publicUrl: request.publicUrl,
            customDomain: request.customDomain || null,
            hostname: request.hostname || null,
          },
          controllerReplaced: false,
        };
      },
      stop: () => false,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      setActiveTunnel: () => undefined,
      issueBootstrapToken: () => ({ token: 'bootstrap-token', expiresAt: 123 }),
      listTunnelSessions: () => [],
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async (value) => { persisted = value; },
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const response = await invoke(app.handlers.post.get('/api/openchamber/tunnel/start'), {
      body: {
        provider: TUNNEL_PROVIDER_FRPC,
        token: secret,
      },
    });

    expect(response.status).toBe(200);
    expect(startRequest).toMatchObject({
      provider: TUNNEL_PROVIDER_FRPC,
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      customDomain: undefined,
      hostname: undefined,
      token: secret,
    });
    expect(persisted).toEqual({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      customDomain: undefined,
      hostname: undefined,
      token: secret,
    });
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(response.body).toMatchObject({
      ok: true,
      url: 'https://app.example.com:18080',
      provider: TUNNEL_PROVIDER_FRPC,
      frpcRemotePort: 18080,
      frpcPublicUrl: 'https://app.example.com:18080',
      frpcProxyType: 'tcp',
      frpcCustomDomain: null,
      frpcPublicHostname: null,
      hasFrpcTunnelToken: true,
    });
  });

  it('never issues a credential-bearing connect URL for insecure or malformed provider URLs', async () => {
    for (const unsafePublicUrl of ['http://app.example.com:18080', 'not a URL']) {
      const controller = { id: unsafePublicUrl };
      let stoppedController = null;
      let bootstrapCalls = 0;
      const tunnelService = {
        start: async (request) => ({
          publicUrl: unsafePublicUrl,
          request,
          activeMode: request.mode,
          provider: request.provider,
          providerMetadata: null,
          controller,
          controllerStarted: true,
          controllerReplaced: false,
        }),
        stop: async (value) => { stoppedController = value; return true; },
        resolveActiveMode: () => null,
        resolveActiveProvider: () => null,
        getPublicUrl: () => null,
        getProviderMetadata: () => null,
        checkAvailability: async () => ({ available: true }),
      };
      const tunnelAuthController = {
        getActiveTunnelId: () => null,
        getActiveTunnelMode: () => null,
        getActiveTunnelHost: () => null,
        setActiveTunnel: () => undefined,
        issueBootstrapToken: () => { bootstrapCalls += 1; return { token: 'must-not-be-used', expiresAt: 123 }; },
        listTunnelSessions: () => [],
        revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
        clearActiveTunnel: () => undefined,
      };
      const runtime = createRuntime({
        tunnelService,
        tunnelAuthController,
        upsertFrpcTunnelConfig: async () => { throw new Error('must not persist'); },
      });
      const app = createApp();
      runtime.registerRoutes(app);

      const response = await invoke(app.handlers.post.get('/api/openchamber/tunnel/start'), {
        body: { provider: TUNNEL_PROVIDER_FRPC, token: 'secret' },
      });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ ok: false, code: 'unsafe_public_url' });
      expect(stoppedController).toBe(controller);
      expect(bootstrapCalls).toBe(0);
      expect(JSON.stringify(response.body)).not.toContain('must-not-be-used');
    }
  });

  it('starts and reports an explicit HTTP endpoint without backfilling a stale TCP draft', async () => {
    const secret = 'http-frpc-secret-SHOULD-NOT-LEAK';
    let startRequest;
    let persisted;
    const tunnelService = {
      start: async (request) => {
        startRequest = request;
        return {
          publicUrl: 'https://public.example.com',
          request,
          activeMode: request.mode,
          provider: request.provider,
          providerMetadata: {
            serverAddress: request.serverAddress,
            serverPort: request.serverPort,
            trustedCaFile: request.trustedCaFile,
            proxyType: 'http',
            remotePort: null,
            customDomain: 'route.example.com',
            hostname: 'public.example.com',
          },
          controllerReplaced: false,
        };
      },
      stop: () => false,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      setActiveTunnel: () => undefined,
      issueBootstrapToken: () => ({ token: 'bootstrap-token', expiresAt: 123 }),
      listTunnelSessions: () => [],
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async (value) => { persisted = value; },
      settings: {
        tunnelProvider: TUNNEL_PROVIDER_FRPC,
        tunnelMode: TUNNEL_MODE_MANAGED_REMOTE,
        frpcServerAddress: 'frps.example.com',
        frpcServerPort: 7000,
        frpcTrustedCaFile: '/home/openchamber/frp/ca.crt',
        frpcProxyType: 'tcp',
        frpcRemotePort: 18080,
      },
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const response = await invoke(app.handlers.post.get('/api/openchamber/tunnel/start'), {
      body: {
        provider: TUNNEL_PROVIDER_FRPC,
        customDomain: 'route.example.com',
        hostname: 'public.example.com',
        token: secret,
      },
    });

    expect(startRequest).toMatchObject({
      proxyType: 'http',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: secret,
    });
    expect(startRequest.remotePort).toBeUndefined();
    expect(persisted).toEqual({
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'http',
      remotePort: undefined,
      publicUrl: undefined,
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: secret,
    });
    expect(response.body).toMatchObject({
      ok: true,
      url: 'https://public.example.com',
      frpcProxyType: 'http',
      frpcTrustedCaFile: '/home/openchamber/frp/ca.crt',
      frpcRemotePort: null,
      frpcPublicUrl: null,
      frpcCustomDomain: 'route.example.com',
      frpcPublicHostname: 'public.example.com',
    });
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });

  it('does not backfill stale HTTP fields into an explicit TCP endpoint', async () => {
    let startRequest;
    const tunnelService = {
      start: async (request) => {
        startRequest = request;
        return {
          publicUrl: request.publicUrl,
          request,
          activeMode: request.mode,
          provider: request.provider,
          providerMetadata: {
            serverAddress: request.serverAddress,
            serverPort: request.serverPort,
            trustedCaFile: request.trustedCaFile,
            proxyType: 'tcp',
            remotePort: request.remotePort,
            publicUrl: request.publicUrl,
            customDomain: null,
            hostname: null,
          },
          controllerReplaced: false,
        };
      },
      stop: () => false,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      setActiveTunnel: () => undefined,
      issueBootstrapToken: () => ({ token: 'bootstrap-token', expiresAt: 123 }),
      listTunnelSessions: () => [],
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
      settings: {
        tunnelProvider: TUNNEL_PROVIDER_FRPC,
        tunnelMode: TUNNEL_MODE_MANAGED_REMOTE,
        frpcServerAddress: 'frps.example.com',
        frpcServerPort: 7000,
        frpcTrustedCaFile: '/home/openchamber/frp/ca.crt',
        frpcProxyType: 'http',
        frpcCustomDomain: 'stale-route.example.com',
        frpcPublicHostname: 'stale-public.example.com',
      },
    });
    const app = createApp();
    runtime.registerRoutes(app);

    await invoke(app.handlers.post.get('/api/openchamber/tunnel/start'), {
      body: {
        provider: TUNNEL_PROVIDER_FRPC,
        remotePort: 18080,
        publicUrl: 'https://tcp.example.com:18080',
        token: 'secret',
      },
    });

    expect(startRequest).toMatchObject({
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://tcp.example.com:18080',
    });
    expect(startRequest.customDomain).toBeUndefined();
    expect(startRequest.hostname).toBeUndefined();
  });

  it('invalidates artifacts when the service authoritatively replaced a same-URL controller', async () => {
    let revokedTunnelId = null;
    let activeTunnel;
    const tunnelService = {
      start: async (request) => ({
        publicUrl: 'https://203.0.113.10:18080',
        request,
        activeMode: request.mode,
        provider: request.provider,
        providerMetadata: {
          serverAddress: request.serverAddress,
          serverPort: request.serverPort,
          trustedCaFile: request.trustedCaFile,
          proxyType: 'tcp',
          remotePort: request.remotePort,
          customDomain: null,
          hostname: null,
        },
        controllerReplaced: true,
      }),
      stop: () => false,
      resolveActiveMode: () => TUNNEL_MODE_MANAGED_REMOTE,
      resolveActiveProvider: () => TUNNEL_PROVIDER_FRPC,
      getPublicUrl: () => 'https://203.0.113.10:18080',
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => 'old-tunnel-id',
      getActiveTunnelMode: () => TUNNEL_MODE_MANAGED_REMOTE,
      getActiveTunnelHost: () => '203.0.113.10',
      setActiveTunnel: (value) => { activeTunnel = value; },
      issueBootstrapToken: () => ({ token: 'bootstrap-token', expiresAt: 123 }),
      listTunnelSessions: () => [],
      revokeTunnelArtifacts: (tunnelId) => {
        revokedTunnelId = tunnelId;
        return { revokedBootstrapCount: 1, invalidatedSessionCount: 2 };
      },
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const response = await invoke(app.handlers.post.get('/api/openchamber/tunnel/start'), {
      body: {
        provider: TUNNEL_PROVIDER_FRPC,
        remotePort: 18080,
        publicUrl: 'https://203.0.113.10:18080',
        token: 'secret',
      },
    });

    expect(response.body).toMatchObject({
      replacedTunnel: true,
      revokedBootstrapCount: 1,
      invalidatedSessionCount: 2,
    });
    expect(revokedTunnelId).toBe('old-tunnel-id');
    expect(activeTunnel.tunnelId).toBe('tunnel-id');
  });

  it('does not clear a previously active tunnel when a new request fails validation', async () => {
    let clearCalls = 0;
    const tunnelService = {
      start: async () => {
        throw new TunnelServiceError('validation_error', 'FRPS remote port is required');
      },
      stop: () => false,
      resolveActiveMode: () => TUNNEL_MODE_MANAGED_REMOTE,
      resolveActiveProvider: () => TUNNEL_PROVIDER_FRPC,
      getPublicUrl: () => 'https://203.0.113.10',
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => 'existing',
      getActiveTunnelMode: () => TUNNEL_MODE_MANAGED_REMOTE,
      getActiveTunnelHost: () => '203.0.113.10',
      setActiveTunnel: () => undefined,
      issueBootstrapToken: () => ({ token: 'bootstrap-token', expiresAt: 123 }),
      listTunnelSessions: () => [],
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      clearActiveTunnel: () => { clearCalls += 1; },
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const response = await invoke(app.handlers.post.get('/api/openchamber/tunnel/start'), {
      body: { provider: TUNNEL_PROVIDER_FRPC, token: 'secret' },
    });

    expect(response.status).toBe(422);
    expect(clearCalls).toBe(0);
  });

  it('keeps Cloudflare, Ngrok, and inactive status readable when the FRPC config is malformed', async () => {
    const scenarios = [
      { provider: TUNNEL_PROVIDER_CLOUDFLARE, url: 'https://cloudflare.example.com' },
      { provider: 'ngrok', url: 'https://example.ngrok.app' },
      { provider: 'ngrok', url: null },
    ];

    for (const scenario of scenarios) {
      const tunnelService = {
        stop: () => false,
        resolveActiveMode: () => scenario.url ? 'quick' : null,
        resolveActiveProvider: () => scenario.url ? scenario.provider : null,
        getPublicUrl: () => scenario.url,
        getProviderMetadata: () => ({ provider: scenario.provider }),
        checkAvailability: async () => ({ available: true }),
      };
      const tunnelAuthController = {
        getActiveTunnelId: () => scenario.url ? 'active-tunnel' : null,
        getActiveTunnelMode: () => scenario.url ? 'quick' : null,
        getActiveTunnelHost: () => scenario.url ? new URL(scenario.url).hostname : null,
        setActiveTunnel: () => undefined,
        getBootstrapStatus: () => ({ hasBootstrapToken: true, bootstrapExpiresAt: 123 }),
        listTunnelSessions: () => [],
        revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
        clearActiveTunnel: () => undefined,
      };
      const runtime = createRuntime({
        tunnelService,
        tunnelAuthController,
        upsertFrpcTunnelConfig: async () => undefined,
        settings: {
          tunnelProvider: scenario.provider,
          tunnelMode: 'quick',
        },
        frpcConfigReadError: new Error('malformed private FRPC config'),
      });
      const app = createApp();
      runtime.registerRoutes(app);

      const response = await invoke(app.handlers.get.get('/api/openchamber/tunnel/status'));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        active: Boolean(scenario.url),
        provider: scenario.provider,
        url: scenario.url,
        hasFrpcTunnelToken: false,
        frpcServerAddress: null,
        frpcTrustedCaFile: null,
        frpcConfigStatus: 'error',
        frpcConfigError: 'FRPC tunnel configuration is invalid or unreadable',
      });
    }
  });

  it('rejects explicit unknown providers and provider-incompatible modes', async () => {
    let starts = 0;
    const tunnelService = {
      start: async () => { starts += 1; },
      stop: async () => false,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
    });
    const app = createApp();
    runtime.registerRoutes(app);
    const start = app.handlers.post.get('/api/openchamber/tunnel/start');

    const unknownProvider = await invoke(start, {
      body: { provider: 'invalid-provider', mode: 'quick' },
    });
    const unsupportedMode = await invoke(start, {
      body: { provider: TUNNEL_PROVIDER_FRPC, mode: 'quick' },
    });
    const unknownCheck = await invoke(app.handlers.get.get('/api/openchamber/tunnel/check'), {
      query: { provider: 'invalid-provider' },
    });
    const unknownDoctor = await invoke(app.handlers.get.get('/api/openchamber/tunnel/doctor'), {
      query: { provider: 'invalid-provider' },
    });
    const emptyCheck = await invoke(app.handlers.get.get('/api/openchamber/tunnel/check'), {
      query: { provider: '' },
    });
    const emptyDoctorMode = await invoke(app.handlers.get.get('/api/openchamber/tunnel/doctor'), {
      query: { mode: '' },
    });

    expect(unknownProvider).toMatchObject({
      status: 422,
      body: { code: 'provider_unsupported' },
    });
    expect(unsupportedMode).toMatchObject({
      status: 422,
      body: { code: 'mode_unsupported' },
    });
    expect(unknownCheck).toMatchObject({
      status: 422,
      body: { code: 'provider_unsupported' },
    });
    expect(unknownDoctor).toMatchObject({
      status: 400,
      body: { code: 'provider_unsupported' },
    });
    expect(emptyCheck).toMatchObject({
      status: 422,
      body: { code: 'provider_unsupported' },
    });
    expect(emptyDoctorMode).toMatchObject({
      status: 400,
      body: { code: 'mode_unsupported' },
    });
    expect(starts).toBe(0);
  });

  it('forwards HTTP disconnect cancellation to an in-progress tunnel start', async () => {
    let receivedSignal;
    const tunnelService = {
      start: async (_request, options) => {
        receivedSignal = options.signal;
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(
            new TunnelServiceError('startup_cancelled', 'Tunnel start was cancelled')
          ), { once: true });
        });
      },
      stop: async () => false,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
    });
    const app = createApp();
    runtime.registerRoutes(app);
    const req = Object.assign(new EventEmitter(), {
      query: {},
      body: { provider: TUNNEL_PROVIDER_FRPC, token: 'secret' },
    });
    const result = { status: 200, body: null };
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      status(status) {
        result.status = status;
        return this;
      },
      json(body) {
        result.body = body;
        return body;
      },
    });

    const startPromise = app.handlers.post.get('/api/openchamber/tunnel/start')(req, res);
    while (!receivedSignal) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    res.emit('close');
    await startPromise;

    expect(receivedSignal.aborted).toBe(true);
    expect(result.body).toMatchObject({ code: 'startup_cancelled' });
  });

  it('stops a tunnel that becomes active before a disconnected request finishes persistence', async () => {
    let resolvePersistence;
    let persistenceStarted;
    const startedPersisting = new Promise((resolve) => { persistenceStarted = resolve; });
    let stopCalls = 0;
    let active = true;
    const controller = { id: 'started-controller' };
    const tunnelService = {
      start: async (request) => ({
        publicUrl: 'https://203.0.113.10:18080',
        request,
        activeMode: request.mode,
        provider: request.provider,
        providerMetadata: {
          serverAddress: request.serverAddress,
          serverPort: request.serverPort,
          trustedCaFile: request.trustedCaFile,
          proxyType: 'tcp',
          remotePort: request.remotePort,
        },
        controllerReplaced: false,
        controller,
        controllerStarted: true,
      }),
      stop: async (expectedController) => {
        expect(expectedController).toBe(controller);
        stopCalls += 1;
        active = false;
        return true;
      },
      resolveActiveMode: () => null,
      resolveActiveProvider: () => active ? TUNNEL_PROVIDER_FRPC : null,
      getPublicUrl: () => active ? 'https://203.0.113.10:18080' : null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => {
        persistenceStarted();
        await new Promise((resolve) => { resolvePersistence = resolve; });
      },
    });
    const app = createApp();
    runtime.registerRoutes(app);
    const req = Object.assign(new EventEmitter(), {
      query: {},
      body: { provider: TUNNEL_PROVIDER_FRPC, token: 'secret' },
    });
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      status() { return this; },
      json(body) { return body; },
    });

    const starting = app.handlers.post.get('/api/openchamber/tunnel/start')(req, res);
    await startedPersisting;
    res.emit('close');
    resolvePersistence();
    await starting;

    expect(stopCalls).toBe(1);
    expect(active).toBe(false);
  });

  it('does not revoke tunnel state until process termination is confirmed', async () => {
    let resolveStop;
    let revokeCalls = 0;
    let clearCalls = 0;
    const tunnelService = {
      stop: () => new Promise((resolve) => { resolveStop = resolve; }),
      resolveActiveMode: () => TUNNEL_MODE_MANAGED_REMOTE,
      resolveActiveProvider: () => TUNNEL_PROVIDER_FRPC,
      getPublicUrl: () => 'https://203.0.113.10:18080',
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => 'active-tunnel',
      revokeTunnelArtifacts: () => {
        revokeCalls += 1;
        return { revokedBootstrapCount: 1, invalidatedSessionCount: 2 };
      },
      clearActiveTunnel: () => { clearCalls += 1; },
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
      getActiveTunnelController: () => ({ provider: TUNNEL_PROVIDER_FRPC }),
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const stopping = invoke(app.handlers.post.get('/api/openchamber/tunnel/stop'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeCalls).toBe(0);
    expect(clearCalls).toBe(0);
    resolveStop(true);
    const response = await stopping;

    expect(response.status).toBe(200);
    expect(revokeCalls).toBe(1);
    expect(clearCalls).toBe(1);
  });

  it('cancels pending starts even when no controller has been published', async () => {
    let stopCalls = 0;
    const tunnelService = {
      stop: async () => { stopCalls += 1; return false; },
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
      getActiveTunnelController: () => null,
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const response = await invoke(app.handlers.post.get('/api/openchamber/tunnel/stop'));

    expect(response.status).toBe(200);
    expect(stopCalls).toBe(1);
  });

  it('does not publish auth after a controller stops during response assembly', async () => {
    let active = true;
    let releaseConfigRead;
    let configReadStarted;
    const readingConfig = new Promise((resolve) => { configReadStarted = resolve; });
    const controller = { id: 'started-controller' };
    const tunnelService = {
      start: async (request) => ({
        publicUrl: 'https://203.0.113.10:18080',
        request,
        activeMode: request.mode,
        provider: request.provider,
        providerMetadata: {
          serverAddress: request.serverAddress,
          serverPort: request.serverPort,
          trustedCaFile: request.trustedCaFile,
          proxyType: 'tcp',
          remotePort: request.remotePort,
        },
        controllerReplaced: false,
        controller,
        controllerStarted: true,
      }),
      stop: async () => false,
      isActiveController: (candidate) => active && candidate === controller,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => active ? TUNNEL_PROVIDER_FRPC : null,
      getPublicUrl: () => active ? 'https://203.0.113.10:18080' : null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    let setActiveCalls = 0;
    const tunnelAuthController = {
      getActiveTunnelId: () => null,
      getActiveTunnelMode: () => null,
      getActiveTunnelHost: () => null,
      setActiveTunnel: () => { setActiveCalls += 1; },
      clearActiveTunnel: () => undefined,
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController,
      upsertFrpcTunnelConfig: async () => undefined,
      readManagedRemoteTunnelConfigFromDisk: async () => {
        configReadStarted();
        return new Promise((resolve) => { releaseConfigRead = resolve; });
      },
    });
    const app = createApp();
    runtime.registerRoutes(app);

    const starting = invoke(app.handlers.post.get('/api/openchamber/tunnel/start'), {
      body: { provider: TUNNEL_PROVIDER_FRPC, token: 'secret' },
    });
    await readingConfig;
    active = false;
    releaseConfigRead({ tunnels: [] });
    const response = await starting;

    expect(response).toMatchObject({
      status: 500,
      body: { code: 'startup_cancelled' },
    });
    expect(setActiveCalls).toBe(0);
  });

  it('stops a new controller when the client disconnects during response assembly', async () => {
    let active = true;
    let stopCalls = 0;
    let releaseConfigRead;
    let configReadStarted;
    const readingConfig = new Promise((resolve) => { configReadStarted = resolve; });
    const controller = { id: 'started-controller' };
    const tunnelService = {
      start: async (request) => ({
        publicUrl: 'https://203.0.113.10:18080',
        request,
        activeMode: request.mode,
        provider: request.provider,
        providerMetadata: {
          serverAddress: request.serverAddress,
          serverPort: request.serverPort,
          trustedCaFile: request.trustedCaFile,
          proxyType: 'tcp',
          remotePort: request.remotePort,
        },
        controllerReplaced: false,
        controller,
        controllerStarted: true,
      }),
      stop: async (candidate) => {
        expect(candidate).toBe(controller);
        stopCalls += 1;
        active = false;
        return true;
      },
      isActiveController: (candidate) => active && candidate === controller,
      resolveActiveMode: () => null,
      resolveActiveProvider: () => active ? TUNNEL_PROVIDER_FRPC : null,
      getPublicUrl: () => active ? 'https://203.0.113.10:18080' : null,
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    let setActiveCalls = 0;
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController: {
        getActiveTunnelId: () => null,
        getActiveTunnelMode: () => null,
        getActiveTunnelHost: () => null,
        setActiveTunnel: () => { setActiveCalls += 1; },
        clearActiveTunnel: () => undefined,
      },
      upsertFrpcTunnelConfig: async () => undefined,
      readManagedRemoteTunnelConfigFromDisk: async () => {
        configReadStarted();
        return new Promise((resolve) => { releaseConfigRead = resolve; });
      },
    });
    const app = createApp();
    runtime.registerRoutes(app);
    const req = Object.assign(new EventEmitter(), {
      query: {},
      body: { provider: TUNNEL_PROVIDER_FRPC, token: 'secret' },
    });
    const response = { status: 200, body: null };
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      status(status) {
        response.status = status;
        return this;
      },
      json(body) {
        response.body = body;
        return body;
      },
    });

    const starting = app.handlers.post.get('/api/openchamber/tunnel/start')(req, res);
    await readingConfig;
    res.emit('close');
    releaseConfigRead({ tunnels: [] });
    await starting;

    expect(response).toMatchObject({
      status: 500,
      body: { code: 'startup_cancelled' },
    });
    expect(stopCalls).toBe(1);
    expect(setActiveCalls).toBe(0);
  });

  it('awaits tunnel termination when private FRPC config persistence fails', async () => {
    let resolveStop;
    let stopped = false;
    const controller = { id: 'started-controller' };
    const tunnelService = {
      start: async (request) => ({
        publicUrl: 'https://203.0.113.10:18080',
        request,
        activeMode: request.mode,
        provider: request.provider,
        providerMetadata: {
          serverAddress: request.serverAddress,
          serverPort: request.serverPort,
          trustedCaFile: request.trustedCaFile,
          proxyType: 'tcp',
          remotePort: request.remotePort,
        },
        controllerReplaced: false,
        controller,
        controllerStarted: true,
      }),
      stop: (expectedController) => new Promise((resolve) => {
        expect(expectedController).toBe(controller);
        resolveStop = () => {
          stopped = true;
          resolve(true);
        };
      }),
      resolveActiveMode: () => null,
      resolveActiveProvider: () => null,
      getPublicUrl: () => stopped ? null : 'https://203.0.113.10:18080',
      getProviderMetadata: () => null,
      checkAvailability: async () => ({ available: true }),
    };
    const runtime = createRuntime({
      tunnelService,
      tunnelAuthController: {},
      upsertFrpcTunnelConfig: async () => {
        throw new Error('credential write failed');
      },
    });

    let settled = false;
    const starting = runtime.startTunnelWithNormalizedRequest({
      provider: TUNNEL_PROVIDER_FRPC,
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      token: 'secret',
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://203.0.113.10:18080',
      frpcEndpointExplicit: true,
    }).finally(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(stopped).toBe(false);
    resolveStop();
    await expect(starting).rejects.toMatchObject({ code: 'config_persistence_failed' });
    expect(stopped).toBe(true);
  });
});
