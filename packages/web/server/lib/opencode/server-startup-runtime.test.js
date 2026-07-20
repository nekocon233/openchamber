import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';

import { createServerStartupRuntime } from './server-startup-runtime.js';

class FakeServer extends EventEmitter {
  address() {
    return { port: 3000 };
  }

  listen(_port, _host, callback) {
    callback();
  }
}

describe('server startup tunnel forwarding', () => {
  it('forwards the FRPC trust anchor and explicit endpoint marker', async () => {
    let receivedRequest;
    const runtime = createServerStartupRuntime({
      process: { env: {} },
      crypto: { randomUUID: () => 'tunnel-id' },
      server: new FakeServer(),
      normalizeTunnelBootstrapTtlMs: (value) => value,
      readSettingsFromDiskMigrated: async () => ({}),
      tunnelAuthController: {},
      startTunnelWithNormalizedRequest: async (request) => {
        receivedRequest = request;
        return { publicUrl: null, mode: 'managed-remote' };
      },
      gracefulShutdown: async () => {},
      getSignalsAttached: () => false,
      setSignalsAttached: () => {},
      syncToHmrState: () => {},
      TUNNEL_MODE_QUICK: 'quick',
      TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    });

    await runtime.startListeningAndMaybeTunnel({
      port: 3000,
      bindHost: '127.0.0.1',
      startupTunnelRequest: {
        provider: 'frpc',
        mode: 'managed-remote',
        serverAddress: '203.0.113.10',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
        token: 'private-token',
      },
    });

    expect(receivedRequest).toMatchObject({
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      frpcEndpointExplicit: true,
    });
  });

  it('treats an explicitly supplied public hostname as an endpoint override', async () => {
    let receivedRequest;
    const runtime = createServerStartupRuntime({
      process: { env: {} },
      crypto: { randomUUID: () => 'tunnel-id' },
      server: new FakeServer(),
      normalizeTunnelBootstrapTtlMs: (value) => value,
      readSettingsFromDiskMigrated: async () => ({}),
      tunnelAuthController: {},
      startTunnelWithNormalizedRequest: async (request) => {
        receivedRequest = request;
        return { publicUrl: null, mode: 'managed-remote' };
      },
      gracefulShutdown: async () => {},
      getSignalsAttached: () => false,
      setSignalsAttached: () => {},
      syncToHmrState: () => {},
      TUNNEL_MODE_QUICK: 'quick',
      TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    });

    await runtime.startListeningAndMaybeTunnel({
      port: 3000,
      bindHost: '127.0.0.1',
      startupTunnelRequest: {
        provider: 'frpc',
        mode: 'managed-remote',
        hostname: 'public.example.com',
      },
    });

    expect(receivedRequest).toMatchObject({
      hostname: 'public.example.com',
      frpcEndpointExplicit: true,
    });
  });
});
