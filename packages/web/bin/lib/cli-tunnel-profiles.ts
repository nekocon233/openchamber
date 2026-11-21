import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import type { JsonValue } from '../../server/lib/shared/json-values.js';
import type { CliOptions } from './cli-args.js';
import {
  getTunnelProfilesFilePath,
  getLegacyCloudflareManagedRemoteFilePath,
} from './cli-paths.js';
import {
  normalizeFrpcCustomDomain,
  normalizeFrpcPublicHostname,
  normalizeFrpcPublicUrl,
  normalizeFrpcRemotePort,
  normalizeFrpcServerAddress,
  normalizeFrpcServerPort,
} from '../../server/lib/tunnels/frpc-endpoint.js';

const TUNNEL_PROFILES_VERSION = 2;
const MAX_TOKEN_FILE_BYTES = 8 * 1024;
const CLI_MANAGED_REMOTE_ID_PREFIX = 'cli-profile:';

export type TunnelProfile = {
  id: string;
  name: string;
  provider: string;
  mode: string;
  hostname?: string;
  customDomain?: string;
  publicUrl?: string;
  serverAddress?: string;
  serverPort?: number;
  remotePort?: number;
  token: string;
  createdAt: number;
  updatedAt: number;
};

export interface TunnelProfileEndpointInput {
  provider?: string | null | undefined;
  hostname?: string | null | undefined;
  customDomain?: string | null | undefined;
  serverAddress?: string | null | undefined;
  serverPort?: number | null | undefined;
  remotePort?: number | null | undefined;
  publicUrl?: string | null | undefined;
}

export interface TunnelProfilesStore {
  version: number;
  profiles: TunnelProfile[];
}

export interface TunnelProfilesInput {
  version?: unknown;
  profiles?: unknown;
}

type PrivateFileSnapshot =
  | { exists: true; contents: string }
  | { exists: false; contents: null };

interface ManagedRemotePairRecord {
  id: string;
  name: string;
  hostname: string;
  token: string;
  updatedAt?: number;
  [key: string]: JsonValue | undefined;
}

interface ManagedRemotePairsData {
  version: 1;
  tunnels: ManagedRemotePairRecord[];
}

export interface WriteManagedRemotePairsOptions {
  previousProfilesData?: TunnelProfilesInput | null | undefined;
  existingPairsData?: ManagedRemotePairsData | null | undefined;
  affectedProfileIds?: Set<string> | undefined;
}

export interface PersistTunnelProfilesOptions {
  writeProfiles?: (data: TunnelProfilesInput | null | undefined) => TunnelProfilesStore;
  writeManagedRemotePairs?: (
    profilesData: TunnelProfilesInput | null | undefined,
    options?: WriteManagedRemotePairsOptions,
  ) => void;
}

function isProfileText(value: unknown): value is string {
  return typeof value === 'string';
}

