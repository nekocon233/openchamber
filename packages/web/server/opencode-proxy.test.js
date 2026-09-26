import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import express from 'express';
import path from 'path';
import { OpenCode } from '@opencode/client';

import { createSseBoundaryTracker, registerOpenCodeProxy, writeSseChunkWithBackpressure } from './lib/opencode/proxy.js';
import { registerCommonRequestMiddleware } from './lib/opencode/core-routes.js';
import { createAuthChannelLifecycle } from './lib/ui-auth/channel-auth.js';
import {
  createClientNotificationAuth,
  invalidateNotificationAuth,
  notificationAuthMatchesSelector,
  subscribeNotificationAuthInvalidation,
} from './lib/notifications/auth-runtime.js';

const listen = (app, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const server = app.listen(0, host, () => resolve(server));
  server.once('error', reject);
});

const waitForCondition = async (condition, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const closeServer = (server) => new Promise((resolve, reject) => {
  if (!server) {
    resolve();
    return;
  }
  server.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

describe('OpenCode proxy SSE forwarding', () => {
  let upstreamServer;
  let proxyServer;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(async () => {
    Object.defineProperty(process, 'platform', originalPlatform);
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
    proxyServer = undefined;
    upstreamServer = undefined;
  });

  it('forwards event streams with nginx-safe headers', async () => {
    let seenAuthorization = null;

    const upstream = express();
    upstream.get('/api/event', (req, res) => {
      seenAuthorization = req.headers.authorization ?? null;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=0');
      res.setHeader('X-Upstream-Test', 'ok');
      res.write('data: {"ok":true}\n\n');
      res.end();
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-upstream-test')).toBe('ok');
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    expect(seenAuthorization).toBe('Bearer test-token');
  });

  it('injects native session events into the global stream only between upstream blocks', async () => {
    let releaseRest;
    const restReleased = new Promise((resolve) => {
      releaseRest = resolve;
    });
    const partial = 'data: {"directory":"/a","payload":{"type":"x","properties":{"n":';
    const rest = '1}}}\n\n';

    const upstream = express();
    upstream.get('/api/event', async (req, res) => {
      if (req.headers['x-opencode-directory']) {
        res.type('text/event-stream').end('data: {"ok":true}\n\n');
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(partial);
      await restReleased;
      res.write(rest);
      res.end();
    });
    upstream.get('/event', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"ok":true}\n\n');
      res.end();
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const listeners = new Set();
    let subscribeCalls = 0;
    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      subscribeNativeEvents: (listener) => {
        subscribeCalls += 1;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const directoryResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/event`, { headers: { 'x-opencode-directory': encodeURIComponent('/a') } });
    expect(await directoryResponse.text()).toBe('data: {"ok":true}\n\n');
    expect(subscribeCalls).toBe(0);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/global/event`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (received.length < partial.length) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    expect(received).toBe(partial);
    expect(listeners.size).toBe(1);

    const nativeEvent = {
      directory: '/work/project',
      payload: { type: 'session.status', properties: { sessionID: 'ncl_a', status: { type: 'busy' } } },
    };
    for (const listener of listeners) listener(nativeEvent);
    releaseRest();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    expect(received).toBe(`${partial}${rest}data: ${JSON.stringify(nativeEvent)}\n\n`);
    await waitForCondition(() => listeners.size === 0);
  });

  it('refuses OpenCode session routes for native CLI session ids without calling OpenCode', async () => {
    const upstreamPaths = [];
    const upstream = express();
    upstream.use((req, res) => {
      upstreamPaths.push(req.path);
      res.json({ id: 'ses_opencode' });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const nativeResponse = await fetch(
      `http://127.0.0.1:${proxyPort}/api/session/ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188/message`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(nativeResponse.status).toBe(409);
    expect(await nativeResponse.json()).toMatchObject({ code: 'NATIVE_SESSION_ROUTE' });

    const openCodeResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/session/ses_opencode`);
    expect(openCodeResponse.status).toBe(200);
    expect(upstreamPaths).toEqual(['/api/session/ses_opencode']);
  });

  it('preserves official SDK prompt request fidelity through the generic proxy', async () => {
    let seenRequest;
    let resolveUpstreamRequest;
    const upstreamRequest = new Promise((resolve) => {
      resolveUpstreamRequest = resolve;
    });
    const upstream = express();
    upstream.post('/api/session/:id/prompt', express.raw({ type: '*/*' }), (req, res) => {
      seenRequest = {
        path: req.path,
        query: req.query,
        body: req.body.toString('utf8'),
        headers: req.headers,
      };
      resolveUpstreamRequest();
      res.json({
        data: {
          admittedSeq: 1,
          id: 'msg_sdk_prompt',
          sessionID: req.params.id,
          text: 'Preserve this prompt exactly.',
          delivery: 'queue',
          timeCreated: 1,
        },
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer upstream-token' }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const payload = {
      id: 'msg_sdk_prompt',
      text: 'Preserve this prompt exactly.',
      delivery: 'queue',
    };
    const client = OpenCode.make({
      baseUrl: `http://127.0.0.1:${proxyPort}`,
      headers: { "x-opencode-directory": encodeURIComponent("/workspace/repo") },
    });
    const promptResponse = client.session.prompt({
      sessionID: 'session-one',
      ...payload,
    });

    await upstreamRequest;
    expect(seenRequest).toMatchObject({
      path: '/api/session/session-one/prompt',
      query: {},
      headers: {
        authorization: 'Bearer upstream-token',
        'content-type': 'application/json',
        'x-opencode-directory': '%2Fworkspace%2Frepo',
      },
    });
    expect(JSON.parse(seenRequest.body)).toEqual(payload);
    await expect(promptResponse).resolves.toMatchObject({
      id: 'msg_sdk_prompt',
      sessionID: 'session-one',
      delivery: 'queue',
    });
  });

  it('terminates an established global event stream when its auth identity is revoked', async () => {
    const upstream = express();
    upstream.get('/api/event', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.write('data: {"type":"ready"}\n\n');
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const auth = createClientNotificationAuth('proxy-sse-revoked');
    const lifecycle = createAuthChannelLifecycle({
      subscribeInvalidation: subscribeNotificationAuthInvalidation,
      matchesSelector: notificationAuthMatchesSelector,
    });

    const app = express();
    app.use((req, _res, next) => {
      req.openchamberAuthIdentity = auth;
      next();
    });
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      trackAuthChannel: lifecycle.track,
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/global/event`, {
        headers: { Accept: 'text/event-stream' },
      });
      const reader = response.body.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"type":"ready"');

      invalidateNotificationAuth(auth);

      const closed = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('stream did not close')), 1000)),
      ]);
      expect(closed.done).toBe(true);
    } finally {
      lifecycle.dispose();
    }
  });

  it('closes downstream SSE when the OpenCode upstream stalls despite proxy heartbeats', async () => {
    let stallTimeoutReads = 0;
    const upstream = express();
    upstream.get('/api/event', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      setTimeout(() => res.write(':upstream-alive\n\n'), 40);
      setTimeout(() => res.write('data: still-alive\n\n'), 80);
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      SSE_HEARTBEAT_INTERVAL_MS: 10,
      getSseUpstreamStallTimeoutMs: () => {
        stallTimeoutReads += 1;
        return stallTimeoutReads === 1 ? 50 : 100;
      },
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(2000),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(':heartbeat\n\n');
    expect(body).toContain(':upstream-alive\n\n');
    expect(body).toContain('data: still-alive\n\n');
    expect(stallTimeoutReads).toBeGreaterThanOrEqual(3);
  });

  it('holds a request through OpenCode warmup and succeeds once ready (no 503/backoff)', async () => {
    const upstream = express();
    upstream.get('/api/config/providers', (_req, res) => {
      res.json({ ok: true });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const runtime = {
      openCodePort: upstreamPort,
      isOpenCodeReady: false,
      openCodeNotReadySince: 0,
      isRestartingOpenCode: false,
    };
    // OpenCode becomes ready shortly after the request arrives.
    setTimeout(() => { runtime.isOpenCodeReady = true; }, 200);

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 5000,
      getRuntime: () => runtime,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/config/providers`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns 503 fast when OpenCode never becomes ready', async () => {
    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      // Zero grace → hold window collapses to nothing → fail fast.
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: 0,
        isOpenCodeReady: false,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:1${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/config/providers`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ restarting: true });
  });

  it('waits for drain when writing to a slow SSE response', async () => {
    const writes = [];
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    res.write = (value) => {
      writes.push(value);
      return false;
    };
    const controller = new AbortController();

    const write = writeSseChunkWithBackpressure(res, Buffer.from('data: {"ok":true}\n\n'), controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toHaveLength(1);

    res.emit('drain');

    await expect(write).resolves.toBe(true);
  });

  it('tracks whether a raw SSE stream is between event blocks', () => {
    const tracker = createSseBoundaryTracker();

    expect(tracker.isAtBoundary()).toBe(true);
    expect(tracker.observe(Buffer.from('id: evt-1\n'))).toBe(false);
    expect(tracker.observe(Buffer.from('data: {"ok"'))).toBe(false);
    expect(tracker.observe(Buffer.from(':true}\n'))).toBe(false);
    expect(tracker.observe(Buffer.from('\n'))).toBe(true);
    expect(tracker.observe(Buffer.from('data: next\r\n\r\n'))).toBe(true);
  });

  it('routes generic API requests through external OpenCode base URL', async () => {
    const upstream = express();
    upstream.get('/api/config/providers', (_req, res) => {
      res.json({ ok: true, source: 'external-host' });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: 3902,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/config/providers`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, source: 'external-host' });
  });

  it('preserves content encoding while streaming generic proxy responses', async () => {
    const upstream = express();
    upstream.get('/api/compressed', (_req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync('compressed upstream body'));
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/compressed`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('compressed upstream body');
  });

  it('never forwards OpenChamber client credentials through the generic API proxy', async () => {
    let upstreamHeaders;
    const upstream = express();
    upstream.get('/api/credential-check', (req, res) => {
      upstreamHeaders = req.headers;
      res.status(404).json({ error: 'not found' });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    await fetch(`http://127.0.0.1:${proxyPort}/api/credential-check`, {
      headers: {
        Authorization: 'Bearer openchamber-client-secret',
        Cookie: 'openchamber_session=private',
        'Proxy-Authorization': 'Basic private',
        'X-OpenChamber-Relay-Connection': 'private-connection-id',
        'X-Forwarded-Test': 'preserved',
      },
    });

    expect(upstreamHeaders.authorization).toBeUndefined();
    expect(upstreamHeaders.cookie).toBeUndefined();
    expect(upstreamHeaders['proxy-authorization']).toBeUndefined();
    expect(upstreamHeaders['x-openchamber-relay-connection']).toBeUndefined();
    expect(upstreamHeaders['x-forwarded-test']).toBe('preserved');
  });

  it('replays parsed urlencoded bodies to generic API proxy requests', async () => {
    const upstream = express();
    upstream.post('/api/form', express.urlencoded({ extended: true }), (req, res) => {
      res.json({ body: req.body });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    app.use('/api', express.urlencoded({ extended: true }));
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ messageID: 'msg_1' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { messageID: 'msg_1' } });
  });

  it('replays parsed JSON bodies to generic API proxy requests', async () => {
    const upstream = express();
    upstream.post('/api/session/abc/prompt', express.json(), (req, res) => {
      res.json({
        body: req.body,
        authorization: req.headers.authorization,
        contentLength: req.headers['content-length'],
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    app.use('/api', express.json());
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer replay-token' }),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const payload = { messageID: 'msg_1', parts: [{ type: 'text', text: 'hello' }] };
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session/abc/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.body).toEqual(payload);
    expect(data.authorization).toBe('Bearer replay-token');
    expect(Number(data.contentLength)).toBeGreaterThan(0);
  });

  it.each([
    ['win32', ''],
    ['win32', '&directory=%2Flink%2Frepo'],
    ['linux', ''],
    ['linux', '&directory=%2Flink%2Frepo'],
  ])('sanitizes session pages and forwards query params (%s, %s)', async (platform, directoryQuery) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    let seenQuery = null;
    let seenAuth = null;

    const upstream = express();
    upstream.get('/api/session', (req, res) => {
      seenQuery = req.query;
      seenAuth = req.headers.authorization ?? null;
      res.setHeader('X-Next-Cursor', '123');
      res.json({
        data: [
          {
            id: 'ses_1',
            projectID: 'proj_1',
            location: { directory: '/repo/app', workspaceID: 'ws_1' },
            subpath: 'app',
            parentID: 'ses_parent',
            title: 'Alpha',
            agent: 'build',
            model: { id: 'gpt-5', providerID: 'openai', variant: 'default' },
            time: { created: 1, updated: 2, archived: 3 },
            cost: 7,
            tokens: { input: 10, output: 20 },
            outcome: 'succeeded',
            fork: { sessionID: 'ses_source', boundary: { type: 'through' } },
            metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_original' } },
            permissions: [{ action: 'deny', resources: ['*'] }],
            revert: { messageID: 'msg_1', partID: 'part_1', snapshot: 'abc123', files: ['a.ts'] },
          },
        ],
        cursor: { next: '123' },
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {
        promises: {
          realpath: async (value) => value === '/link/repo' ? '/real/repo' : value,
        },
      },
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer session-token' }),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session?archived=false&limit=500&cursor=99&roots=true${directoryQuery}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-next-cursor')).toBe('123');
    expect(seenAuth).toBe('Bearer session-token');
    const expectedQuery = {
      archived: 'false',
      limit: '500',
      cursor: '99',
      roots: 'true',
    };
    if (directoryQuery) expectedQuery.directory = '/real/repo';
    expect(seenQuery).toEqual(expectedQuery);

    // The heavy parts of a revert and the per-session permission ruleset are
    // dropped; everything the list view reads survives.
    await expect(response.json()).resolves.toEqual({
      data: [
        {
          id: 'ses_1',
          projectID: 'proj_1',
          location: { directory: '/repo/app', workspaceID: 'ws_1' },
          subpath: 'app',
          parentID: 'ses_parent',
          title: 'Alpha',
          agent: 'build',
          model: { id: 'gpt-5', providerID: 'openai', variant: 'default' },
          time: { created: 1, updated: 2, archived: 3 },
          cost: 7,
          tokens: { input: 10, output: 20 },
          outcome: 'succeeded',
          fork: { sessionID: 'ses_source', boundary: { type: 'through' } },
          metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_original' } },
          revert: { messageID: 'msg_1', partID: 'part_1' },
        },
      ],
      cursor: { next: '123' },
    });
  });

  it.each([
    [200, { data: [], cursor: {} }],
    [503, { error: 'Upstream unavailable' }],
  ])('preserves Windows global list status and empty/error payload (%s)', async (status, payload) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const upstream = express();
    upstream.get('/api/session', (_req, res) => res.status(status).json(payload));
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const baseUrl = `http://127.0.0.1:${upstreamPort}`;
    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: baseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${baseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/session?limit=1`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(payload);
  });

  it('sanitizes session list responses without sanitizing session detail responses', async () => {
    let seenListQuery = null;

    const upstream = express();
    upstream.get('/api/session', (req, res) => {
      seenListQuery = req.query;
      res.json({
        data: [
          {
            id: 'ses_1',
            location: { directory: '/repo/app' },
            title: 'Alpha',
            time: { created: 1, updated: 2 },
            metadata: { custom: { value: 'kept' } },
            permissions: [{ action: 'deny', resources: ['*'] }],
            revert: { messageID: 'msg_1', partID: 'part_1', snapshot: 'abc123', files: ['a.ts'] },
          },
        ],
        cursor: {},
      });
    });
    upstream.get('/api/session/abc', (_req, res) => {
      res.json({
        id: 'abc',
        location: { directory: '/repo/app' },
        title: 'Detail',
        revert: { messageID: 'msg_1', snapshot: 'abc123', files: ['a.ts'] },
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {
        promises: {
          realpath: async (value) => value === '/link/repo' ? '/real/repo' : value,
        },
      },
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const listResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/session?directory=%2Flink%2Frepo`);

    expect(listResponse.status).toBe(200);
    expect(seenListQuery).toMatchObject({ directory: '/real/repo' });
    await expect(listResponse.json()).resolves.toEqual({
      data: [
        {
          id: 'ses_1',
          location: { directory: '/repo/app' },
          title: 'Alpha',
          time: { created: 1, updated: 2 },
          metadata: { custom: { value: 'kept' } },
          revert: { messageID: 'msg_1', partID: 'part_1' },
        },
      ],
      cursor: {},
    });

    const detailResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/session/abc`);

    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({
      id: 'abc',
      location: { directory: '/repo/app' },
      title: 'Detail',
      revert: { messageID: 'msg_1', snapshot: 'abc123', files: ['a.ts'] },
    });
  });

  it('folds OpenChamber-owned archive state and metadata onto sessions it serves', async () => {
    const upstream = express();
    upstream.get('/api/session', (_req, res) => {
      res.json({
        data: [
          { id: 'ses_1', location: { directory: '/repo/app' }, title: 'Alpha', time: { created: 1, updated: 2 }, metadata: { fromOpenCode: true, shared: 'theirs', removed: 'stale' } },
          { id: 'ses_2', location: { directory: '/repo/app' }, title: 'Beta', time: { created: 1, updated: 3, archived: 999 }, metadata: { openchamber: { reviewSessionID: 'ses_old' } } },
          { id: 'ses_3', metadata: { untouched: true } },
        ],
        cursor: {},
      });
    });
    upstream.get('/api/session/ses_1', (_req, res) => {
      res.json({ id: 'ses_1', location: { directory: '/repo/app' }, title: 'Alpha', metadata: { fromOpenCode: true, shared: 'theirs', removed: 'stale' } });
    });
    upstream.get('/api/session/ses_2', (_req, res) => {
      res.json({ id: 'ses_2', metadata: { openchamber: { reviewSessionID: 'ses_old' } } });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      getArchivedSessions: async () => ({ ses_1: 4242 }),
      getStoredSessionMetadata: async () => ({
        ses_1: { fromOpenCode: true, openchamber: { goal: { status: 'active' } }, shared: 'ours' },
        ses_2: {},
      }),
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const list = await (await fetch(`http://127.0.0.1:${proxyPort}/api/session`)).json();
    // The seeded metadata includes unchanged upstream fields but excludes
    // deleted keys. Empty metadata is authoritative too.
    expect(list.data[0]).toMatchObject({
      id: 'ses_1',
      time: { created: 1, updated: 2, archived: 4242 },
      metadata: { fromOpenCode: true, shared: 'ours', openchamber: { goal: { status: 'active' } } },
    });
    expect(list.data[0].metadata).not.toHaveProperty('removed');
    expect(list.data[1].metadata).toEqual({});
    expect(list.data[2].metadata).toEqual({ untouched: true });
    // The archive file does not mention ses_2, so the stamp OpenCode carries
    // (a session migrated from v1) stays as it is.
    expect(list.data[1].time).toEqual({ created: 1, updated: 3, archived: 999 });

    const detail = await (await fetch(`http://127.0.0.1:${proxyPort}/api/session/ses_1`)).json();
    expect(detail).toMatchObject({
      id: 'ses_1',
      time: { archived: 4242 },
      metadata: { fromOpenCode: true, shared: 'ours', openchamber: { goal: { status: 'active' } } },
    });
    expect(detail.metadata).not.toHaveProperty('removed');
    const cleared = await (await fetch(`http://127.0.0.1:${proxyPort}/api/session/ses_2`)).json();
    expect(cleared.metadata).toEqual({});
  });

  it('hands the first page of the session list to the spaces merge, and later pages not', async () => {
    const upstream = express();
    upstream.get('/api/session', (req, res) => res.json({ data: [{ id: 'h1', location: { directory: '/repo' }, title: 'host', permissions: {} }], cursor: { next: req.query.cursor ? undefined : 'p2' } }));
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const merges = [];
    const app = express();
    registerOpenCodeProxy(app, {
      fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: upstreamPort, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      mergeSpaceSessionList: async (payload) => {
        merges.push(payload);
        return { ...payload, data: [...payload.data, { id: 's1', location: { directory: '/spaces/a1b2c3d4e5f6/repo' } }], spaces: [{ id: 'a1b2c3d4e5f6', state: 'complete', sessions: 1 }] };
      },
    });
    proxyServer = await listen(app);
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    const first = await (await fetch(`${base}/api/session?limit=50`)).json();
    expect(first.data.map((item) => item.id)).toEqual(['h1', 's1']);
    expect(first.spaces).toEqual([{ id: 'a1b2c3d4e5f6', state: 'complete', sessions: 1 }]);
    // The merge sees the host's list already sanitized.
    expect(merges[0].data[0]).not.toHaveProperty('permissions');
    const second = await (await fetch(`${base}/api/session?limit=50&cursor=p2`)).json();
    expect(second.data.map((item) => item.id)).toEqual(['h1']);
    expect(second.spaces).toBeUndefined();
    // A list scoped to one directory, as the sidebar reads per project, is the host's alone.
    const scoped = await (await fetch(`${base}/api/session?limit=50&directory=${encodeURIComponent('/repo')}`)).json();
    expect(scoped.data.map((item) => item.id)).toEqual(['h1']);
    expect(scoped.spaces).toBeUndefined();
    const scopedByHeader = await (await fetch(`${base}/api/session?limit=50`, { headers: { 'x-opencode-directory': '/repo' } })).json();
    expect(scopedByHeader.spaces).toBeUndefined();
    expect(merges).toHaveLength(1);
  });

  it('writes the events of isolated spaces into the global event stream between the upstream\'s blocks', async () => {
    const upstream = express();
    let upstreamRes = null;
    upstream.get('/api/event', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: {"id":"h1","type":"host"}\n\n');
      upstreamRes = res;
      req.on('close', () => { upstreamRes = null; });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const subscribers = new Set();
    const spaceEventHub = {
      subscribeEvent: (subscriber, options) => {
        const entry = { subscriber, options };
        subscribers.add(entry);
        return () => subscribers.delete(entry);
      },
    };
    const app = express();
    registerOpenCodeProxy(app, {
      fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: upstreamPort, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      spaceEventHub,
    });
    proxyServer = await listen(app);
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    // A stream scoped by the directory header is the host's alone: no subscription for it.
    const scopedController = new AbortController();
    const scoped = await fetch(`${base}/api/event`, { headers: { Accept: 'text/event-stream', 'x-opencode-directory': '/repo' }, signal: scopedController.signal });
    expect(scoped.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscribers.size).toBe(0);
    scopedController.abort();

    const controller = new AbortController();
    const response = await fetch(`${base}/api/global/event`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('"h1"');
    expect(subscribers.size).toBe(1);
    const [{ subscriber, options }] = subscribers;
    expect(options).toEqual({ spaces: true });
    // A host event of the hub is not written twice; a space event is written as one block.
    subscriber({ spaceId: null, payload: { id: 'x', type: 'host-from-hub' } });
    subscriber({ spaceId: 'a1b2c3d4e5f6', payload: { id: 's1', type: 'session.execution.started', location: { directory: '/spaces/a1b2c3d4e5f6/repo' } } });
    await readUntil('"s1"');
    expect(text).toBe('data: {"id":"h1","type":"host"}\n\ndata: {"id":"s1","type":"session.execution.started","location":{"directory":"/spaces/a1b2c3d4e5f6/repo"}}\n\n');
    // Half a block of the host's holds a space event back until the block is whole.
    upstreamRes.write('data: {"id":"h2",');
    await readUntil('"h2"');
    subscriber({ spaceId: 'a1b2c3d4e5f6', payload: { id: 's2', type: 'session.execution.succeeded' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(text).not.toContain('"s2"');
    upstreamRes.write('"type":"host"}\n\n');
    await readUntil('"s2"');
    expect(text.endsWith('data: {"id":"h2","type":"host"}\n\ndata: {"id":"s2","type":"session.execution.succeeded"}\n\n')).toBe(true);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscribers.size).toBe(0);
  });

  it('forwards unparsed SDK JSON bodies to generic API proxy requests', async () => {
    const upstream = express();
    upstream.post('/api/session/abc/revert', express.json(), (req, res) => {
      res.json({
        body: req.body,
        contentLength: req.headers['content-length'],
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const payload = { messageID: 'msg_1' };
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session/abc/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.body).toEqual(payload);
    expect(Number(data.contentLength)).toBeGreaterThan(0);
  });

  it('uses the long proxy timeout budget for slow upstream responses', async () => {
    const upstream = express();
    upstream.get('/api/slow', (_req, _res) => {
      // Leave the response open so the proxy timeout path is exercised.
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      LONG_REQUEST_TIMEOUT_MS: 50,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/slow`, {
      signal: AbortSignal.timeout(2000),
    });

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: 'OpenCode upstream timed out' });
  });

});
