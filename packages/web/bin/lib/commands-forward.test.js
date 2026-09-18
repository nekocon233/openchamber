import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDevTunnelRuntime } from '../../server/lib/dev-tunnel/runtime.js';

/**
 * These run the whole command: a dev server, an OpenChamber host with the real
 * tunnel runtime, and the CLI in a child process. The forward exists to make a
 * page load, so the test loads one through it — anything short of that would
 * not prove the part that matters.
 */

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const TOKEN = 'test-client-token';

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const track = (server) => {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
};

const startDevServer = async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`dev:${req.url}`);
  });
  track(server);
  return listen(server);
};

/**
 * @param {{ devPort: number|null, acceptToken?: boolean, discoveryOk?: boolean }} options
 */
const startHost = async ({ devPort, acceptToken = true, discoveryOk = true }) => {
  const servers = devPort === null ? [] : [{ port: devPort, url: `http://localhost:${devPort}/`, command: 'vite' }];
  const discover = async () => (discoveryOk ? { ok: true, servers } : { ok: false, reason: 'no-listener-source' });

  const server = http.createServer(async (req, res) => {
    if (!new URL(req.url, 'http://x').pathname.startsWith('/api/dev-servers')) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}` || !acceptToken) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'UI authentication required' }));
      return;
    }
    const result = await discover();
    if (!result.ok) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Port discovery is unavailable', reason: result.reason }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ servers: result.servers }));
  });
  track(server);

  createDevTunnelRuntime({
    server,
    discoverDevServers: discover,
    uiAuthController: {
      enabled: true,
      resolveAuthContext: async (req) => (
        req.headers.authorization === `Bearer ${TOKEN}` ? { type: 'client' } : null
      ),
    },
    isRequestOriginAllowed: async () => false,
    rejectWebSocketUpgrade: (socket, status, message) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
      socket.destroy();
    },
    logger: { warn: () => {} },
  });

  return listen(server);
};

/** Runs the CLI until it prints something matching `ready`, or exits. */
const runForward = (args, { ready } = {}) => new Promise((resolve, reject) => {
  const child = spawn('node', [CLI, 'forward', ...args], {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`timed out; stdout=${stdout} stderr=${stderr}`));
  }, 20_000);

  cleanups.push(async () => { child.kill('SIGKILL'); });

  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    if (ready && ready.test(stdout)) finish({ stdout, stderr, child, exitCode: null });
  });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', (code) => finish({ stdout, stderr, child, exitCode: code }));
});

const localUrlFrom = (stdout) => stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0] ?? null;

describe('openchamber forward', () => {
  test('serves the remote dev server on a local port', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort });

    const run = await runForward(
      [String(devPort), '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN, '--quiet'],
      { ready: /http:\/\/127\.0\.0\.1:\d+/ },
    );

    const localUrl = localUrlFrom(run.stdout);
    expect(localUrl).not.toBeNull();

    // The whole point: a page loads through it, unchanged.
    const response = await fetch(`${localUrl}/app/page`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('dev:/app/page');

    run.child.kill('SIGTERM');
  });

  test('--quiet prints only the local URL', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort });

    const run = await runForward(
      [String(devPort), '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN, '--quiet'],
      { ready: /http:\/\/127\.0\.0\.1:\d+/ },
    );

    expect(run.stdout.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    run.child.kill('SIGTERM');
  });

  test('default output names the local URL and how to stop', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort });

    const run = await runForward(
      [String(devPort), '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN],
      { ready: /Ctrl-C/ },
    );

    expect(localUrlFrom(run.stdout)).not.toBeNull();
    expect(run.stdout).toContain(`http://127.0.0.1:${hostPort} port ${devPort}`);
    expect(run.stdout).toContain('[FORWARD_STOP]');

    run.child.kill('SIGTERM');
  });

  test('--json prints JSON only, before blocking', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort });

    const run = await runForward(
      [String(devPort), '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN, '--json'],
      { ready: /"localPort"/ },
    );

    const payload = JSON.parse(run.stdout);
    expect(payload.status).toBe('ok');
    expect(payload.remotePort).toBe(devPort);
    expect(Number.isInteger(payload.localPort)).toBe(true);
    expect(payload.localUrl).toBe(`http://127.0.0.1:${payload.localPort}`);

    run.child.kill('SIGTERM');
  });

  test('reads the token from the environment', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort });

    const child = spawn('node', [CLI, 'forward', String(devPort), '--url', `http://127.0.0.1:${hostPort}`, '--quiet'], {
      env: { ...process.env, OPENCHAMBER_CLIENT_TOKEN: TOKEN, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanups.push(async () => { child.kill('SIGKILL'); });

    const stdout = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`timed out; got ${buffer}`)), 20_000);
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        if (/http:\/\/127\.0\.0\.1:\d+/.test(buffer)) {
          clearTimeout(timer);
          resolve(buffer);
        }
      });
      child.on('close', () => { clearTimeout(timer); resolve(buffer); });
    });

    expect(localUrlFrom(stdout)).not.toBeNull();
    child.kill('SIGTERM');
  });
});

describe('openchamber forward failures', () => {
  test('names the running ports when the requested one is not among them', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort });

    const run = await runForward([
      '4321', '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN, '--quiet',
    ]);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Port 4321 is not a dev server');
    expect(run.stderr).toContain(String(devPort));
  });

  test('says nothing is running when discovery reports an empty host', async () => {
    const hostPort = await startHost({ devPort: null });

    const run = await runForward(['5173', '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN, '--quiet']);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('No dev servers are running there');
  });

  test('reports a refused token as an auth problem', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort, acceptToken: false });

    const run = await runForward([String(devPort), '--url', `http://127.0.0.1:${hostPort}`, '--token', 'wrong', '--quiet']);

    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain('refused this client token');
  });

  test('refuses when discovery is unavailable rather than tunnelling blind', async () => {
    const devPort = await startDevServer();
    const hostPort = await startHost({ devPort, discoveryOk: false });

    const run = await runForward([String(devPort), '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN, '--quiet']);

    expect(run.exitCode).toBe(5);
    expect(run.stderr).toContain('cannot list the dev servers');
  });

  test('reports an unreachable host as a network failure', async () => {
    // Port 1 on loopback refuses immediately on every supported platform.
    const run = await runForward(['5173', '--url', 'http://127.0.0.1:1', '--token', TOKEN, '--quiet']);

    expect(run.exitCode).toBe(5);
    expect(run.stderr).toContain('Could not reach OpenChamber');
  });

  test('reports failures as JSON in --json mode', async () => {
    const hostPort = await startHost({ devPort: null });

    const run = await runForward(['5173', '--url', `http://127.0.0.1:${hostPort}`, '--token', TOKEN, '--json']);

    expect(run.exitCode).toBe(1);
    const payload = JSON.parse(run.stdout);
    expect(payload.status).toBe('error');
    expect(payload.error.message).toContain('not a dev server');
  });
});