function isProfileContainer(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isProfileList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isProfileTimestamp(value: unknown): value is number {
  return Number.isFinite(value);
}

const normalizeProfileText = z.unknown().transform((value) => isProfileText(value) ? value.trim() : '').parse;
const normalizeProfileId = z.unknown().transform((value) => normalizeProfileText(value).toLowerCase()).parse;

const getCliManagedRemoteCredentialId = z.unknown().transform((profileId) => {
  const normalized = normalizeProfileText(profileId);
  return normalized ? `${CLI_MANAGED_REMOTE_ID_PREFIX}${normalized}` : '';
}).parse;

const profileEndpointTextParser = (parse: typeof normalizeFrpcCustomDomain) => z.unknown().transform((value) => {
  try {
    return parse(value);
  } catch {
    return '';
  }
}).parse;

const normalizeProfileCustomDomain = profileEndpointTextParser(normalizeFrpcCustomDomain);
const normalizeProfilePublicHostname = profileEndpointTextParser(normalizeFrpcPublicHostname);
const normalizeProfilePublicUrl = profileEndpointTextParser(normalizeFrpcPublicUrl);
const normalizeProfileServerAddress = profileEndpointTextParser(normalizeFrpcServerAddress);

const profilePortParser = (parse: typeof normalizeFrpcServerPort) => z.unknown().transform((value) => {
  const parsed = isProfileText(value) ? Number(value.trim()) : value;
  try {
    return parse(parsed);
  } catch {
    return undefined;
  }
}).parse;

const normalizeProfileServerPort = profilePortParser(normalizeFrpcServerPort);
const normalizeProfileRemotePort = profilePortParser(normalizeFrpcRemotePort);

function suggestProfileNameFromHostname(hostname: string | null | undefined) {
  const normalizedHost = normalizeProfileText(hostname);
  if (!normalizedHost) return 'prod-main';
  const firstLabel = normalizedHost.split('.')[0] || normalizedHost;
  const sanitized = firstLabel.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'prod-main';
}

function maskToken(token: string | null | undefined) {
  if (!isProfileText(token) || token.length === 0) {
    return '***';
  }
  if (token.length <= 4) {
    return '*'.repeat(token.length);
  }
  return `${'*'.repeat(Math.max(4, token.length - 4))}${token.slice(-4)}`;
}

function readTokenFromFileSafely(tokenFilePath: string) {
  const absolutePath = path.resolve(tokenFilePath);
  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch (error) {
    if (isProfileContainer(error) && error.code === 'ENOENT') {
      throw new Error(`Token file '${absolutePath}' not found.`);
    }
    if (isProfileContainer(error) && error.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch (error) {
    if (isProfileContainer(error) && error.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`Token file '${absolutePath}' must be a regular file.`);
  }
  if (stats.size <= 0) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  if (stats.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error(`Token file '${absolutePath}' is too large (max ${MAX_TOKEN_FILE_BYTES} bytes).`);
  }

  const raw = fs.readFileSync(realPath, 'utf8');
  if (raw.includes('\u0000')) {
    throw new Error(`Token file '${absolutePath}' appears to be binary. Use a plain text token file.`);
  }

  const value = raw.trim();
  if (!value) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  return value;
}

function resolveToken(options: Pick<Partial<CliOptions>, 'tokenStdin' | 'tokenFile' | 'token'>) {
  const sources = [
    options.tokenStdin ? 'stdin' : null,
    options.tokenFile ? 'file' : null,
    options.token ? 'flag' : null,
  ].filter(Boolean);

  if (sources.length > 1) {
    throw new Error(`Multiple token sources specified (${sources.join(', ')}). Use only one of --token, --token-file, or --token-stdin.`);
  }

  if (options.tokenStdin) {
    const buf = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    const bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    if (bytesRead > MAX_TOKEN_FILE_BYTES) {
      throw new Error(`Token from stdin is too large (max ${MAX_TOKEN_FILE_BYTES} bytes).`);
    }
    const raw = buf.slice(0, bytesRead).toString('utf8');
    if (raw.includes('\u0000')) {
      throw new Error('Token from stdin appears to be binary. Use a plain text token.');
    }
    const value = raw.trim();
    if (!value) {
      throw new Error('No token received from stdin.');
    }
    return value;
  }

  if (options.tokenFile) {
    return readTokenFromFileSafely(options.tokenFile);
  }

  return isProfileText(options.token) ? options.token.trim() : undefined;
}

type RedactedProfile<Profile extends { token?: unknown }> = Omit<Profile, 'token'> & { hasToken: boolean };

function redactProfileForOutput<Profile extends { token?: unknown }>(
  profile: Profile | null | undefined,
  _showSecrets = false,
): RedactedProfile<Profile> | null | undefined {
  if (!isProfileContainer(profile)) {
    return profile;
  }
  const { token, ...safeProfile } = profile;
  return {
    ...safeProfile,
    hasToken: isProfileText(token) && token.trim().length > 0,
  };
}

function redactProfilesForOutput<Profile extends { token?: unknown }>(
  profiles: Profile[],
  _showSecrets = false,
) {
  if (!Array.isArray(profiles)) {
    return profiles;
  }
  return profiles.map((entry) => redactProfileForOutput(entry));
}

function formatProfileTokenStatus(profile: { token?: unknown } | null | undefined, _showSecrets = false) {
  const token = isProfileText(profile?.token) ? profile.token.trim() : '';
  if (!token) {
    return 'token:missing';
  }
  return 'token:present';
}

function formatProfileEndpoint(profile: TunnelProfileEndpointInput | null | undefined) {
  if (profile?.provider === 'frpc') {
    if (profile.customDomain && profile.hostname) {
      return `${profile.serverAddress}:${profile.serverPort} http:${profile.customDomain} public:${profile.hostname}`;
    }
    return `${profile.serverAddress}:${profile.serverPort} remote:${profile.remotePort} public:${profile.publicUrl || 'missing'}`;
  }
  return profile?.hostname || 'n/a';
}

function sanitizeTunnelProfilesData(data: TunnelProfilesInput | null | undefined): TunnelProfilesStore {
  const parsed = isProfileContainer(data) ? data : {};
  const list = isProfileList(parsed.profiles) ? parsed.profiles : [];
  const seen = new Set<string>();
  const profiles: TunnelProfile[] = [];
  for (const entry of list) {
    if (!isProfileContainer(entry)) continue;
    const id = isProfileText(entry.id) && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
    const provider = normalizeProfileId(entry.provider);
    const mode = normalizeProfileId(entry.mode);
    const name = normalizeProfileText(entry.name);
    const hostname = provider === 'frpc'
      ? normalizeProfilePublicHostname(entry.hostname)
      : normalizeProfileText(entry.hostname);
    const customDomain = normalizeProfileCustomDomain(entry.customDomain);
    const publicUrl = normalizeProfilePublicUrl(entry.publicUrl);
    const serverAddress = normalizeProfileServerAddress(entry.serverAddress);
    const serverPort = normalizeProfileServerPort(entry.serverPort);
    const remotePort = normalizeProfileRemotePort(entry.remotePort);
    const token = normalizeProfileText(entry.token);
    if (!provider || !mode || !name || !token) continue;

    const createdAt = isProfileTimestamp(entry.createdAt) ? entry.createdAt : Date.now();
    const updatedAt = isProfileTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now();

    if (provider === 'frpc') {
      if (!serverAddress || serverPort === undefined) continue;
      const hasFrpcTcpEndpoint = remotePort !== undefined && !customDomain && !hostname;
      const hasFrpcHttpEndpoint = remotePort === undefined && Boolean(customDomain) && Boolean(hostname);
      if (!hasFrpcTcpEndpoint && !hasFrpcHttpEndpoint) continue;
      const key = `${provider}::${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (hasFrpcTcpEndpoint) {
        const profile: TunnelProfile = {
          id,
          name,
          provider,
          mode,
          serverAddress,
          serverPort,
          remotePort,
          token,
          createdAt,
          updatedAt,
        };
        if (publicUrl) profile.publicUrl = publicUrl;
        profiles.push(profile);
      } else {
        profiles.push({
          id,
          name,
          provider,
          mode,
          serverAddress,
          serverPort,
          customDomain,
          hostname,
          token,
          createdAt,
          updatedAt,
        });
      }
      continue;
    }

    if (!hostname) continue;
    const key = `${provider}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({
      id,
      name,
      provider,
      mode,
      hostname,
      token,
      createdAt,
      updatedAt,
    });
  }
  return { version: TUNNEL_PROFILES_VERSION, profiles };
}

function warnIfUnsafeFilePermissions(filePath: string, { shouldWarn = true } = {}) {
  if (process.platform === 'win32') {
    return;
  }
  if (!shouldWarn) {
    return;
  }
  try {
    const stats = fs.statSync(filePath);
    const perms = stats.mode & 0o777;
    if (perms & 0o077) {
      const octal = perms.toString(8).padStart(3, '0');
      console.warn(
        `Warning: Profile file '${filePath}' has permissions ${octal} (should be 600). ` +
        `Other users may be able to read tunnel tokens. Fix with: chmod 600 '${filePath}'`
      );
    }
  } catch {
    void 0;
  }
}

function readTunnelProfilesFromDisk(options: { shouldWarn?: boolean } = {}): TunnelProfilesStore {
  const filePath = getTunnelProfilesFilePath();
  try {
    warnIfUnsafeFilePermissions(filePath, options);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return sanitizeTunnelProfilesData(isProfileContainer(parsed) ? parsed : undefined);
  } catch (error) {
    if (isProfileContainer(error) && error.code === 'ENOENT') {
      return { version: TUNNEL_PROFILES_VERSION, profiles: [] };
    }
    throw new Error(`Failed to read tunnel profile file '${filePath}'`, { cause: error });
  }
}

function writePrivateFileAtomic(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function writeTunnelProfilesToDisk(data: TunnelProfilesInput | null | undefined) {
  const filePath = getTunnelProfilesFilePath();
  const sanitized = sanitizeTunnelProfilesData(data);
  writePrivateFileAtomic(filePath, JSON.stringify(sanitized, null, 2));
  return sanitized;
}

function getCloudflareManagedRemoteProfiles(data: TunnelProfilesInput | null | undefined) {
  return sanitizeTunnelProfilesData(data).profiles.filter(
    (entry) => entry.provider === 'cloudflare' && entry.mode === 'managed-remote'
  );
}

function resolveAffectedCloudflareProfileIds(
  previousData: TunnelProfilesInput | null | undefined,
  nextData: TunnelProfilesInput | null | undefined,
) {
  const previous = new Map(getCloudflareManagedRemoteProfiles(previousData).map((entry) => [entry.id, entry]));
  const next = new Map(getCloudflareManagedRemoteProfiles(nextData).map((entry) => [entry.id, entry]));
  const affected = new Set<string>();
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const before = previous.get(id);
    const after = next.get(id);
    if (
      !before
      || !after
      || before.name !== after.name
      || before.hostname !== after.hostname
      || before.token !== after.token
    ) {
      affected.add(id);
    }
  }
  return affected;
}

function parseManagedRemotePairsSnapshot(snapshot: PrivateFileSnapshot): ManagedRemotePairsData {
  if (!snapshot.exists) {
    return { version: 1, tunnels: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.contents);
  } catch (error) {
    throw new Error('Failed to read managed-remote compatibility credentials', { cause: error });
  }
  if (!isProfileContainer(parsed) || parsed.version !== 1 || !isProfileList(parsed.tunnels)) {
    throw new Error('Managed-remote compatibility credentials have an unsupported format');
  }
  const tunnels: ManagedRemotePairRecord[] = [];
  for (const entry of parsed.tunnels) {
    if (!isProfileContainer(entry)) {
      throw new Error('Managed-remote compatibility credentials contain an invalid entry');
    }
    const id = normalizeProfileText(entry.id);
    const name = normalizeProfileText(entry.name);
    const hostname = normalizeProfileText(entry.hostname);
    const token = normalizeProfileText(entry.token);
    if (!id || !name || !hostname || !token) {
      throw new Error('Managed-remote compatibility credentials contain an invalid entry');
    }
    tunnels.push({
      ...entry,
      id: isProfileText(entry.id) ? entry.id : id,
      name: isProfileText(entry.name) ? entry.name : name,
      hostname: isProfileText(entry.hostname) ? entry.hostname : hostname,
      token: isProfileText(entry.token) ? entry.token : token,
    });
  }
  return { version: 1, tunnels };
}

function resolveCredentialOwnerProfileId(entry: { id?: unknown } | null | undefined, knownProfileIds: Set<string>) {
  const id = normalizeProfileText(entry?.id);
  if (id.startsWith(CLI_MANAGED_REMOTE_ID_PREFIX)) {
    return id.slice(CLI_MANAGED_REMOTE_ID_PREFIX.length) || null;
  }
  return knownProfileIds.has(id) ? id : null;
}

function buildManagedRemotePairsData({
  previousProfilesData,
  nextProfilesData,
  existingPairsData,
  affectedProfileIds,
}: {
  previousProfilesData: TunnelProfilesInput | null | undefined;
  nextProfilesData: TunnelProfilesInput | null | undefined;
  existingPairsData: ManagedRemotePairsData;
  affectedProfileIds: Set<string>;
}): ManagedRemotePairsData {
  const previousProfiles = getCloudflareManagedRemoteProfiles(previousProfilesData);
  const nextProfiles = getCloudflareManagedRemoteProfiles(nextProfilesData);
  const knownProfileIds = new Set([
    ...previousProfiles.map((entry) => entry.id),
    ...nextProfiles.map((entry) => entry.id),
  ]);
  const tunnels = existingPairsData.tunnels.filter((entry) => {
    const ownerProfileId = resolveCredentialOwnerProfileId(entry, knownProfileIds);
    return !ownerProfileId || !affectedProfileIds.has(ownerProfileId);
  });

  for (const profile of nextProfiles) {
    if (!affectedProfileIds.has(profile.id)) {
      continue;
    }
    tunnels.push({
      id: getCliManagedRemoteCredentialId(profile.id),
      name: profile.name,
      hostname: normalizeProfileText(profile.hostname),
      token: profile.token,
      updatedAt: Number.isFinite(profile.updatedAt) ? profile.updatedAt : Date.now(),
    });
  }

  return { version: 1, tunnels };
}

function writeManagedRemotePairsToDiskFromProfiles(
  profilesData: TunnelProfilesInput | null | undefined,
  options: WriteManagedRemotePairsOptions = {},
) {
  const previousProfilesData = options.previousProfilesData
    ?? parseTunnelProfilesSnapshot(snapshotPrivateFile(getTunnelProfilesFilePath()));
  const existingPairsData = options.existingPairsData
    ?? parseManagedRemotePairsSnapshot(snapshotPrivateFile(getLegacyCloudflareManagedRemoteFilePath()));
  const affectedProfileIds = options.affectedProfileIds
    ?? resolveAffectedCloudflareProfileIds(previousProfilesData, profilesData);
  const data = buildManagedRemotePairsData({
    previousProfilesData,
    nextProfilesData: profilesData,
    existingPairsData,
    affectedProfileIds,
  });
  const filePath = getLegacyCloudflareManagedRemoteFilePath();
  writePrivateFileAtomic(filePath, JSON.stringify(data, null, 2));
}

function snapshotPrivateFile(filePath: string): PrivateFileSnapshot {
  try {
    return { exists: true, contents: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    if (isProfileContainer(error) && error.code === 'ENOENT') {
      return { exists: false, contents: null };
    }
    throw error;
  }
}

function parseTunnelProfilesSnapshot(snapshot: PrivateFileSnapshot): TunnelProfilesStore {
  if (!snapshot.exists) {
    return { version: TUNNEL_PROFILES_VERSION, profiles: [] };
  }
  try {
    const parsed: unknown = JSON.parse(snapshot.contents);
    return sanitizeTunnelProfilesData(isProfileContainer(parsed) ? parsed : undefined);
  } catch (error) {
    throw new Error('Failed to read the previous tunnel profile state', { cause: error });
  }
}

function restorePrivateFile(filePath: string, snapshot: PrivateFileSnapshot) {
  if (!snapshot.exists) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  writePrivateFileAtomic(filePath, snapshot.contents);
}

function persistTunnelProfilesToDisk(
  data: TunnelProfilesInput | null | undefined,
  {
    writeProfiles = writeTunnelProfilesToDisk,
    writeManagedRemotePairs = writeManagedRemotePairsToDiskFromProfiles,
  }: PersistTunnelProfilesOptions = {},
) {
  const sanitized = sanitizeTunnelProfilesData(data);
  const profilesPath = getTunnelProfilesFilePath();
  const pairsPath = getLegacyCloudflareManagedRemoteFilePath();
  const profilesSnapshot = snapshotPrivateFile(profilesPath);
  const pairsSnapshot = snapshotPrivateFile(pairsPath);
  const previousProfilesData = parseTunnelProfilesSnapshot(profilesSnapshot);
  const affectedProfileIds = resolveAffectedCloudflareProfileIds(previousProfilesData, sanitized);
  const existingPairsData = affectedProfileIds.size > 0
    ? parseManagedRemotePairsSnapshot(pairsSnapshot)
    : null;
  let pairsAttempted = false;
  let profilesAttempted = false;

  try {
    if (affectedProfileIds.size > 0) {
      pairsAttempted = true;
      writeManagedRemotePairs(sanitized, {
        previousProfilesData,
        existingPairsData,
        affectedProfileIds,
      });
    }
    profilesAttempted = true;
    writeProfiles(sanitized);
    return sanitized;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (profilesAttempted) {
      try {
        restorePrivateFile(profilesPath, profilesSnapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (pairsAttempted) {
      try {
        restorePrivateFile(pairsPath, pairsSnapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Failed to persist tunnel profiles and restore the previous state'
      );
    }
    throw error;
  }
}

function readLegacyManagedRemoteEntries(): TunnelProfile[] {
  try {
    const raw = fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const tunnels = isProfileContainer(parsed) && isProfileList(parsed.tunnels) ? parsed.tunnels : [];
    return tunnels
      .map((entry) => {
        if (!isProfileContainer(entry)) return null;
        const rawId = isProfileText(entry.id) ? entry.id.trim() : '';
        if (!rawId.startsWith(CLI_MANAGED_REMOTE_ID_PREFIX)) return null;
        const id = rawId.slice(CLI_MANAGED_REMOTE_ID_PREFIX.length);
        if (!id) return null;
        const name = normalizeProfileText(entry.name);
        const hostname = normalizeProfileText(entry.hostname);
        const token = normalizeProfileText(entry.token);
        if (!name || !hostname || !token) return null;
        return {
          id,
          name,
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname,
          token,
          createdAt: isProfileTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now(),
          updatedAt: isProfileTimestamp(entry.updatedAt) ? entry.updatedAt : Date.now(),
        };
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

function makeUniqueProfileName(provider: string, desiredName: string, existingProfiles: TunnelProfile[]) {
  const normalizedDesired = normalizeProfileText(desiredName);
  if (!normalizedDesired) {
    return '';
  }
  const existingNames = new Set(
    existingProfiles
      .filter((entry) => entry.provider === provider)
      .map((entry) => entry.name.toLowerCase())
  );

  if (!existingNames.has(normalizedDesired.toLowerCase())) {
    return normalizedDesired;
  }

  let index = 2;
  while (true) {
    const candidate = `${normalizedDesired}-${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
}

function ensureTunnelProfilesMigrated(options: { shouldWarn?: boolean } = {}) {
  const current = readTunnelProfilesFromDisk(options);
  if (current.profiles.length > 0) {
    return current;
  }

  const legacyEntries = readLegacyManagedRemoteEntries();
  if (legacyEntries.length === 0) {
    return current;
  }

  const migratedProfiles: TunnelProfile[] = [];
  for (const entry of legacyEntries) {
    const name = makeUniqueProfileName(entry.provider, entry.name, migratedProfiles);
    migratedProfiles.push({ ...entry, name });
  }

  const migrated = sanitizeTunnelProfilesData({ version: TUNNEL_PROFILES_VERSION, profiles: migratedProfiles });
  writeTunnelProfilesToDisk(migrated);
  return migrated;
}

function resolveProfileByName(
  profiles: TunnelProfile[],
  profileName: string | null | undefined,
  provider: string | null | undefined,
): { profile: TunnelProfile; error: null } | { profile: null; error: string } {
  const normalizedName = normalizeProfileText(profileName).toLowerCase();
  const normalizedProvider = normalizeProfileId(provider);
  const matches = profiles.filter((entry) => {
    if (entry.name.toLowerCase() !== normalizedName) return false;
    if (!normalizedProvider) return true;
    return entry.provider === normalizedProvider;
  });

  const [match] = matches;
  if (matches.length === 0 || match === undefined) {
    return { profile: null, error: `No tunnel profile found for name '${profileName}'. Run 'openchamber tunnel profile list'.` };
  }
  if (matches.length > 1) {
    return { profile: null, error: `Profile name '${profileName}' exists for multiple providers. Use --provider <id>.` };
  }
  return { profile: match, error: null };
}

export {
  normalizeProfileId as normalizeProfileProvider,
  normalizeProfileId as normalizeProfileMode,
  normalizeProfileText as normalizeProfileName,
  normalizeProfileText as normalizeProfileHostname,
  normalizeProfileCustomDomain,
  normalizeProfilePublicHostname,
  normalizeProfilePublicUrl,
  normalizeProfileServerAddress,
  normalizeProfileServerPort,
  normalizeProfileRemotePort,
  normalizeProfileText as normalizeProfileToken,
  suggestProfileNameFromHostname,
  maskToken,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  formatProfileTokenStatus,
  formatProfileEndpoint,
  getCliManagedRemoteCredentialId,
  warnIfUnsafeFilePermissions,
  writeTunnelProfilesToDisk,
  writeManagedRemotePairsToDiskFromProfiles,
  persistTunnelProfilesToDisk,
  ensureTunnelProfilesMigrated,
  resolveProfileByName,
};
