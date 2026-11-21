import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
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
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { get as httpsGet, type RequestOptions } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { openZipArchive } from '../shared/zip-archive.js';

import { isRecord, isString } from '../shared/guards.js';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
export const DEFAULT_LOCK_TIMEOUT_MS = 120000;
export const DEFAULT_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_BINARY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EXPANDED_TAR_BYTES = 256 * 1024 * 1024;
const DEFAULT_STALE_LOCK_MS = 300000;
const DEFAULT_LOCK_POLL_MS = 100;
const MAX_REDIRECTS = 5;
const STAGING_PREFIXES: readonly string[] = ['.download-', '.extract-'];

const DOWNLOAD_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
]);
const DOWNLOAD_HOST_ALLOWLIST: ReadonlySet<string> = new Set(DOWNLOAD_HOSTS);

export interface PinnedBinaryAsset {
  platform: string;
  arch: string;
  archiveType: string;
  size: number;
  sha256: string;
  name: string;
  member: string;
  binaryName: string;
  url: string;
}

export interface PinnedBinaryLimits {
  archiveBytes: number;
  binaryBytes: number;
  expandedTarBytes: number;
}

export interface VersionVerificationObject {
  ok: boolean;
  version?: string | null | undefined;
  error?: string | null | undefined;
}

export type VersionVerificationInput = boolean | VersionVerificationObject;

export interface NormalizedVersionVerification {
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface PinnedBinaryDescriptor {
  id: string;
  label: string;
  version: string;
  userAgent?: string | undefined;
  downloadTimeoutMs?: number | undefined;
  lockTimeoutMs?: number | undefined;
  allowedDownloadHosts?: ReadonlySet<string> | undefined;
  productRoot: (dataDir: string) => string;
  resolveAsset: (platform: string, arch: string) => PinnedBinaryAsset;
  limits: PinnedBinaryLimits;
  isBinaryMember: (asset: PinnedBinaryAsset, entryName: string) => boolean;
  verifyBinary: (
    binaryPath: string,
    options: { spawnSyncImpl: typeof spawnSync },
  ) => VersionVerificationInput | Promise<VersionVerificationInput>;
}

export type HttpsRequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export type ProgressCallback = (bytes: number, totalBytes: number) => void;

export interface PinnedBinaryPaths {
  versionDirectory: string;
  targetDirectory: string;
  lockDirectory: string;
  archivePath: string;
  binaryPath: string;
  target: string;
}

export interface ExtractTarGzMemberOptions {
  archivePath: string;
  member: string;
  destinationPath: string;
  label?: string | undefined;
  binaryBytes?: number | undefined;
  expandedTarBytes?: number | undefined;
}

export interface ExtractZipMemberOptions {
  archivePath: string;
  member: string;
  destinationPath: string;
  label?: string | undefined;
  binaryBytes?: number | undefined;
}

export interface CreatePinnedBinaryManagerOptions {
  descriptor: PinnedBinaryDescriptor;
  platform?: string | undefined;
  arch?: string | undefined;
  asset?: PinnedBinaryAsset | undefined;
  dataDir?: string | undefined;
  requestImpl?: HttpsRequestFn | undefined;
  spawnSyncImpl?: typeof spawnSync | undefined;
  verifyBinary?: ((binaryPath: string) => VersionVerificationInput | Promise<VersionVerificationInput>) | undefined;
  downloadTimeoutMs?: number | undefined;
  lockTimeoutMs?: number | undefined;
  staleLockMs?: number | undefined;
  lockPollMs?: number | undefined;
  allowedDownloadHosts?: ReadonlySet<string> | undefined;
  createId?: (() => string) | undefined;
  onProgress?: ProgressCallback | undefined;
}

export interface PinnedBinaryInspectResult {
  supported: boolean;
  prepared: boolean;
  path: string | null;
  version: string;
  target: string;
  error: string | null;
}

export interface PinnedBinaryPrepareResult {
  path: string;
  version: string;
  target: string;
  source: 'installed' | 'archive-cache' | 'download';
}

class PinnedBinaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PinnedBinaryError';
    this.code = code;
  }
}

const isErrorWithCode = (value: unknown): value is { code?: unknown; message?: unknown } =>
  isRecord(value);

const isOwnerRecord = (value: unknown): value is { id?: unknown } =>
  isRecord(value);

const hasDestroyMethod = (value: unknown): value is { destroy: () => void } =>
  isRecord(value) && typeof value.destroy === 'function';

const isBufferLike = (value: unknown): value is Buffer | Uint8Array | string =>
  Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string';

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const assertAssetMetadata = (asset: PinnedBinaryAsset, descriptor: PinnedBinaryDescriptor): void => {
  if (!isRecord(asset)) {
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
  if (!isString(asset.sha256) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset checksum is invalid`);
  }
  if (!isString(asset.name) || path.posix.basename(asset.name) !== asset.name) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset filename is invalid`);
  }
  if (!isString(asset.member) || !descriptor.isBinaryMember(asset, asset.member)) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} archive member is invalid`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(asset.url);
  } catch {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset URL is invalid`);
  }
  if (parsedUrl.protocol !== 'https:' || path.posix.basename(parsedUrl.pathname) !== asset.name) {
    throw new PinnedBinaryError('invalid_asset', `${descriptor.label} asset URL does not match its filename`);
  }
};

