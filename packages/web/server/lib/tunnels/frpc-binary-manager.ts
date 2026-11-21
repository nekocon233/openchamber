import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  DEFAULT_ARCHIVE_BYTES,
  DEFAULT_BINARY_BYTES,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_EXPANDED_TAR_BYTES,
  DEFAULT_LOCK_TIMEOUT_MS,
  createPinnedBinaryManager,
  extractTarGzMember,
  extractZipMember,
} from '../pinned-binary/manager.js';
import type {
  CreatePinnedBinaryManagerOptions,
  ExtractTarGzMemberOptions,
  ExtractZipMemberOptions,
  PinnedBinaryDescriptor,
} from '../pinned-binary/manager.js';
import {
  FRPC_ASSETS,
  FRPC_VERSION,
  resolveFrpcAsset,
} from './frpc-assets.js';
import type { FrpcAsset } from './frpc-assets.js';
import { isString } from '../shared/object-guards.js';

export const FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS = DEFAULT_DOWNLOAD_TIMEOUT_MS;
export const FRPC_DEFAULT_LOCK_TIMEOUT_MS = DEFAULT_LOCK_TIMEOUT_MS;

export interface VerifyFrpcVersionOptions {
  expectedVersion?: string;
  spawnSyncImpl?: typeof spawnSync;
  timeoutMs?: number;
}

export interface FrpcVersionVerificationResult {
  ok: boolean;
  version: string | null;
  error: string | null;
}

export function verifyFrpcVersion(
  binaryPath: string,
  {
    expectedVersion = FRPC_VERSION,
    spawnSyncImpl = spawnSync,
    timeoutMs = 5000,
  }: VerifyFrpcVersionOptions = {},
): FrpcVersionVerificationResult {
  try {
    const result = spawnSyncImpl(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    const output = isString(result.stdout) ? result.stdout.trim() : '';
    if (result.status === 0 && output === expectedVersion) {
      return { ok: true, version: output, error: null };
    }
    const stderr = isString(result.stderr) ? result.stderr.trim() : '';
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

export const extractFrpcTarGzMember = (options: ExtractTarGzMemberOptions) => extractTarGzMember({ label: 'FRPC', ...options });
export const extractFrpcZipMember = (options: ExtractZipMemberOptions) => extractZipMember({ label: 'FRPC', ...options });

const descriptor = (assets: Readonly<Record<string, FrpcAsset>>): PinnedBinaryDescriptor => ({
  id: 'frpc',
  label: 'FRPC',
  version: FRPC_VERSION,
  productRoot: (dataDir) => path.join(dataDir, 'tunnels', 'frpc'),
  resolveAsset: (platform, arch) => resolveFrpcAsset(platform, arch, assets),
  limits: {
    archiveBytes: DEFAULT_ARCHIVE_BYTES,
    binaryBytes: DEFAULT_BINARY_BYTES,
    expandedTarBytes: DEFAULT_EXPANDED_TAR_BYTES,
  },
  isBinaryMember: (asset, entryName) => entryName.endsWith(`/${asset.binaryName}`),
  verifyBinary: (binaryPath, { spawnSyncImpl }) => verifyFrpcVersion(binaryPath, { spawnSyncImpl }),
});

export type CreateFrpcBinaryManagerOptions = Omit<CreatePinnedBinaryManagerOptions, 'descriptor'> & {
  assets?: Readonly<Record<string, FrpcAsset>> | undefined;
};

export function createFrpcBinaryManager({ assets = FRPC_ASSETS, ...options }: CreateFrpcBinaryManagerOptions = {}) {
  return createPinnedBinaryManager({ descriptor: descriptor(assets), ...options });
}
