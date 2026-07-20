export const FRPC_VERSION = '0.70.0';

const RELEASE_BASE_URL = `https://github.com/fatedier/frp/releases/download/v${FRPC_VERSION}`;

const defineAsset = ({ platform, arch, releasePlatform, releaseArch, archiveType, size, sha256 }) => {
  const archiveExtension = archiveType === 'zip' ? 'zip' : 'tar.gz';
  const name = `frp_${FRPC_VERSION}_${releasePlatform}_${releaseArch}.${archiveExtension}`;
  const binaryName = platform === 'win32' ? 'frpc.exe' : 'frpc';

  return Object.freeze({
    platform,
    arch,
    archiveType,
    name,
    url: `${RELEASE_BASE_URL}/${name}`,
    size,
    sha256,
    member: `frp_${FRPC_VERSION}_${releasePlatform}_${releaseArch}/${binaryName}`,
    binaryName,
  });
};

export const FRPC_ASSETS = Object.freeze({
  'darwin-x64': defineAsset({
    platform: 'darwin',
    arch: 'x64',
    releasePlatform: 'darwin',
    releaseArch: 'amd64',
    archiveType: 'tar.gz',
    size: 14272939,
    sha256: '040d844f43ead7d2f8c83247359b6c42270801b2b9bf642b4e02913569d76caa',
  }),
  'darwin-arm64': defineAsset({
    platform: 'darwin',
    arch: 'arm64',
    releasePlatform: 'darwin',
    releaseArch: 'arm64',
    archiveType: 'tar.gz',
    size: 12966023,
    sha256: 'bb9cc92548cf7f304722beb244dc8a9b1fd3139e508309c8de6b780e2a166eba',
  }),
  'linux-x64': defineAsset({
    platform: 'linux',
    arch: 'x64',
    releasePlatform: 'linux',
    releaseArch: 'amd64',
    archiveType: 'tar.gz',
    size: 14236735,
    sha256: '281cb31e6b915113179c6ebb65b5977a5d9d7fb96f9a70867be83dee3b657721',
  }),
  'linux-arm64': defineAsset({
    platform: 'linux',
    arch: 'arm64',
    releasePlatform: 'linux',
    releaseArch: 'arm64',
    archiveType: 'tar.gz',
    size: 12647534,
    sha256: '9dd282fd8d1b90a8ee760702ac5b876748b519c6bdfac7c68418f62a05d805c6',
  }),
  'win32-x64': defineAsset({
    platform: 'win32',
    arch: 'x64',
    releasePlatform: 'windows',
    releaseArch: 'amd64',
    archiveType: 'zip',
    size: 14243353,
    sha256: '8407f83429643aa3fa9590d0c87a46b1ac14660efb96e46c955a4c2802f744b0',
  }),
  'win32-arm64': defineAsset({
    platform: 'win32',
    arch: 'arm64',
    releasePlatform: 'windows',
    releaseArch: 'arm64',
    archiveType: 'zip',
    size: 12486033,
    sha256: 'ee4ebec11f61129935cac67dbb56d70fc28bc3176f6b92c1fbef84e05f8c6ebb',
  }),
});

export class UnsupportedFrpcTargetError extends Error {
  constructor(platform, arch) {
    super(`FRPC ${FRPC_VERSION} is not available for ${platform}/${arch}`);
    this.name = 'UnsupportedFrpcTargetError';
    this.code = 'unsupported_target';
    this.platform = platform;
    this.arch = arch;
  }
}

export function resolveFrpcAsset(platform = process.platform, arch = process.arch, assets = FRPC_ASSETS) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) {
    throw new UnsupportedFrpcTargetError(platform, arch);
  }
  return asset;
}
