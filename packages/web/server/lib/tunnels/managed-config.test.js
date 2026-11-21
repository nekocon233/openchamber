import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  normalizeFrpcToken,
} from './frpc-client.js';
import { createManagedTunnelConfigRuntime } from './managed-config.js';
import { createSettingsNormalizationRuntime } from '../settings/settings-normalization-runtime.js';

const createInMemoryRuntime = (initialFiles = [], normalizerOverrides = {}) => {
  const files = new Map(initialFiles);
  const normalizers = createSettingsNormalizationRuntime({});
  const runtime = createManagedTunnelConfigRuntime({
    fsPromises: {
      mkdir: async () => {},
      readFile: async (file) => {
        if (!files.has(file)) {
          throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
        }
        return files.get(file);
      },
      writeFile: async (file, data) => { files.set(file, data); },
    },
    path,
    normalizeManagedRemoteTunnelHostname: normalizers.normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets: normalizers.normalizeManagedRemoteTunnelPresets,
    ...normalizerOverrides,
    constants: {
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: '/managed.json',
      CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: '/legacy.json',
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
    },
  });
  return { runtime, files };
};

describe('managed remote tunnel config', () => {
  it.each([null, false, 7, 'text', [], {}, { tunnels: {} }, { tunnels: 'constructor' }])(
    'reads an empty list from invalid config %j',
    async (input) => {
      const { runtime } = createInMemoryRuntime([['/managed.json', JSON.stringify(input)]]);
      expect(await runtime.readManagedRemoteTunnelConfigFromDisk()).toEqual({ version: 1, tunnels: [] });
    }
  );

  it('retains only complete, unique entries and preserves finite timestamps', async () => {
    const timestamp = vi.spyOn(Date, 'now').mockReturnValue(1234);
    const entry = { id: ' a ', name: ' A ', hostname: 'https://A.EXAMPLE.COM/path', token: ' secret ', updatedAt: -1.5 };
    const { runtime } = createInMemoryRuntime([['/managed.json', JSON.stringify({
      tunnels: [
        null, false, 'text', [], {}, { ...entry, id: 7 }, { ...entry, token: false },
        entry,
        { ...entry, hostname: 'b.example.com' },
        { ...entry, id: 'b' },
        { ...entry, id: 'c', hostname: 'c.example.com', updatedAt: '100' },
      ],
    })]]);
    try {
      expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toEqual([
        { id: 'a', name: 'A', hostname: 'a.example.com', token: 'secret', updatedAt: -1.5 },
        { id: 'c', name: 'A', hostname: 'c.example.com', token: 'secret', updatedAt: 1234 },
      ]);
    } finally {
      timestamp.mockRestore();
    }
  });

  it('migrates only when the current file is absent', async () => {
    const legacy = JSON.stringify({ tunnels: [{ id: 'a', name: 'A', hostname: 'a.example.com', token: 'secret', updatedAt: 1 }] });
    const { runtime, files } = createInMemoryRuntime([['/legacy.json', legacy]]);
    const migrated = await runtime.readManagedRemoteTunnelConfigFromDisk();
    expect(migrated.tunnels).toHaveLength(1);
    expect(JSON.parse(files.get('/managed.json'))).toEqual(migrated);
    files.set('/managed.json', 'invalid JSON');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await runtime.readManagedRemoteTunnelConfigFromDisk()).toEqual({ version: 1, tunnels: [] });
      expect(files.get('/managed.json')).toBe('invalid JSON');
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves prototype-like preset ids and resolves id before hostname', async () => {
    const preset = Object.create({ id: 'constructor', name: 'Constructor', hostname: 'a.example.com' });
    const { runtime } = createInMemoryRuntime();
    await runtime.upsertManagedRemoteTunnelToken({ id: preset.id, name: preset.name, hostname: preset.hostname, token: 'first' });
    await runtime.upsertManagedRemoteTunnelToken({ id: 'other', name: 'Other', hostname: 'b.example.com', token: 'second' });
    expect(await runtime.resolveManagedRemoteTunnelToken({ presetId: 'constructor', hostname: 'b.example.com' })).toBe('first');
    await runtime.syncManagedRemoteTunnelConfigWithPresets([preset]);
    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toMatchObject([
      { id: 'constructor', name: 'Constructor', hostname: 'a.example.com', token: 'first' },
    ]);
  });

  it('forwards raw preset input to the injected normalizer', async () => {
    const normalize = vi.fn(() => []);
    const { runtime } = createInMemoryRuntime([], { normalizeManagedRemoteTunnelPresets: normalize });
    const raw = { unvalidated: true };
    await runtime.syncManagedRemoteTunnelConfigWithPresets(raw);
    expect(normalize).toHaveBeenCalledWith(raw);
    expect((await runtime.readManagedRemoteTunnelConfigFromDisk()).tunnels).toEqual([]);
  });

  it.each(['id', 'name', 'hostname', 'token'])('rejects a non-string %s before persisting', async (field) => {
    const { runtime, files } = createInMemoryRuntime();
    await runtime.upsertManagedRemoteTunnelToken({
      id: 'a', name: 'A', hostname: 'a.example.com', token: 'secret', [field]: 7,
    });
    expect(files.size).toBe(0);
  });

  it('writes the next update after one failed with a full disk', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-managed-tunnels-'));
    const configPath = path.join(tempRoot, 'cloudflare-managed-remote-tunnels.json');
    let failNextWrite = true;
    const runtime = createManagedTunnelConfigRuntime({
      fsPromises: {
        ...fsPromises,
        writeFile: async (file, ...rest) => {
          if (failNextWrite && file === configPath) {
            failNextWrite = false;
            const error = new Error('ENOSPC: no space left on device, write');
            error.code = 'ENOSPC';
            throw error;
          }
          return fsPromises.writeFile(file, ...rest);
        },
      },
      path,
      normalizeManagedRemoteTunnelHostname: (value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''),
      normalizeManagedRemoteTunnelPresets: (value) => value,
      constants: {
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: configPath,
        CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: path.join(tempRoot, 'legacy.json'),
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tunnel = { id: 'a', name: 'A', hostname: 'a.example.com' };
    try {
      await expect(runtime.upsertManagedRemoteTunnelToken({ ...tunnel, token: 'first' })).rejects.toThrow('ENOSPC');
      await expect(runtime.upsertManagedRemoteTunnelToken({ ...tunnel, token: 'second' })).resolves.toBeUndefined();
      const onDisk = await runtime.readManagedRemoteTunnelConfigFromDisk();
      expect(onDisk.tunnels).toMatchObject([{ ...tunnel, token: 'second' }]);
    } finally {
      warn.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('FRPC managed tunnel config', () => {
  let tempRoot;
  let configPath;
  let runtime;
  const supportsPosixPermissions = process.platform !== 'win32';

  const createConfigRuntime = (runtimeFsPromises = fsPromises) => createManagedTunnelConfigRuntime({
    fsPromises: runtimeFsPromises,
    path,
    crypto,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: () => [],
    normalizeFrpcServerAddress,
    normalizeFrpcServerPort,
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
      FRPC_MANAGED_TUNNEL_VERSION: 3,
    },
  });

  beforeEach(async () => {
    tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-frpc-config-test-'));
    configPath = path.join(tempRoot, 'frpc-managed-tunnel.json');
    runtime = createConfigRuntime();
  });

  afterEach(async () => {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  });

  it('round-trips the private endpoint credential with restrictive permissions', async () => {
    await runtime.upsertFrpcTunnelConfig({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'private-frpc-token',
    });

    expect(await runtime.readFrpcTunnelConfigFromDisk()).toMatchObject({
      version: 3,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      token: 'private-frpc-token',
    });
    if (supportsPosixPermissions) {
      expect((await fsPromises.stat(configPath)).mode & 0o777).toBe(0o600);
    }
    await expect(runtime.resolveFrpcTunnelToken({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
    })).resolves.toBe('private-frpc-token');
    await expect(runtime.resolveFrpcTunnelToken({
      serverAddress: '203.0.113.11',
      serverPort: 7000,
    })).resolves.toBe('');
  });

  it('migrates a version-2 record and drops its legacy CA path', async () => {
    await fsPromises.writeFile(configPath, JSON.stringify({
      version: 2,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      proxyType: 'http',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: 'private-frpc-token',
      updatedAt: 123,
    }), { encoding: 'utf8', mode: 0o600 });

    expect(await runtime.readFrpcTunnelConfigFromDisk()).toMatchObject({
      version: 3,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      proxyType: 'http',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: 'private-frpc-token',
    });
    expect(await runtime.readFrpcTunnelConfigFromDisk()).not.toHaveProperty('trustedCaFile');
  });

  it('round-trips an HTTP-vhost endpoint without persisting a remote port', async () => {
    await runtime.upsertFrpcTunnelConfig({
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      proxyType: 'http',
      customDomain: 'Route.Example.com',
      hostname: 'Public.Example.com',
      token: 'private-frpc-token',
    });

    expect(await runtime.readFrpcTunnelConfigFromDisk()).toMatchObject({
      version: 3,
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      proxyType: 'http',
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      token: 'private-frpc-token',
    });
    const persisted = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
    expect(persisted.remotePort).toBeUndefined();
    if (supportsPosixPermissions) {
      expect((await fsPromises.stat(configPath)).mode & 0o777).toBe(0o600);
    }
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
    if (supportsPosixPermissions) {
      expect((await fsPromises.stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects legacy or insecure TCP records without a valid public HTTPS URL', async () => {
    for (const publicUrl of [undefined, 'http://app.example.com:18080', 'https://app.example.com:18080/path']) {
      await fsPromises.writeFile(configPath, JSON.stringify({
        version: 2,
        serverAddress: '203.0.113.10',
        serverPort: 7000,
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

  it('preserves the previous endpoint and token when atomic publish fails', async () => {
    await runtime.upsertFrpcTunnelConfig({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      proxyType: 'tcp',
      remotePort: 18080,
      publicUrl: 'https://old.example.com:18080',
      token: 'old-private-token',
    });
    const failingRuntime = createConfigRuntime({
      ...fsPromises,
      rename: async () => {
        throw new Error('publish failed');
      },
    });

    await expect(failingRuntime.upsertFrpcTunnelConfig({
      serverAddress: '203.0.113.11',
      serverPort: 7001,
      proxyType: 'tcp',
      remotePort: 18081,
      publicUrl: 'https://new.example.com:18081',
      token: 'new-private-token',
    })).rejects.toThrow(/publish failed/);

    expect(await runtime.readFrpcTunnelConfigFromDisk()).toMatchObject({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      remotePort: 18080,
      publicUrl: 'https://old.example.com:18080',
      token: 'old-private-token',
    });
  });
});
