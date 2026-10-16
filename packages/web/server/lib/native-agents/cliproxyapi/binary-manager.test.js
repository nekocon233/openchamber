import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';
import { afterEach, describe, expect, it } from 'bun:test';

import { CLIPROXYAPI_ASSETS, CLIPROXYAPI_VERSION, resolveGatewayAsset } from './gateway-assets.js';
import { createCliproxyapiBinaryManager, verifyGatewayVersion } from './binary-manager.js';

const tempDirectories = [];
const tempDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxyapi-binary-'));
  tempDirectories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const writeTarOctal = (buffer, offset, length, value) => {
  buffer.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
};

/** A flat tar.gz holding `entries` at the archive root. */
const createTarGzFixture = (entries) => {
  const chunks = [];
  for (const { name, data } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    writeTarOctal(header, 100, 8, 0o700);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
};

const assetFixture = (archive) => ({
  platform: 'darwin',
  arch: 'arm64',
  archiveType: 'tar.gz',
  name: 'fixture.tar.gz',
  url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXYAPI_VERSION}/fixture.tar.gz`,
  size: archive.length,
  sha256: createHash('sha256').update(archive).digest('hex'),
  member: 'cli-proxy-api',
  binaryName: 'cli-proxy-api',
});

const responseFrom = (buffer, statusCode = 200) => {
  const stream = Readable.from([buffer]);
  stream.statusCode = statusCode;
  stream.headers = { 'content-length': String(buffer.length) };
  return stream;
};

const createRequestMock = (responses, calls = []) => (url, _options, callback) => {
  calls.push(String(url));
  const request = new EventEmitter();
  request.destroy = (error) => {
    if (error) queueMicrotask(() => request.emit('error', error));
  };
  const next = responses.shift();
  queueMicrotask(() => {
    if (next instanceof Error) {
      request.emit('error', next);
      return;
    }
    callback(next);
  });
  return request;
};

const passingVerify = () => ({ ok: true, version: CLIPROXYAPI_VERSION, error: null });

describe('CLIProxyAPI pinned assets', () => {
  it('pins every supported target to a published asset', () => {
    expect(Object.keys(CLIPROXYAPI_ASSETS).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
    ]);
    for (const [target, asset] of Object.entries(CLIPROXYAPI_ASSETS)) {
      expect(target).toBe(`${asset.platform}-${asset.arch}`);
      expect(asset.url).toBe(`https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXYAPI_VERSION}/${asset.name}`);
      expect(asset.url.endsWith(asset.name)).toBe(true);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.size).toBeGreaterThan(20 * 1024 * 1024);
      // Flat archives: the member is the bare binary name.
      expect(asset.member).toBe(asset.binaryName);
      expect(asset.binaryName).toBe(asset.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api');
      expect(asset.archiveType).toBe(asset.platform === 'win32' ? 'zip' : 'tar.gz');
    }
  });

  it('refuses an unsupported target without touching the network or the disk', () => {
    expect(() => resolveGatewayAsset('freebsd', 'x64')).toThrow(/not available for freebsd\/x64/);
    expect(() => resolveGatewayAsset('linux', 'ia32')).toThrow(/not available for linux\/ia32/);
  });
});

describe('CLIProxyAPI version verification', () => {
  const banner = `CLIProxyAPI Version: ${CLIPROXYAPI_VERSION}, Commit: test, BuiltAt: 2026-10-16T00:00:00Z\n`;

  it('reads the version out of the help banner', () => {
    const spawnSyncImpl = () => ({ status: 0, stdout: banner, stderr: '' });
    expect(verifyGatewayVersion('/managed/cli-proxy-api', { spawnSyncImpl })).toEqual({
      ok: true, version: CLIPROXYAPI_VERSION, error: null,
    });
    const seen = [];
    verifyGatewayVersion('/managed/cli-proxy-api', { spawnSyncImpl: (...args) => { seen.push(args); return { status: 0, stdout: banner, stderr: '' }; } });
    expect(seen[0][1]).toEqual(['-h']);
  });

  it('rejects a binary that reports another version, exits non-zero, or prints no banner', () => {
    expect(verifyGatewayVersion('/x', { spawnSyncImpl: () => ({ status: 0, stdout: 'CLIProxyAPI Version: 8.0.30, Commit: c\n', stderr: '' }) }))
      .toMatchObject({ ok: false, version: '8.0.30' });
    expect(verifyGatewayVersion('/x', { spawnSyncImpl: () => ({ status: 2, stdout: banner, stderr: 'flag provided but not defined: -version' }) }))
      .toMatchObject({ ok: false });
    expect(verifyGatewayVersion('/x', { spawnSyncImpl: () => ({ status: 0, stdout: 'not the gateway\n', stderr: '' }) }))
      .toMatchObject({ ok: false, version: null });
    expect(verifyGatewayVersion('/x', { spawnSyncImpl: () => { throw new Error('spawn failed'); } }))
      .toMatchObject({ ok: false, version: null, error: 'spawn failed' });
  });
});

describe('CLIProxyAPI binary manager', () => {
  it('publishes the downloaded binary and reuses it afterwards', async () => {
    const dataDir = tempDirectory();
    const archive = createTarGzFixture([{ name: 'cli-proxy-api', data: Buffer.from('#!/bin/sh\necho ok\n') }]);
    const asset = assetFixture(archive);
    const calls = [];
    const requestImpl = createRequestMock([responseFrom(archive)], calls);
    const manager = createCliproxyapiBinaryManager({ dataDir, asset, requestImpl, verifyBinary: passingVerify });

    const prepared = await manager.prepare();
    expect(prepared).toMatchObject({ source: 'download', version: CLIPROXYAPI_VERSION, target: 'darwin-arm64' });
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(prepared.path, 'utf8')).toContain('echo ok');
    if (process.platform !== 'win32') {
      expect(fs.statSync(prepared.path).mode & 0o777).toBe(0o700);
    }
    expect(fs.existsSync(path.join(dataDir, 'native-agents', 'cliproxyapi', `v${CLIPROXYAPI_VERSION}`, 'darwin-arm64', 'fixture.tar.gz'))).toBe(true);

    const second = await manager.prepare();
    expect(second).toMatchObject({ source: 'installed' });
    expect(calls).toHaveLength(1);
    expect(manager.getPaths().binaryPath).toBe(prepared.path);
  });

  it('accepts the Windows-sized binary the shared caps would refuse', async () => {
    const dataDir = tempDirectory();
    // Larger than the shared 64 MiB binary cap, under this product's 192 MiB one.
    const big = Buffer.alloc(65 * 1024 * 1024);
    const archive = createTarGzFixture([{ name: 'cli-proxy-api', data: big }]);
    const asset = assetFixture(archive);
    const manager = createCliproxyapiBinaryManager({
      dataDir,
      asset,
      requestImpl: createRequestMock([responseFrom(archive)]),
      verifyBinary: passingVerify,
    });
    const prepared = await manager.prepare();
    expect(fs.statSync(prepared.path).size).toBe(big.length);
  });

  it('deletes a staged download whose checksum does not match', async () => {
    const dataDir = tempDirectory();
    const archive = createTarGzFixture([{ name: 'cli-proxy-api', data: Buffer.from('binary') }]);
    const asset = { ...assetFixture(archive), sha256: 'a'.repeat(64) };
    const manager = createCliproxyapiBinaryManager({
      dataDir,
      asset,
      requestImpl: createRequestMock([responseFrom(archive)]),
      verifyBinary: passingVerify,
    });
    await expect(manager.prepare()).rejects.toThrow(/checksum did not match pinned metadata/);
    const targetDirectory = path.join(dataDir, 'native-agents', 'cliproxyapi', `v${CLIPROXYAPI_VERSION}`, 'darwin-arm64');
    expect(fs.readdirSync(targetDirectory)).toEqual([]);
  });

  it('reports an unsupported target instead of throwing from inspect', async () => {
    const manager = createCliproxyapiBinaryManager({ platform: 'freebsd', arch: 'x64', dataDir: tempDirectory() });
    expect(await manager.inspect()).toMatchObject({ supported: false, prepared: false, target: 'freebsd-x64' });
    await expect(manager.prepare()).rejects.toThrow(/not available for freebsd\/x64/);
  });
});
