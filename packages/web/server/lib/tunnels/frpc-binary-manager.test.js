import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';
import AdmZip from 'adm-zip';

import {
  createFrpcBinaryManager,
  extractFrpcTarGzMember,
  extractFrpcZipMember,
  verifyFrpcVersion,
} from './frpc-binary-manager.js';
import {
  FRPC_ASSETS,
  FRPC_VERSION,
  resolveFrpcAsset,
} from './frpc-assets.js';

const tempDirectories = [];

const createTempDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-frpc-binary-test-'));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createAsset = ({ archive, archiveType, member, platform, arch, binaryName }) => {
  const name = `fixture.${archiveType === 'zip' ? 'zip' : 'tar.gz'}`;
  return {
    platform,
    arch,
    archiveType,
    name,
    url: `https://github.com/fatedier/frp/releases/download/v${FRPC_VERSION}/${name}`,
    size: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    member,
    binaryName,
  };
};

const createZipFixture = (member, binary) => {
  const zip = new AdmZip();
  zip.addFile(member, binary);
  return zip.toBuffer();
};

const writeTarOctal = (buffer, offset, length, value) => {
  const encoded = value.toString(8).padStart(length - 1, '0');
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
};

const createTarGzFixture = (entries) => {
  const chunks = [];
  for (const { name, data, type = '0' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    writeTarOctal(header, 100, 8, 0o700);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
};

const createRequestImpl = (responses, calls = []) => (url, _options, callback) => {
  calls.push(String(url));
  const request = new EventEmitter();
  request.destroy = (error) => {
    if (error) {
      queueMicrotask(() => request.emit('error', error));
    }
  };
  const next = responses.shift();
  queueMicrotask(() => {
    if (next instanceof Error) {
      request.emit('error', next);
      return;
    }
    const response = Readable.from(next.body === undefined ? [] : [next.body]);
    response.statusCode = next.statusCode ?? 200;
    response.headers = next.headers ?? {};
    callback(response);
  });
  return request;
};

const createBinaryVerifier = (expectedBinary) => async (binaryPath) => {
  try {
    const actual = await fs.promises.readFile(binaryPath);
    return actual.equals(expectedBinary)
      ? { ok: true, version: FRPC_VERSION, error: null }
      : { ok: false, version: null, error: 'fixture binary mismatch' };
  } catch (error) {
    return { ok: false, version: null, error: error.message };
  }
};

describe('FRPC pinned assets', () => {
  it('pins exact official v0.70.0 URLs, sizes, and SHA256 values for every supported target', () => {
    expect(Object.fromEntries(Object.entries(FRPC_ASSETS).map(([target, asset]) => [target, {
      url: asset.url,
      size: asset.size,
      sha256: asset.sha256,
    }]))).toEqual({
      'darwin-x64': {
        url: 'https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_darwin_amd64.tar.gz',
        size: 14272939,
        sha256: '040d844f43ead7d2f8c83247359b6c42270801b2b9bf642b4e02913569d76caa',
      },
      'darwin-arm64': {
        url: 'https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_darwin_arm64.tar.gz',
        size: 12966023,
        sha256: 'bb9cc92548cf7f304722beb244dc8a9b1fd3139e508309c8de6b780e2a166eba',
      },
      'linux-x64': {
        url: 'https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_linux_amd64.tar.gz',
        size: 14236735,
        sha256: '281cb31e6b915113179c6ebb65b5977a5d9d7fb96f9a70867be83dee3b657721',
      },
      'linux-arm64': {
        url: 'https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_linux_arm64.tar.gz',
        size: 12647534,
        sha256: '9dd282fd8d1b90a8ee760702ac5b876748b519c6bdfac7c68418f62a05d805c6',
      },
      'win32-x64': {
        url: 'https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_windows_amd64.zip',
        size: 14243353,
        sha256: '8407f83429643aa3fa9590d0c87a46b1ac14660efb96e46c955a4c2802f744b0',
      },
      'win32-arm64': {
        url: 'https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_windows_arm64.zip',
        size: 12486033,
        sha256: 'ee4ebec11f61129935cac67dbb56d70fc28bc3176f6b92c1fbef84e05f8c6ebb',
      },
    });
  });

  it('rejects unsupported targets', () => {
    expect(() => resolveFrpcAsset('freebsd', 'x64')).toThrow(/not available for freebsd\/x64/);
    expect(() => resolveFrpcAsset('linux', 'ia32')).toThrow(/not available for linux\/ia32/);
  });
});

describe('FRPC version verification', () => {
  it('uses a direct hidden spawn with no shell and requires the exact pinned version', () => {
    let launch;
    const result = verifyFrpcVersion('/managed/frpc', {
      spawnSyncImpl: (command, args, options) => {
        launch = { command, args, options };
        return { status: 0, stdout: '0.70.0\n', stderr: '' };
      },
    });

    expect(result).toEqual({ ok: true, version: '0.70.0', error: null });
    expect(launch.command).toBe('/managed/frpc');
    expect(launch.args).toEqual(['--version']);
    expect(launch.options).toMatchObject({ windowsHide: true, shell: false });
    expect(verifyFrpcVersion('/managed/frpc', {
      spawnSyncImpl: () => ({ status: 0, stdout: 'frpc 0.70.0\n', stderr: '' }),
    }).ok).toBe(false);
  });
});

describe('FRPC archive extraction', () => {
  it('streams only the exact regular member from tar.gz with Node built-ins', async () => {
    const directory = createTempDirectory();
    const archivePath = path.join(directory, 'fixture.tar.gz');
    const destinationPath = path.join(directory, 'frpc');
    const binary = Buffer.from('linux-frpc-fixture');
    fs.writeFileSync(archivePath, createTarGzFixture([
      { name: 'fixture/README.md', data: Buffer.from('ignore') },
      { name: 'fixture/frpc', data: binary },
      { name: '../frpc', data: Buffer.from('malicious') },
    ]));

    await extractFrpcTarGzMember({
      archivePath,
      member: 'fixture/frpc',
      destinationPath,
    });

    expect(fs.readFileSync(destinationPath)).toEqual(binary);
    expect(fs.existsSync(path.join(directory, '..', 'frpc'))).toBe(false);
  });

  it('does not substitute a traversal entry for the exact zip member', async () => {
    const directory = createTempDirectory();
    const archivePath = path.join(directory, 'fixture.zip');
    const destinationPath = path.join(directory, 'frpc.exe');
    fs.writeFileSync(archivePath, createZipFixture('../frpc.exe', Buffer.from('malicious')));

    await expect(extractFrpcZipMember({
      archivePath,
      member: 'fixture/frpc.exe',
      destinationPath,
    })).rejects.toThrow(/does not contain fixture\/frpc.exe/);
    expect(fs.existsSync(destinationPath)).toBe(false);
  });
});

describe('createFrpcBinaryManager', () => {
  it('fails unsupported targets before network access or filesystem writes', async () => {
    const root = createTempDirectory();
    const dataDir = path.join(root, 'must-not-be-created');
    let requestCalls = 0;
    const manager = createFrpcBinaryManager({
      platform: 'freebsd',
      arch: 'x64',
      dataDir,
      requestImpl: () => { requestCalls += 1; },
    });

    await expect(manager.prepare()).rejects.toThrow(/not available for freebsd\/x64/);
    expect(requestCalls).toBe(0);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('downloads once, publishes privately, and repairs a corrupt binary offline from the verified archive', async () => {
    const dataDir = createTempDirectory();
    const binary = Buffer.from('windows-frpc-fixture');
    const member = 'fixture/frpc.exe';
    const archive = createZipFixture(member, binary);
    const asset = createAsset({
      archive,
      archiveType: 'zip',
      member,
      platform: 'win32',
      arch: 'x64',
      binaryName: 'frpc.exe',
    });
    const calls = [];
    const manager = createFrpcBinaryManager({
      asset,
      dataDir,
      requestImpl: createRequestImpl([{
        body: archive,
        headers: { 'content-length': String(archive.length) },
      }], calls),
      verifyBinary: createBinaryVerifier(binary),
    });

    const first = await manager.prepare();
    const paths = manager.getPaths();
    expect(paths.versionDirectory).toBe(path.join(dataDir, 'tunnels', 'frpc', 'v0.70.0'));
    expect(paths.targetDirectory).toBe(path.join(paths.versionDirectory, 'win32-x64'));
    expect(first.source).toBe('download');
    expect(first.path).toBe(paths.binaryPath);
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(paths.binaryPath)).toEqual(binary);
    expect(fs.statSync(paths.targetDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.archivePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.binaryPath).mode & 0o777).toBe(0o700);

    fs.writeFileSync(paths.binaryPath, 'corrupt');
    const offlineManager = createFrpcBinaryManager({
      asset,
      dataDir,
      requestImpl: () => {
        throw new Error('network must not be used for offline repair');
      },
      verifyBinary: createBinaryVerifier(binary),
    });
    const repaired = await offlineManager.prepare();

    expect(repaired.source).toBe('archive-cache');
    expect(fs.readFileSync(paths.binaryPath)).toEqual(binary);
    expect((await offlineManager.inspect()).prepared).toBe(true);
  });

  it('rejects oversized responses, cleans staging files, and releases the install lock', async () => {
    const dataDir = createTempDirectory();
    const binary = Buffer.from('frpc');
    const member = 'fixture/frpc.exe';
    const archive = createZipFixture(member, binary);
    const asset = createAsset({
      archive,
      archiveType: 'zip',
      member,
      platform: 'win32',
      arch: 'x64',
      binaryName: 'frpc.exe',
    });
    const manager = createFrpcBinaryManager({
      asset,
      dataDir,
      requestImpl: createRequestImpl([{ body: Buffer.concat([archive, Buffer.from('extra')]) }]),
      verifyBinary: createBinaryVerifier(binary),
    });

    await expect(manager.prepare()).rejects.toThrow(/exceeded its pinned size/);

    const paths = manager.getPaths();
    expect(fs.existsSync(paths.lockDirectory)).toBe(false);
    expect(fs.existsSync(paths.archivePath)).toBe(false);
    const entries = fs.existsSync(paths.targetDirectory) ? fs.readdirSync(paths.targetDirectory) : [];
    expect(entries.some((entry) => entry.startsWith('.download-') || entry.startsWith('.extract-'))).toBe(false);
  });

  it('rejects redirects outside the compiled HTTPS host allowlist', async () => {
    const dataDir = createTempDirectory();
    const binary = Buffer.from('frpc');
    const member = 'fixture/frpc.exe';
    const archive = createZipFixture(member, binary);
    const asset = createAsset({
      archive,
      archiveType: 'zip',
      member,
      platform: 'win32',
      arch: 'x64',
      binaryName: 'frpc.exe',
    });
    const manager = createFrpcBinaryManager({
      asset,
      dataDir,
      requestImpl: createRequestImpl([{
        statusCode: 302,
        headers: { location: 'https://downloads.evil.example/frpc.zip' },
      }]),
      verifyBinary: createBinaryVerifier(binary),
    });

    await expect(manager.prepare()).rejects.toThrow(/download host is not allowed/);
    expect(fs.existsSync(manager.getPaths().lockDirectory)).toBe(false);
  });

  it('recovers a stale mkdir lock and uses a verified cached archive without network access', async () => {
    const dataDir = createTempDirectory();
    const binary = Buffer.from('cached-frpc');
    const member = 'fixture/frpc.exe';
    const archive = createZipFixture(member, binary);
    const asset = createAsset({
      archive,
      archiveType: 'zip',
      member,
      platform: 'win32',
      arch: 'x64',
      binaryName: 'frpc.exe',
    });
    const manager = createFrpcBinaryManager({
      asset,
      dataDir,
      requestImpl: () => {
        throw new Error('network must not be used');
      },
      verifyBinary: createBinaryVerifier(binary),
      staleLockMs: 10,
      lockPollMs: 1,
    });
    const paths = manager.getPaths();
    fs.mkdirSync(paths.targetDirectory, { recursive: true });
    fs.writeFileSync(paths.archivePath, archive);
    fs.mkdirSync(paths.lockDirectory);
    const oldTime = new Date(Date.now() - 1000);
    fs.utimesSync(paths.lockDirectory, oldTime, oldTime);

    const prepared = await manager.prepare();

    expect(prepared.source).toBe('archive-cache');
    expect(fs.readFileSync(paths.binaryPath)).toEqual(binary);
    expect(fs.existsSync(paths.lockDirectory)).toBe(false);
  });

  it('serializes independent managers with the cross-process mkdir lock', async () => {
    const dataDir = createTempDirectory();
    const binary = Buffer.from('locked-frpc');
    const member = 'fixture/frpc.exe';
    const archive = createZipFixture(member, binary);
    const asset = createAsset({
      archive,
      archiveType: 'zip',
      member,
      platform: 'win32',
      arch: 'x64',
      binaryName: 'frpc.exe',
    });
    const calls = [];
    const requestImpl = createRequestImpl([{
      body: archive,
      headers: { 'content-length': String(archive.length) },
    }], calls);
    const options = {
      asset,
      dataDir,
      requestImpl,
      verifyBinary: createBinaryVerifier(binary),
      lockPollMs: 1,
      staleLockMs: 1000,
    };
    const firstManager = createFrpcBinaryManager(options);
    const secondManager = createFrpcBinaryManager(options);

    const [first, second] = await Promise.all([firstManager.prepare(), secondManager.prepare()]);

    expect(calls).toHaveLength(1);
    expect(first.path).toBe(second.path);
    expect(fs.readFileSync(first.path)).toEqual(binary);
    expect(fs.existsSync(firstManager.getPaths().lockDirectory)).toBe(false);
  });
});
