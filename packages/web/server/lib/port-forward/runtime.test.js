import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isUpgradeClaimed } from './claim.js';
import { createPortForwardRuntime } from './runtime.js';

/**
 * These run the real path: a dev server, an OpenChamber host splitting traffic
 * by hostname, and requests carrying the headers a tunnel would add. Anything
 * stubbed short of that would not prove the thing that matters — that a page,
 * and the socket it opens, load through the forward exactly as they do locally.
 *
 * The WebSocket case runs in a Node child process so it holds under either
 * runner: Bun's `node:http` moves no bytes on an upgraded socket, so inline it
 * would fail under `bun test` for a reason unrelated to the code. Node is the
 * runtime that ships (`bin/cli.js` starts with `#!/usr/bin/env node`).
 */

const TEMPLATE = 'oc--{port}.example.com';
const started = [];

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const track = (server) => {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  started.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
};

afterEach(async () => {
  while (started.length > 0) await started.pop()();
});

/** A dev server that reports what it was actually asked. */
const startDevServer = async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`dev:${req.url}`);
  });
  track(server);

  const port = await listen(server);
  return { port, seen };
};

const startHost = async ({ devPort, discovery = 'ok', template = TEMPLATE }) => {
  const runtime = createPortForwardRuntime({
    discoverDevServers: async () => {
      if (discovery === 'unavailable') return { ok: false, reason: 'no-listener-source' };
      if (discovery === 'gone') return { ok: true, servers: [] };
      return { ok: true, servers: [{ port: devPort, url: `http://localhost:${devPort}/`, command: 'vite' }] };
    },
  });
  runtime.configure(template);

  const server = http.createServer((req, res) => {
    if (runtime.handles(req)) {
      void runtime.handleRequest(req, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('openchamber');
  });
  server.on('upgrade', (req, socket, head) => {
    if (!runtime.handles(req)) return;
    void runtime.handleUpgrade(req, socket, head);
  });
  track(server);

  const port = await listen(server);
  return { runtime, port };
};

const request = (hostPort, { path = '/', host, proto = 'https', cookie, method = 'GET' } = {}) => (
  new Promise((resolve, reject) => {
    const headers = { host };
    if (proto) headers['x-forwarded-proto'] = proto;
    if (cookie) headers.cookie = cookie;

    const req = http.request({ host: '127.0.0.1', port: hostPort, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  })
);

/**
 * Sends a request line verbatim. Bun's HTTP client normalises `//host/` down to
 * `/host/`, which would quietly defeat the very check this exercises.
 */
const rawRequest = (hostPort, { target, host, proto = 'https' }) => new Promise((resolve, reject) => {
  const socket = net.connect(hostPort, '127.0.0.1', () => {
    socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nX-Forwarded-Proto: ${proto}\r\nConnection: close\r\n\r\n`);
  });
  let raw = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { raw += chunk; });
  socket.on('end', () => resolve({ status: Number.parseInt(raw.split(' ')[1] ?? '', 10), raw }));
  socket.on('error', reject);
});

/** Sends an upgrade handshake and leaves; only the listeners' view matters here. */
const rawUpgrade = (hostPort, { target, host }) => new Promise((resolve) => {
  const socket = net.connect(hostPort, '127.0.0.1', () => {
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nX-Forwarded-Proto: https\r\n`
      + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: MTIzNDU2Nzg5YWJjZGVmMA==\r\n\r\n',
    );
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 150);
  });
  socket.on('error', () => resolve());
});

const sessionCookieFrom = (response) => {
  const header = response.headers['set-cookie']?.[0] ?? '';
  return header.split(';')[0];
};

/** Walks the grant redirect the way a browser would, returning the cookie. */
const openForward = async ({ runtime, hostPort, devPort, path = '/' }) => {
  const grantUrl = new URL(runtime.issueGrantUrl(devPort, path));
  const redirect = await request(hostPort, {
    path: `${grantUrl.pathname}${grantUrl.search}`,
    host: grantUrl.host,
  });
  return { redirect, cookie: sessionCookieFrom(redirect), host: grantUrl.host };
};

describe('port forward', () => {
  test('serves the dev server from its own origin once opened from OpenChamber', async () => {
    const dev = await startDevServer();
    const host = await startHost({ devPort: dev.port });
    host.runtime.enable(dev.port);

    const { redirect, cookie, host: forwardHost } = await openForward({
      runtime: host.runtime,
      hostPort: host.port,
      devPort: dev.port,
      path: '/app/page',
    });

    expect(redirect.status).toBe(302);
    // The grant is gone from the URL the browser keeps, and so from the
    // `Referer` of everything the page loads next.
    expect(redirect.headers.location).toBe('/app/page');
    expect(redirect.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(redirect.headers['set-cookie'][0]).toContain('Secure');
    expect(redirect.headers['set-cookie'][0]).toContain('SameSite=None');
    expect(redirect.headers['set-cookie'][0]).toContain('Partitioned');

    const page = await request(host.port, { path: '/app/page', host: forwardHost, cookie });
    expect(page.status).toBe(200);
    expect(page.body).toBe('dev:/app/page');
  });

  test('presents the dev server with a loopback Host, so host allowlists pass', async () => {
    const dev = await startDevServer();
    const host = await startHost({ devPort: dev.port });
    host.runtime.enable(dev.port);

    const { cookie, host: forwardHost } = await openForward({
      runtime: host.runtime,
      hostPort: host.port,
      devPort: dev.port,
    });
    await request(host.port, { path: '/', host: forwardHost, cookie });

    const received = dev.seen.at(-1);
    expect(received.headers.host).toBe(`localhost:${dev.port}`);
    expect(received.headers['x-forwarded-proto']).toBe('https');
    expect(received.headers['x-forwarded-host']).toBe(forwardHost);
  });

  test('does not hand OpenChamber\'s own cookie to the dev server', async () => {
    const dev = await startDevServer();
    const host = await startHost({ devPort: dev.port });
    host.runtime.enable(dev.port);

    const { cookie, host: forwardHost } = await openForward({
      runtime: host.runtime,
      hostPort: host.port,
      devPort: dev.port,
    });
    await request(host.port, { path: '/', host: forwardHost, cookie: `${cookie}; app_session=keep-me` });

    const received = dev.seen.at(-1);
    expect(received.headers.cookie).toBe('app_session=keep-me');
    expect(received.headers.cookie).not.toContain('oc_forward');
  });

  test('carries WebSocket upgrades under Node, which is what makes HMR work', () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'websocket-forward.fixture.mjs',
    );
    const result = spawnSync('node', [fixture], { encoding: 'utf8', timeout: 30_000 });

    expect(result.error).toBeUndefined();
    expect(result.stdout.trim().split('\n')).toEqual([
      'hmr-socket-reaches-dev-server=pass',
      'upgrade-without-session-refused=pass',
      'upgrade-after-disable-refused=pass',
    ]);
    expect(result.status).toBe(0);
  });
});

describe('port forward authorization', () => {
  const setup = async (options = {}) => {
    const dev = await startDevServer();
    const host = await startHost({ devPort: dev.port, ...options });
    return { dev, host, forwardHost: `oc--${dev.port}.example.com` };
  };

  test('a port nobody turned on is not reachable, even though discovery sees it', async () => {
    const { host, forwardHost } = await setup();
    const response = await request(host.port, { host: forwardHost });
    expect(response.status).toBe(404);
    expect(response.body).toContain('not being forwarded');
  });

  test('a dev server that stopped stops being reachable', async () => {
    const { dev, host, forwardHost } = await setup({ discovery: 'gone' });
    host.runtime.enable(dev.port);

    const response = await request(host.port, { host: forwardHost });
    expect(response.status).toBe(502);
  });

  test('a discovery failure denies the request without cancelling the forward', async () => {
    const { dev, host, forwardHost } = await setup({ discovery: 'unavailable' });
    host.runtime.enable(dev.port);

    const response = await request(host.port, { host: forwardHost });
    expect(response.status).toBe(503);
    // "The scan broke" is not "the user changed their mind".
    expect(host.runtime.list()).toEqual([{ port: dev.port, origin: `https://${forwardHost}` }]);
  });

  test('refuses plain HTTP, where the cookie could never be set', async () => {
    const { dev, host, forwardHost } = await setup();
    host.runtime.enable(dev.port);

    const response = await request(host.port, { host: forwardHost, proto: 'http' });
    expect(response.status).toBe(400);
    expect(response.body).toContain('HTTPS');
  });

  test('refuses a request with no session', async () => {
    const { dev, host, forwardHost } = await setup();
    host.runtime.enable(dev.port);

    const response = await request(host.port, { host: forwardHost });
    expect(response.status).toBe(403);
  });

  test('a grant works once', async () => {
    const { dev, host } = await setup();
    host.runtime.enable(dev.port);

    const grantUrl = new URL(host.runtime.issueGrantUrl(dev.port));
    const target = { path: `${grantUrl.pathname}${grantUrl.search}`, host: grantUrl.host };

    expect((await request(host.port, target)).status).toBe(302);
    expect((await request(host.port, target)).status).toBe(403);
  });

  test('turning a forward off cuts existing sessions', async () => {
    const { dev, host } = await setup();
    host.runtime.enable(dev.port);

    const { cookie, host: forwardHost } = await openForward({
      runtime: host.runtime,
      hostPort: host.port,
      devPort: dev.port,
    });
    expect((await request(host.port, { host: forwardHost, cookie })).status).toBe(200);

    host.runtime.disable(dev.port);
    expect((await request(host.port, { host: forwardHost, cookie })).status).toBe(404);
  });

  test('a hostname outside the template falls through to OpenChamber', async () => {
    const { dev, host } = await setup();
    host.runtime.enable(dev.port);

    const response = await request(host.port, { host: 'oc.example.com' });
    expect(response.body).toBe('openchamber');
  });

  test('a matching hostname never falls through to OpenChamber', async () => {
    // Otherwise the app, and its sign-in page, would be served from an origin
    // OpenChamber does not authenticate.
    const { host, forwardHost } = await setup();
    const response = await request(host.port, { host: forwardHost });
    expect(response.body).not.toBe('openchamber');
  });

  test('refuses a request target that is not a path', async () => {
    const { dev, host, forwardHost } = await setup();
    host.runtime.enable(dev.port);
    // `//evil.example/` parses as protocol-relative, so an unchecked target
    // would move both the redirect and the proxied path off this origin.
    const response = await rawRequest(host.port, { target: '//evil.example/', host: forwardHost });
    expect(response.status).toBe(400);
  });
});

describe('port forward upgrade claiming', () => {
  /**
   * Node runs every `upgrade` listener for every upgrade, and the others on
   * this server match on path. A forwarded hostname owns all of its paths, so
   * without the claim a hot-reload socket that happened to sit on, say,
   * `/api/event` would be answered by OpenChamber's event stream — which looks
   * like HMR silently never reconnecting.
   */
  const startClaimHost = async ({ devPort }) => {
    const runtime = createPortForwardRuntime({
      discoverDevServers: async () => ({ ok: true, servers: [{ port: devPort }] }),
    });
    runtime.configure(TEMPLATE);
    runtime.enable(devPort);

    const server = http.createServer((_req, res) => res.end('openchamber'));
    server.on('upgrade', (req, socket, head) => {
      if (!runtime.handles(req)) return;
      void runtime.handleUpgrade(req, socket, head);
    });

    const seen = [];
    // Stands in for the terminal, dictation, event-stream, realtime-proxy, and
    // dev-tunnel listeners, all of which check this before matching a path.
    server.on('upgrade', (req) => seen.push(isUpgradeClaimed(req)));
    track(server);

    return { port: await listen(server), seen };
  };

  test('claims an upgrade on a forwarded host', async () => {
    const dev = await startDevServer();
    const host = await startClaimHost({ devPort: dev.port });

    await rawUpgrade(host.port, { target: '/api/event', host: `oc--${dev.port}.example.com` });

    expect(host.seen).toEqual([true]);
  });

  test('leaves OpenChamber\'s own upgrades unclaimed', async () => {
    const dev = await startDevServer();
    const host = await startClaimHost({ devPort: dev.port });

    await rawUpgrade(host.port, { target: '/api/event', host: 'oc.example.com' });

    expect(host.seen).toEqual([false]);
  });
});

describe('port forward configuration', () => {
  const build = () => createPortForwardRuntime({
    discoverDevServers: async () => ({ ok: true, servers: [{ port: 5173, url: '', command: '' }] }),
  });

  test('does nothing until a template is configured', () => {
    const runtime = build();
    expect(runtime.configured).toBe(false);
    expect(runtime.handles({ headers: { host: 'oc--5173.example.com' } })).toBe(false);
    expect(runtime.enable(5173)).toEqual({ ok: false, error: 'no-template' });
  });

  test('reports an unusable template instead of silently ignoring it', () => {
    const runtime = build();
    expect(runtime.configure('oc.example.com').ok).toBe(false);
    expect(runtime.configured).toBe(false);
  });

  test('changing the template drops forwards whose URLs no longer route', () => {
    const runtime = build();
    runtime.configure(TEMPLATE);
    runtime.enable(5173);
    expect(runtime.list()).toHaveLength(1);

    runtime.configure('dev--{port}.example.com');
    expect(runtime.list()).toEqual([]);
  });

  test('re-applying the same template leaves forwards alone', () => {
    const runtime = build();
    runtime.configure(TEMPLATE);
    runtime.enable(5173);
    runtime.configure(TEMPLATE);
    expect(runtime.list()).toHaveLength(1);
  });

  test.each([['an empty string', ''], ['null', null], ['undefined', undefined]])(
    'clearing the template with %s drops forwards',
    (_label, value) => {
      const runtime = build();
      runtime.configure(TEMPLATE);
      runtime.enable(5173);
      runtime.configure(value);
      expect(runtime.configured).toBe(false);
      expect(runtime.list()).toEqual([]);
    },
  );

  test('a malformed template is reported, not treated as "clear it"', () => {
    const runtime = build();
    runtime.configure(TEMPLATE);
    runtime.enable(5173);

    // Silently clearing would destroy the user's forwards on a bad write.
    expect(runtime.configure(12345).ok).toBe(false);
    expect(runtime.template).toBe(TEMPLATE);
    expect(runtime.list()).toHaveLength(1);
  });

  test('refuses a grant URL for a port that is not forwarded', () => {
    const runtime = build();
    runtime.configure(TEMPLATE);
    expect(runtime.issueGrantUrl(5173)).toBeNull();
  });

  test('refuses a grant URL for a target that is not a path', () => {
    const runtime = build();
    runtime.configure(TEMPLATE);
    runtime.enable(5173);
    expect(runtime.issueGrantUrl(5173, 'https://evil.example/')).toBeNull();
    expect(runtime.issueGrantUrl(5173, '//evil.example/')).toBeNull();
    expect(runtime.issueGrantUrl(5173, '/ok')).toContain('https://oc--5173.example.com/ok?');
  });

  test.each([0, -1, 65_536, 1.5, Number.NaN])('refuses to forward port %p', (port) => {
    const runtime = build();
    runtime.configure(TEMPLATE);
    expect(runtime.enable(port).ok).toBe(false);
  });
});
