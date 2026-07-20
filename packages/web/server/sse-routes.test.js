import { describe, expect, it, vi } from 'bun:test';

import { NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS, registerNotificationRoutes } from './lib/notifications/routes.js';
import { createClientNotificationAuth, invalidateNotificationAuth } from './lib/notifications/auth-runtime.js';
import { createTunnelAuth } from './lib/opencode/tunnel-auth.js';
import { registerScheduledTaskRoutes } from './lib/scheduled-tasks/routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(path, handler) {
        routes.set(`GET ${path}`, handler);
      },
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
      put(path, handler) {
        routes.set(`PUT ${path}`, handler);
      },
      delete(path, handler) {
        routes.set(`DELETE ${path}`, handler);
      },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createMockRequest = (headers = {}) => {
  const listeners = new Map();

  return {
    method: 'GET',
    path: '/api/notifications/stream',
    url: '/api/notifications/stream',
    headers,
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    off(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
    listenerCount: (event) => listeners.has(event) ? 1 : 0,
  };
};

const createMockResponse = () => {
  const headers = new Map();
  const listeners = new Map();
  let statusCode = 200;
  let body = '';
  let flushed = false;
  let bodyFlushCount = 0;
  let ended = false;

  return {
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    off(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      flushed = true;
    },
    flush() {
      bodyFlushCount += 1;
    },
    write(chunk) {
      body += String(chunk);
      return true;
    },
    end() {
      ended = true;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body += JSON.stringify(payload);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get flushed() {
      return flushed;
    },
    get bodyFlushCount() {
      return bodyFlushCount;
    },
    get writableEnded() {
      return ended;
    },
    get destroyed() {
      return false;
    },
    get ended() {
      return ended;
    },
    listenerCount: (event) => listeners.has(event) ? 1 : 0,
  };
};

describe('local SSE routes', () => {
  it('serves notification SSE with nginx-safe headers', async () => {
    vi.useFakeTimers();
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    try {
      registerNotificationRoutes(app, {
        uiAuthController: {
          ensureSessionToken: async () => 'ui-token',
          validateNotificationAuth: async () => true,
        },
        getUiSessionTokenFromRequest: () => 'ui-token',
        getUiNotificationClients: () => clients,
        writeSseEvent(res, payload) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
      });

      const handler = getRoute('GET', '/api/notifications/stream');
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-type')).toContain('text/event-stream');
      expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
      expect(res.getHeader('connection')).toBe('keep-alive');
      expect(res.getHeader('x-accel-buffering')).toBe('no');
      expect(res.flushed).toBe(true);
      expect(res.body).toContain('openchamber:notification-stream-ready');
      expect(res.body).not.toContain('ui-token');
      expect(clients.has(res)).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(res.bodyFlushCount).toBe(1);

      await vi.advanceTimersByTimeAsync(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toContain(':heartbeat\n\n');
      expect(res.bodyFlushCount).toBe(2);

      res.emit('error');
      expect(clients.has(res)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(req.listenerCount('close')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
      expect(res.listenerCount('error')).toBe(0);

      const bodyAfterClose = res.body;
      vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toBe(bodyAfterClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an authenticated managed tunnel identity server-side and closes it on revocation', async () => {
    vi.useFakeTimers();
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example',
      mode: 'quick',
    });
    const bootstrap = tunnelAuthController.issueBootstrapToken({ ttlMs: 60_000 });
    const connectReq = createMockRequest({ host: 'tunnel.example', 'x-forwarded-proto': 'https' });
    const connectRes = createMockResponse();
    const exchange = tunnelAuthController.exchangeBootstrapToken({
      req: connectReq,
      res: connectRes,
      token: bootstrap.token,
      sessionTtlMs: 60_000,
    });
    expect(exchange.ok).toBe(true);
    const sessionCookie = String(connectRes.getHeader('set-cookie') || '').split(';', 1)[0];
    const sessionId = decodeURIComponent(sessionCookie.slice(sessionCookie.indexOf('=') + 1));

    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();
    const ensureSessionToken = vi.fn(async () => null);
    registerNotificationRoutes(app, {
      uiAuthController: { ensureSessionToken },
      tunnelAuthController,
      getUiSessionTokenFromRequest: () => null,
      getUiNotificationClients: () => clients,
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    });

    const req = createMockRequest({ host: 'tunnel.example', cookie: sessionCookie });
    const res = createMockResponse();
    await getRoute('GET', '/api/notifications/stream')(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('openchamber:notification-stream-ready');
    expect(res.body).not.toContain(sessionId);
    expect(res.body).not.toContain('uiToken');
    expect(ensureSessionToken).not.toHaveBeenCalled();
    expect(clients.has(res)).toBe(true);

    tunnelAuthController.clearActiveTunnel();
    await Promise.resolve();
    expect(clients.has(res)).toBe(false);
    expect(res.ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('rejects an invalid managed tunnel session before minting a local UI cookie', async () => {
    const { app, getRoute } = createRouteRegistry();
    const ensureSessionToken = vi.fn(async (_req, res) => {
      res.setHeader('Set-Cookie', 'oc_ui_session=unexpected');
      return 'unexpected-ui-session';
    });
    const ensureGlobalWatcherStarted = vi.fn(async () => {});
    registerNotificationRoutes(app, {
      uiAuthController: { ensureSessionToken },
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        getTunnelSessionFromRequest: () => null,
      },
      getUiNotificationClients: () => new Set(),
      ensureGlobalWatcherStarted,
    });

    const req = createMockRequest({ cookie: 'oc_tunnel_session=invalid' });
    const res = createMockResponse();
    await getRoute('GET', '/api/notifications/stream')(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.getHeader('set-cookie')).toBeUndefined();
    expect(ensureSessionToken).not.toHaveBeenCalled();
    expect(ensureGlobalWatcherStarted).not.toHaveBeenCalled();
  });

  it('terminates an existing notification stream when its client auth is revoked', async () => {
    vi.useFakeTimers();
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();
    const notificationAuth = createClientNotificationAuth('client-revoked');
    registerNotificationRoutes(app, {
      uiAuthController: {
        resolveNotificationAuth: async () => notificationAuth,
        validateNotificationAuth: async () => true,
      },
      getUiNotificationClients: () => clients,
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
      removePushSubscription: vi.fn(async () => {}),
      removeApnsToken: vi.fn(async () => {}),
    });

    const req = createMockRequest();
    const res = createMockResponse();
    await getRoute('GET', '/api/notifications/stream')(req, res);
    expect(clients.has(res)).toBe(true);

    invalidateNotificationAuth(notificationAuth);
    await Promise.resolve();

    expect(clients.has(res)).toBe(false);
    expect(res.ended).toBe(true);
    expect(req.listenerCount('close')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('terminates an existing notification stream when its auth expires', async () => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();
    const notificationAuth = createClientNotificationAuth('client-expiring', Date.now() + 10);
    registerNotificationRoutes(app, {
      uiAuthController: {
        resolveNotificationAuth: async () => notificationAuth,
        validateNotificationAuth: async () => true,
      },
      getUiNotificationClients: () => clients,
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    });

    const req = createMockRequest();
    const res = createMockResponse();
    await getRoute('GET', '/api/notifications/stream')(req, res);
    expect(clients.has(res)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(clients.has(res)).toBe(false);
    expect(res.ended).toBe(true);
    expect(req.listenerCount('close')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
  });

  it('rejects notification streams when auth validation is unknown or fails', async () => {
    for (const [clientId, validateNotificationAuth] of [
      ['client-validation-unknown', async () => null],
      ['client-validation-error', async () => { throw new Error('auth store unavailable'); }],
    ]) {
      const { app, getRoute } = createRouteRegistry();
      const clients = new Set();
      registerNotificationRoutes(app, {
        uiAuthController: {
          resolveNotificationAuth: async () => createClientNotificationAuth(clientId),
          validateNotificationAuth,
        },
        getUiNotificationClients: () => clients,
        ensureGlobalWatcherStarted: vi.fn(async () => {}),
      });
      const req = createMockRequest();
      const res = createMockResponse();

      await getRoute('GET', '/api/notifications/stream')(req, res);

      expect(res.statusCode).toBe(401);
      expect(clients.size).toBe(0);
      expect(res.body).not.toContain('openchamber:notification-stream-ready');
    }
  });

  it('terminates an established notification stream when revalidation becomes unknown', async () => {
    vi.useFakeTimers();
    try {
      const { app, getRoute } = createRouteRegistry();
      const clients = new Set();
      let validationCalls = 0;
      registerNotificationRoutes(app, {
        uiAuthController: {
          resolveNotificationAuth: async () => createClientNotificationAuth('client-lost-validation'),
          validateNotificationAuth: async () => {
            validationCalls += 1;
            return validationCalls === 1 ? true : null;
          },
        },
        getUiNotificationClients: () => clients,
        writeSseEvent(res, payload) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
      });
      const req = createMockRequest();
      const res = createMockResponse();
      await getRoute('GET', '/api/notifications/stream')(req, res);
      expect(clients.has(res)).toBe(true);

      await vi.advanceTimersByTimeAsync(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);

      expect(clients.has(res)).toBe(false);
      expect(res.ended).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not write from an orphaned heartbeat validation after stream cleanup', async () => {
    vi.useFakeTimers();
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();
    const notificationAuth = createClientNotificationAuth('client-closing');
    let resolveValidation;
    const validation = new Promise((resolve) => {
      resolveValidation = resolve;
    });
    registerNotificationRoutes(app, {
      uiAuthController: {
        resolveNotificationAuth: async () => notificationAuth,
        validateNotificationAuth: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            return calls === 1 ? true : validation;
          };
        })(),
      },
      getUiNotificationClients: () => clients,
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    });

    const req = createMockRequest();
    const res = createMockResponse();
    await getRoute('GET', '/api/notifications/stream')(req, res);
    const bodyBeforeHeartbeat = res.body;

    vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
    await Promise.resolve();
    req.emit('close');
    resolveValidation(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.body).toBe(bodyBeforeHeartbeat);
    expect(clients.has(res)).toBe(false);
    expect(req.listenerCount('close')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('serves OpenChamber SSE with nginx-safe headers', () => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    registerScheduledTaskRoutes(app, {
      getOpenChamberEventClients: () => clients,
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    });

    const handler = getRoute('GET', '/api/openchamber/events');
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/event-stream');
    expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
    expect(res.getHeader('connection')).toBe('keep-alive');
    expect(res.getHeader('x-accel-buffering')).toBe('no');
    expect(res.flushed).toBe(true);
    expect(res.body).toContain('openchamber:event-stream-ready');
    expect(clients.has(res)).toBe(true);

    req.emit('close');
    expect(clients.has(res)).toBe(false);
  });
});
