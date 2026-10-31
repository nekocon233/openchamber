import { EventEmitter } from 'events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliproxyapiGateway } from './gateway.js';
import { gatewayConfigPath } from './config.js';
import { spawnCliProcess } from '../process.js';

const MANAGEMENT = '/v0/management/auth-files';
const directories = [];
const tempDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cliproxyapi-gateway-'));
  directories.push(directory);
  return directory;
};
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

const fixture = async ({ enabled = false, listening = false, bindsPort = true, port = 8317, readinessTimeoutMs = 2000 } = {}) => {
  const dataDir = await tempDirectory();
  const state = {
    listening,
    requests: [],
    spawned: [],
    terminated: [],
    store: { version: 2, enabled, port, authDir: '/auth', upstreamProxy: null, managementKey: 'management-key', clientKeys: ['client-key'], installedVersion: null },
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    state.requests.push({ url: target, headers: options.headers ?? {} });
    if (!state.listening) throw new Error('connect ECONNREFUSED 127.0.0.1');
    if (target.includes(MANAGEMENT)) {
      return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json', 'x-cpa-version': '8.0.31' } });
    }
    return new Response(JSON.stringify({ error: 'missing api key' }), { status: 401 });
  };
  const store = {
    file: path.join(dataDir, 'native-agents', 'cliproxyapi.json'),
    read: async () => ({ ...state.store }),
    update: async (change) => { state.store = change({ ...state.store }); return state.store; },
  };
  const binaryManager = {
    prepare: async () => {
      calls.push('prepare');
      return { path: path.join(dataDir, 'managed', 'cli-proxy-api'), version: '8.0.31', target: 'darwin-arm64', source: 'installed' };
    },
  };
  const spawnProcess = (executable, args, options) => {
    calls.push('spawn');
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    state.spawned.push({ executable, args, options, child });
    if (bindsPort) state.listening = true;
    return child;
  };
  const terminateProcess = async (child) => {
    calls.push('terminate');
    state.terminated.push(child);
    state.listening = false;
    child.emit('exit', 0);
  };
  // A clock that follows real time plus an offset the backoff test can jump.
  const clock = { offset: 0 };
  const gateway = createCliproxyapiGateway({
    store,
    binaryManager,
    dataDir,
    buildEnv: () => ({ PATH: '/usr/bin', HTTPS_PROXY: 'http://elsewhere:1' }),
    spawnProcess,
    terminateProcess,
    fetchImpl,
    now: () => Date.now() + clock.offset,
    readinessTimeoutMs,
  });
  return { dataDir, state, calls, clock, gateway };
};

describe('CLIProxyAPI gateway process', () => {
  it('completes HTTP responses after a real child writes more than a pipe buffer of stdout', async () => {
    const dataDir = await tempDirectory();
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const { port } = reservation.address();
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const script = path.join(dataDir, 'noisy-gateway.mjs');
    await fs.writeFile(script, `
      import { createServer } from 'node:http';
      createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('X-Cpa-Version', '8.0.31');
        if (request.url === '/flood') {
          const bytes = 2 * 1024 * 1024;
          await new Promise((resolve, reject) => process.stdout.write(Buffer.alloc(bytes, 120), (error) => error ? reject(error) : resolve()));
          response.end(JSON.stringify({ bytes }));
          return;
        }
        if (request.url === '/v1/models') response.statusCode = 401;
        response.end(JSON.stringify({ files: [] }));
      }).listen(Number(process.env.OPENCHAMBER_TEST_GATEWAY_PORT), '127.0.0.1');
    `);
    let document = { version: 2, enabled: false, port, authDir: dataDir, upstreamProxy: null,
      managementKey: 'fixture-management', clientKeys: ['fixture-client'], installedVersion: null };
    const gateway = createCliproxyapiGateway({
      dataDir,
      store: {
        read: async () => document,
        update: async (change) => { document = change(document); return document; },
      },
      binaryManager: { prepare: async () => ({ path: process.execPath, version: '8.0.31' }) },
      buildEnv: () => ({ ...process.env, OPENCHAMBER_TEST_GATEWAY_PORT: String(port) }),
      spawnProcess: (executable, _args, options) => spawnCliProcess(executable, [script], options),
    });
    try {
      await gateway.start();
      const response = await fetch(`http://127.0.0.1:${port}/flood`, { signal: AbortSignal.timeout(1500) });
      expect(await response.json()).toEqual({ bytes: 2 * 1024 * 1024 });
      expect(gateway.isRunning()).toBe(true);
    } finally {
      await gateway.stop();
    }
  });

  it('writes the config, spawns the managed binary, and reports the running version', async () => {
    const { dataDir, state, calls, gateway } = await fixture();
    const started = await gateway.start();
    expect(started).toMatchObject({ running: true, version: '8.0.31' });
    expect(calls).toEqual(['prepare', 'spawn']);
    expect(state.spawned[0].executable).toBe(path.join(dataDir, 'managed', 'cli-proxy-api'));
    expect(state.spawned[0].args).toEqual(['-config', gatewayConfigPath(dataDir)]);
    expect(state.store).toMatchObject({ enabled: true, installedVersion: '8.0.31' });
    // The config file is the only proxy the child can see.
    expect(state.spawned[0].options.env).toMatchObject({ NO_PROXY: '127.0.0.1,localhost,::1' });
    expect(state.spawned[0].options.env).not.toHaveProperty('HTTPS_PROXY');
    const written = await fs.readFile(gatewayConfigPath(dataDir), 'utf8');
    expect(written).toContain('secret-key: "management-key"');
    expect(written).toContain('        - "client-key"');
    expect(gateway.status()).toMatchObject({ running: true, version: '8.0.31' });
    if (process.platform !== 'win32') {
      expect((await fs.stat(gatewayConfigPath(dataDir))).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to start when another process already answers on the port', async () => {
    const { state, calls, gateway } = await fixture({ listening: true });
    await expect(gateway.start()).rejects.toMatchObject({ code: 'CLIPROXYAPI_PORT_IN_USE', status: 409 });
    expect(calls).toEqual([]);
    expect(state.terminated).toEqual([]);
    expect(state.store.enabled).toBe(false);
  });

  it('keeps the stderr tail and backs off after a crash', async () => {
    const { state, clock, gateway } = await fixture();
    await gateway.start();
    state.spawned[0].child.stderr.write('gateway: dial tcp 1.2.3.4:443: connection refused');
    state.listening = false;
    state.spawned[0].child.emit('exit', 1);
    expect(gateway.status()).toMatchObject({ running: false, lastError: expect.stringContaining('connection refused') });
    await expect(gateway.start()).rejects.toThrow(/failed 1 times/);
    clock.offset += 30_000;
    expect(state.spawned).toHaveLength(1);
  });

  it('stops idempotently, persists the switch, and resumes only when it is on', async () => {
    const { state, gateway } = await fixture({ enabled: true });
    await gateway.resume();
    expect(state.store.enabled).toBe(true);
    await gateway.stop();
    expect(state.store.enabled).toBe(false);
    expect(state.terminated).toHaveLength(1);
    await gateway.stop();
    expect(state.terminated).toHaveLength(1);
    expect(await gateway.resume()).toEqual({ running: false });
    expect(gateway.isRunning()).toBe(false);
  });

  it('fails and terminates the child when the port never answers', async () => {
    const { calls, gateway } = await fixture({ bindsPort: false, readinessTimeoutMs: 20 });
    await expect(gateway.start()).rejects.toMatchObject({ code: 'CLIPROXYAPI_START_FAILED' });
    expect(calls).toContain('terminate');
    expect(gateway.isRunning()).toBe(false);
  });
});
