import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'fs/promises';
import { get as httpsGet } from 'https';
import os from 'os';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import AdmZip from 'adm-zip';

import {
  FRPC_ASSETS,
  FRPC_VERSION,
  UnsupportedFrpcTargetError,
  resolveFrpcAsset,
} from './frpc-assets.js';

export const FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
export const FRPC_DEFAULT_LOCK_TIMEOUT_MS = 120000;
const DEFAULT_STALE_LOCK_MS = 300000;
const DEFAULT_LOCK_POLL_MS = 100;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_TAR_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const STAGING_PREFIXES = ['.download-', '.extract-'];

const FRPC_DOWNLOAD_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
]);
const FRPC_DOWNLOAD_HOST_ALLOWLIST = new Set(FRPC_DOWNLOAD_HOSTS);

class FrpcBinaryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'FrpcBinaryError';
    this.code = code;
  }
}

const isErrorCode = (error, code) => Boolean(error && typeof error === 'object' && error.code === code);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertAssetMetadata = (asset) => {
  if (!asset || typeof asset !== 'object') {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset metadata is missing');
  }
  if (!['darwin', 'linux', 'win32'].includes(asset.platform) || !['x64', 'arm64'].includes(asset.arch)) {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset target is invalid');
  }
  if (!['tar.gz', 'zip'].includes(asset.archiveType)) {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset archive type is invalid');
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset size is invalid');
  }
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset checksum is invalid');
  }
  if (typeof asset.name !== 'string' || path.posix.basename(asset.name) !== asset.name) {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset filename is invalid');
  }
  if (typeof asset.member !== 'string' || !asset.member.endsWith(`/${asset.binaryName}`)) {
    throw new FrpcBinaryError('invalid_asset', 'FRPC archive member is invalid');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(asset.url);
  } catch {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset URL is invalid');
  }
  if (parsedUrl.protocol !== 'https:' || path.posix.basename(parsedUrl.pathname) !== asset.name) {
    throw new FrpcBinaryError('invalid_asset', 'FRPC asset URL does not match its filename');
  }
};

function resolveOpenChamberDataDir({ env = process.env, homedir = os.homedir() } = {}) {
  const configured = typeof env.OPENCHAMBER_DATA_DIR === 'string'
    ? env.OPENCHAMBER_DATA_DIR.trim()
    : '';
  return configured
    ? path.resolve(configured)
    : path.join(homedir, '.config', 'openchamber');
}

function resolveFrpcBinaryPaths(asset, dataDir) {
  assertAssetMetadata(asset);
  const versionDirectory = path.join(dataDir, 'tunnels', 'frpc', `v${FRPC_VERSION}`);
  const target = `${asset.platform}-${asset.arch}`;
  const targetDirectory = path.join(versionDirectory, target);

  return {
    versionDirectory,
    targetDirectory,
    lockDirectory: path.join(versionDirectory, `.${target}.lock`),
    archivePath: path.join(targetDirectory, asset.name),
    binaryPath: path.join(targetDirectory, asset.binaryName),
    target,
  };
}

