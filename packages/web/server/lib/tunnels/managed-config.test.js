import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  normalizeFrpcCustomDomain,
  normalizeFrpcPublicHostname,
  normalizeFrpcPublicUrl,
  normalizeFrpcRemotePort,
  normalizeFrpcServerAddress,
  normalizeFrpcServerPort,
  normalizeFrpcTrustedCaFile,
  normalizeFrpcToken,
} from './frpc-client.js';
import { createManagedTunnelConfigRuntime } from './managed-config.js';

let tempRoot;
let configPath;
let runtime;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-frpc-config-test-'));
  configPath = path.join(tempRoot, 'frpc-managed-tunnel.json');
  runtime = createManagedTunnelConfigRuntime({
    fsPromises,
    path,
    crypto,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: () => [],
    normalizeFrpcServerAddress,
    normalizeFrpcServerPort,
    normalizeFrpcTrustedCaFile,
    normalizeFrpcRemotePort,
    normalizeFrpcCustomDomain,
    normalizeFrpcPublicHostname,
    normalizeFrpcPublicUrl,
    normalizeFrpcToken,
    constants: {
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: path.join(tempRoot, 'cloudflare.json'),
      CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: path.join(tempRoot, 'cloudflare-legacy.json'),
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
      FRPC_MANAGED_TUNNEL_FILE_PATH: configPath,
      FRPC_MANAGED_TUNNEL_VERSION: 2,
    },
  });
});

afterEach(async () => {
  await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('FRPC managed tunnel config', () => {
  it('round-trips the private endpoint credential with restrictive permissions', async () => {
    await runtime.upsertFrpcTunnelConfig({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'private-frpc-token',
    });

    expect(await runtime.readFrpcTunnelConfigFromDisk()).toMatchObject({
      version: 2,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'private-frpc-token',
    });
    expect((await fsPromises.stat(configPath)).mode & 0o777).toBe(0o600);
    await expect(runtime.resolveFrpcTunnelToken({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
    })).resolves.toBe('private-frpc-token');
    await expect(runtime.resolveFrpcTunnelToken({
      serverAddress: '203.0.113.11',
      serverPort: 7000,
    })).resolves.toBe('');
  });

  it('round-trips an HTTP-vhost endpoint without persisting a remote port', async () => {
    await runtime.upsertFrpcTunnelConfig({
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'http',
      customDomain: 'Route.Example.com',
      hostname: 'Public.Example.com',
      token: 'private-frpc-token',
    });

    expect(await runtime.readFrpcTunnelConfigFromDisk()).toMatchObject({
      version: 2,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'http',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: 'private-frpc-token',
    });
    const persisted = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
    expect(persisted.remotePort).toBeUndefined();
    expect((await fsPromises.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects a version-1 record that cannot verify the FRPS identity', async () => {
    await fsPromises.writeFile(configPath, JSON.stringify({
      version: 1,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      remotePort: 18080,
      token: 'private-frpc-token',
      updatedAt: 123,
    }), { encoding: 'utf8', mode: 0o600 });

    await expect(runtime.readFrpcTunnelConfigFromDisk()).rejects.toThrow(/Failed to read FRPC tunnel config/);
    expect(JSON.parse(await fsPromises.readFile(configPath, 'utf8')).version).toBe(1);
    expect((await fsPromises.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects legacy or insecure TCP records without a valid public HTTPS URL', async () => {
    for (const publicUrl of [undefined, 'http://app.example.com:18080', 'https://app.example.com:18080/path']) {
      await fsPromises.writeFile(configPath, JSON.stringify({
        version: 2,
        serverAddress: '203.0.113.10',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        proxyType: 'tcp',
        remotePort: 18080,
        ...(publicUrl ? { publicUrl } : {}),
        token: 'private-frpc-token',
      }), { encoding: 'utf8', mode: 0o600 });

      await expect(runtime.readFrpcTunnelConfigFromDisk()).rejects.toThrow(/Failed to read FRPC tunnel config/);
    }
  });

  it('rejects a persisted endpoint that mixes HTTP and TCP fields without exposing its token', async () => {
    const token = 'private-token-must-not-leak';
    await fsPromises.writeFile(configPath, JSON.stringify({
      version: 2,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'http',
      remotePort: 18080,
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token,
    }), { encoding: 'utf8', mode: 0o600 });

    let failure;
    try {
      await runtime.readFrpcTunnelConfigFromDisk();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/Failed to read FRPC tunnel config/);
    expect(failure.message).not.toContain(token);
  });

  it('reports malformed persisted state instead of treating it as an empty credential', async () => {
    await fsPromises.writeFile(configPath, '{not-json', { encoding: 'utf8', mode: 0o600 });

    await expect(runtime.readFrpcTunnelConfigFromDisk()).rejects.toThrow(/Failed to read FRPC tunnel config/);
  });

  it('preserves the previous endpoint, token, and trust anchor when atomic publish fails', async () => {
    await runtime.upsertFrpcTunnelConfig({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/old-ca.crt',
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://old.example.com:18080',
      token: 'old-private-token',
    });
    const failingRuntime = createManagedTunnelConfigRuntime({
      fsPromises: {
        ...fsPromises,
        rename: async () => {
          throw new Error('publish failed');
        },
      },
      path,
      crypto,
      normalizeManagedRemoteTunnelHostname: (value) => value,
      normalizeManagedRemoteTunnelPresets: () => [],
      normalizeFrpcServerAddress,
      normalizeFrpcServerPort,
      normalizeFrpcTrustedCaFile,
      normalizeFrpcRemotePort,
      normalizeFrpcCustomDomain,
      normalizeFrpcPublicHostname,
      normalizeFrpcPublicUrl,
      normalizeFrpcToken,
      constants: {
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: path.join(tempRoot, 'cloudflare.json'),
        CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: path.join(tempRoot, 'cloudflare-legacy.json'),
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
        FRPC_MANAGED_TUNNEL_FILE_PATH: configPath,
        FRPC_MANAGED_TUNNEL_VERSION: 2,
      },
    });

    await expect(failingRuntime.upsertFrpcTunnelConfig({
      serverAddress: '203.0.113.11',
      serverPort: 7001,
      trustedCaFile: '/home/openchamber/frp/new-ca.crt',
      proxyType: 'tcp',
      remotePort: 18081,
      publicUrl: 'https://new.example.com:18081',
      token: 'new-private-token',
    })).rejects.toThrow(/publish failed/);

    expect(await runtime.readFrpcTunnelConfigFromDisk()).toMatchObject({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/old-ca.crt',
      remotePort: 18080,
      publicUrl: 'https://old.example.com:18080',
      token: 'old-private-token',
    });
  });
});
