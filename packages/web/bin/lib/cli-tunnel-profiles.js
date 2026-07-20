import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
  normalizeFrpcTrustedCaFile,
} from '../../server/lib/tunnels/frpc-client.js';

const TUNNEL_PROFILES_VERSION = 2;
const MAX_TOKEN_FILE_BYTES = 8 * 1024;
const CLI_MANAGED_REMOTE_ID_PREFIX = 'cli-profile:';

function getCliManagedRemoteCredentialId(profileId) {
  const normalized = typeof profileId === 'string' ? profileId.trim() : '';
  return normalized ? `${CLI_MANAGED_REMOTE_ID_PREFIX}${normalized}` : '';
}

function normalizeProfileProvider(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeProfileMode(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeProfileName(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeProfileHostname(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeProfileCustomDomain(value) {
  try {
    return normalizeFrpcCustomDomain(value);
  } catch {
    return '';
  }
}

function normalizeProfilePublicHostname(value) {
  try {
    return normalizeFrpcPublicHostname(value);
  } catch {
    return '';
  }
}

function normalizeProfilePublicUrl(value) {
  try {
    return normalizeFrpcPublicUrl(value);
  } catch {
    return '';
  }
}

function normalizeProfileToken(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeProfileServerAddress(value) {
  try {
    return normalizeFrpcServerAddress(value);
  } catch {
    return '';
  }
}

function normalizeProfileServerPort(value) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  try {
    return normalizeFrpcServerPort(parsed);
  } catch {
    return undefined;
  }
}

function normalizeProfileTrustedCaFile(value) {
  try {
    return normalizeFrpcTrustedCaFile(value);
  } catch {
    return '';
  }
}

function normalizeProfileRemotePort(value) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  try {
    return normalizeFrpcRemotePort(parsed);
  } catch {
    return undefined;
  }
}

function suggestProfileNameFromHostname(hostname) {
  const normalizedHost = normalizeProfileHostname(hostname);
  if (!normalizedHost) return 'prod-main';
  const firstLabel = normalizedHost.split('.')[0] || normalizedHost;
  const sanitized = firstLabel.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'prod-main';
}

function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return '***';
  }
  if (token.length <= 4) {
    return '*'.repeat(token.length);
  }
  return `${'*'.repeat(Math.max(4, token.length - 4))}${token.slice(-4)}`;
}

function readTokenFromFileSafely(tokenFilePath) {
  const absolutePath = path.resolve(tokenFilePath);
  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Token file '${absolutePath}' not found.`);
    }
    if (error?.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch (error) {
    if (error?.code === 'EACCES') {
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

function resolveToken(options) {
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

  return typeof options.token === 'string' ? options.token.trim() : undefined;
}

function redactProfileForOutput(profile) {
  if (!profile || typeof profile !== 'object') {
    return profile;
  }
  const { token, ...safeProfile } = profile;
  return { ...safeProfile, hasToken: typeof token === 'string' && token.trim().length > 0 };
}

function redactProfilesForOutput(profiles) {
  if (!Array.isArray(profiles)) {
    return profiles;
  }
  return profiles.map((entry) => redactProfileForOutput(entry));
}

function formatProfileTokenStatus(profile) {
  const token = typeof profile?.token === 'string' ? profile.token.trim() : '';
  if (!token) {
    return 'token:missing';
  }
  return 'token:present';
}

function formatProfileEndpoint(profile) {
  if (profile?.provider === 'frpc') {
    if (profile.customDomain && profile.hostname) {
      return `${profile.serverAddress}:${profile.serverPort} http:${profile.customDomain} public:${profile.hostname}`;
    }
    return `${profile.serverAddress}:${profile.serverPort} remote:${profile.remotePort} public:${profile.publicUrl || 'missing'}`;
  }
  return profile?.hostname || 'n/a';
}

function sanitizeTunnelProfilesData(data) {
  const parsed = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const seen = new Set();
  const profiles = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
    const provider = normalizeProfileProvider(entry.provider);
    const mode = normalizeProfileMode(entry.mode);
    const name = normalizeProfileName(entry.name);
    const hostname = provider === 'frpc'
      ? normalizeProfilePublicHostname(entry.hostname)
      : normalizeProfileHostname(entry.hostname);
    const customDomain = normalizeProfileCustomDomain(entry.customDomain);
    const publicUrl = normalizeProfilePublicUrl(entry.publicUrl);
    const serverAddress = normalizeProfileServerAddress(entry.serverAddress);
    const serverPort = normalizeProfileServerPort(entry.serverPort);
    const trustedCaFile = normalizeProfileTrustedCaFile(entry.trustedCaFile);
    const remotePort = normalizeProfileRemotePort(entry.remotePort);
    const token = normalizeProfileToken(entry.token);
    const hasFrpcTcpEndpoint = Boolean(remotePort && !customDomain && !hostname);
    const hasFrpcHttpEndpoint = Boolean(!remotePort && customDomain && hostname);
    const hasRequiredEndpoint = provider === 'frpc'
      ? Boolean(serverAddress && serverPort && trustedCaFile && (hasFrpcTcpEndpoint || hasFrpcHttpEndpoint))
      : Boolean(hostname);
    if (!provider || !mode || !name || !hasRequiredEndpoint || !token) continue;
    const key = `${provider}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({
      id,
      name,
      provider,
      mode,
      ...(provider === 'frpc'
        ? {
          serverAddress,
          serverPort,
          trustedCaFile,
          ...(hasFrpcTcpEndpoint ? { remotePort, ...(publicUrl ? { publicUrl } : {}) } : { customDomain, hostname }),
        }
        : { hostname }),
      token,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    });
  }
  return { version: TUNNEL_PROFILES_VERSION, profiles };
}