export function verifyFrpcVersion(binaryPath, {
  expectedVersion = FRPC_VERSION,
  spawnSyncImpl = spawnSync,
  timeoutMs = 5000,
} = {}) {
  try {
    const result = spawnSyncImpl(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (result.status === 0 && output === expectedVersion) {
      return { ok: true, version: output, error: null };
    }
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const detail = result.error?.message || stderr || output || `exit code ${result.status ?? 'unknown'}`;
    return { ok: false, version: output || null, error: detail };
  } catch (error) {
    return {
      ok: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const normalizeVersionVerification = (result) => {
  if (result === true) {
    return { ok: true, version: FRPC_VERSION, error: null };
  }
  if (result === false || !result || typeof result !== 'object') {
    return { ok: false, version: null, error: 'version verification failed' };
  }
  return {
    ok: result.ok === true,
    version: typeof result.version === 'string' ? result.version : null,
    error: typeof result.error === 'string' ? result.error : null,
  };
};

async function inspectBinary(binaryPath, verifyBinary) {
  let fileStats;
  try {
    fileStats = await stat(binaryPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return { exists: false, ok: false, version: null, error: 'binary is missing' };
    }
    return {
      exists: true,
      ok: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!fileStats.isFile() || fileStats.size <= 0) {
    return { exists: true, ok: false, version: null, error: 'binary is not a non-empty file' };
  }

  try {
    const verification = normalizeVersionVerification(await verifyBinary(binaryPath));
    return { exists: true, ...verification };
  } catch (error) {
    return {
      exists: true,
      ok: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyPinnedFile(filePath, asset) {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return { ok: false, reason: 'missing' };
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!fileStats.isFile() || fileStats.size !== asset.size) {
    return { ok: false, reason: 'size mismatch' };
  }

  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(filePath)) {
      bytes += chunk.length;
      if (bytes > asset.size) {
        return { ok: false, reason: 'size mismatch' };
      }
      hash.update(chunk);
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) {
    return { ok: false, reason: bytes !== asset.size ? 'size mismatch' : 'checksum mismatch' };
  }
  return { ok: true, reason: null };
}

const validateDownloadUrl = (value, allowedHosts) => {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(value);
  } catch {
    throw new FrpcBinaryError('download_rejected', 'FRPC download URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new FrpcBinaryError('download_rejected', 'FRPC downloads require HTTPS');
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new FrpcBinaryError('download_rejected', 'FRPC download URL contains disallowed authority data');
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new FrpcBinaryError('download_rejected', `FRPC download host is not allowed: ${parsed.hostname}`);
  }
  return parsed;
};

const requestHttpsResponse = (requestImpl, url, deadline) => new Promise((resolve, reject) => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    reject(new FrpcBinaryError('download_timeout', 'Timed out downloading FRPC'));
    return;
  }

  let request;
  let settled = false;
  const finish = (handler, value) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    handler(value);
  };
  const timer = setTimeout(() => {
    const error = new FrpcBinaryError('download_timeout', 'Timed out downloading FRPC');
    request?.destroy?.(error);
    finish(reject, error);
  }, remainingMs);

  try {
    request = requestImpl(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': `OpenChamber-FRPC/${FRPC_VERSION}`,
      },
    }, (response) => finish(resolve, response));
    request.once?.('error', (error) => {
      finish(reject, new FrpcBinaryError(
        'download_failed',
        `Failed to download FRPC: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      ));
    });
  } catch (error) {
    finish(reject, new FrpcBinaryError(
      'download_failed',
      `Failed to download FRPC: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    ));
  }
});

async function downloadVerifiedFrpcAsset({
  asset,
  destinationPath,
  requestImpl = httpsGet,
  timeoutMs = FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS,
  allowedHosts = FRPC_DOWNLOAD_HOST_ALLOWLIST,
  maxRedirects = MAX_REDIRECTS,
  onProgress,
}) {
  assertAssetMetadata(asset);
  const deadline = Date.now() + timeoutMs;
  let currentUrl = validateDownloadUrl(asset.url, allowedHosts);
  let response;
  const discardResponse = (value) => {
    if (typeof value.destroy === 'function') {
      value.destroy();
    } else {
      value.resume?.();
    }
  };

  for (let redirects = 0; ; redirects += 1) {
    response = await requestHttpsResponse(requestImpl, currentUrl, deadline);
    const statusCode = Number(response.statusCode);
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      discardResponse(response);
      if (redirects >= maxRedirects) {
        throw new FrpcBinaryError('download_rejected', 'FRPC download exceeded the redirect limit');
      }
      const location = response.headers?.location;
      if (typeof location !== 'string' || !location) {
        throw new FrpcBinaryError('download_rejected', 'FRPC download redirect did not include a location');
      }
      currentUrl = validateDownloadUrl(new URL(location, currentUrl), allowedHosts);
      continue;
    }
    if (statusCode !== 200) {
      discardResponse(response);
      throw new FrpcBinaryError('download_failed', `FRPC download returned HTTP ${statusCode || 'unknown'}`);
    }
    break;
  }

  const contentLengthHeader = response.headers?.['content-length'];
  if (contentLengthHeader !== undefined) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength !== asset.size) {
      discardResponse(response);
      throw new FrpcBinaryError('download_invalid', 'FRPC download size did not match pinned metadata');
    }
  }

  const hash = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > asset.size) {
        callback(new FrpcBinaryError('download_invalid', 'FRPC download exceeded its pinned size'));
        return;
      }
      hash.update(buffer);
      try {
        onProgress?.(bytes, asset.size);
      } catch (error) {
        callback(error);
        return;
      }
      callback(null, buffer);
    },
  });

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    response.destroy?.();
    throw new FrpcBinaryError('download_timeout', 'Timed out downloading FRPC');
  }
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), remainingMs);

  try {
    await pipeline(
      response,
      verifier,
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }),
      { signal: abortController.signal }
    );
    const digest = hash.digest('hex');
    if (bytes !== asset.size || digest !== asset.sha256) {
      throw new FrpcBinaryError(
        'download_invalid',
        bytes !== asset.size
          ? 'FRPC download size did not match pinned metadata'
          : 'FRPC download checksum did not match pinned metadata'
      );
    }
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    if (abortController.signal.aborted) {
      throw new FrpcBinaryError('download_timeout', 'Timed out downloading FRPC', { cause: error });
    }
    if (error instanceof FrpcBinaryError) {
      throw error;
    }
    throw new FrpcBinaryError(
      'download_failed',
      `Failed to download FRPC: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    clearTimeout(timeout);
  }
}

const parseTarString = (field) => {
  const nulIndex = field.indexOf(0);
  return field.subarray(0, nulIndex === -1 ? field.length : nulIndex).toString('utf8');
};

const parseTarOctal = (field, label) => {
  const raw = parseTarString(field).trim();
  if (!raw) {
    return 0;
  }
  if (!/^[0-7]+$/.test(raw)) {
    throw new FrpcBinaryError('archive_invalid', `FRPC tar ${label} is invalid`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FrpcBinaryError('archive_invalid', `FRPC tar ${label} is out of range`);
  }
  return value;
};

const parseTarHeader = (header) => {
  const expectedChecksum = parseTarOctal(header.subarray(148, 156), 'checksum');
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  let actualChecksum = 0;
  for (const byte of checksumHeader) {
    actualChecksum += byte;
  }
  if (expectedChecksum !== actualChecksum) {
    throw new FrpcBinaryError('archive_invalid', 'FRPC tar header checksum is invalid');
  }

  const name = parseTarString(header.subarray(0, 100));
  const prefix = parseTarString(header.subarray(345, 500));
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: parseTarOctal(header.subarray(124, 136), 'member size'),
    type: header[156] === 0 ? '0' : String.fromCharCode(header[156]),
  };
};

const writeAll = async (fileHandle, buffer) => {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) {
      throw new FrpcBinaryError('archive_invalid', 'Could not write the extracted FRPC binary');
    }
    offset += bytesWritten;
  }
};

export async function extractFrpcTarGzMember({ archivePath, member, destinationPath }) {
  const source = createReadStream(archivePath);
  const gunzip = createGunzip();
  const output = await open(destinationPath, 'wx', 0o700);
  let succeeded = false;
  let pending = Buffer.alloc(0);
  let state = 'header';
  let entryRemaining = 0;
  let paddingRemaining = 0;
  let writeEntry = false;
  let found = false;
  let extractedBytes = 0;
  let expandedBytes = 0;

  try {
    for await (const chunk of source.pipe(gunzip)) {
      expandedBytes += chunk.length;
      if (expandedBytes > MAX_EXPANDED_TAR_BYTES) {
        throw new FrpcBinaryError('archive_invalid', 'FRPC tar archive expands beyond the allowed size');
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      while (pending.length > 0) {
        if (state === 'header') {
          if (pending.length < 512) {
            break;
          }
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (header.every((byte) => byte === 0)) {
            state = 'end';
            continue;
          }

          const entry = parseTarHeader(header);
          entryRemaining = entry.size;
          paddingRemaining = (512 - (entry.size % 512)) % 512;
          writeEntry = entry.name === member;
          if (writeEntry) {
            if (found) {
              throw new FrpcBinaryError('archive_invalid', 'FRPC archive contains the binary member more than once');
            }
            if (!['0', ''].includes(entry.type)) {
              throw new FrpcBinaryError('archive_invalid', 'FRPC archive binary member is not a regular file');
            }
            if (entry.size <= 0 || entry.size > MAX_BINARY_BYTES) {
              throw new FrpcBinaryError('archive_invalid', 'FRPC archive binary member has an invalid size');
            }
            found = true;
          }
          state = entryRemaining > 0 ? 'data' : (paddingRemaining > 0 ? 'padding' : 'header');
          continue;
        }

        if (state === 'data') {
          const length = Math.min(entryRemaining, pending.length);
          const data = pending.subarray(0, length);
          pending = pending.subarray(length);
          entryRemaining -= length;
          if (writeEntry) {
            await writeAll(output, data);
            extractedBytes += length;
          }
          if (entryRemaining === 0) {
            state = paddingRemaining > 0 ? 'padding' : 'header';
          }
          continue;
        }

        if (state === 'padding') {
          const length = Math.min(paddingRemaining, pending.length);
          pending = pending.subarray(length);
          paddingRemaining -= length;
          if (paddingRemaining === 0) {
            state = 'header';
          }
          continue;
        }

        if (state === 'end') {
          if (!pending.every((byte) => byte === 0)) {
            throw new FrpcBinaryError('archive_invalid', 'FRPC tar contains data after its end marker');
          }
          pending = Buffer.alloc(0);
        }
      }
    }

    if (state !== 'end' || pending.length > 0) {
      throw new FrpcBinaryError('archive_invalid', 'FRPC tar archive is truncated');
    }
    if (!found || extractedBytes <= 0) {
      throw new FrpcBinaryError('archive_invalid', `FRPC archive does not contain ${member}`);
    }
    succeeded = true;
  } catch (error) {
    if (error instanceof FrpcBinaryError) {
      throw error;
    }
    throw new FrpcBinaryError(
      'archive_invalid',
      `Could not extract FRPC: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    source.destroy();
    gunzip.destroy();
    await output.close().catch(() => undefined);
    if (!succeeded) {
      await rm(destinationPath, { force: true }).catch(() => undefined);
    }
  }
  await chmod(destinationPath, 0o700);
}

