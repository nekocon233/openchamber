// Downloads and publishes a pinned third-party binary: pinned metadata, an
// HTTPS-only download with a host allowlist, streaming checksum verification,
// archive extraction with size caps, a directory lock that serializes
// concurrent installs, and an owner-only published binary.
//
// Products differ only through their descriptor (see createPinnedBinaryManager
// below). Nothing in this module names a product.

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

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
export const DEFAULT_LOCK_TIMEOUT_MS = 120000;
/** Caps a product may tighten or widen through its descriptor. */
export const DEFAULT_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_BINARY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EXPANDED_TAR_BYTES = 256 * 1024 * 1024;
const DEFAULT_STALE_LOCK_MS = 300000;
const DEFAULT_LOCK_POLL_MS = 100;
const MAX_REDIRECTS = 5;
const STAGING_PREFIXES = ['.download-', '.extract-'];

const DOWNLOAD_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
]);
const DOWNLOAD_HOST_ALLOWLIST = new Set(DOWNLOAD_HOSTS);

class PinnedBinaryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'PinnedBinaryError';
    this.code = code;
  }
}

const isErrorCode = (error, code) => Boolean(error && typeof error === 'object' && error.code === code);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertAssetMetadata = (asset, descriptor) => {
  if (!asset || typeof asset !== 'object') {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset metadata is missing`);
  }
  if (!['darwin', 'linux', 'win32'].includes(asset.platform) || !['x64', 'arm64'].includes(asset.arch)) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset target is invalid`);
  }
  if (!['tar.gz', 'zip'].includes(asset.archiveType)) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset archive type is invalid`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > descriptor.limits.archiveBytes) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset size is invalid`);
  }
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset checksum is invalid`);
  }
  if (typeof asset.name !== 'string' || path.posix.basename(asset.name) !== asset.name) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset filename is invalid`);
  }
  if (typeof asset.member !== 'string' || !descriptor.isBinaryMember(asset, asset.member)) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} archive member is invalid`);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(asset.url);
  } catch {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset URL is invalid`);
  }
  if (parsedUrl.protocol !== 'https:' || path.posix.basename(parsedUrl.pathname) !== asset.name) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset URL does not match its filename`);
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

function resolveBinaryPaths(descriptor, asset, dataDir) {
  assertAssetMetadata(asset, descriptor);
  const versionDirectory = path.join(descriptor.productRoot(dataDir), `v${descriptor.version}`);
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

const normalizeVersionVerification = (result, version) => {
  if (result === true) {
    return { ok: true, version, error: null };
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

async function inspectBinary(binaryPath, verifyBinary, version) {
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
    const verification = normalizeVersionVerification(await verifyBinary(binaryPath), version);
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

const validateDownloadUrl = (value, allowedHosts, label) => {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(value);
  } catch {
    throw new PinnedBinaryError('download_rejected', `${label} download URL is invalid`);
  }
  if (parsed.protocol !== 'https:') {
    throw new PinnedBinaryError('download_rejected', `${label} downloads require HTTPS`);
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new PinnedBinaryError('download_rejected', `${label} download URL contains disallowed authority data`);
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new PinnedBinaryError('download_rejected', `${label} download host is not allowed: ${parsed.hostname}`);
  }
  return parsed;
};

const requestHttpsResponse = (requestImpl, url, deadline, { userAgent, label }) => new Promise((resolve, reject) => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    reject(new PinnedBinaryError('download_timeout', `Timed out downloading ${label}`));
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
    const error = new PinnedBinaryError('download_timeout', `Timed out downloading ${label}`);
    request?.destroy?.(error);
    finish(reject, error);
  }, remainingMs);

  try {
    request = requestImpl(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': userAgent,
      },
    }, (response) => finish(resolve, response));
    request.once?.('error', (error) => {
      finish(reject, new PinnedBinaryError(
        'download_failed',
        `Failed to download ${label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      ));
    });
  } catch (error) {
    finish(reject, new PinnedBinaryError(
      'download_failed',
      `Failed to download ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    ));
  }
});

async function downloadVerifiedAsset({
  asset,
  descriptor,
  destinationPath,
  requestImpl = httpsGet,
  timeoutMs = descriptor.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  allowedHosts = descriptor.allowedDownloadHosts ?? DOWNLOAD_HOST_ALLOWLIST,
  maxRedirects = MAX_REDIRECTS,
  onProgress,
}) {
  assertAssetMetadata(asset, descriptor);
  const label = descriptor.label;
  const userAgent = descriptor.userAgent ?? `OpenChamber-${descriptor.id}/${descriptor.version}`;
  const deadline = Date.now() + timeoutMs;
  let currentUrl = validateDownloadUrl(asset.url, allowedHosts, label);
  let response;
  const discardResponse = (value) => {
    if (typeof value.destroy === 'function') {
      value.destroy();
    } else {
      value.resume?.();
    }
  };

  for (let redirects = 0; ; redirects += 1) {
    response = await requestHttpsResponse(requestImpl, currentUrl, deadline, { userAgent, label });
    const statusCode = Number(response.statusCode);
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      discardResponse(response);
      if (redirects >= maxRedirects) {
        throw new PinnedBinaryError('download_rejected', `${label} download exceeded the redirect limit`);
      }
      const location = response.headers?.location;
      if (typeof location !== 'string' || !location) {
        throw new PinnedBinaryError('download_rejected', `${label} download redirect did not include a location`);
      }
      currentUrl = validateDownloadUrl(new URL(location, currentUrl), allowedHosts, label);
      continue;
    }
    if (statusCode !== 200) {
      discardResponse(response);
      throw new PinnedBinaryError('download_failed', `${label} download returned HTTP ${statusCode || 'unknown'}`);
    }
    break;
  }

  const contentLengthHeader = response.headers?.['content-length'];
  if (contentLengthHeader !== undefined) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength !== asset.size) {
      discardResponse(response);
      throw new PinnedBinaryError('download_invalid', `${label} download size did not match pinned metadata`);
    }
  }

  const hash = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > asset.size) {
        callback(new PinnedBinaryError('download_invalid', `${label} download exceeded its pinned size`));
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
    throw new PinnedBinaryError('download_timeout', `Timed out downloading ${label}`);
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
      throw new PinnedBinaryError(
        'download_invalid',
        bytes !== asset.size
          ? `${label} download size did not match pinned metadata`
          : `${label} download checksum did not match pinned metadata`
      );
    }
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    if (abortController.signal.aborted) {
      throw new PinnedBinaryError('download_timeout', `Timed out downloading ${label}`, { cause: error });
    }
    if (error instanceof PinnedBinaryError) {
      throw error;
    }
    throw new PinnedBinaryError(
      'download_failed',
      `Failed to download ${label}: ${error instanceof Error ? error.message : String(error)}`,
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
    throw new PinnedBinaryError('archive_invalid', `tar ${label} is invalid`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PinnedBinaryError('archive_invalid', `tar ${label} is out of range`);
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
    throw new PinnedBinaryError('archive_invalid', 'tar header checksum is invalid');
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
      throw new PinnedBinaryError('archive_invalid', 'Could not write the extracted binary');
    }
    offset += bytesWritten;
  }
};

export async function extractTarGzMember({
  archivePath,
  member,
  destinationPath,
  label = 'pinned binary',
  binaryBytes = DEFAULT_BINARY_BYTES,
  expandedTarBytes = DEFAULT_EXPANDED_TAR_BYTES,
}) {
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
      if (expandedBytes > expandedTarBytes) {
        throw new PinnedBinaryError('archive_invalid', `${label} tar archive expands beyond the allowed size`);
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
              throw new PinnedBinaryError('archive_invalid', `${label} archive contains the binary member more than once`);
            }
            if (!['0', ''].includes(entry.type)) {
              throw new PinnedBinaryError('archive_invalid', `${label} archive member is not a regular file`);
            }
            if (entry.size <= 0 || entry.size > binaryBytes) {
              throw new PinnedBinaryError('archive_invalid', `${label} archive member has an invalid size`);
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
            throw new PinnedBinaryError('archive_invalid', `${label} tar contains data after its end marker`);
          }
          pending = Buffer.alloc(0);
        }
      }
    }

    if (state !== 'end' || pending.length > 0) {
      throw new PinnedBinaryError('archive_invalid', `${label} tar archive is truncated`);
    }
    if (!found || extractedBytes <= 0) {
      throw new PinnedBinaryError('archive_invalid', `${label} archive does not contain ${member}`);
    }
    succeeded = true;
  } catch (error) {
    if (error instanceof PinnedBinaryError) {
      throw error;
    }
    throw new PinnedBinaryError(
      'archive_invalid',
      `Could not extract ${label}: ${error instanceof Error ? error.message : String(error)}`,
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

export async function extractZipMember({
  archivePath,
  member,
  destinationPath,
  label = 'pinned binary',
  binaryBytes = DEFAULT_BINARY_BYTES,
}) {
  let zip;
  try {
    zip = new AdmZip(archivePath);
  } catch (error) {
    throw new PinnedBinaryError(
      'archive_invalid',
      `Could not read ${label} zip archive: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const matches = zip.getEntries().filter((entry) => entry.entryName === member);
  if (matches.length !== 1) {
    throw new PinnedBinaryError(
      'archive_invalid',
      matches.length === 0
        ? `${label} archive does not contain ${member}`
        : `${label} archive contains the binary member more than once`
    );
  }

  const entry = matches[0];
  const unixMode = ((entry.attr ?? entry.header?.attr ?? 0) >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (entry.isDirectory || (unixType !== 0 && unixType !== 0o100000)) {
    throw new PinnedBinaryError('archive_invalid', `${label} archive member is not a regular file`);
  }
  const declaredSize = Number(entry.header?.size ?? 0);
  if (declaredSize > binaryBytes) {
    throw new PinnedBinaryError('archive_invalid', `${label} archive member is too large`);
  }

  let data;
  try {
    data = entry.getData();
  } catch (error) {
    throw new PinnedBinaryError(
      'archive_invalid',
      `Could not extract ${label} zip member: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!Buffer.isBuffer(data) || data.length <= 0 || data.length > binaryBytes) {
    throw new PinnedBinaryError('archive_invalid', `${label} archive member has an invalid size`);
  }

  try {
    await writeFile(destinationPath, data, { flag: 'wx', mode: 0o700 });
    await chmod(destinationPath, 0o700);
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractBinary({ asset, descriptor, archivePath, destinationPath }) {
  if (asset.archiveType === 'zip') {
    await extractZipMember({
      archivePath,
      member: asset.member,
      destinationPath,
      label: descriptor.label,
      binaryBytes: descriptor.limits.binaryBytes,
    });
    return;
  }
  if (asset.archiveType === 'tar.gz') {
    await extractTarGzMember({
      archivePath,
      member: asset.member,
      destinationPath,
      label: descriptor.label,
      binaryBytes: descriptor.limits.binaryBytes,
      expandedTarBytes: descriptor.limits.expandedTarBytes,
    });
    return;
  }
  throw new PinnedBinaryError('archive_invalid', `Unsupported ${descriptor.label} archive type: ${asset.archiveType}`);
}

async function acquireDirectoryLock(lockDirectory, {
  label,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
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
      throw new PinnedBinaryError('lock_timeout', `Timed out waiting for another ${label} installation to finish`);
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


/**
 * A pinned-binary manager: downloads one pinned release asset for the running
 * target, verifies its pinned size and digest, extracts the binary and
 * publishes it with owner-only permissions. Products differ only through the
 * descriptor, so nothing here names a product.
 *
 * @param {object} descriptor
 * @param {string} descriptor.id directory-adjacent identifier and User-Agent tag
 * @param {string} descriptor.label how messages name the product
 * @param {string} descriptor.version pinned release version
 * @param {(dataDir: string) => string} descriptor.productRoot where versions live
 * @param {(platform: string, arch: string) => object} descriptor.resolveAsset throws an error coded `unsupported_target`
 * @param {{ archiveBytes: number, binaryBytes: number, expandedTarBytes: number }} descriptor.limits
 * @param {(asset: object, entryName: string) => boolean} descriptor.isBinaryMember
 * @param {(binaryPath: string, options: { spawnSyncImpl: Function }) => object|Promise<object>} descriptor.verifyBinary `{ ok, version, error }`
 */
export function createPinnedBinaryManager({
  descriptor,
  platform = process.platform,
  arch = process.arch,
  asset: assetOverride,
  dataDir = resolveOpenChamberDataDir(),
  requestImpl = httpsGet,
  spawnSyncImpl = spawnSync,
  verifyBinary: verifyBinaryOverride,
  downloadTimeoutMs = descriptor.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  lockTimeoutMs = descriptor.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  lockPollMs = DEFAULT_LOCK_POLL_MS,
  allowedDownloadHosts = descriptor.allowedDownloadHosts ?? DOWNLOAD_HOST_ALLOWLIST,
  createId = randomUUID,
  onProgress,
} = {}) {
  const getAsset = () => {
    const asset = assetOverride ?? descriptor.resolveAsset(platform, arch);
    assertAssetMetadata(asset, descriptor);
    return asset;
  };
  const getPaths = () => resolveBinaryPaths(descriptor, getAsset(), dataDir);
  const verifyBinary = verifyBinaryOverride ?? ((binaryPath) => descriptor.verifyBinary(binaryPath, { spawnSyncImpl }));

  const inspect = async () => {
    let asset;
    try {
      asset = getAsset();
    } catch (error) {
      if (isErrorCode(error, 'unsupported_target')) {
        return {
          supported: false,
          prepared: false,
          path: null,
          version: descriptor.version,
          target: `${platform}-${arch}`,
          error: error.message,
        };
      }
      throw error;
    }
    const paths = resolveBinaryPaths(descriptor, asset, dataDir);
    const binary = await inspectBinary(paths.binaryPath, verifyBinary, descriptor.version);
    return {
      supported: true,
      prepared: binary.ok,
      path: binary.ok ? paths.binaryPath : null,
      version: binary.version ?? descriptor.version,
      target: paths.target,
      error: binary.ok ? null : binary.error,
    };
  };

  const prepare = async ({ onProgress: prepareProgress } = {}) => {
    const asset = getAsset();
    const paths = resolveBinaryPaths(descriptor, asset, dataDir);

    const initialBinary = await inspectBinary(paths.binaryPath, verifyBinary, descriptor.version);
    if (initialBinary.ok) {
      return {
        path: paths.binaryPath,
        version: descriptor.version,
        target: paths.target,
        source: 'installed',
      };
    }

    await ensurePrivateDirectory(paths.versionDirectory);
    const releaseLock = await acquireDirectoryLock(paths.lockDirectory, {
      label: descriptor.label,
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

      const lockedBinary = await inspectBinary(paths.binaryPath, verifyBinary, descriptor.version);
      if (lockedBinary.ok) {
        return {
          path: paths.binaryPath,
          version: descriptor.version,
          target: paths.target,
          source: 'installed',
        };
      }

      let archiveVerification = await verifyPinnedFile(paths.archivePath, asset);
      let source = 'archive-cache';
      if (!archiveVerification.ok) {
        downloadPath = path.join(paths.targetDirectory, `.download-${createId()}`);
        await downloadVerifiedAsset({
          asset,
          descriptor,
          destinationPath: downloadPath,
          requestImpl,
          timeoutMs: downloadTimeoutMs,
          allowedHosts: allowedDownloadHosts,
          onProgress: prepareProgress ?? onProgress,
        });
        archiveVerification = await verifyPinnedFile(downloadPath, asset);
        if (!archiveVerification.ok) {
          throw new PinnedBinaryError('download_invalid', `Downloaded ${descriptor.label} archive failed verification`);
        }
        await rm(paths.archivePath, { force: true });
        await rename(downloadPath, paths.archivePath);
        downloadPath = null;
        await chmod(paths.archivePath, 0o600);
        source = 'download';
      }

      extractionPath = path.join(paths.targetDirectory, `.extract-${createId()}`);
      await extractBinary({ asset, descriptor, archivePath: paths.archivePath, destinationPath: extractionPath });
      const stagedVerification = await inspectBinary(extractionPath, verifyBinary, descriptor.version);
      if (!stagedVerification.ok) {
        throw new PinnedBinaryError(
          'version_mismatch',
          `Extracted ${descriptor.label} failed ${descriptor.version} verification: ${stagedVerification.error || 'unknown error'}`
        );
      }

      await rm(paths.binaryPath, { force: true });
      await rename(extractionPath, paths.binaryPath);
      extractionPath = null;
      await chmod(paths.binaryPath, 0o700);

      return {
        path: paths.binaryPath,
        version: descriptor.version,
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
    version: descriptor.version,
    inspect,
    prepare,
    getPaths,
  };
}
