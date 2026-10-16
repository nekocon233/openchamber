// The FRPC product's view of the shared pinned-binary manager: it pins this
// product's assets, limits, archive member rule and version check, and keeps
// the names its callers already import. Everything generic lives in
// ../pinned-binary/manager.js.
import { spawnSync } from 'child_process';
import path from 'path';

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
import {
  FRPC_ASSETS,
  FRPC_VERSION,
  resolveFrpcAsset,
} from './frpc-assets.js';

export const FRPC_DEFAULT_DOWNLOAD_TIMEOUT_MS = DEFAULT_DOWNLOAD_TIMEOUT_MS;
export const FRPC_DEFAULT_LOCK_TIMEOUT_MS = DEFAULT_LOCK_TIMEOUT_MS;

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

export const extractFrpcTarGzMember = (options) => extractTarGzMember({ label: 'FRPC', ...options });
export const extractFrpcZipMember = (options) => extractZipMember({ label: 'FRPC', ...options });

const descriptor = (assets) => ({
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
  // The release archives keep the binary inside a versioned directory.
  isBinaryMember: (asset, entryName) => entryName.endsWith(`/${asset.binaryName}`),
  verifyBinary: (binaryPath, { spawnSyncImpl }) => verifyFrpcVersion(binaryPath, { spawnSyncImpl }),
});

export function createFrpcBinaryManager({ assets = FRPC_ASSETS, ...options } = {}) {
  return createPinnedBinaryManager({ descriptor: descriptor(assets), ...options });
}