export async function extractFrpcZipMember({ archivePath, member, destinationPath }) {
  let zip;
  try {
    zip = new AdmZip(archivePath);
  } catch (error) {
    throw new FrpcBinaryError(
      'archive_invalid',
      `Could not read FRPC zip archive: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const matches = zip.getEntries().filter((entry) => entry.entryName === member);
  if (matches.length !== 1) {
    throw new FrpcBinaryError(
      'archive_invalid',
      matches.length === 0
        ? `FRPC archive does not contain ${member}`
        : 'FRPC archive contains the binary member more than once'
    );
  }

  const entry = matches[0];
  const unixMode = ((entry.attr ?? entry.header?.attr ?? 0) >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (entry.isDirectory || (unixType !== 0 && unixType !== 0o100000)) {
    throw new FrpcBinaryError('archive_invalid', 'FRPC archive binary member is not a regular file');
  }
  const declaredSize = Number(entry.header?.size ?? 0);
  if (declaredSize > MAX_BINARY_BYTES) {
    throw new FrpcBinaryError('archive_invalid', 'FRPC archive binary member is too large');
  }

  let data;
  try {
    data = entry.getData();
  } catch (error) {
    throw new FrpcBinaryError(
      'archive_invalid',
      `Could not extract FRPC zip member: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!Buffer.isBuffer(data) || data.length <= 0 || data.length > MAX_BINARY_BYTES) {
    throw new FrpcBinaryError('archive_invalid', 'FRPC archive binary member has an invalid size');
  }

  try {
    await writeFile(destinationPath, data, { flag: 'wx', mode: 0o700 });
    await chmod(destinationPath, 0o700);
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractFrpcBinary({ asset, archivePath, destinationPath }) {
  if (asset.archiveType === 'zip') {
    await extractFrpcZipMember({ archivePath, member: asset.member, destinationPath });
    return;
  }
  if (asset.archiveType === 'tar.gz') {
    await extractFrpcTarGzMember({ archivePath, member: asset.member, destinationPath });
    return;
  }
  throw new FrpcBinaryError('archive_invalid', `Unsupported FRPC archive type: ${asset.archiveType}`);
}

async function acquireFrpcDirectoryLock(lockDirectory, {
  timeoutMs = FRPC_DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_LOCK_MS,
  pollMs = DEFAULT_LOCK_POLL_MS,
  now = Date.now,
  sleep = delay,
  createId = randomUUID,
} = {}) {
  const ownerId = createId();
  const startedAt = now();

  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        await writeFile(
          path.join(lockDirectory, 'owner.json'),
          JSON.stringify({ id: ownerId, pid: process.pid, startedAt }),
          { flag: 'wx', mode: 0o600 }
        );
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      const heartbeatMs = Math.max(1000, Math.floor(staleMs / 3));
      const heartbeat = setInterval(() => {
        const timestamp = new Date(now());
        void utimes(lockDirectory, timestamp, timestamp).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref?.();

      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(heartbeat);
        try {
          const owner = JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
          if (owner?.id !== ownerId) {
            return;
          }
        } catch {
          return;
        }
        await rm(lockDirectory, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }

    let lockStats;
    try {
      lockStats = await stat(lockDirectory);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        continue;
      }
      throw error;
    }

    if (now() - lockStats.mtimeMs > staleMs) {
      const staleDirectory = `${lockDirectory}.stale-${createId()}`;
      try {
        await rename(lockDirectory, staleDirectory);
        await rm(staleDirectory, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'EEXIST')) {
          continue;
        }
        throw error;
      }
    }

    if (now() - startedAt >= timeoutMs) {
      throw new FrpcBinaryError('lock_timeout', 'Timed out waiting for another FRPC installation to finish');
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))));
  }
}

