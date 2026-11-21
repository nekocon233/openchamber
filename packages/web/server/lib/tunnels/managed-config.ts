import nodeCrypto from 'node:crypto';
import { z } from 'zod';
import type { createSettingsNormalizationRuntime } from '../settings/settings-normalization-runtime.js';
import {
  normalizeFrpcCustomDomain as defaultNormalizeFrpcCustomDomain,
  normalizeFrpcPublicHostname as defaultNormalizeFrpcPublicHostname,
  normalizeFrpcPublicUrl as defaultNormalizeFrpcPublicUrl,
  normalizeFrpcRemotePort as defaultNormalizeFrpcRemotePort,
  normalizeFrpcServerAddress as defaultNormalizeFrpcServerAddress,
  normalizeFrpcServerPort as defaultNormalizeFrpcServerPort,
  normalizeFrpcToken as defaultNormalizeFrpcToken,
} from './frpc-endpoint.js';
import { isString } from '../shared/object-guards.js';

export interface ManagedRemoteTunnelPreset {
  id: string;
  name: string;
  hostname: string;
}

export interface ManagedRemoteTunnelEntry extends ManagedRemoteTunnelPreset {
  token: string;
  updatedAt: number;
}

export interface ManagedRemoteTunnelConfig {
  version: number;
  tunnels: ManagedRemoteTunnelEntry[];
}

export interface ManagedRemoteTunnelTokenInput {
  id: unknown;
  name: unknown;
  hostname: unknown;
  token: unknown;
}

export interface FrpcTunnelConfigBase {
  version: number;
  serverAddress: string;
  serverPort: number;
  token: string;
  updatedAt: number;
}

export type FrpcTunnelConfig =
  | (FrpcTunnelConfigBase & {
    proxyType: 'tcp';
    remotePort: number;
    publicUrl: string;
    customDomain?: undefined;
    hostname?: undefined;
  })
  | (FrpcTunnelConfigBase & {
    proxyType: 'http';
    customDomain: string;
    hostname: string;
    remotePort?: undefined;
    publicUrl?: undefined;
  });

export interface FrpcTunnelConfigInput {
  serverAddress: unknown;
  serverPort: unknown;
  proxyType?: unknown;
  remotePort?: unknown;
  publicUrl?: unknown;
  customDomain?: unknown;
  hostname?: unknown;
  token: unknown;
}

export interface ManagedTunnelConfigDependencies<PresetInput> {
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'readFile'>
    & Partial<Pick<typeof import('node:fs/promises'), 'chmod' | 'rename' | 'rm'>>;
  path: Pick<typeof import('node:path'), 'dirname'>;
  crypto?: Pick<typeof import('node:crypto'), 'randomUUID'>;
  normalizeManagedRemoteTunnelHostname: ReturnType<typeof createSettingsNormalizationRuntime>['normalizeManagedRemoteTunnelHostname'];
  normalizeManagedRemoteTunnelPresets: (value: PresetInput) => ManagedRemoteTunnelPreset[] | undefined;
  normalizeFrpcServerAddress?: typeof defaultNormalizeFrpcServerAddress;
  normalizeFrpcServerPort?: typeof defaultNormalizeFrpcServerPort;
  normalizeFrpcRemotePort?: typeof defaultNormalizeFrpcRemotePort;
  normalizeFrpcCustomDomain?: typeof defaultNormalizeFrpcCustomDomain;
  normalizeFrpcPublicHostname?: typeof defaultNormalizeFrpcPublicHostname;
  normalizeFrpcPublicUrl?: typeof defaultNormalizeFrpcPublicUrl;
  normalizeFrpcToken?: typeof defaultNormalizeFrpcToken;
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: string;
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: string;
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: number;
    FRPC_MANAGED_TUNNEL_FILE_PATH?: string;
    FRPC_MANAGED_TUNNEL_VERSION?: number;
  };
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isEntryObject = (value: unknown): value is {
  id?: unknown;
  name?: unknown;
  hostname?: unknown;
  token?: unknown;
  updatedAt?: unknown;
} => Boolean(value) && typeof value === 'object';
const isConfigObject = (value: unknown): value is { tunnels?: unknown } =>
  Boolean(value) && typeof value === 'object';
const isFrpcConfigRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';
const hasErrorCode = (value: unknown): value is { code?: unknown } =>
  Boolean(value) && typeof value === 'object';
const isFiniteTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const createManagedTunnelConfigRuntime = <PresetInput>(deps: ManagedTunnelConfigDependencies<PresetInput>) => {
  const {
    fsPromises,
    path,
    crypto = nodeCrypto,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeFrpcServerAddress = defaultNormalizeFrpcServerAddress,
    normalizeFrpcServerPort = defaultNormalizeFrpcServerPort,
    normalizeFrpcRemotePort = defaultNormalizeFrpcRemotePort,
    normalizeFrpcCustomDomain = defaultNormalizeFrpcCustomDomain,
    normalizeFrpcPublicHostname = defaultNormalizeFrpcPublicHostname,
    normalizeFrpcPublicUrl = defaultNormalizeFrpcPublicUrl,
    normalizeFrpcToken = defaultNormalizeFrpcToken,
    constants,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
    FRPC_MANAGED_TUNNEL_FILE_PATH,
    FRPC_MANAGED_TUNNEL_VERSION = 3,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();
  let persistFrpcTunnelConfigLock = Promise.resolve();

  const sanitizeManagedRemoteTunnelConfigEntries = (value: unknown[]) => {
    const result: ManagedRemoteTunnelEntry[] = [];
    const seenIds = new Set();
    const seenHostnames = new Set();
    for (const entry of value) {
      if (!isEntryObject(entry)) {
        continue;
      }

      const id = isText(entry.id) ? entry.id.trim() : '';
      const name = isText(entry.name) ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      const token = isText(entry.token) ? entry.token.trim() : '';
      const updatedAt = isFiniteTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now();

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname, token, updatedAt });
    }

    return result;
  };

  const parseManagedRemoteTunnelConfigEntries = (raw: string) => {
    const parsed: unknown = JSON.parse(raw);
    return isConfigObject(parsed) && Array.isArray(parsed.tunnels)
      ? sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels)
      : [];
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data: ManagedRemoteTunnelConfig) => {
    await fsPromises.mkdir(path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
    try {
      const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
      const tunnels = parseManagedRemoteTunnelConfigEntries(legacyRaw);
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels,
      };
      await writeManagedRemoteTunnelConfigToDisk(migrated);
      return migrated;
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }
      console.warn('Failed to migrate legacy named tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const readManagedRemoteTunnelConfigFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8');
      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: parseManagedRemoteTunnelConfigEntries(raw),
      };
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      console.warn('Failed to read managed remote tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const updateManagedRemoteTunnelConfig = async (mutate: (current: ManagedRemoteTunnelConfig) => ManagedRemoteTunnelConfig) => {
    const result = persistManagedRemoteTunnelConfigLock.then(async () => {
      const current = await readManagedRemoteTunnelConfigFromDisk();
      const next = mutate({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
      });

      await writeManagedRemoteTunnelConfigToDisk({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
      });
    });
    persistManagedRemoteTunnelConfigLock = result.catch(() => {});
    return result;
  };

  const syncManagedRemoteTunnelConfigWithPresets = async (presets: PresetInput) => {
    const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

    await updateManagedRemoteTunnelConfig((current) => {
      const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
      const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

      const nextTunnels = [];
      for (const preset of sanitizedPresets) {
        const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
        if (!existing) {
          continue;
        }

        nextTunnels.push({
          ...existing,
          id: preset.id,
          name: preset.name,
          hostname: preset.hostname,
        });
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: nextTunnels,
      };
    });
  };

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token }: ManagedRemoteTunnelTokenInput) => {
    if (!isText(id) || !isText(name) || !isText(hostname) || !isText(token)) {
      return;
    }
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const normalizedToken = token.trim();
    if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
      return;
    }

    await updateManagedRemoteTunnelConfig((current) => {
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        token: normalizedToken,
        updatedAt: Date.now(),
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }: { presetId: string; hostname: string | undefined }) => {
    const normalizedPresetId = presetId.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const config = await readManagedRemoteTunnelConfigFromDisk();

    if (normalizedPresetId) {
      const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
      if (byId?.token) {
        return byId.token;
      }
    }

    if (normalizedHostname) {
      const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
      if (byHostname?.token) {
        return byHostname.token;
      }
    }

    return '';
  };

  const sanitizeFrpcTunnelConfig = z.unknown().transform((value): FrpcTunnelConfig => {
    if (!isFrpcConfigRecord(value)) {
      throw new Error('FRPC tunnel config has an unsupported format');
    }

    if (value.version === 1) {
      throw new Error('FRPC version-1 tunnel config does not satisfy the current secure endpoint contract');
    }

    if (value.version !== 2 && value.version !== FRPC_MANAGED_TUNNEL_VERSION) {
      throw new Error('FRPC tunnel config has an unsupported format');
    }

    const common: FrpcTunnelConfigBase = {
      version: FRPC_MANAGED_TUNNEL_VERSION,
      serverAddress: normalizeFrpcServerAddress(value.serverAddress),
      serverPort: normalizeFrpcServerPort(value.serverPort),
      token: normalizeFrpcToken(value.token),
      updatedAt: isFiniteTimestamp(value.updatedAt) ? value.updatedAt : Date.now(),
    };

    const proxyType = isString(value.proxyType) ? value.proxyType.trim().toLowerCase() : '';
    if (proxyType === 'tcp') {
      if (
        (value.customDomain !== undefined && value.customDomain !== null)
        || (value.hostname !== undefined && value.hostname !== null)
      ) {
        throw new Error('FRPC TCP tunnel config contains HTTP endpoint fields');
      }
      return {
        ...common,
        proxyType: 'tcp',
        remotePort: normalizeFrpcRemotePort(value.remotePort),
        publicUrl: normalizeFrpcPublicUrl(value.publicUrl),
      };
    }
    if (proxyType === 'http') {
      if (
        (value.remotePort !== undefined && value.remotePort !== null)
        || (value.publicUrl !== undefined && value.publicUrl !== null)
      ) {
        throw new Error('FRPC HTTP tunnel config contains TCP endpoint fields');
      }
      return {
        ...common,
        proxyType: 'http',
        customDomain: normalizeFrpcCustomDomain(value.customDomain),
        hostname: normalizeFrpcPublicHostname(value.hostname),
      };
    }

    throw new Error('FRPC tunnel config has an unsupported proxy type');
  }).parse;

  const readFrpcTunnelConfigFromDisk = async (): Promise<FrpcTunnelConfig | null> => {
    if (!FRPC_MANAGED_TUNNEL_FILE_PATH) {
      return null;
    }
    try {
      const raw = await fsPromises.readFile(FRPC_MANAGED_TUNNEL_FILE_PATH, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return sanitizeFrpcTunnelConfig(parsed);
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        return null;
      }
      throw new Error('Failed to read FRPC tunnel config', { cause: error });
    }
  };

  const writeFrpcTunnelConfigToDisk = async (config: FrpcTunnelConfig): Promise<void> => {
    if (!FRPC_MANAGED_TUNNEL_FILE_PATH) {
      throw new Error('FRPC tunnel config path is not configured');
    }
    const sanitized = sanitizeFrpcTunnelConfig(config);
    const directory = path.dirname(FRPC_MANAGED_TUNNEL_FILE_PATH);
    const tempPath = `${FRPC_MANAGED_TUNNEL_FILE_PATH}.${crypto.randomUUID()}.tmp`;
    await fsPromises.mkdir(directory, { recursive: true });
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(sanitized, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsPromises.chmod?.(tempPath, 0o600);
      if (fsPromises.rename) {
        await fsPromises.rename(tempPath, FRPC_MANAGED_TUNNEL_FILE_PATH);
      } else {
        await fsPromises.writeFile(FRPC_MANAGED_TUNNEL_FILE_PATH, JSON.stringify(sanitized, null, 2), { encoding: 'utf8', mode: 0o600 });
      }
    } catch (error) {
      await fsPromises.rm?.(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const upsertFrpcTunnelConfig = async ({
    serverAddress,
    serverPort,
    proxyType,
    remotePort,
    publicUrl,
    customDomain,
    hostname,
    token,
  }: FrpcTunnelConfigInput): Promise<void> => {
    const next = sanitizeFrpcTunnelConfig({
      version: FRPC_MANAGED_TUNNEL_VERSION,
      serverAddress,
      serverPort,
      proxyType,
      remotePort,
      publicUrl,
      customDomain,
      hostname,
      token,
      updatedAt: Date.now(),
    });
    const operation = persistFrpcTunnelConfigLock
      .catch(() => undefined)
      .then(() => writeFrpcTunnelConfigToDisk(next));
    persistFrpcTunnelConfigLock = operation;
    return operation;
  };

  const resolveFrpcTunnelToken = async ({
    serverAddress,
    serverPort,
  }: { serverAddress: unknown; serverPort: unknown }): Promise<string> => {
    const config = await readFrpcTunnelConfigFromDisk();
    if (!config) {
      return '';
    }
    let normalizedAddress: string;
    let normalizedPort: number;
    try {
      normalizedAddress = normalizeFrpcServerAddress(serverAddress);
      normalizedPort = normalizeFrpcServerPort(serverPort);
    } catch {
      return '';
    }
    return config.serverAddress === normalizedAddress && config.serverPort === normalizedPort
      ? config.token
      : '';
  };

  return {
    readManagedRemoteTunnelConfigFromDisk,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    readFrpcTunnelConfigFromDisk,
    upsertFrpcTunnelConfig,
    resolveFrpcTunnelToken,
  };
};
