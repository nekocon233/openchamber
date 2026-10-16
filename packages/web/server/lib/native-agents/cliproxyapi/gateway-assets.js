export const CLIPROXYAPI_VERSION = '8.0.31';

const RELEASE_BASE_URL = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXYAPI_VERSION}`;

// Unlike FRP's, these archives are flat: the binary, the licence and the
// example config all sit at the archive root.
const defineAsset = ({ platform, arch, releasePlatform, releaseArch, archiveType, size, sha256 }) => {
  const archiveExtension = archiveType === 'zip' ? 'zip' : 'tar.gz';
  const name = `CLIProxyAPI_${CLIPROXYAPI_VERSION}_${releasePlatform}_${releaseArch}.${archiveExtension}`;
  const binaryName = platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';

  return Object.freeze({
    platform,
    arch,
    archiveType,
    name,
    url: `${RELEASE_BASE_URL}/${name}`,
    size,
    sha256,
    member: binaryName,
    binaryName,
  });
};

export const CLIPROXYAPI_ASSETS = Object.freeze({
  'darwin-arm64': defineAsset({
    platform: 'darwin',
    arch: 'arm64',
    releasePlatform: 'darwin',
    releaseArch: 'aarch64',
    archiveType: 'tar.gz',
    size: 21574062,
    sha256: '36e193a737c4821aa122cf35c293c13f2b16c10d56d4ac4b19ced197fab19a79',
  }),
  'darwin-x64': defineAsset({
    platform: 'darwin',
    arch: 'x64',
    releasePlatform: 'darwin',
    releaseArch: 'amd64',
    archiveType: 'tar.gz',
    size: 23377720,
    sha256: '4a3b17a82856260c67ef2c246538075e41e553591b21a7681314d309ceed8922',
  }),
  'linux-arm64': defineAsset({
    platform: 'linux',
    arch: 'arm64',
    releasePlatform: 'linux',
    releaseArch: 'aarch64',
    archiveType: 'tar.gz',
    size: 21099824,
    sha256: '3a535ddb2000e5cdc7b25e0765f1538d68708faec4272cf98327c11d2af2ad14',
  }),
  'linux-x64': defineAsset({
    platform: 'linux',
    arch: 'x64',
    releasePlatform: 'linux',
    releaseArch: 'amd64',
    archiveType: 'tar.gz',
    size: 23421904,
    sha256: 'c00a2df9a75513ea23feec4e4b0c4d3ee76a15cd14e80b896e000586914b69b9',
  }),
  'win32-arm64': defineAsset({
    platform: 'win32',
    arch: 'arm64',
    releasePlatform: 'windows',
    releaseArch: 'aarch64',
    archiveType: 'zip',
    size: 21133355,
    sha256: '51a0b8d0ca2452340a73a18ad7c7eda7a349ea7a608a525f2f62148373b5ec57',
  }),
  'win32-x64': defineAsset({
    platform: 'win32',
    arch: 'x64',
    releasePlatform: 'windows',
    releaseArch: 'amd64',
    archiveType: 'zip',
    size: 23699580,
    sha256: '28bde34eb33a1b03884bac1e8c1a402a25ae4eadd3c60df7ae0df53f8b281318',
  }),
});

class UnsupportedGatewayTargetError extends Error {
  constructor(platform, arch) {
    super(`CLIProxyAPI ${CLIPROXYAPI_VERSION} is not available for ${platform}/${arch}`);
    this.name = 'UnsupportedGatewayTargetError';
    this.code = 'unsupported_target';
    this.platform = platform;
    this.arch = arch;
  }
}

export function resolveGatewayAsset(platform = process.platform, arch = process.arch, assets = CLIPROXYAPI_ASSETS) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) {
    throw new UnsupportedGatewayTargetError(platform, arch);
  }
  return asset;
}