const ensurePrivateDirectory = async (directoryPath) => {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
};

const cleanupStagingFiles = async (targetDirectory) => {
  let entries;
  try {
    entries = await readdir(targetDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => STAGING_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => rm(path.join(targetDirectory, entry.name), { recursive: true, force: true })));
};

export function createFrpcBinaryManager({
  platform = process.platform,
  arch = process.arch,
  assets = FRPC_ASSETS,
  asset: assetOverride,
  dataDir = resolveOpenChamberDataDir(),
  requestImpl = httpsGet,
  spawnSyncImpl = spawnSync,
  verifyBinary: verifyBinaryOverride,
  downloadTimeoutMs = FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS,
  lockTimeoutMs = FRPC_DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  lockPollMs = DEFAULT_LOCK_POLL_MS,
  allowedDownloadHosts = FRPC_DOWNLOAD_HOST_ALLOWLIST,
  createId = randomUUID,
  onProgress,
} = {}) {
  const getAsset = () => {
    const asset = assetOverride ?? resolveFrpcAsset(platform, arch, assets);
    assertAssetMetadata(asset);
    return asset;
  };
  const getPaths = () => resolveFrpcBinaryPaths(getAsset(), dataDir);
  const verifyBinary = verifyBinaryOverride ?? ((binaryPath) => verifyFrpcVersion(binaryPath, { spawnSyncImpl }));

  const inspect = async () => {
    let asset;
    try {
      asset = getAsset();
    } catch (error) {
      if (error instanceof UnsupportedFrpcTargetError) {
        return {
          supported: false,
          prepared: false,
          path: null,
          version: FRPC_VERSION,
          target: `${platform}-${arch}`,
          error: error.message,
        };
      }
      throw error;
    }
    const paths = resolveFrpcBinaryPaths(asset, dataDir);
    const binary = await inspectBinary(paths.binaryPath, verifyBinary);
    return {
      supported: true,
      prepared: binary.ok,
      path: binary.ok ? paths.binaryPath : null,
      version: binary.version ?? FRPC_VERSION,
      target: paths.target,
      error: binary.ok ? null : binary.error,
    };
  };

  const prepare = async ({ onProgress: prepareProgress } = {}) => {
    const asset = getAsset();
    const paths = resolveFrpcBinaryPaths(asset, dataDir);

    const initialBinary = await inspectBinary(paths.binaryPath, verifyBinary);
    if (initialBinary.ok) {
      return {
        path: paths.binaryPath,
        version: FRPC_VERSION,
        target: paths.target,
        source: 'installed',
      };
    }

    await ensurePrivateDirectory(paths.versionDirectory);
    const releaseLock = await acquireFrpcDirectoryLock(paths.lockDirectory, {
      timeoutMs: lockTimeoutMs,
      staleMs: staleLockMs,
      pollMs: lockPollMs,
      createId,
    });
    let downloadPath = null;
    let extractionPath = null;

    try {
      await ensurePrivateDirectory(paths.targetDirectory);
      await cleanupStagingFiles(paths.targetDirectory);

      const lockedBinary = await inspectBinary(paths.binaryPath, verifyBinary);
      if (lockedBinary.ok) {
        return {
          path: paths.binaryPath,
          version: FRPC_VERSION,
          target: paths.target,
          source: 'installed',
        };
      }

      let archiveVerification = await verifyPinnedFile(paths.archivePath, asset);
      let source = 'archive-cache';
      if (!archiveVerification.ok) {
        downloadPath = path.join(paths.targetDirectory, `.download-${createId()}`);
        await downloadVerifiedFrpcAsset({
          asset,
          destinationPath: downloadPath,
          requestImpl,
          timeoutMs: downloadTimeoutMs,
          allowedHosts: allowedDownloadHosts,
          onProgress: prepareProgress ?? onProgress,
        });
        archiveVerification = await verifyPinnedFile(downloadPath, asset);
        if (!archiveVerification.ok) {
          throw new FrpcBinaryError('download_invalid', 'Downloaded FRPC archive failed verification');
        }
        await rm(paths.archivePath, { force: true });
        await rename(downloadPath, paths.archivePath);
        downloadPath = null;
        await chmod(paths.archivePath, 0o600);
        source = 'download';
      }

      extractionPath = path.join(paths.targetDirectory, `.extract-${createId()}`);
      await extractFrpcBinary({ asset, archivePath: paths.archivePath, destinationPath: extractionPath });
      const stagedVerification = await inspectBinary(extractionPath, verifyBinary);
      if (!stagedVerification.ok) {
        throw new FrpcBinaryError(
          'version_mismatch',
          `Extracted FRPC failed ${FRPC_VERSION} verification: ${stagedVerification.error || 'unknown error'}`
        );
      }

      await rm(paths.binaryPath, { force: true });
      await rename(extractionPath, paths.binaryPath);
      extractionPath = null;
      await chmod(paths.binaryPath, 0o700);

      return {
        path: paths.binaryPath,
        version: FRPC_VERSION,
        target: paths.target,
        source,
      };
    } finally {
      if (downloadPath) {
        await rm(downloadPath, { force: true }).catch(() => undefined);
      }
      if (extractionPath) {
        await rm(extractionPath, { force: true }).catch(() => undefined);
      }
      await releaseLock();
    }
  };

  return {
    version: FRPC_VERSION,
    inspect,
    prepare,
    getPaths,
  };
}
