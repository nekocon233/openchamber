import { spawnSync } from 'child_process';
import path from 'path';

import {
  DEFAULT_ARCHIVE_BYTES,
  DEFAULT_BINARY_BYTES,
  DEFAULT_EXPANDED_TAR_BYTES,
  createPinnedBinaryManager,
} from '../../pinned-binary/manager.js';
import { CLIPROXYAPI_ASSETS, CLIPROXYAPI_VERSION, resolveGatewayAsset } from './gateway-assets.js';

// The Windows build is a 69 MB binary, so the shared 64 MB cap is raised here.
const LIMITS = Object.freeze({
  archiveBytes: DEFAULT_ARCHIVE_BYTES * 2,
  binaryBytes: DEFAULT_BINARY_BYTES * 3,
  expandedTarBytes: DEFAULT_EXPANDED_TAR_BYTES * 2,
});

/**
 * The gateway has no `--version` flag: it rejects it with exit code 2. `-h`
 * prints the banner and exits 0, which is the only way to make it name itself.
 */
export function verifyGatewayVersion(binaryPath, {
  expectedVersion = CLIPROXYAPI_VERSION,
  spawnSyncImpl = spawnSync,
  timeoutMs = 5000,
} = {}) {
  try {
    const result = spawnSyncImpl(binaryPath, ['-h'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const version = /CLIProxyAPI Version:\s*([^\s,]+)/.exec(output)?.[1] ?? null;
    if (result.status === 0 && version === expectedVersion) {
      return { ok: true, version, error: null };
    }
    const detail = result.error?.message
      || (version === null ? 'output did not name a version' : `reported version ${version}`);
    return { ok: false, version, error: detail };
  } catch (error) {
    return {
      ok: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const descriptor = (assets) => ({
  id: 'cliproxyapi',
  label: 'CLIProxyAPI',
  version: CLIPROXYAPI_VERSION,
  productRoot: (dataDir) => path.join(dataDir, 'native-agents', 'cliproxyapi'),
  resolveAsset: (platform, arch) => resolveGatewayAsset(platform, arch, assets),
  limits: LIMITS,
  // Flat archives: the member name is the binary name, with no directory.
  isBinaryMember: (asset, entryName) => entryName === asset.binaryName,
  verifyBinary: (binaryPath, { spawnSyncImpl }) => verifyGatewayVersion(binaryPath, { spawnSyncImpl }),
});

/** Downloads, verifies and publishes the pinned gateway binary. */
export function createCliproxyapiBinaryManager({ assets = CLIPROXYAPI_ASSETS, ...options } = {}) {
  return createPinnedBinaryManager({ descriptor: descriptor(assets), ...options });
}