function resolveOpenChamberDataDir({
  env = process.env,
  homedir = os.homedir(),
}: { env?: NodeJS.ProcessEnv; homedir?: string } = {}): string {
  const configured = isString(env.OPENCHAMBER_DATA_DIR)
    ? env.OPENCHAMBER_DATA_DIR.trim()
    : '';
  return configured
    ? path.resolve(configured)
    : path.join(homedir, '.config', 'openchamber');
}

function resolveBinaryPaths(
  descriptor: PinnedBinaryDescriptor,
  asset: PinnedBinaryAsset,
  dataDir: string,
): PinnedBinaryPaths {
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

const normalizeVersionVerification = (
  result: VersionVerificationInput | null | undefined,
  version: string,
): NormalizedVersionVerification => {
  if (result === true) {
    return { ok: true, version, error: null };
  }
  if (result === false || !result || !isRecord(result)) {
    return { ok: false, version: null, error: 'version verification failed' };
  }
  return {
    ok: result.ok === true,
    version: isString(result.version) ? result.version : null,
    error: isString(result.error) ? result.error : null,
  };
};

async function inspectBinary(
  binaryPath: string,
  verifyBinary: (binaryPath: string) => VersionVerificationInput | Promise<VersionVerificationInput>,
  version: string,
): Promise<{ exists: boolean; ok: boolean; version: string | null; error: string | null }> {
  let fileStats;
  try {
    fileStats = await stat(binaryPath);
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') {
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

async function verifyPinnedFile(
  filePath: string,
  asset: PinnedBinaryAsset,
): Promise<{ ok: boolean; reason: string | null }> {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') {
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
      if (!isBufferLike(chunk)) continue;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > asset.size) {
        return { ok: false, reason: 'size mismatch' };
      }
      hash.update(buffer);
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) {
    return { ok: false, reason: bytes !== asset.size ? 'size mismatch' : 'checksum mismatch' };
  }
  return { ok: true, reason: null };
}

const validateDownloadUrl = (value: string | URL, allowedHosts: ReadonlySet<string>, label: string): URL => {
  let parsed: URL;
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

const requestHttpsResponse = (
  requestImpl: HttpsRequestFn,
  url: URL,
  deadline: number,
  { userAgent, label }: { userAgent: string; label: string },
): Promise<IncomingMessage> => new Promise<IncomingMessage>((resolve, reject) => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    reject(new PinnedBinaryError('download_timeout', `Timed out downloading ${label}`));
    return;
  }

  let request: ClientRequest | undefined;
  let settled = false;
  const finishResolve = (value: IncomingMessage) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const finishReject = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  };
  const timer = setTimeout(() => {
    const error = new PinnedBinaryError('download_timeout', `Timed out downloading ${label}`);
    request?.destroy?.(error);
    finishReject(error);
  }, remainingMs);

  try {
    request = requestImpl(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': userAgent,
      },
    }, (response) => finishResolve(response));
    request.once?.('error', (error) => {
      finishReject(new PinnedBinaryError(
        'download_failed',
        `Failed to download ${label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ));
    });
  } catch (error) {
    finishReject(new PinnedBinaryError(
      'download_failed',
      `Failed to download ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
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
}: {
  asset: PinnedBinaryAsset;
  descriptor: PinnedBinaryDescriptor;
  destinationPath: string;
  requestImpl?: HttpsRequestFn;
  timeoutMs?: number;
  allowedHosts?: ReadonlySet<string>;
  maxRedirects?: number;
  onProgress?: ProgressCallback | undefined;
}): Promise<void> {
  assertAssetMetadata(asset, descriptor);
  const label = descriptor.label;
  const userAgent = descriptor.userAgent ?? `OpenChamber-${descriptor.id}/${descriptor.version}`;
  const deadline = Date.now() + timeoutMs;
  let currentUrl = validateDownloadUrl(asset.url, allowedHosts, label);
  let response: IncomingMessage;
  const discardResponse = (value: Pick<IncomingMessage, 'resume'> & { destroy?: () => void }) => {
    if (hasDestroyMethod(value)) {
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
      if (!isString(location) || !location) {
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
        callback(error instanceof Error ? error : new Error(String(error)));
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
      { signal: abortController.signal },
    );
    const digest = hash.digest('hex');
    if (bytes !== asset.size || digest !== asset.sha256) {
      throw new PinnedBinaryError(
        'download_invalid',
        bytes !== asset.size
          ? `${label} download size did not match pinned metadata`
          : `${label} download checksum did not match pinned metadata`,
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
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

const parseTarString = (field: Buffer): string => {
  const nulIndex = field.indexOf(0);
  return field.subarray(0, nulIndex === -1 ? field.length : nulIndex).toString('utf8');
};

const parseTarOctal = (field: Buffer, label: string): number => {
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

const parseTarHeader = (header: Buffer) => {
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
  const typeByte = header[156] ?? 0;
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: parseTarOctal(header.subarray(124, 136), 'member size'),
    type: typeByte === 0 ? '0' : String.fromCharCode(typeByte),
  };
};

const writeAll = async (fileHandle: FileHandle, buffer: Buffer): Promise<void> => {
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
}: ExtractTarGzMemberOptions): Promise<void> {
  const source = createReadStream(archivePath);
  const gunzip = createGunzip();
  const output = await open(destinationPath, 'wx', 0o700);
  let succeeded = false;
  let pending: Buffer = Buffer.alloc(0);
  let state: 'header' | 'data' | 'padding' | 'end' = 'header';
  let entryRemaining = 0;
  let paddingRemaining = 0;
  let writeEntry = false;
  let found = false;
  let extractedBytes = 0;
  let expandedBytes = 0;

  try {
    for await (const rawChunk of source.pipe(gunzip)) {
      if (!isBufferLike(rawChunk)) continue;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
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
      { cause: error },
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
}: ExtractZipMemberOptions): Promise<void> {
  let data: Buffer;
  try {
    const read = openZipArchive(await readFile(archivePath), DEFAULT_EXPANDED_TAR_BYTES);
    data = await read(member, binaryBytes);
  } catch (error) {
    throw new PinnedBinaryError(
      'archive_invalid',
      `Could not extract ${label} zip member: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Buffer.isBuffer(data) || data.length <= 0 || data.length > binaryBytes) {
    throw new PinnedBinaryError('archive_invalid', `${label} archive member has an invalid size`);
  }

  const output = await open(destinationPath, 'wx', 0o700);
  let succeeded = false;
  try {
    await output.writeFile(data);
    await output.chmod(0o700);
    succeeded = true;
  } finally {
    await output.close();
    if (!succeeded) await rm(destinationPath, { force: true });
  }
}

async function extractBinary({
  asset,
  descriptor,
  archivePath,
  destinationPath,
}: {
  asset: PinnedBinaryAsset;
  descriptor: PinnedBinaryDescriptor;
  archivePath: string;
  destinationPath: string;
}): Promise<void> {
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

async function acquireDirectoryLock(
  lockDirectory: string,
  {
    label,
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_LOCK_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
    now = Date.now,
    sleep = delay,
    createId = randomUUID,
  }: {
    label: string;
    timeoutMs?: number;
    staleMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    createId?: () => string;
  },
): Promise<() => Promise<void>> {
  const ownerId = createId();
  const startedAt = now();

  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        await writeFile(
          path.join(lockDirectory, 'owner.json'),
          JSON.stringify({ id: ownerId, pid: process.pid, startedAt }),
          { flag: 'wx', mode: 0o600 },
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
          const owner: unknown = JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
          if (!isOwnerRecord(owner) || owner.id !== ownerId) {
            return;
          }
        } catch {
          return;
        }
        await rm(lockDirectory, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }

    let lockStats;
    try {
      lockStats = await stat(lockDirectory);
    } catch (error) {
      if (isErrorWithCode(error) && error.code === 'ENOENT') {
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
        if (isErrorWithCode(error) && (error.code === 'ENOENT' || error.code === 'EEXIST')) {
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

const ensurePrivateDirectory = async (directoryPath: string): Promise<void> => {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
};

const cleanupStagingFiles = async (targetDirectory: string): Promise<void> => {
  let entries;
  try {
    entries = await readdir(targetDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => STAGING_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => rm(path.join(targetDirectory, entry.name), { recursive: true, force: true })));
};

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
}: CreatePinnedBinaryManagerOptions) {
  const getAsset = (): PinnedBinaryAsset => {
    const asset = assetOverride ?? descriptor.resolveAsset(platform, arch);
    assertAssetMetadata(asset, descriptor);
    return asset;
  };
  const getPaths = (): PinnedBinaryPaths => resolveBinaryPaths(descriptor, getAsset(), dataDir);
  const verifyBinary = verifyBinaryOverride ?? ((binaryPath: string) => descriptor.verifyBinary(binaryPath, { spawnSyncImpl }));

  const inspect = async (): Promise<PinnedBinaryInspectResult> => {
    let asset: PinnedBinaryAsset;
    try {
      asset = getAsset();
    } catch (error) {
      if (isErrorWithCode(error) && error.code === 'unsupported_target') {
        return {
          supported: false,
          prepared: false,
          path: null,
          version: descriptor.version,
          target: `${platform}-${arch}`,
          error: isString(error.message) ? error.message : String(error),
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

  const prepare = async ({ onProgress: prepareProgress }: { onProgress?: ProgressCallback | undefined } = {}): Promise<PinnedBinaryPrepareResult> => {
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
    let downloadPath: string | null = null;
    let extractionPath: string | null = null;

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
      let source: PinnedBinaryPrepareResult['source'] = 'archive-cache';
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
          `Extracted ${descriptor.label} failed ${descriptor.version} verification: ${stagedVerification.error || 'unknown error'}`,
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
