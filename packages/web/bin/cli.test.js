import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer } from 'http';
import net from 'net';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import { isModuleCliExecution, normalizeCliEntryPath } from './cli-entry.js';
import { requestJson } from './lib/cli-http.js';
import { getTunnelProfilesFilePath } from './lib/cli-paths.js';
import {
  createTunnelAutoStartOptions,
  FRPC_START_SERVER_BUDGET_MS,
  TUNNEL_START_REQUEST_TIMEOUT_MS,
  TUNNEL_STOP_REQUEST_TIMEOUT_MS,
} from './lib/commands-tunnel.js';
import { inspectTunnelAttachability } from './lib/cli-lifecycle.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './lib/cli-tunnel-capabilities.js';
import {
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_FRPC,
  TUNNEL_PROVIDER_NGROK,
} from '../server/lib/tunnels/types.js';
import {
  assertAuthenticatedNetworkExposure,
  commands,
  discoverOpenChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverRunningInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  ensureTunnelProfilesMigrated,
  generateCompletionScript,
  getInstanceFilePath,
  getPidFilePath,
  isOpenchamberCmdline,
  isOpenchamberProcessRunning,
  parseArgs,
  resolveServeHost,
} from './cli.js';

async function withTempOpenChamberDataDir(fn) {
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cli-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.OPENCHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockJsonResponse(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, callback) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function captureCommandOutput(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = (chunk, encoding, callback) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  process.stderr.write = (chunk, encoding, callback) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    let value;
    let error;
    try {
      value = await fn();
    } catch (caught) {
      error = caught;
    }
    return { stdout, stderr, value, error };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function runCliProcess(args, env = {}) {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stdout, stderr };
}

async function startMockOpenChamberServer(options = {}) {
  const runtime = options.runtime || 'web';
  const pid = Number.isFinite(options.pid) ? options.pid : null;
  let shutdownRequested = false;
  let tunnelStartBody = null;
  let tunnelTokenSyncBody = null;
  let closed = false;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/system/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runtime, pid }));
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/openchamber/tunnel/start' && options.tunnelStartResponse) {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        tunnelStartBody = JSON.parse(rawBody);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(options.tunnelStartResponse));
      });
      return;
    }

    if (req.method === 'PUT' && req.url === '/api/openchamber/tunnel/managed-remote-token' && options.tunnelTokenSyncResponse) {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        tunnelTokenSyncBody = JSON.parse(rawBody);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(options.tunnelTokenSyncResponse));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/openchamber/tunnel/stop' && options.tunnelStopResponse) {
      const status = Number.isInteger(options.tunnelStopStatus) ? options.tunnelStopStatus : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(options.tunnelStopResponse));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/system/shutdown') {
      shutdownRequested = true;
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ ok: true }));
      try {
        server.close(() => {
          closed = true;
        });
      } catch {
        closed = true;
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    get shutdownRequested() {
      return shutdownRequested;
    },
    get tunnelStartBody() {
      return tunnelStartBody;
    },
    get tunnelTokenSyncBody() {
      return tunnelTokenSyncBody;
    },
    close: async () => {
      if (closed || !server.listening) return;
      await new Promise((resolve) => {
        try {
          server.close(() => {
            closed = true;
            resolve();
          });
        } catch {
          closed = true;
          resolve();
        }
      });
    },
  };
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForTcpPort(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(250, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function spawnOpenChamberLikeIdleProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'openchamber-idle'], { stdio: 'ignore' });
}

