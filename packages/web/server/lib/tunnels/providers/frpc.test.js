import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  FRPC_TUNNEL_PROVIDER,
  createFrpcTunnelProvider,
  frpcTunnelProviderCapabilities,
} from './frpc.js';
import {
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_MODE_MANAGED_REMOTE,
} from '../types.js';

const createController = (url, endpoint = {}) => {
  let running = true;
  let stopCalls = 0;
  return {
    stop: () => {
      stopCalls += 1;
      const wasRunning = running;
      running = false;
      return wasRunning;
    },
    isRunning: () => running,
    getPublicUrl: () => (running ? url : null),
    getServerAddress: () => endpoint.serverAddress ?? null,
    getServerPort: () => endpoint.serverPort ?? null,
    getTrustedCaFile: () => endpoint.trustedCaFile ?? null,
    getProxyType: () => endpoint.proxyType ?? null,
    getRemotePort: () => endpoint.remotePort ?? null,
    getCustomDomain: () => endpoint.customDomain ?? null,
    getHostname: () => endpoint.hostname ?? null,
    getConfiguredPublicUrl: () => endpoint.publicUrl ?? null,
    getStopCalls: () => stopCalls,
  };
};

describe('FRPC tunnel provider', () => {
  it('declares both managed TCP and HTTP-vhost capability contracts', () => {
    expect(frpcTunnelProviderCapabilities).toEqual({
      provider: FRPC_TUNNEL_PROVIDER,
      defaults: {
        mode: TUNNEL_MODE_MANAGED_REMOTE,
        optionDefaults: {},
      },
      modes: [{
        key: TUNNEL_MODE_MANAGED_REMOTE,
        label: 'Managed FRP Tunnel',
        intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
        requires: ['serverAddress', 'serverPort', 'trustedCaFile', 'token'],
        supports: ['customDomain', 'publicUrl', 'sessionTTL'],
        proxyTypes: ['tcp', 'http'],
        stability: 'beta',
      }],
    });
  });

  it('exposes prepare and reports supported managed binaries as available before download', async () => {
    let prepareCalls = 0;
    const binaryManager = {
      inspect: async () => ({
        supported: true,
        prepared: false,
        path: null,
        version: '0.70.0',
        target: 'linux-x64',
        error: 'binary is missing',
      }),
      prepare: async () => {
        prepareCalls += 1;
        return { path: '/managed/frpc', version: '0.70.0' };
      },
    };
    const provider = createFrpcTunnelProvider({ binaryManager, startClient: async () => createController('https://app.example.com') });

    expect(await provider.checkAvailability()).toMatchObject({
      available: true,
      managed: true,
      prepared: false,
      version: '0.70.0',
      target: 'linux-x64',
    });
    expect(await provider.prepare()).toEqual({ path: '/managed/frpc', version: '0.70.0' });
    expect(prepareCalls).toBe(1);
  });

  it('reports unsupported targets without trying to prepare them', async () => {
    const binaryManager = {
      inspect: async () => ({
        supported: false,
        prepared: false,
        path: null,
        version: '0.70.0',
        target: 'freebsd-x64',
        error: 'FRPC 0.70.0 is not available for freebsd/x64',
      }),
      prepare: async () => { throw new Error('must not prepare'); },
    };
    const provider = createFrpcTunnelProvider({ binaryManager });

    expect(await provider.checkAvailability()).toMatchObject({
      available: false,
      managed: true,
      prepared: false,
      target: 'freebsd-x64',
    });
  });

  it('diagnoses the endpoint requirements conditionally without exposing the token', async () => {
    const token = 'doctor-secret-must-not-leak';
    const binaryManager = {
      inspect: async () => ({
        supported: true,
        prepared: true,
        path: '/managed/frpc',
        version: '0.70.0',
        target: 'linux-x64',
      }),
      prepare: async () => ({ path: '/managed/frpc', version: '0.70.0' }),
    };
    const provider = createFrpcTunnelProvider({ binaryManager });

    const diagnosed = await provider.diagnose({
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      customDomain: 'route.example.com',
      token,
    });

    expect(diagnosed.modes[0].ready).toBe(false);
    expect(diagnosed.modes[0].blockers.join(' ')).toMatch(/public hostname is required/i);
    expect(JSON.stringify(diagnosed)).not.toContain(token);
  });

  it('validates doctor trust anchors with the same readable-file rules as startup', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-frpc-doctor-test-'));
    const trustedCaFile = path.join(tempRoot, 'custom-ca.crt');
    fs.writeFileSync(trustedCaFile, 'custom-ca', { mode: 0o600 });
    const binaryManager = {
      inspect: async () => ({
        supported: true,
        prepared: true,
        path: '/managed/frpc',
        version: '0.70.0',
        target: 'linux-x64',
      }),
      prepare: async () => ({ path: '/managed/frpc', version: '0.70.0' }),
    };
    const provider = createFrpcTunnelProvider({ binaryManager });

    try {
      const ready = await provider.diagnose({
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile,
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
        token: 'secret',
      });
      expect(ready.modes[0].checks.find((entry) => entry.id === 'requirement_trustedCaFile')).toMatchObject({
        status: 'pass',
      });

      fs.rmSync(trustedCaFile);
      const missing = await provider.diagnose({
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile,
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
        token: 'secret',
      });
      expect(missing.modes[0].checks.find((entry) => entry.id === 'requirement_trustedCaFile')).toMatchObject({
        status: 'fail',
        detail: expect.stringMatching(/Could not read FRPS trusted CA file/),
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('prepares before start, forwards only the required launch contract, and replaces the active client', async () => {
    const launches = [];
    const controllers = [
      createController('https://first.example.com'),
      createController('https://second.example.com'),
    ];
    const binaryManager = {
      inspect: async () => ({ supported: true, prepared: true }),
      prepare: async () => ({ path: '/managed/frpc', version: '0.70.0' }),
    };
    const startClient = async (options) => {
      launches.push(options);
      return controllers[launches.length - 1];
    };
    const provider = createFrpcTunnelProvider({ binaryManager, startClient });

    const first = await provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://first.example.com:18080',
      token: 'first-secret',
    }, { activePort: 3000 });
    const second = await provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: '203.0.113.11',
      serverPort: 7001,
      trustedCaFile: '/etc/frp/secondary-ca.crt',
      remotePort: 18081,
      publicUrl: 'https://second.example.com:18081',
      token: 'second-secret',
    }, { activePort: 4000 });

    expect(launches.map(({ onExit, ...launch }) => launch)).toEqual([
      {
        binaryPath: '/managed/frpc',
        serverAddress: '203.0.113.10',
        serverPort: 7000,
        trustedCaFile: '/etc/frp/ca.crt',
        token: 'first-secret',
        localPort: 3000,
        proxyType: 'tcp',
        remotePort: 18080,
        publicUrl: 'https://first.example.com:18080',
      },
      {
        binaryPath: '/managed/frpc',
        serverAddress: '203.0.113.11',
        serverPort: 7001,
        trustedCaFile: '/etc/frp/secondary-ca.crt',
        token: 'second-secret',
        localPort: 4000,
        proxyType: 'tcp',
        remotePort: 18081,
        publicUrl: 'https://second.example.com:18081',
      },
    ]);
    expect(typeof launches[0].onExit).toBe('function');
    expect(first.getStopCalls()).toBe(1);
    expect(first.getPublicUrl()).toBeNull();
    expect(second.mode).toBe(TUNNEL_MODE_MANAGED_REMOTE);
    expect(provider.resolvePublicUrl()).toBe('https://second.example.com');
    await expect(provider.stop()).resolves.toBe(true);
    expect(provider.resolvePublicUrl()).toBeNull();
  });

  it('forwards and reports an HTTP-vhost endpoint without a remote port', async () => {
    let launch;
    const binaryManager = {
      inspect: async () => ({ supported: true, prepared: true }),
      prepare: async () => ({ path: '/managed/frpc', version: '0.70.0' }),
    };
    const controller = createController('https://public.example.com', {
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      proxyType: 'http',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      publicUrl: null,
    });
    const provider = createFrpcTunnelProvider({
      binaryManager,
      startClient: async (options) => {
        launch = options;
        return controller;
      },
    });

    await provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: 'secret',
    }, { activePort: 3000 });

    const { onExit, ...launchContract } = launch;
    expect(typeof onExit).toBe('function');
    expect(launchContract).toEqual({
      binaryPath: '/managed/frpc',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      token: 'secret',
      localPort: 3000,
      proxyType: 'http',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
    });
    expect(provider.getMetadata()).toEqual({
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      proxyType: 'http',
      remotePort: null,
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      publicUrl: null,
    });
  });

  it('rejects unsupported modes and missing active ports before launching', async () => {
    let launches = 0;
    let prepares = 0;
    const binaryManager = {
      inspect: async () => ({ supported: true, prepared: true }),
      prepare: async () => {
        prepares += 1;
        return { path: '/managed/frpc', version: '0.70.0' };
      },
    };
    const provider = createFrpcTunnelProvider({
      binaryManager,
      startClient: async () => {
        launches += 1;
        return createController('https://app.example.com');
      },
    });

    await expect(provider.start({ mode: 'quick' }, { activePort: 3000 })).rejects.toMatchObject({
      code: 'mode_unsupported',
    });
    await expect(provider.start({ mode: TUNNEL_MODE_MANAGED_REMOTE }, {})).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'secret',
    }, { activePort: 3000 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: 'https://203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'secret',
    }, { activePort: 3000 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      token: 'secret',
    }, { activePort: 3000 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: 'secret',
    }, { activePort: 3000 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'http://app.example.com:18080',
      token: 'secret',
    }, { activePort: 3000 })).rejects.toMatchObject({ code: 'validation_error' });
    expect(launches).toBe(0);
    expect(prepares).toBe(0);
  });

  it('does not launch after stop supersedes an in-progress prepare', async () => {
    let resolvePrepare;
    let prepareStarted;
    const started = new Promise((resolve) => { prepareStarted = resolve; });
    const binaryManager = {
      inspect: async () => ({ supported: true, prepared: false }),
      prepare: () => {
        prepareStarted();
        return new Promise((resolve) => { resolvePrepare = resolve; });
      },
    };
    let launches = 0;
    const provider = createFrpcTunnelProvider({
      binaryManager,
      startClient: async () => {
        launches += 1;
        return createController('https://app.example.com');
      },
    });

    const start = provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'secret',
    }, { activePort: 3000 });
    await started;
    await expect(provider.stop()).resolves.toBe(false);
    resolvePrepare({ path: '/managed/frpc', version: '0.70.0' });

    await expect(start).rejects.toMatchObject({ code: 'startup_cancelled' });
    expect(launches).toBe(0);
  });

  it('stops a client that becomes ready after a concurrent stop', async () => {
    let resolveStart;
    let launchStarted;
    const started = new Promise((resolve) => { launchStarted = resolve; });
    const controller = createController('https://app.example.com');
    const binaryManager = {
      inspect: async () => ({ supported: true, prepared: true }),
      prepare: async () => ({ path: '/managed/frpc', version: '0.70.0' }),
    };
    const provider = createFrpcTunnelProvider({
      binaryManager,
      startClient: () => {
        launchStarted();
        return new Promise((resolve) => { resolveStart = resolve; });
      },
    });
    const start = provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'secret',
    }, { activePort: 3000 });
    await started;
    await expect(provider.stop()).resolves.toBe(false);
    resolveStart(controller);

    await expect(start).rejects.toMatchObject({ code: 'startup_cancelled' });
    expect(controller.getStopCalls()).toBe(1);
    expect(controller.getPublicUrl()).toBeNull();
    expect(provider.resolvePublicUrl()).toBeNull();
  });

  it('cancels a pending prepare when the HTTP client aborts', async () => {
    let resolvePrepare;
    let prepareStarted;
    const started = new Promise((resolve) => { prepareStarted = resolve; });
    const binaryManager = {
      inspect: async () => ({ supported: true, prepared: false }),
      prepare: () => {
        prepareStarted();
        return new Promise((resolve) => { resolvePrepare = resolve; });
      },
    };
    let launches = 0;
    const provider = createFrpcTunnelProvider({
      binaryManager,
      startClient: async () => {
        launches += 1;
        return createController('https://app.example.com');
      },
    });
    const abortController = new AbortController();
    const start = provider.start({
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/etc/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'secret',
    }, { activePort: 3000, signal: abortController.signal });
    await started;
    abortController.abort();
    resolvePrepare({ path: '/managed/frpc', version: '0.70.0' });

    await expect(start).rejects.toMatchObject({ code: 'startup_cancelled' });
    expect(launches).toBe(0);
  });
});