function warnIfUnsafeFilePermissions(filePath, { shouldWarn = true } = {}) {
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
    // File may not exist yet — not an error
  }
}

function readTunnelProfilesFromDisk(options = {}) {
  const filePath = getTunnelProfilesFilePath();
  try {
    warnIfUnsafeFilePermissions(filePath, options);
    const raw = fs.readFileSync(filePath, 'utf8');
    return sanitizeTunnelProfilesData(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: TUNNEL_PROFILES_VERSION, profiles: [] };
    }
    throw new Error(`Failed to read tunnel profile file '${filePath}'`, { cause: error });
  }
}

function writePrivateFileAtomic(filePath, contents) {
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

function writeTunnelProfilesToDisk(data) {
  const filePath = getTunnelProfilesFilePath();
  const sanitized = sanitizeTunnelProfilesData(data);
  writePrivateFileAtomic(filePath, JSON.stringify(sanitized, null, 2));
  return sanitized;
}

function getCloudflareManagedRemoteProfiles(data) {
  return sanitizeTunnelProfilesData(data).profiles.filter(
    (entry) => entry.provider === 'cloudflare' && entry.mode === 'managed-remote'
  );
}

function resolveAffectedCloudflareProfileIds(previousData, nextData) {
  const previous = new Map(getCloudflareManagedRemoteProfiles(previousData).map((entry) => [entry.id, entry]));
  const next = new Map(getCloudflareManagedRemoteProfiles(nextData).map((entry) => [entry.id, entry]));
  const affected = new Set();
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

function parseManagedRemotePairsSnapshot(snapshot) {
  if (!snapshot.exists) {
    return { version: 1, tunnels: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(snapshot.contents);
  } catch (error) {
    throw new Error('Failed to read managed-remote compatibility credentials', { cause: error });
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.tunnels)) {
    throw new Error('Managed-remote compatibility credentials have an unsupported format');
  }
  for (const entry of parsed.tunnels) {
    if (
      !entry
      || typeof entry !== 'object'
      || !normalizeProfileName(entry.id)
      || !normalizeProfileName(entry.name)
      || !normalizeProfileHostname(entry.hostname)
      || !normalizeProfileToken(entry.token)
    ) {
      throw new Error('Managed-remote compatibility credentials contain an invalid entry');
    }
  }
  return { version: 1, tunnels: parsed.tunnels.map((entry) => ({ ...entry })) };
}

function resolveCredentialOwnerProfileId(entry, knownProfileIds) {
  const id = normalizeProfileName(entry?.id);
  if (id.startsWith(CLI_MANAGED_REMOTE_ID_PREFIX)) {
    return id.slice(CLI_MANAGED_REMOTE_ID_PREFIX.length) || null;
  }
  return knownProfileIds.has(id) ? id : null;
}

function buildManagedRemotePairsData({ previousProfilesData, nextProfilesData, existingPairsData, affectedProfileIds }) {
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
      hostname: profile.hostname,
      token: profile.token,
      updatedAt: Number.isFinite(profile.updatedAt) ? profile.updatedAt : Date.now(),
    });
  }

  return { version: 1, tunnels };
}

