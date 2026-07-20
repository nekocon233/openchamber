import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import {
  buildFrpcConfig,
  normalizeFrpcCustomDomain,
  normalizeFrpcPublicHostname,
  normalizeFrpcPublicUrl,
  normalizeFrpcServerAddress,
  startFrpcClient,
} from './frpc-client.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('exit', null, signal));
    }
    return true;
  }

  exit(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

let tempRoot;
let trustedCaFile;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-frpc-client-test-'));
  trustedCaFile = path.join(tempRoot, 'ca.crt');
  fs.writeFileSync(trustedCaFile, 'test-ca-certificate', { mode: 0o600 });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('FRPC configuration', () => {
  it('builds native TLS, file-token, and loopback TCP proxy settings', () => {
    const config = buildFrpcConfig({
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      localPort: 3210,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      tokenFilePath: path.join(tempRoot, 'token'),
      trustedCaFile,
    });

    expect(config).toContain('serverAddr = "203.0.113.10"');
    expect(config).toContain('serverPort = 7000');
    expect(config).toContain('loginFailExit = true');
    expect(config).toContain('auth.additionalScopes = ["HeartBeats", "NewWorkConns"]');
    expect(config).toContain('auth.tokenSource.type = "file"');
    expect(config).toContain(`auth.tokenSource.file.path = ${JSON.stringify(path.join(tempRoot, 'token'))}`);
    expect(config).not.toContain('auth.token =');
    expect(config).toContain('transport.protocol = "tcp"');
    expect(config).toContain('transport.tls.enable = true');
    expect(config).toContain(`transport.tls.trustedCaFile = ${JSON.stringify(trustedCaFile)}`);
    expect(config).toContain('transport.tls.serverName = "203.0.113.10"');
    expect(config).toContain('name = "openchamber-18080"');
    expect(config).toContain('type = "tcp"');
    expect(config).toContain('localIP = "127.0.0.1"');
    expect(config).toContain('localPort = 3210');
    expect(config).toContain('remotePort = 18080');
    expect(config).not.toContain('customDomains');
  });

  it('accepts IP addresses and bare hostnames while rejecting URLs and embedded ports', () => {
    expect(normalizeFrpcServerAddress('203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeFrpcServerAddress('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeFrpcServerAddress('Example-FRPS-1')).toBe('example-frps-1');
    expect(() => normalizeFrpcServerAddress('https://203.0.113.10')).toThrow(/without a scheme/);
    expect(() => normalizeFrpcServerAddress('app.example.com:7000')).toThrow(/valid IP address or hostname/);
    expect(() => normalizeFrpcServerAddress('*.example.com')).toThrow(/valid IP address or hostname/);
  });

  it('builds an HTTP-vhost proxy with a bounded deterministic name and no remote port', () => {
    const options = {
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      localPort: 3210,
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      tokenFilePath: path.join(tempRoot, 'token'),
      trustedCaFile,
    };
    const first = buildFrpcConfig(options);
    const second = buildFrpcConfig(options);
    const proxyName = first.match(/name = "([^"]+)"/)?.[1];

    expect(proxyName).toMatch(/^openchamber-http-[a-f0-9]{32}$/);
    expect(proxyName.length).toBeLessThan(64);
    expect(second).toContain(`name = "${proxyName}"`);
    expect(first).toContain('type = "http"');
    expect(first).toContain('localIP = "127.0.0.1"');
    expect(first).toContain('localPort = 3210');
    expect(first).toContain('customDomains = ["route.example.com"]');
    expect(first).not.toContain('remotePort');
  });

  it('normalizes only bare DNS hostnames for HTTP-vhost routing and public URLs', () => {
    expect(normalizeFrpcCustomDomain('Routé.Example')).toBe('xn--rout-epa.example');
    expect(normalizeFrpcPublicHostname('Public.Example.com')).toBe('public.example.com');
    for (const invalid of [
      'https://public.example.com',
      'public.example.com/path',
      'public.example.com:443',
      '*.example.com',
      'public.example.com.',
      '127.0.0.1',
    ]) {
      expect(() => normalizeFrpcPublicHostname(invalid)).toThrow();
    }
  });

  it('accepts only origin-only HTTPS URLs for externally terminated TCP', () => {
    expect(normalizeFrpcPublicUrl(' HTTPS://Public.Example.com:18080/ ')).toBe('https://public.example.com:18080');
    for (const invalid of [
      'http://public.example.com:18080',
      'public.example.com:18080',
      'https://user:secret@public.example.com:18080',
      'https://public.example.com:18080/path',
      'https://public.example.com:18080?token=secret',
      'https://public.example.com:18080#fragment',
      'https://[invalid',
    ]) {
      expect(() => normalizeFrpcPublicUrl(invalid)).toThrow();
    }
  });
});

describe('startFrpcClient', () => {
  it('spawns directly and keeps token and config in private temporary files until stop', async () => {
    const token = 'top-secret-frp-token';
    const binaryPath = path.join(tempRoot, 'frpc');
    const child = new FakeChild();
    let launch;
    const spawnImpl = (command, args, options) => {
      launch = { command, args, options };
      queueMicrotask(() => {
        child.stderr.write('2026/07/18 [I] [openchamber-18080] start proxy suc');
        child.stderr.write('cess\n');
      });
      return child;
    };

    const controller = await startFrpcClient({
      binaryPath,
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token,
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile,
      tempRoot,
      env: {
        SAFE_VALUE: 'kept',
        OPENCHAMBER_TUNNEL_TOKEN: token,
        FRP_TOKEN: token,
        DUPLICATE_SECRET: token,
      },
      spawnImpl,
    });

    expect(launch.command).toBe(binaryPath);
    expect(launch.args).toHaveLength(2);
    expect(launch.args[0]).toBe('-c');
    expect(JSON.stringify(launch.args)).not.toContain(token);
    expect(launch.options).toMatchObject({
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(launch.options.env).toEqual({ SAFE_VALUE: 'kept' });

    const configPath = launch.args[1];
    const configDirectory = path.dirname(configPath);
    const tokenPath = path.join(configDirectory, 'token');
    const copiedTrustedCaPath = path.join(configDirectory, 'trusted-ca.pem');
    const config = fs.readFileSync(configPath, 'utf8');
    expect(config).not.toContain(token);
    expect(fs.readFileSync(tokenPath, 'utf8')).toBe(token);
    expect(fs.readFileSync(copiedTrustedCaPath, 'utf8')).toBe('test-ca-certificate');
    expect(fs.statSync(configDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(copiedTrustedCaPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(controller.getPublicUrl()).toBe('https://app.example.com:18080');
    expect(controller.getConfiguredPublicUrl()).toBe('https://app.example.com:18080');
    expect(controller.getRemotePort()).toBe(18080);

    await expect(controller.stop()).resolves.toBe(true);
    expect(child.killedWith).toBe('SIGTERM');
    expect(fs.existsSync(configDirectory)).toBe(false);
    expect(controller.getPublicUrl()).toBeNull();
  });

  it('does not treat login success or process liveness as proxy readiness', async () => {
    const child = new FakeChild();
    let configDirectory;
    const spawnImpl = (_command, args) => {
      configDirectory = path.dirname(args[1]);
      queueMicrotask(() => child.stdout.write('login to server success, get run id [abc]\n'));
      return child;
    };

    await expect(startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile,
      startupTimeoutMs: 15,
      tempRoot,
      spawnImpl,
    })).rejects.toThrow(/Timed out after 15ms waiting for FRPC to report proxy readiness/);

    expect(child.killedWith).toBe('SIGTERM');
    expect(fs.existsSync(configDirectory)).toBe(false);
  });

  it('rejects non-file and oversized trust anchors before launching FRPC', async () => {
    const spawnImpl = () => {
      throw new Error('FRPC must not launch');
    };

    await expect(startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile: tempRoot,
      tempRoot,
      spawnImpl,
    })).rejects.toThrow(/regular file/);

    const oversizedCaFile = path.join(tempRoot, 'oversized-ca.crt');
    fs.writeFileSync(oversizedCaFile, Buffer.alloc((1024 * 1024) + 1));
    await expect(startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile: oversizedCaFile,
      tempRoot,
      spawnImpl,
    })).rejects.toThrow(/between 1 and 1048576 bytes/);
  });

  it('uses the exact HTTP proxy name for readiness and the external hostname for its public URL', async () => {
    const child = new FakeChild();
    let proxyName;
    const spawnImpl = (_command, args) => {
      const config = fs.readFileSync(args[1], 'utf8');
      proxyName = config.match(/name = "([^"]+)"/)?.[1];
      queueMicrotask(() => {
        child.stdout.write(`[${proxyName}-other] start proxy success\n`);
        child.stdout.write(`[${proxyName}] start proxy success\n`);
      });
      return child;
    };

    const controller = await startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      trustedCaFile,
      tempRoot,
      spawnImpl,
    });

    expect(proxyName).toMatch(/^openchamber-http-[a-f0-9]{32}$/);
    expect(controller.getPublicUrl()).toBe('https://public.example.com');
    expect(controller.getProxyType()).toBe('http');
    expect(controller.getRemotePort()).toBeNull();
    expect(controller.getCustomDomain()).toBe('route.example.com');
    expect(controller.getHostname()).toBe('public.example.com');
    await controller.stop();
  });

  it('does not accept readiness for a different HTTP proxy name', async () => {
    const child = new FakeChild();
    const spawnImpl = (_command, args) => {
      const config = fs.readFileSync(args[1], 'utf8');
      const proxyName = config.match(/name = "([^"]+)"/)?.[1];
      queueMicrotask(() => child.stdout.write(`[${proxyName}-other] start proxy success\n`));
      return child;
    };

    await expect(startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      customDomain: 'route.example.com',
      hostname: 'public.example.com',
      trustedCaFile,
      startupTimeoutMs: 15,
      tempRoot,
      spawnImpl,
    })).rejects.toThrow(/Timed out after 15ms/);
  });

  it('still recognizes readiness when the secret equals a public log marker', async () => {
    const child = new FakeChild();
    const spawnImpl = () => {
      queueMicrotask(() => child.stdout.write('[openchamber-18080] start proxy success\n'));
      return child;
    };

    const controller = await startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token: 'openchamber',
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile,
      tempRoot,
      spawnImpl,
    });

    expect(controller.getPublicUrl()).toBe('https://app.example.com:18080');
    await controller.stop();
  });

  it('returns actionable fatal diagnostics without exposing the token', async () => {
    const token = 'diagnostic-secret';
    const child = new FakeChild();
    let configDirectory;
    const spawnImpl = (_command, args) => {
      configDirectory = path.dirname(args[1]);
      queueMicrotask(() => child.stderr.write(
        `connect to server error: authentication failed for ${token}\n`
      ));
      return child;
    };

    let failure;
    try {
      await startFrpcClient({
        binaryPath: path.join(tempRoot, 'frpc'),
        serverAddress: '203.0.113.10',
        serverPort: 7000,
        token,
        localPort: 3000,
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
        trustedCaFile,
        tempRoot,
        spawnImpl,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('authentication failed');
    expect(failure.message).toContain('[redacted]');
    expect(failure.message).not.toContain(token);
    expect(child.killedWith).toBe('SIGTERM');
    expect(fs.existsSync(configDirectory)).toBe(false);
  });

  it('cleans temporary credentials when a ready process later exits', async () => {
    const child = new FakeChild();
    let configDirectory;
    let exitCalls = 0;
    const spawnImpl = (_command, args) => {
      configDirectory = path.dirname(args[1]);
      queueMicrotask(() => child.stdout.write('[openchamber-18080] start proxy success\n'));
      return child;
    };
    const controller = await startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile,
      tempRoot,
      spawnImpl,
      onExit: () => { exitCalls += 1; },
    });

    child.exit(1);

    expect(exitCalls).toBe(1);
    expect(controller.isRunning()).toBe(false);
    expect(controller.getPublicUrl()).toBeNull();
    expect(fs.existsSync(configDirectory)).toBe(false);
  });

  it('waits for confirmed termination and escalates to SIGKILL after the grace period', async () => {
    const child = new FakeChild();
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') {
        queueMicrotask(() => child.exit(null, signal));
      }
      return true;
    };
    const spawnImpl = () => {
      queueMicrotask(() => child.stdout.write('[openchamber-18080] start proxy success\n'));
      return child;
    };
    const controller = await startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile,
      stopGraceTimeoutMs: 5,
      stopForceTimeoutMs: 20,
      tempRoot,
      spawnImpl,
    });

    const stopping = controller.stop();
    expect(controller.isRunning()).toBe(true);
    await expect(stopping).resolves.toBe(true);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(controller.isRunning()).toBe(false);
  });

  it('keeps the controller active when termination cannot be confirmed', async () => {
    const child = new FakeChild();
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    const spawnImpl = () => {
      queueMicrotask(() => child.stdout.write('[openchamber-18080] start proxy success\n'));
      return child;
    };
    const controller = await startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token: 'secret',
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile,
      stopGraceTimeoutMs: 5,
      stopForceTimeoutMs: 5,
      tempRoot,
      spawnImpl,
    });

    await expect(controller.stop()).rejects.toThrow(/did not terminate/);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(controller.isRunning()).toBe(true);
    expect(controller.getPublicUrl()).toBe('https://app.example.com:18080');

    child.exit(0);
    expect(controller.isRunning()).toBe(false);
  });

  it('streams bounded redacted runtime diagnostics instead of retaining process output', async () => {
    const child = new FakeChild();
    const logs = [];
    const token = `runtime-${'s'.repeat(1000)}-secret`;
    const spawnImpl = () => {
      queueMicrotask(() => child.stdout.write('[openchamber-18080] start proxy success\n'));
      return child;
    };
    const controller = await startFrpcClient({
      binaryPath: path.join(tempRoot, 'frpc'),
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      token,
      localPort: 3000,
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
      trustedCaFile,
      tempRoot,
      spawnImpl,
      onLog: (stream, line) => logs.push({ stream, line }),
    });

    child.stderr.write(`prefix ${token.slice(0, 700)}`);
    child.stderr.write(`${token.slice(700)} suffix\n`);
    child.stderr.write(`boundary ${token.slice(0, 700)}`);
    child.stderr.write(`${token.slice(700)} ${'x'.repeat(700)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logs).toHaveLength(2);
    expect(logs[0].stream).toBe('stderr');
    expect(logs[0].line.length).toBeLessThanOrEqual(600);
    expect(logs[0].line).toContain('[redacted]');
    expect(logs[0].line).not.toContain(token);
    expect(logs[0].line).not.toContain('s'.repeat(100));
    expect(logs[1].line.length).toBeLessThanOrEqual(600);
    expect(logs[1].line).not.toContain(token);
    expect(logs[1].line).not.toContain('s'.repeat(100));
    child.stderr.write(token.slice(0, 700));
    await controller.stop();
    expect(logs).toHaveLength(2);
  });
});
