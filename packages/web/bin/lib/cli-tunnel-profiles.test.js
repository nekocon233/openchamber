import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getLegacyCloudflareManagedRemoteFilePath,
  getTunnelProfilesFilePath,
} from './cli-paths.js';
import {
  ensureTunnelProfilesMigrated,
  formatProfileEndpoint,
  getCliManagedRemoteCredentialId,
  persistTunnelProfilesToDisk,
  redactProfileForOutput,
  writeTunnelProfilesToDisk,
} from './cli-tunnel-profiles.js';

let tempRoot;
let priorDataDir;

const readManagedRemoteCredentials = () => JSON.parse(
  fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8')
);

beforeEach(() => {
  priorDataDir = process.env.OPENCHAMBER_DATA_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cli-profile-test-'));
  process.env.OPENCHAMBER_DATA_DIR = tempRoot;
});

afterEach(() => {
  if (typeof priorDataDir === 'string') {
    process.env.OPENCHAMBER_DATA_DIR = priorDataDir;
  } else {
    delete process.env.OPENCHAMBER_DATA_DIR;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('FRPC tunnel profiles', () => {
  it('round-trips an existing version-2 TCP profile without data loss', () => {
    writeTunnelProfilesToDisk({
      version: 2,
      profiles: [{
        id: 'frpc-main',
        name: 'frpc-main',
        provider: 'frpc',
        mode: 'managed-remote',
        serverAddress: '203.0.113.10',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
        token: 'private-frpc-token',
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    const store = ensureTunnelProfilesMigrated({ shouldWarn: false });
    expect(store).toEqual({
      version: 2,
      profiles: [{
        id: 'frpc-main',
        name: 'frpc-main',
        provider: 'frpc',
        mode: 'managed-remote',
        serverAddress: '203.0.113.10',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
        token: 'private-frpc-token',
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    expect(formatProfileEndpoint(store.profiles[0])).toBe('203.0.113.10:7000 remote:18080 public:https://app.example.com:18080');
    if (process.platform !== 'win32') {
      expect(fs.statSync(getTunnelProfilesFilePath()).mode & 0o777).toBe(0o600);
    }
  });

  it('persists an HTTP-vhost endpoint in version 2 without a stale remote port', () => {
    writeTunnelProfilesToDisk({
      version: 2,
      profiles: [{
        id: 'frpc-http',
        name: 'frpc-http',
        provider: 'frpc',
        mode: 'managed-remote',
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        token: 'http-profile-test-token',
        createdAt: 2,
        updatedAt: 3,
      }],
    });

    const store = ensureTunnelProfilesMigrated({ shouldWarn: false });
    expect(store.version).toBe(2);
    expect(store.profiles[0]).toEqual({
      id: 'frpc-http',
      name: 'frpc-http',
      provider: 'frpc',
      mode: 'managed-remote',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      customDomain: 'openchamber.internal',
      hostname: 'app.example.com',
      token: 'http-profile-test-token',
      createdAt: 2,
      updatedAt: 3,
    });
    expect(store.profiles[0]).not.toHaveProperty('remotePort');
    expect(formatProfileEndpoint(store.profiles[0])).toBe(
      'frps.example.com:7000 http:openchamber.internal public:app.example.com',
    );
  });

  it('drops ambiguous FRPC profiles that mix TCP and HTTP endpoints', () => {
    writeTunnelProfilesToDisk({
      version: 2,
      profiles: [{
        name: 'mixed',
        provider: 'frpc',
        mode: 'managed-remote',
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile: '/home/openchamber/frp/ca.crt',
        remotePort: 18080,
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        token: 'mixed-profile-test-token',
      }],
    });

    expect(ensureTunnelProfilesMigrated({ shouldWarn: false }).profiles).toEqual([]);
  });

  it('never serializes a stored token for output', () => {
    const safe = redactProfileForOutput({
      name: 'frpc-main',
      provider: 'frpc',
      token: 'frpc-secret-SHOULD-NOT-LEAK',
    }, true);

    expect(safe).toEqual({ name: 'frpc-main', provider: 'frpc', hasToken: true });
    expect(JSON.stringify(safe)).not.toContain('frpc-secret-SHOULD-NOT-LEAK');
  });

  it('does not treat malformed profile storage as an empty store', () => {
    const filePath = getTunnelProfilesFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{not-json', { encoding: 'utf8', mode: 0o600 });

    expect(() => ensureTunnelProfilesMigrated({ shouldWarn: false })).toThrow(/Failed to read tunnel profile file/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{not-json');
  });

  it('updates a legacy CLI-owned credential without deleting Settings-owned records', () => {
    const original = {
      version: 2,
      profiles: [{
        id: 'cloudflare-main',
        name: 'cloudflare-main',
        provider: 'cloudflare',
        mode: 'managed-remote',
        hostname: 'old.example.com',
        token: 'old-token',
      }],
    };
    writeTunnelProfilesToDisk(original);
    const settingsEntry = {
      id: 'settings-owned',
      name: 'settings-owned',
      hostname: 'settings.example.com',
      token: 'settings-token',
      updatedAt: 11,
      source: 'settings',
    };
    const pairsPath = getLegacyCloudflareManagedRemoteFilePath();
    fs.writeFileSync(pairsPath, JSON.stringify({
      version: 1,
      tunnels: [
        settingsEntry,
        {
          id: 'cloudflare-main',
          name: 'cloudflare-main',
          hostname: 'old.example.com',
          token: 'old-token',
          updatedAt: 10,
        },
      ],
    }, null, 2), { encoding: 'utf8', mode: 0o600 });

    persistTunnelProfilesToDisk({
      version: 2,
      profiles: [{
        ...original.profiles[0],
        hostname: 'new.example.com',
        token: 'new-token',
        updatedAt: 12,
      }],
    });

    expect(readManagedRemoteCredentials().tunnels).toEqual([
      settingsEntry,
      {
        id: getCliManagedRemoteCredentialId('cloudflare-main'),
        name: 'cloudflare-main',
        hostname: 'new.example.com',
        token: 'new-token',
        updatedAt: 12,
      },
    ]);
  });

  it('removes only the deleted CLI profile credential', () => {
    const profile = {
      id: 'cloudflare-main',
      name: 'cloudflare-main',
      provider: 'cloudflare',
      mode: 'managed-remote',
      hostname: 'cli.example.com',
      token: 'cli-token',
    };
    persistTunnelProfilesToDisk({ version: 2, profiles: [profile] });
    const credentials = readManagedRemoteCredentials();
    const settingsEntry = {
      id: 'settings-owned',
      name: 'settings-owned',
      hostname: 'settings.example.com',
      token: 'settings-token',
      updatedAt: 21,
    };
    credentials.tunnels.unshift(settingsEntry);
    fs.writeFileSync(
      getLegacyCloudflareManagedRemoteFilePath(),
      JSON.stringify(credentials, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );

    persistTunnelProfilesToDisk({ version: 2, profiles: [] });

    expect(readManagedRemoteCredentials().tunnels).toEqual([settingsEntry]);
  });

  it('migrates an explicitly owned compatibility record without duplicating its prefix', () => {
    const pairsPath = getLegacyCloudflareManagedRemoteFilePath();
    fs.mkdirSync(path.dirname(pairsPath), { recursive: true });
    fs.writeFileSync(pairsPath, JSON.stringify({
      version: 1,
      tunnels: [{
        id: getCliManagedRemoteCredentialId('cloudflare-main'),
        name: 'cloudflare-main',
        hostname: 'cli.example.com',
        token: 'cli-token',
        updatedAt: 31,
      }],
    }, null, 2), { encoding: 'utf8', mode: 0o600 });

    const migrated = ensureTunnelProfilesMigrated({ shouldWarn: false });

    expect(migrated.profiles[0].id).toBe('cloudflare-main');
    expect(readManagedRemoteCredentials().tunnels[0].id).toBe(
      getCliManagedRemoteCredentialId('cloudflare-main')
    );
  });

  it('does not import an unowned Settings credential as a CLI profile', () => {
    const pairsPath = getLegacyCloudflareManagedRemoteFilePath();
    fs.mkdirSync(path.dirname(pairsPath), { recursive: true });
    const settingsData = {
      version: 1,
      tunnels: [{
        id: 'settings-owned',
        name: 'settings-owned',
        hostname: 'settings.example.com',
        token: 'settings-token',
        updatedAt: 32,
      }],
    };
    fs.writeFileSync(pairsPath, JSON.stringify(settingsData, null, 2), { encoding: 'utf8', mode: 0o600 });

    expect(ensureTunnelProfilesMigrated({ shouldWarn: false })).toEqual({ version: 2, profiles: [] });
    expect(readManagedRemoteCredentials()).toEqual(settingsData);
    expect(fs.existsSync(getTunnelProfilesFilePath())).toBe(false);
  });

  it('does not publish profile changes when the credential write fails', () => {
    const original = {
      version: 2,
      profiles: [{
        id: 'cloudflare-main',
        name: 'cloudflare-main',
        provider: 'cloudflare',
        mode: 'managed-remote',
        hostname: 'old.example.com',
        token: 'old-token',
      }],
    };
    persistTunnelProfilesToDisk(original);
    const originalProfiles = fs.readFileSync(getTunnelProfilesFilePath(), 'utf8');
    const originalCredentials = fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8');

    expect(() => persistTunnelProfilesToDisk({
      version: 2,
      profiles: [{
        ...original.profiles[0],
        hostname: 'new.example.com',
        token: 'new-token',
      }],
    }, {
      writeManagedRemotePairs: () => {
        throw new Error('credential write failed');
      },
    })).toThrow(/credential write failed/);

    expect(fs.readFileSync(getTunnelProfilesFilePath(), 'utf8')).toBe(originalProfiles);
    expect(fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8')).toBe(originalCredentials);
  });

  it('rolls back the credential file when publishing the profile file fails', () => {
    const original = {
      version: 2,
      profiles: [{
        id: 'cloudflare-main',
        name: 'cloudflare-main',
        provider: 'cloudflare',
        mode: 'managed-remote',
        hostname: 'old.example.com',
        token: 'old-token',
      }],
    };
    persistTunnelProfilesToDisk(original);
    const credentials = readManagedRemoteCredentials();
    credentials.tunnels.unshift({
      id: 'settings-owned',
      name: 'settings-owned',
      hostname: 'settings.example.com',
      token: 'settings-token',
      updatedAt: 30,
    });
    fs.writeFileSync(
      getLegacyCloudflareManagedRemoteFilePath(),
      JSON.stringify(credentials, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    const originalProfiles = fs.readFileSync(getTunnelProfilesFilePath(), 'utf8');
    const originalCredentials = fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8');

    expect(() => persistTunnelProfilesToDisk({
      version: 2,
      profiles: [{
        ...original.profiles[0],
        hostname: 'new.example.com',
        token: 'new-token',
      }],
    }, {
      writeProfiles: () => {
        throw new Error('profile write failed');
      },
    })).toThrow(/profile write failed/);

    expect(fs.readFileSync(getTunnelProfilesFilePath(), 'utf8')).toBe(originalProfiles);
    expect(fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8')).toBe(originalCredentials);
  });
});
