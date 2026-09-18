/**
 * The WebSocket half of the forward, exercised end to end under Node.
 *
 * It runs in its own Node process so the check holds whichever runner invokes
 * it. Bun's `node:http` delivers no bytes in either direction on an upgraded
 * socket (verified with a bare `socket.write` after an `upgrade` event), so
 * under `bun test` an inline version of this would fail for a reason that says
 * nothing about the code. Node is also the runtime that matters: every shipped
 * server starts from `bin/cli.js`, which is `#!/usr/bin/env node`.
 *
 * Prints one `name=pass|fail` line per case and exits non-zero if any failed.
 */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { createPortForwardRuntime } from './runtime.js';

const TIMEOUT_MS = 3_000;
const results = [];
const record = (name, passed) => results.push(`${name}=${passed ? 'pass' : 'fail'}`);

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const startDevServer = async () => {
  const server = http.createServer((_req, res) => res.end('dev'));
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => socket.send('hello-from-dev'));
  const port = await listen(server);
  return { server, port };
};

const startHost = async (devPort) => {
  const runtime = createPortForwardRuntime({
    discoverDevServers: async () => ({ ok: true, servers: [{ port: devPort }] }),
  });
  runtime.configure('oc--{port}.example.com');
  runtime.enable(devPort);

  const server = http.createServer((req, res) => {
    if (runtime.handles(req)) {
      void runtime.handleRequest(req, res);
      return;
    }
    res.end('openchamber');
  });
  server.on('upgrade', (req, socket, head) => {
    if (!runtime.handles(req)) return;
    void runtime.handleUpgrade(req, socket, head);
  });

  const port = await listen(server);
  return { server, port, runtime };
};

const redeemCookie = (hostPort, grantUrl) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port: hostPort,
    path: `${grantUrl.pathname}${grantUrl.search}`,
    headers: { host: grantUrl.host, 'x-forwarded-proto': 'https' },
  }, (res) => {
    res.resume();
    res.on('end', () => resolve((res.headers['set-cookie']?.[0] ?? '').split(';')[0]));
  });
  req.on('error', reject);
  req.end();
});

const connect = (hostPort, headers) => new Promise((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:${hostPort}/`, { headers });
  const finish = (outcome) => {
    clearTimeout(timer);
    try { socket.close(); } catch { /* already closing */ }
    resolve(outcome);
  };
  const timer = setTimeout(() => finish({ kind: 'timeout' }), TIMEOUT_MS);
  socket.on('message', (data) => finish({ kind: 'message', text: String(data) }));
  socket.on('error', (error) => finish({ kind: 'error', message: String(error?.message || error) }));
});

const dev = await startDevServer();
const host = await startHost(dev.port);
const forwardHost = `oc--${dev.port}.example.com`;

const cookie = await redeemCookie(host.port, new URL(host.runtime.issueGrantUrl(dev.port, '/')));

const authorized = await connect(host.port, { host: forwardHost, cookie, 'x-forwarded-proto': 'https' });
record('hmr-socket-reaches-dev-server', authorized.kind === 'message' && authorized.text === 'hello-from-dev');

const anonymous = await connect(host.port, { host: forwardHost, 'x-forwarded-proto': 'https' });
record('upgrade-without-session-refused', anonymous.kind !== 'message');

host.runtime.disable(dev.port);
const afterDisable = await connect(host.port, { host: forwardHost, cookie, 'x-forwarded-proto': 'https' });
record('upgrade-after-disable-refused', afterDisable.kind !== 'message');

dev.server.close();
host.server.close();

process.stdout.write(`${results.join('\n')}\n`);
process.exit(results.some((line) => line.endsWith('=fail')) ? 1 : 0);