function writeManagedRemotePairsToDiskFromProfiles(profilesData, options = {}) {
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

function snapshotPrivateFile(filePath) {
  try {
    return { exists: true, contents: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, contents: null };
    }
    throw error;
  }
}

function parseTunnelProfilesSnapshot(snapshot) {
  if (!snapshot.exists) {
    return { version: TUNNEL_PROFILES_VERSION, profiles: [] };
  }
  try {
    return sanitizeTunnelProfilesData(JSON.parse(snapshot.contents));
  } catch (error) {
    throw new Error('Failed to read the previous tunnel profile state', { cause: error });
  }
}

function restorePrivateFile(filePath, snapshot) {
  if (!snapshot.exists) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  writePrivateFileAtomic(filePath, snapshot.contents);
}

function persistTunnelProfilesToDisk(data, {
  writeProfiles = writeTunnelProfilesToDisk,
  writeManagedRemotePairs = writeManagedRemotePairsToDiskFromProfiles,
} = {}) {
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
    // Credentials are written first so their failure can never publish a profile
    // that refers to credentials which were not saved.
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
    const rollbackErrors = [];
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

function readLegacyManagedRemoteEntries() {
  try {
    const raw = fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const tunnels = Array.isArray(parsed?.tunnels) ? parsed.tunnels : [];
    return tunnels
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const rawId = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!rawId.startsWith(CLI_MANAGED_REMOTE_ID_PREFIX)) return null;
        const id = rawId.slice(CLI_MANAGED_REMOTE_ID_PREFIX.length);
        if (!id) return null;
        const name = normalizeProfileName(entry.name);
        const hostname = normalizeProfileHostname(entry.hostname);
        const token = normalizeProfileToken(entry.token);
        if (!name || !hostname || !token) return null;
        return {
          id,
          name,
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname,
          token,
          createdAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function makeUniqueProfileName(provider, desiredName, existingProfiles) {
  const normalizedDesired = normalizeProfileName(desiredName);
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

function ensureTunnelProfilesMigrated(options = {}) {
  const current = readTunnelProfilesFromDisk(options);
  if (current.profiles.length > 0) {
    return current;
  }

  const legacyEntries = readLegacyManagedRemoteEntries();
  if (legacyEntries.length === 0) {
    return current;
  }

  const migratedProfiles = [];
  for (const entry of legacyEntries) {
    const name = makeUniqueProfileName(entry.provider, entry.name, migratedProfiles);
    migratedProfiles.push({ ...entry, name });
  }

  const migrated = sanitizeTunnelProfilesData({ version: TUNNEL_PROFILES_VERSION, profiles: migratedProfiles });
  persistTunnelProfilesToDisk(migrated);
  return migrated;
}

function resolveProfileByName(profiles, profileName, provider) {
  const normalizedName = normalizeProfileName(profileName).toLowerCase();
  const normalizedProvider = normalizeProfileProvider(provider);
  const matches = profiles.filter((entry) => {
    if (entry.name.toLowerCase() !== normalizedName) return false;
    if (!normalizedProvider) return true;
    return entry.provider === normalizedProvider;
  });

  if (matches.length === 0) {
    return { profile: null, error: `No tunnel profile found for name '${profileName}'. Run 'openchamber tunnel profile list'.` };
  }
  if (matches.length > 1) {
    return { profile: null, error: `Profile name '${profileName}' exists for multiple providers. Use --provider <id>.` };
  }
  return { profile: matches[0], error: null };
}


export {
  normalizeProfileProvider,
  normalizeProfileMode,
  normalizeProfileName,
  normalizeProfileHostname,
  normalizeProfileCustomDomain,
  normalizeProfilePublicHostname,
  normalizeProfilePublicUrl,
  normalizeProfileServerAddress,
  normalizeProfileServerPort,
  normalizeProfileTrustedCaFile,
  normalizeProfileRemotePort,
  normalizeProfileToken,
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
