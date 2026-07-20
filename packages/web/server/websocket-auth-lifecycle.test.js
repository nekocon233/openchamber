import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import express from 'express';
import { WebSocket } from 'ws';

import { createDictationRuntime } from './lib/dictation/runtime.js';
import { createMessageStreamWsRuntime } from './lib/event-stream/runtime.js';
import {
  createClientNotificationAuth,
  invalidateNotificationAuth,
  notificationAuthMatchesSelector,
  subscribeNotificationAuthInvalidation,
} from './lib/notifications/auth-runtime.js';
import { createTunnelAuth } from './lib/opencode/tunnel-auth.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { createAuthChannelLifecycle } from './lib/ui-auth/channel-auth.js';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';

const createResponse = () => {
  let body = null;
  return {
    setHeader() {},
    status() { return this; },
    json(value) { body = value; return this; },
    get body() { return body; },
  };
};

const openSocket = (url, headers = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers });
  socket.once('open', () => resolve(socket));
  socket.once('unexpected-response', (_request, response) => {
    response.resume();
    reject(new Error(`Unexpected status ${response.statusCode}`));
  });
  socket.once('error', reject);
});

const rejectedUpgradeStatus = (url, headers = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers });
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error('Timed out waiting for upgrade rejection'));
  }, 1000);
  socket.once('unexpected-response', (_request, response) => {
    clearTimeout(timeout);
    const status = response.statusCode;
    response.resume();
    resolve(status);
  });
  socket.once('open', () => {
    clearTimeout(timeout);
    socket.terminate();
    reject(new Error('WebSocket unexpectedly opened'));
  });
  socket.on('error', () => {});
});

const createGlobalHub = () => ({
  subscribeEvent: () => () => {},
  subscribeStatus: () => () => {},
  replayAfter: () => [],
  isConnected: () => true,
  start() {},
  stop() {},
});

const runtimeCases = [
  {
    name: 'global event',
    path: '/api/global/event/ws',
    start({ app: _app, server, uiAuthController, tunnelAuthController, security, trackAuthChannel }) {
      const runtime = createMessageStreamWsRuntime({
        server,
        uiAuthController,
        tunnelAuthController,
        trackAuthChannel,
        isRequestOriginAllowed: security.isRequestOriginAllowed,
        rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
        buildOpenCodeUrl: () => 'http://127.0.0.1:4096/global/event',
        getOpenCodeAuthHeaders: () => ({}),
        processForwardedEventPayload() {},
        wsClients: new Set(),
        globalEventHub: createGlobalHub(),
      });
      return () => runtime.close();
    },
  },
  {
    name: 'terminal',
    path: '/api/terminal/ws',
    start({ app, server, uiAuthController, tunnelAuthController, security, trackAuthChannel }) {
      const runtime = createTerminalRuntime({
        app,
        server,
        fs,
        path,
        uiAuthController,
        tunnelAuthController,
        trackAuthChannel,
        buildAugmentedPath: () => process.env.PATH || '',
        searchPathFor: () => null,
        isExecutable: () => false,
        isRequestOriginAllowed: security.isRequestOriginAllowed,
        rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
        TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
      });
      return () => runtime.shutdown();
    },
  },
  {
    name: 'dictation',
    path: '/api/dictation/ws',
    start({ app, server, uiAuthController, tunnelAuthController, security, trackAuthChannel }) {
      const runtime = createDictationRuntime({
        app,
        server,
        express,
        uiAuthController,
        tunnelAuthController,
        trackAuthChannel,
        isRequestOriginAllowed: security.isRequestOriginAllowed,
        rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
        modelsDir: path.join(os.tmpdir(), 'openchamber-dictation-auth-test'),
      });
      return () => runtime.stop();
    },
  },
];

describe.each(runtimeCases)('$name relay websocket auth lifecycle', ({ name, path: socketPath, start }) => {
  it('enforces URL auth and origin, closes on revocation, and preserves direct local passwordless access', async () => {
    const clientId = `websocket-${name.replaceAll(' ', '-')}`;
    const app = express();
    const server = http.createServer(app);
    const tunnelAuthController = createTunnelAuth();
    const uiAuthController = createUiAuth({
      clientAuthController: {
        authenticateBearerToken: async (token) => token === `bearer-${clientId}`
          ? { ok: true, clientId, client: { id: clientId, revokedAt: null, expiresAt: null } }
          : null,
        listClients: async () => [{ id: clientId, revokedAt: null, expiresAt: null }],
      },
    });
    const security = createRequestSecurityRuntime({
      readSettingsFromDiskMigrated: async () => ({}),
    });
    const lifecycle = createAuthChannelLifecycle({
      subscribeInvalidation: subscribeNotificationAuthInvalidation,
      matchesSelector: notificationAuthMatchesSelector,
    });
    const stopRuntime = start({
      app,
      server,
      uiAuthController,
      tunnelAuthController,
      security,
      trackAuthChannel: lifecycle.track,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `ws://127.0.0.1:${port}${socketPath}`;
    const relayHeaders = {
      'x-openchamber-relay-connection': `relay-${clientId}`,
      origin: `http://127.0.0.1:${port}`,
    };
    const mintRes = createResponse();
    await uiAuthController.handleUrlAuthToken({
      method: 'POST',
      path: '/auth/url-token',
      headers: { authorization: `Bearer bearer-${clientId}` },
    }, mintRes);
    const authenticatedUrl = `${baseUrl}?oc_url_token=${encodeURIComponent(mintRes.body.token)}`;

    try {
      expect(await rejectedUpgradeStatus(baseUrl, relayHeaders)).toBe(401);
      expect(await rejectedUpgradeStatus(authenticatedUrl, {
        ...relayHeaders,
        origin: 'https://invalid.example',
      })).toBe(403);

      const relaySocket = await openSocket(authenticatedUrl, relayHeaders);
      const relayClosed = once(relaySocket, 'close');
      invalidateNotificationAuth(createClientNotificationAuth(clientId));
      const [closeCode] = await relayClosed;
      expect(closeCode).toBe(1008);

      expect(await rejectedUpgradeStatus(authenticatedUrl, relayHeaders)).toBe(401);

      const localSocket = await openSocket(baseUrl);
      const localClosed = once(localSocket, 'close');
      localSocket.close();
      await localClosed;
    } finally {
      await stopRuntime();
      lifecycle.dispose();
      uiAuthController.dispose();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 10_000);
});
