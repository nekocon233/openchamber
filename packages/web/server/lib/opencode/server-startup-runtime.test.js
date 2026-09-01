import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';

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
  it('forwards the FRPC endpoint marker without a CA option', async () => {
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
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
        token: 'private-token',
      },
    });

    expect(receivedRequest).toMatchObject({
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

/**
 * The desktop app embeds this server and nothing restarts it, so shutting down
 * on a single uncaught exception turned every stray socket error into "the
 * instance is unreachable until restarted". Only a sustained storm shuts down.
 */
describe('uncaught exception policy', () => {
  const setup = () => {
    const fakeProcess = new EventEmitter();
    let shutdowns = 0;
    const runtime = createServerStartupRuntime({
      process: fakeProcess,
      gracefulShutdown: () => { shutdowns += 1; },
      getSignalsAttached: () => true,
      setSignalsAttached: () => {},
      syncToHmrState: () => {},
    });
    runtime.attachProcessHandlers({ attachSignals: false });
    return { fakeProcess, shutdowns: () => shutdowns };
  };

  it('a single uncaught exception keeps the server running', () => {
    const { fakeProcess, shutdowns } = setup();
    fakeProcess.emit('uncaughtException', new Error('setTypeOfService EINVAL'));
    expect(shutdowns()).toBe(0);
  });

  it('a storm of uncaught exceptions still shuts down', () => {
    const { fakeProcess, shutdowns } = setup();
    for (let i = 0; i < 11; i += 1) {
      fakeProcess.emit('uncaughtException', new Error(`stray ${i}`));
    }
    expect(shutdowns()).toBeGreaterThan(0);
  });

  it('an unhandled rejection is logged without shutting down', () => {
    const { fakeProcess, shutdowns } = setup();
    fakeProcess.emit('unhandledRejection', new Error('late failure'), Promise.resolve());
    expect(shutdowns()).toBe(0);
  });
});