function spawnOpenChamberLikeHungServer(port) {
  const script = `
    const net = require('net');
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(${port}, '127.0.0.1');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['-e', script, 'openchamber-hung-server'], { stdio: 'ignore' });
}

describe('cli args', () => {
  it('loads fallback tunnel provider capabilities for CLI startup', () => {
    expect(DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.map((provider) => provider.provider)).toEqual([
      TUNNEL_PROVIDER_CLOUDFLARE,
      TUNNEL_PROVIDER_FRPC,
      TUNNEL_PROVIDER_NGROK,
    ]);
  });

  it('parses FRPC server and remote mapping options', () => {
    const parsed = parseArgs([
      'tunnel', 'start',
      '--provider', 'frpc',
      '--frps-address', '203.0.113.10',
      '--frps-port', '7000',
      '--frps-ca-file', '/home/openchamber/frp/ca.crt',
      '--remote-port', '18080',
      '--public-url', 'https://app.example.com:18080',
    ]);

    expect(parsed.options).toMatchObject({
      provider: 'frpc',
      serverAddress: '203.0.113.10',
      serverPort: 7000,
      trustedCaFile: '/home/openchamber/frp/ca.crt',
      remotePort: 18080,
      publicUrl: 'https://app.example.com:18080',
    });
  });

  it('parses FRPC HTTP-vhost endpoint options', () => {
    const parsed = parseArgs([
      'tunnel', 'start',
      '--provider', 'frpc',
      '--frps-address', 'frps.example.com',
      '--frps-port', '7000',
      '--custom-domain', 'openchamber.internal',
      '--hostname', 'app.example.com',
    ]);

    expect(parsed.options).toMatchObject({
      provider: 'frpc',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      customDomain: 'openchamber.internal',
      hostname: 'app.example.com',
    });
    expect(parsed.options.remotePort).toBeUndefined();
  });

  it('allows the FRPC download deadline plus proxy startup before timing out', () => {
    expect(FRPC_START_SERVER_BUDGET_MS).toBe(120000 + 120000 + 20000);
    expect(TUNNEL_START_REQUEST_TIMEOUT_MS).toBe(FRPC_START_SERVER_BUDGET_MS + 40000);
    expect(TUNNEL_STOP_REQUEST_TIMEOUT_MS).toBe(317000);
  });

  it('silences nested server auto-start output in JSON and quiet tunnel flows', () => {
    expect(createTunnelAutoStartOptions({
      json: true,
      quiet: false,
      provider: 'frpc',
      mode: 'managed-remote',
      apiOnly: true,
    }, { port: 3003 })).toMatchObject({
      json: false,
      quiet: true,
      suppressQuietOutput: true,
      suppressStartupSummary: true,
      provider: 'frpc',
      mode: 'managed-remote',
      apiOnly: true,
      port: 3003,
    });
  });

  it('rejects a missing --custom-domain value', () => {
    expect(() => parseArgs(['tunnel', 'start', '--custom-domain'])).toThrow(/Missing value for --custom-domain/);
  });

  it('rejects missing explicit provider and mode values', () => {
    expect(() => parseArgs(['tunnel', 'start', '--provider'])).toThrow(/Missing value for --provider/);
    expect(() => parseArgs(['tunnel', 'start', '--mode'])).toThrow(/Missing value for --mode/);
  });

  it('renders parse-time provider and mode failures in the raw requested output mode', async () => {
    for (const args of [
      ['tunnel', 'start', '--json', '--provider'],
      ['tunnel', 'start', '--provider', '--json'],
      ['tunnel', 'start', '--json', '--mode'],
      ['tunnel', 'start', '--mode', '--json'],
    ]) {
      const result = await runCliProcess(args, { NO_COLOR: '1' });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'error',
        error: { message: expect.stringMatching(/Missing value for --(?:provider|mode)/) },
      });
    }

    for (const args of [
      ['tunnel', 'start', '--quiet', '--provider'],
      ['tunnel', 'start', '--mode', '-q'],
    ]) {
      const result = await runCliProcess(args, { NO_COLOR: '1' });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Missing value for --(?:provider|mode)/);
    }

    const nonTty = await runCliProcess(['tunnel', 'start', '--provider'], { NO_COLOR: '1' });
    expect(nonTty.code).toBe(2);
    expect(nonTty.stdout).toBe('');
    expect(nonTty.stderr).toMatch(/Missing value for --provider/);
  });

  it('includes FRPC endpoint and stop safety flags in bash, zsh, and fish completions', () => {
    expect(generateCompletionScript('bash')).toContain('--custom-domain');
    expect(generateCompletionScript('zsh')).toContain('--custom-domain');
    expect(generateCompletionScript('fish')).toContain('-l custom-domain');
    expect(generateCompletionScript('bash')).toContain('--public-url');
    expect(generateCompletionScript('zsh')).toContain('--public-url');
    expect(generateCompletionScript('fish')).toContain('-l public-url');
    expect(generateCompletionScript('bash')).toContain('--force');
    expect(generateCompletionScript('zsh')).toContain('--force');
    expect(generateCompletionScript('fish')).toContain('-l force');
  });

  it('accepts legacy daemon flags as no-ops', () => {
    expect(parseArgs(['serve', '--daemon']).removedFlagErrors).toEqual([]);
    expect(parseArgs(['serve', '-d']).removedFlagErrors).toEqual([]);
  });

  it('parses explicit connect-url server overrides', () => {
    const parsed = parseArgs(['connect-url', '--server', 'https://openchamber.example.com', '--port', '3002']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.server).toBe('https://openchamber.example.com');
    expect(parsed.options.port).toBe(3002);
  });

  it('parses connect-url server-url alias', () => {
    const parsed = parseArgs(['connect-url', '--server-url=http://homebridge:3002']);

    expect(parsed.options.server).toBe('http://homebridge:3002');
  });

  it('parses connect-url --relay flag', () => {
    const parsed = parseArgs(['connect-url', '--relay', '--name', 'My laptop']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.relay).toBe(true);
    expect(parsed.options.name).toBe('My laptop');
  });

  it('parses connect-url api-only help', () => {
    const parsed = parseArgs(['connect-url', '--api-only', '--help']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.helpRequested).toBe(true);
  });

  it('parses startup api-only option', () => {
    const parsed = parseArgs(['startup', 'enable', '--api-only', '--port', '3002']);

    expect(parsed.command).toBe('startup');
    expect(parsed.startupAction).toBe('enable');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.port).toBe(3002);
  });

  it('parses tunnel auto-start server options', () => {
    const parsed = parseArgs(['tunnel', 'start', '--port', '3002', '--api-only', '--lan', '--ui-password', 'secret']);

    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('start');
    expect(parsed.options.port).toBe(3002);
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.uiPassword).toBe('secret');
  });

  it('maps --lan to wildcard bind host', () => {
    const parsed = parseArgs(['serve', '--lan', '--port', '3002']);

    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.lan).toBe(true);
  });

  it('supports --hostname as top-level bind alias', () => {
    const parsed = parseArgs(['serve', '--hostname', '0.0.0.0']);

    expect(parsed.options.host).toBe('0.0.0.0');
  });

  it('keeps --hostname for tunnel commands', () => {
    const parsed = parseArgs(['tunnel', 'start', '--hostname', 'app.example.com']);

    expect(parsed.options.hostname).toBe('app.example.com');
    expect(parsed.options.host).toBeUndefined();
  });
});

describe('network-exposed auth validation', () => {
  it('allows loopback without a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '127.0.0.1' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: 'localhost' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: '::1' })).not.toThrow();
  });

  it('requires a UI password for LAN and wildcard bind hosts', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).toThrow(/refuses to bind/);
    expect(() => assertAuthenticatedNetworkExposure({ host: '192.168.1.10' })).toThrow(/refuses to bind/);
  });

  it('allows network-exposed bind hosts with a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0', uiPassword: 'secret' })).not.toThrow();
  });

  it('allows explicit unsafe LAN override from process env only', () => {
    const previous = process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
    process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = 'true';
    try {
      expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).not.toThrow();
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = previous;
      } else {
        delete process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
      }
    }
  });
});

describe('serve host resolution', () => {
  it('uses OPENCHAMBER_HOST when --host is not provided', () => {
    const previous = process.env.OPENCHAMBER_HOST;
    process.env.OPENCHAMBER_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost(undefined)).toBe('192.0.2.20');
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_HOST = previous;
      } else {
        delete process.env.OPENCHAMBER_HOST;
      }
    }
  });

  it('prefers explicit --host over OPENCHAMBER_HOST', () => {
    const previous = process.env.OPENCHAMBER_HOST;
    process.env.OPENCHAMBER_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost('192.0.2.21')).toBe('192.0.2.21');
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_HOST = previous;
      } else {
        delete process.env.OPENCHAMBER_HOST;
      }
    }
  });
});

describe('compatibility exports', () => {
  it('allows tunnel profile migration before command options are initialized', async () => {
    await withTempOpenChamberDataDir(async () => {
      const store = ensureTunnelProfilesMigrated();

      expect(store).toEqual({ version: 2, profiles: [] });
    });
  });

  it('includes ngrok in fallback tunnel providers when no server is reachable', async () => {
    await withTempOpenChamberDataDir(async () => {
      const output = await captureStdout(async () => {
        await commands.tunnel({ json: true }, 'providers');
      });

      const body = JSON.parse(output);
      expect(body.source).toBe('fallback');
      expect(body.providers.map((entry) => entry.provider)).toContain('ngrok');
    });
  });

  it('supports ngrok quick dry-run with an explicit port', async () => {
    await withTempOpenChamberDataDir(async () => {
      const output = await captureStdout(async () => {
        await commands.tunnel({
          json: true,
          dryRun: true,
          explicitPort: true,
          port: 3003,
          provider: 'ngrok',
          mode: 'quick',
        }, 'start');
      });

      const body = JSON.parse(output);
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        dryRun: true,
        provider: 'ngrok',
        mode: 'quick',
      }));
    });
  });

  it('uses the CLI ownership id when syncing and starting a Cloudflare profile', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const tokenFile = path.join(dir, 'cloudflare-token');
      fs.writeFileSync(tokenFile, 'cloudflare-secret', { mode: 0o600 });
      const addOutput = await captureStdout(() => commands.tunnel({
        provider: 'cloudflare',
        mode: 'managed-remote',
        name: 'cloudflare-main',
        hostname: 'cli.example.com',
        tokenFile,
        json: true,
      }, 'profile', 'add'));
      const profile = JSON.parse(addOutput).profile;
      const ownedId = `cli-profile:${profile.id}`;
      const server = await startMockOpenChamberServer({
        runtime: 'web',
        pid: process.pid,
        tunnelTokenSyncResponse: { ok: true },
        tunnelStartResponse: {
          ok: true,
          provider: 'cloudflare',
          mode: 'managed-remote',
          url: 'https://cli.example.com',
        },
      });
      fs.writeFileSync(await getPidFilePath(server.port), String(process.pid));
      fs.writeFileSync(await getInstanceFilePath(server.port), JSON.stringify({
        port: server.port,
        pid: process.pid,
        runtime: 'web',
        launchMode: 'daemon',
      }));

      try {
        await captureStdout(() => commands.tunnel({
          profile: 'cloudflare-main',
          explicitPort: true,
          port: server.port,
          json: true,
        }, 'start'));

        expect(server.tunnelTokenSyncBody).toMatchObject({ presetId: ownedId });
        expect(server.tunnelStartBody).toMatchObject({
          managedRemoteTunnelPresetId: ownedId,
          managedRemoteTunnelPresetName: 'cloudflare-main',
        });
      } finally {
        await server.close();
      }
    });
  });

  it('rejects explicit unknown providers and unsupported provider modes in every output mode', async () => {
    for (const outputMode of [{}, { quiet: true }, { json: true }]) {
      await expect(commands.tunnel({
        ...outputMode,
        dryRun: true,
        explicitPort: true,
        port: 3003,
        provider: 'invalid-provider',
        mode: 'quick',
      }, 'start')).rejects.toMatchObject({
        name: 'TunnelCliError',
        exitCode: 2,
        message: expect.stringMatching(/Unsupported tunnel provider/),
      });
      await expect(commands.tunnel({
        ...outputMode,
        dryRun: true,
        explicitPort: true,
        port: 3003,
        provider: 'frpc',
        mode: 'quick',
      }, 'start')).rejects.toMatchObject({
        name: 'TunnelCliError',
        exitCode: 2,
        message: expect.stringMatching(/does not support mode/),
      });
    }
    await expect(commands.tunnel({
      json: true,
      provider: 'invalid-provider',
    }, 'status')).rejects.toMatchObject({
      name: 'TunnelCliError',
      exitCode: 2,
    });
  });

  it('keeps invalid-provider errors JSON-only and quiet-output safe at the CLI boundary', () => {
    const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
    const jsonResult = spawnSync(process.execPath, [
      cliPath,
      'tunnel',
      'start',
      '--provider',
      'invalid-provider',
      '--mode',
      'quick',
      '--dry-run',
      '--json',
    ], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const quietResult = spawnSync(process.execPath, [
      cliPath,
      'tunnel',
      'start',
      '--provider',
      'invalid-provider',
      '--mode',
      'quick',
      '--dry-run',
      '--quiet',
    ], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const modeJsonResult = spawnSync(process.execPath, [
      cliPath,
      'tunnel',
      'start',
      '--json',
      '--provider',
      'cloudflare',
      '--mode',
      'invalid-mode',
      '--dry-run',
    ], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const nonTtyResult = spawnSync(process.execPath, [
      cliPath,
      'tunnel',
      'start',
      '--provider',
      'invalid-provider',
      '--dry-run',
    ], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    expect(jsonResult.status).toBe(2);
    expect(jsonResult.stderr).toBe('');
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      status: 'error',
      error: { message: expect.stringMatching(/Unsupported tunnel provider/) },
    });
    expect(quietResult.status).toBe(2);
    expect(quietResult.stdout).toBe('');
    expect(quietResult.stderr).toMatch(/Unsupported tunnel provider/);
    expect(modeJsonResult.status).toBe(2);
    expect(modeJsonResult.stderr).toBe('');
    expect(JSON.parse(modeJsonResult.stdout)).toMatchObject({
      status: 'error',
      error: { message: expect.stringMatching(/Unsupported tunnel mode/) },
    });
    expect(nonTtyResult.status).toBe(2);
    expect(nonTtyResult.stdout).toBe('');
    expect(nonTtyResult.stderr).toMatch(/Unsupported tunnel provider/);
  });
});

describe('tunnel stop safety and exit semantics', () => {
  it('requires --force for stop --all outside interactive human mode', async () => {
    for (const outputMode of [{ json: true }, { quiet: true }]) {
      await expect(commands.tunnel({ all: true, ...outputMode }, 'stop')).rejects.toMatchObject({
        name: 'TunnelCliError',
        exitCode: 2,
        message: expect.stringMatching(/requires --force/),
      });
    }

    const jsonResult = await runCliProcess(['tunnel', 'stop', '--all', '--json'], { NO_COLOR: '1' });
    expect(jsonResult.code).toBe(2);
    expect(jsonResult.stderr).toBe('');
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      status: 'error',
      error: { message: expect.stringMatching(/requires --force/) },
    });

    const nonInteractiveResult = await runCliProcess(['tunnel', 'stop', '--all'], { NO_COLOR: '1' });
    expect(nonInteractiveResult.code).toBe(2);
    expect(nonInteractiveResult.stdout).toBe('');
    expect(nonInteractiveResult.stderr).toMatch(/requires --force/);
  });

  it('reports every partial stop result before returning failure in JSON, quiet, and human modes', async () => {
    await withTempOpenChamberDataDir(async () => {
      const successServer = await startMockOpenChamberServer({
        pid: process.pid,
        tunnelStopResponse: { ok: true, revokedBootstrapCount: 1, invalidatedSessionCount: 2 },
      });
      const failureServer = await startMockOpenChamberServer({
        pid: process.pid,
        tunnelStopStatus: 500,
        tunnelStopResponse: { ok: false, error: 'simulated stop failure' },
      });
      try {
        for (const server of [successServer, failureServer]) {
          fs.writeFileSync(await getPidFilePath(server.port), String(process.pid));
          fs.writeFileSync(await getInstanceFilePath(server.port), JSON.stringify({
            port: server.port,
            host: '127.0.0.1',
            launchMode: 'daemon',
          }, null, 2));
        }

        const jsonResult = await captureCommandOutput(() => commands.tunnel({
          all: true,
          force: true,
          json: true,
        }, 'stop'));
        expect(jsonResult.error).toMatchObject({
          name: 'TunnelCliError',
          exitCode: 5,
          reported: true,
        });
        expect(jsonResult.stderr).toBe('');
        const jsonPayload = JSON.parse(jsonResult.stdout);
        expect(jsonPayload).toMatchObject({ status: 'error', ok: false });
        expect(jsonPayload.instances).toHaveLength(2);
        expect(jsonPayload.instances).toEqual(expect.arrayContaining([
          expect.objectContaining({ port: successServer.port, result: expect.objectContaining({ ok: true }) }),
          expect.objectContaining({ port: failureServer.port, error: 'simulated stop failure' }),
        ]));

        const quietResult = await captureCommandOutput(() => commands.tunnel({
          all: true,
          force: true,
          quiet: true,
        }, 'stop'));
        expect(quietResult.error).toMatchObject({ exitCode: 5, reported: true });
        expect(quietResult.stdout).toContain(`port ${successServer.port} stopped`);
        expect(quietResult.stderr).toContain(`port ${failureServer.port} failed: simulated stop failure`);

        const humanResult = await captureCommandOutput(() => commands.tunnel({
          all: true,
          force: true,
          plain: true,
        }, 'stop'));
        expect(humanResult.error).toMatchObject({ exitCode: 5, reported: true });
        expect(`${humanResult.stdout}${humanResult.stderr}`).toContain(`port ${successServer.port} stopped`);
        expect(`${humanResult.stdout}${humanResult.stderr}`).toContain(`port ${failureServer.port} failed`);
      } finally {
        await successServer.close();
        await failureServer.close();
      }
    });
  });

  it('exits non-zero with one JSON document for a single stop failure', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const server = await startMockOpenChamberServer({
        pid: process.pid,
        tunnelStopStatus: 500,
        tunnelStopResponse: { ok: false, error: 'single stop failure' },
      });
      try {
        fs.writeFileSync(await getPidFilePath(server.port), String(process.pid));
        fs.writeFileSync(await getInstanceFilePath(server.port), JSON.stringify({
          port: server.port,
          host: '127.0.0.1',
          launchMode: 'daemon',
        }, null, 2));

        const result = await runCliProcess([
          'tunnel',
          'stop',
          '--port',
          String(server.port),
          '--json',
        ], {
          OPENCHAMBER_DATA_DIR: dir,
          NO_COLOR: '1',
        });

        expect(result.code).toBe(5);
        expect(result.stderr).toBe('');
        const payload = JSON.parse(result.stdout);
        expect(payload).toMatchObject({ status: 'error', ok: false });
        expect(payload.instances).toEqual([
          expect.objectContaining({ port: server.port, error: 'single stop failure' }),
        ]);
      } finally {
        await server.close();
      }
    });
  });
});

describe('FRPC endpoint CLI', () => {
  it('rejects mixed and incomplete endpoints in normal, quiet, JSON, and dry-run modes', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const tokenFile = path.join(dir, 'frpc-token');
      const trustedCaFile = path.join(dir, 'frps-ca.crt');
      fs.writeFileSync(tokenFile, 'not-a-secret', { mode: 0o600 });
      fs.writeFileSync(trustedCaFile, 'test-ca', { mode: 0o600 });
      const outputModes = [
        {},
        { quiet: true },
        { json: true },
        { dryRun: true },
        { quiet: true, dryRun: true },
        { json: true, dryRun: true },
      ];

      for (const outputMode of outputModes) {
        const startBase = {
          provider: 'frpc',
          mode: 'managed-remote',
          serverAddress: 'frps.example.com',
          serverPort: 7000,
          trustedCaFile,
          tokenFile,
          explicitPort: true,
          port: 3000,
          ...outputMode,
        };
        await expect(commands.tunnel({
          ...startBase,
          remotePort: 18080,
          customDomain: 'openchamber.internal',
          hostname: 'app.example.com',
        }, 'start')).rejects.toThrow(/mutually exclusive/);
        await expect(commands.tunnel({
          ...startBase,
          customDomain: 'openchamber.internal',
        }, 'start')).rejects.toThrow(/requires both --custom-domain.*--hostname/);

        const profileBase = {
          provider: 'frpc',
          mode: 'managed-remote',
          name: 'http-main',
          serverAddress: 'frps.example.com',
          serverPort: 7000,
          trustedCaFile,
          tokenFile,
          ...outputMode,
        };
        await expect(commands.tunnel({
          ...profileBase,
          remotePort: 18080,
          customDomain: 'openchamber.internal',
          hostname: 'app.example.com',
        }, 'profile', 'add')).rejects.toThrow(/mutually exclusive/);
        await expect(commands.tunnel({
          ...profileBase,
          hostname: 'app.example.com',
        }, 'profile', 'add')).rejects.toThrow(/requires both --custom-domain.*--hostname/);
      }
    });
  });

  it('requires and canonicalizes an externally terminated HTTPS origin for TCP', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const tokenFile = path.join(dir, 'frpc-token');
      const trustedCaFile = path.join(dir, 'frps-ca.crt');
      fs.writeFileSync(tokenFile, 'not-a-secret', { mode: 0o600 });
      fs.writeFileSync(trustedCaFile, 'test-ca', { mode: 0o600 });
      const base = {
        provider: 'frpc',
        mode: 'managed-remote',
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile,
        remotePort: 18080,
        tokenFile,
        explicitPort: true,
        port: 3000,
        dryRun: true,
        json: true,
      };

      for (const publicUrl of [undefined, 'http://app.example.com:18080', 'https://app.example.com:18080/path', 'not a URL']) {
        await expect(commands.tunnel({ ...base, publicUrl }, 'start')).rejects.toMatchObject({
          name: 'TunnelCliError',
          exitCode: 2,
          message: expect.stringMatching(/public-url/),
        });
      }

      const output = await captureStdout(() => commands.tunnel({
        ...base,
        publicUrl: 'HTTPS://App.Example.com:18080/',
      }, 'start'));
      expect(JSON.parse(output)).toMatchObject({
        remotePort: 18080,
        publicUrl: 'https://app.example.com:18080',
      });
    });
  });

  it('fails a legacy TCP profile without guessing a browser URL', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const trustedCaFile = path.join(dir, 'frps-ca.crt');
      fs.writeFileSync(trustedCaFile, 'test-ca', { mode: 0o600 });
      const profilesPath = getTunnelProfilesFilePath();
      fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
      fs.writeFileSync(profilesPath, JSON.stringify({
        version: 2,
        profiles: [{
          id: 'legacy-tcp',
          name: 'legacy-tcp',
          provider: 'frpc',
          mode: 'managed-remote',
          serverAddress: 'frps.example.com',
          serverPort: 7000,
          trustedCaFile,
          remotePort: 18080,
          token: 'not-a-secret',
          createdAt: 1,
          updatedAt: 1,
        }],
      }), { mode: 0o600 });

      await expect(commands.tunnel({
        profile: 'legacy-tcp',
        explicitPort: true,
        port: 3000,
        dryRun: true,
        json: true,
      }, 'start')).rejects.toMatchObject({
        name: 'TunnelCliError',
        exitCode: 2,
        message: expect.stringMatching(/public-url/),
      });
    });
  });

  it('emits canonical HTTP-vhost dry-run JSON without exposing the token', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const tokenFile = path.join(dir, 'frpc-token');
      const trustedCaFile = path.join(dir, 'frps-ca.crt');
      fs.writeFileSync(tokenFile, 'not-a-secret', { mode: 0o600 });
      fs.writeFileSync(trustedCaFile, 'test-ca', { mode: 0o600 });

      const output = await captureStdout(() => commands.tunnel({
        provider: 'frpc',
        mode: 'managed-remote',
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile,
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        tokenFile,
        explicitPort: true,
        port: 3000,
        dryRun: true,
        json: true,
      }, 'start'));

      expect(JSON.parse(output)).toEqual(expect.objectContaining({
        ok: true,
        dryRun: true,
        provider: 'frpc',
        mode: 'managed-remote',
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        remotePort: null,
        hasToken: true,
      }));
      expect(output).not.toContain('not-a-secret');
    });
  });

  it('continues to reject inline FRPC tokens', async () => {
    await expect(commands.tunnel({
      provider: 'frpc',
      mode: 'managed-remote',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      remotePort: 18080,
      token: 'not-a-secret',
      explicitPort: true,
      port: 3000,
      dryRun: true,
      json: true,
    }, 'start')).rejects.toThrow(/FRPC tokens cannot be passed with --token/);
  });

  it('rejects an explicit invalid FRPS address before a saved profile can replace it in every output mode', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const tokenFile = path.join(dir, 'frpc-token');
      const trustedCaFile = path.join(dir, 'frps-ca.crt');
      fs.writeFileSync(tokenFile, 'not-a-secret', { mode: 0o600 });
      fs.writeFileSync(trustedCaFile, 'test-ca', { mode: 0o600 });
      await captureStdout(() => commands.tunnel({
        provider: 'frpc',
        mode: 'managed-remote',
        name: 'saved-frpc',
        serverAddress: 'frps.example.com',
        serverPort: 7000,
          trustedCaFile,
          remotePort: 18080,
          publicUrl: 'https://saved.example.com:18080',
          tokenFile,
        json: true,
      }, 'profile', 'add'));

      for (const outputMode of [
        {},
        { quiet: true },
        { json: true },
        { dryRun: true },
        { quiet: true, dryRun: true },
        { json: true, dryRun: true },
      ]) {
        await expect(commands.tunnel({
          profile: 'saved-frpc',
          serverAddress: 'https://invalid.example.com',
          explicitPort: true,
          port: 3000,
          ...outputMode,
        }, 'start')).rejects.toMatchObject({
          name: 'TunnelCliError',
          exitCode: 2,
          message: expect.stringMatching(/Invalid --frps-address/),
        });
      }
    });
  });

  it('requires a readable trusted CA file for FRPS identity verification', async () => {
    await expect(commands.tunnel({
      provider: 'frpc',
      mode: 'managed-remote',
      serverAddress: 'frps.example.com',
      serverPort: 7000,
      remotePort: 18080,
      explicitPort: true,
      port: 3000,
      dryRun: true,
      json: true,
    }, 'start')).rejects.toThrow(/frps-ca-file/);
  });

  it('round-trips HTTP-vhost profile add, list, show, and selected-profile start', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const tokenFile = path.join(dir, 'frpc-token');
      const trustedCaFile = path.join(dir, 'frps-ca.crt');
      fs.writeFileSync(tokenFile, 'not-a-secret', { mode: 0o600 });
      fs.writeFileSync(trustedCaFile, 'test-ca', { mode: 0o600 });
      const addOptions = {
        provider: 'frpc',
        mode: 'managed-remote',
        name: 'http-main',
        serverAddress: 'frps.example.com',
        serverPort: 7000,
        trustedCaFile,
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        tokenFile,
        json: true,
      };

      const dryRunOutput = await captureStdout(() => commands.tunnel({
        ...addOptions,
        dryRun: true,
      }, 'profile', 'add'));
      const dryRunProfile = JSON.parse(dryRunOutput).profile;
      expect(dryRunProfile).toEqual(expect.objectContaining({
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        hasToken: true,
      }));
      expect(dryRunProfile).not.toHaveProperty('remotePort');
      expect(dryRunOutput).not.toContain('not-a-secret');

      const addOutput = await captureStdout(() => commands.tunnel(addOptions, 'profile', 'add'));
      const added = JSON.parse(addOutput).profile;
      expect(added).toEqual(expect.objectContaining({
        name: 'http-main',
        provider: 'frpc',
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        hasToken: true,
      }));
      expect(added).not.toHaveProperty('remotePort');
      expect(addOutput).not.toContain('not-a-secret');

      const listOutput = await captureStdout(() => commands.tunnel({ json: true }, 'profile', 'list'));
      const listed = JSON.parse(listOutput).profiles[0];
      expect(listed).toEqual(expect.objectContaining({
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
      }));
      expect(listed).not.toHaveProperty('remotePort');

      const showOutput = await captureStdout(() => commands.tunnel({
        json: true,
        name: 'http-main',
        provider: 'frpc',
      }, 'profile', 'show'));
      expect(JSON.parse(showOutput).profile).toEqual(expect.objectContaining({
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        hasToken: true,
      }));
      expect(showOutput).not.toContain('not-a-secret');

      const quietOutput = await captureStdout(() => commands.tunnel({ quiet: true }, 'profile', 'list'));
      expect(quietOutput).toContain('http:openchamber.internal public:app.example.com');
      expect(quietOutput).not.toContain('not-a-secret');

      const startOutput = await captureStdout(() => commands.tunnel({
        profile: 'http-main',
        explicitPort: true,
        port: 3000,
        dryRun: true,
        json: true,
      }, 'start'));
      expect(JSON.parse(startOutput)).toEqual(expect.objectContaining({
        profile: 'http-main',
        customDomain: 'openchamber.internal',
        hostname: 'app.example.com',
        remotePort: null,
      }));

      const tcpOverrideOutput = await captureStdout(() => commands.tunnel({
        profile: 'http-main',
        remotePort: 19090,
        publicUrl: 'https://tcp.example.com:19090',
        explicitPort: true,
        port: 3000,
        dryRun: true,
        json: true,
      }, 'start'));
      expect(JSON.parse(tcpOverrideOutput)).toEqual(expect.objectContaining({
        remotePort: 19090,
        publicUrl: 'https://tcp.example.com:19090',
        customDomain: null,
        hostname: null,
      }));
    });
  });

  it('sends a canonical run-once HTTP-vhost payload and safe replay command', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const server = await startMockOpenChamberServer({
        runtime: 'web',
        pid: process.pid,
        tunnelStartResponse: {
          ok: true,
          provider: 'frpc',
          mode: 'managed-remote',
          url: 'https://app.example.com',
        },
      });
      const tokenFile = path.join(dir, 'frpc-token');
      const trustedCaFile = path.join(dir, 'frps-ca.crt');
      fs.writeFileSync(tokenFile, 'not-a-secret', { mode: 0o600 });
      fs.writeFileSync(trustedCaFile, 'test-ca', { mode: 0o600 });
      fs.writeFileSync(await getPidFilePath(server.port), String(process.pid));
      fs.writeFileSync(await getInstanceFilePath(server.port), JSON.stringify({
        port: server.port,
        pid: process.pid,
        runtime: 'web',
        launchMode: 'daemon',
      }));

      try {
        const output = await captureStdout(() => commands.tunnel({
          provider: 'frpc',
          mode: 'managed-remote',
          serverAddress: 'frps.example.com',
          serverPort: 7000,
          trustedCaFile,
          customDomain: 'openchamber.internal',
          hostname: 'app.example.com',
          tokenFile,
          explicitPort: true,
          port: server.port,
          json: true,
        }, 'start'));

        expect(server.tunnelStartBody).toEqual({
          provider: 'frpc',
          mode: 'managed-remote',
          token: 'not-a-secret',
          serverAddress: 'frps.example.com',
          serverPort: 7000,
          trustedCaFile,
          customDomain: 'openchamber.internal',
          hostname: 'app.example.com',
        });
        expect(server.tunnelStartBody).not.toHaveProperty('remotePort');

        const result = JSON.parse(output);
        expect(result.customDomain).toBe('openchamber.internal');
        expect(result.hostname).toBe('app.example.com');
        expect(result).not.toHaveProperty('remotePort');
        expect(result.replayCommand).toContain('--custom-domain openchamber.internal');
        expect(result.replayCommand).toContain('--hostname app.example.com');
        expect(result.replayCommand).not.toContain('--remote-port');
        expect(output).not.toContain('not-a-secret');
      } finally {
        await server.close();
      }
    });
  });
});

describe('CLI HTTP helpers', () => {
  it('retries UI-authenticated API requests with the stored instance password', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45678;
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, uiPassword: 'secret' }, null, 2));
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/auth/session')) {
          expect(JSON.parse(options.body)).toEqual({ password: 'secret' });
          return {
            ok: true,
            headers: { get: (name) => name.toLowerCase() === 'set-cookie' ? 'oc_ui_session=session-token; Path=/; HttpOnly' : null },
            json: async () => ({ authenticated: true }),
          };
        }
        if (options.headers?.Cookie === 'oc_ui_session=session-token') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'UI authentication required', locked: true }),
        };
      };

      try {
        const { response, body } = await requestJson(port, '/api/openchamber/tunnel/start', {
          method: 'POST',
          body: JSON.stringify({ provider: 'ngrok', mode: 'quick' }),
        });

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          '/api/openchamber/tunnel/start',
          '/auth/session',
          '/api/openchamber/tunnel/start',
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('cli entry detection', () => {
  const modulePath = '/tmp/openchamber/bin/cli.js';
  const moduleUrl = pathToFileURL(modulePath).href;

  it('resolves symlinked entry paths before comparing', () => {
    const symlinkPath = '/usr/local/bin/openchamber';
    const realpath = (filePath) => {
      if (filePath === path.resolve(symlinkPath)) {
        return modulePath;
      }
      return filePath;
    };

    expect(isModuleCliExecution(symlinkPath, moduleUrl, realpath)).toBe(true);
  });

  it('falls back to resolved paths when realpath fails', () => {
    const realpath = () => {
      throw new Error('realpath unavailable');
    };

    expect(isModuleCliExecution(modulePath, moduleUrl, realpath)).toBe(true);
  });

  it('returns false for non-matching entry path', () => {
    expect(isModuleCliExecution('/tmp/other-cli.js', moduleUrl)).toBe(false);
  });

  it('returns false for empty entry path', () => {
    expect(isModuleCliExecution('', moduleUrl)).toBe(false);
  });

  it('returns false when module url is not provided', () => {
    expect(isModuleCliExecution(modulePath)).toBe(false);
  });

  it('accepts wrapper binary name fallback when requested', () => {
    const wrapperPath = '/home/user/.local/bin/openchamber';
    expect(isModuleCliExecution(wrapperPath, moduleUrl, undefined, 'openchamber')).toBe(true);
  });

  it('normalizes direct paths when realpath fails', () => {
    const unresolvedPath = './packages/web/bin/cli.js';
    const realpath = () => {
      throw new Error('no symlink resolution');
    };

    expect(normalizeCliEntryPath(unresolvedPath, realpath)).toBe(path.resolve(unresolvedPath));
  });
});

describe('isOpenchamberCmdline', () => {
  it('accepts OpenChamber CLI and daemon cmdlines', () => {
    expect(isOpenchamberCmdline('node /x/@openchamber/web/bin/cli.js serve')).toBe(true);
    expect(isOpenchamberCmdline('node /x/@openchamber/web/server/index.js --port 9090')).toBe(true);
    expect(isOpenchamberCmdline('bun /home/u/projects/openchamber/packages/web/server/index.js --port 3001')).toBe(true);
  });

  it('rejects recycled and unrelated processes (issue #1721)', () => {
    expect(isOpenchamberCmdline('node /home/herjarsa/npm-global/bin/agentmemory')).toBe(false);
    expect(isOpenchamberCmdline('node /usr/lib/node_modules/npm/bin/npm-cli.js install')).toBe(false);
    expect(isOpenchamberCmdline('')).toBe(false);
    expect(isOpenchamberCmdline(null)).toBe(false);
  });
});

describe('isOpenchamberProcessRunning', () => {
  it('returns false for a dead PID', () => {
    expect(isOpenchamberProcessRunning(2147483646)).toBe(false);
  });

  // Identity verification is available on Linux (/proc) and macOS (ps); on those
  // platforms a live but unrelated process (a recycled stale PID) must read as
  // not-running so it can't trip the "already running" guard (issue #1721).
  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'returns false for a live non-OpenChamber PID',
    async () => {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(isOpenchamberProcessRunning(child.pid)).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    }
  );
});

describe('lifecycle instance discovery', () => {
  it('does not attribute a desktop runtime response to a different explicit port', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverOpenChamberInstanceOnPort(3003, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toBeNull();
    });
  });

  it('attributes a desktop runtime response to its configured desktop port', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverOpenChamberInstanceOnPort(57123, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toEqual(expect.objectContaining({
        port: 57123,
        pid: 934,
        runtime: 'desktop',
      }));
    });
  });

  it('does not mark tunnel attachability as desktop for a different explicit port', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 });
      try {
        const attachability = await inspectTunnelAttachability(3004, { requireHealthy: false });

        expect(attachability.reason).not.toBe('desktop');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('keeps pid and instance files when live port probe confirms a cmdline mismatch', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45123;
      const pid = 12345;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon', startedAt: 123 }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid }),
        getOpenchamberProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('removes stale pid and instance files when a cmdline mismatch is not confirmed by live probe', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45124;
      const pid = 12346;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(instanceFile)).toBe(false);
    });
  });

  it('preserves matched pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45126;
      const pid = 12347;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'matched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('preserves unknown-identity pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45129;
      const pid = 12350;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'unknown',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('uses the live system-info pid instead of a stale OpenChamber-looking pid-file pid', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45127;
      const stalePid = 12348;
      const livePid = 54321;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(stalePid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: livePid }),
        getOpenchamberProcessState: () => 'matched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: livePid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('uses the explicit host when probing a pid-file entry without a stored host', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45128;
      const pid = 12349;
      const host = '192.0.2.10';
      const urls = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return createMockJsonResponse({ runtime: 'web', pid });
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(new URL(urls[0]).hostname).toBe(host);
    });
  });

  it('tries loopback before treating an explicit-host pid-file probe as inconclusive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45130;
      const pid = 12351;
      const host = '192.0.2.11';
      const urls = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid })
              : createMockJsonResponse(null, false);
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(urls.map((url) => new URL(url).hostname)).toContain(host);
      expect(urls.map((url) => new URL(url).hostname)).toContain('127.0.0.1');
      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('does not accept a fallback loopback probe with a different pid for a concrete host registry', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45131;
      const pid = 12352;
      const otherPid = 54322;
      const host = '192.0.2.12';
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, host, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid: otherPid })
              : createMockJsonResponse(null, false);
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('discovers an explicit live OpenChamber port without a pid-file registry entry', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45125;
      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port },
        { fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: null }) },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: null, runtime: 'web', source: 'probe' }),
      ]);
    });
  });

  it('cleans a matched pid-file entry without stopping it when the recorded port is free', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnOpenChamberLikeIdleProcess();
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        const instance = await discoverUnconfirmedRegistryInstanceOnPort(port, { host: '127.0.0.1' });

        expect(instance).toBeNull();
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});

describe('lifecycle commands with unmanaged explicit ports', () => {
  it('serve refuses to start on a live OpenChamber port without requiring pid files', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      try {
        await expect(commands.serve({ explicitPort: true, port: server.port, quiet: true })).rejects.toThrow(
          /already running on port/
        );
      } finally {
        await server.close();
      }
    });
  });

  it('status --port reports a live unmanaged server when the registry is empty', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      try {
        const output = await captureStdout(() => commands.status({ explicitPort: true, port: server.port, json: true }));
        const payload = JSON.parse(output);
        expect(payload.state).toBe('running');
        expect(payload.runningCount).toBe(1);
        expect(payload.instances).toEqual([
          expect.objectContaining({ runtime: 'unmanaged', port: server.port, pid: null }),
        ]);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port reaches unmanaged shutdown when the registry is empty', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      try {
        await commands.stop({ explicitPort: true, port: server.port, quiet: true, suppressQuietOutput: true });
        expect(server.shutdownRequested).toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port can recover a matched pid-file instance whose HTTP endpoint is unresponsive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnOpenChamberLikeHungServer(port);
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        expect(await waitForTcpPort(port)).toBe(true);
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        await commands.stop({ explicitPort: true, port, host: '127.0.0.1', quiet: true, suppressQuietOutput: true });

        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  it('plain stop ignores a stale CLI registry entry that resolves to desktop runtime', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer({ runtime: 'desktop' });
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      const pidFile = await getPidFilePath(server.port);
      const instanceFile = await getInstanceFilePath(server.port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port: server.port, launchMode: 'daemon' }, null, 2));

        await commands.stop({ quiet: true, suppressQuietOutput: true });

        expect(server.shutdownRequested).toBe(false);
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
      } finally {
        child.kill('SIGKILL');
        await server.close();
      }
    });
  });

  it('restart --port restarts a live unmanaged server through the shared explicit-port discovery path', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      const calls = [];
      const host = '127.0.0.1';
      try {
        const output = await captureStdout(() => commands.restart.call({
          stop: async (options) => {
            calls.push(['stop', options.port, options.host]);
          },
          serve: async (options) => {
            calls.push(['serve', options.port, options.host]);
            return options.port;
          },
        }, { explicitPort: true, port: server.port, host, json: true }));

        const payload = JSON.parse(output);
        expect(calls).toEqual([
          ['stop', server.port, host],
          ['serve', server.port, host],
        ]);
        expect(payload.restartedCount).toBe(1);
        expect(payload.results).toEqual([
          expect.objectContaining({ fromPort: server.port, toPort: server.port, ok: true }),
        ]);
      } finally {
        await server.close();
      }
    });
  });
});
