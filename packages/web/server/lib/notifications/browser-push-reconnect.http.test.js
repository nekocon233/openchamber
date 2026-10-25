import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import webPush from 'web-push';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { createNotificationEmitterRuntime } from './emitter-runtime.js';
import { createPushRuntime } from './push-runtime.js';
import { registerNotificationRoutes } from './routes.js';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { getRuntimeKey } from '@openchamber/ui/lib/runtime-switch';
import { getBrowserPushRegistrationState } from '@openchamber/ui/lib/browserPushRegistration';
import { useBrowserPushSubscriptionReconciliation } from '@openchamber/ui/hooks/useBrowserPushSubscriptionReconciliation';
import { subscribeOpenchamberEvents } from '@openchamber/ui/lib/openchamberEvents';
import { createWebPushAPI } from '@web/api/push';

// The DOM fixture belongs to the UI workspace's declared test dependencies.
const { Window } = createRequire(new URL('../../../../ui/package.json', import.meta.url))('happy-dom');

const Probe = ({ enabled = true }) => {
  useBrowserPushSubscriptionReconciliation({ enabled });
  return null;
};

// The browser boundary uses fetch to drive the real authenticated control SSE
// route. Reconnect scheduling remains owned by the shared production transport.
const createEventSource = (browserFetch) => class FetchEventSource {
  static CLOSED = 2;
  static instances = [];
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  abort = new AbortController();

  constructor(url) {
    this.constructor.instances.push(this);
    void this.read(url);
  }

  async read(url) {
    try {
      const response = await browserFetch(url, { signal: this.abort.signal });
      if (!response.ok || !response.body) throw new Error('Event stream unavailable');
      this.readyState = 1;
      this.onopen?.();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += value;
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.startsWith('data: ')) this.onmessage?.({ data: line.slice(6) });
          newline = buffered.indexOf('\n');
        }
      }
    } catch {
      // Closing the HTTP server or aborting the source ends the browser stream.
    }
    if (this.readyState !== FetchEventSource.CLOSED) this.onerror?.();
  }

  close() {
    this.readyState = FetchEventSource.CLOSED;
    this.abort.abort();
  }
};

describe('browser push after an authenticated backend restart', () => {
  it.each(['desktop', 'mobile'])('restores the existing subscription on the %s web surface', async (surface) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-push-reconnect-'));
    const settings = { vapidKeys: webPush.generateVAPIDKeys(), publicOrigin: 'https://push-fixture.test' };
    const settingsPath = path.join(directory, 'settings.json');
    await writeFile(settingsPath, JSON.stringify(settings));
    const subscriptionsPath = path.join(directory, 'push-subscriptions.json');
    const sent = vi.fn(async () => {});
    const nativeFetch = globalThis.fetch;
    let cookie = '';
    const browserFetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('Cookie', cookie);
      const response = await nativeFetch(input, { ...init, headers });
      const issuedCookie = response.headers.get('set-cookie');
      if (issuedCookie) cookie = issuedCookie.split(';')[0];
      return response;
    };

    const startBackend = async (port = 0) => {
      const auth = createUiAuth();
      const clients = new Set();
      const emitter = createNotificationEmitterRuntime({
        process,
        getDesktopNotifyEnabled: () => false,
        desktopNotifyPrefix: '',
        getUiNotificationClients: () => new Set(),
        getOpenChamberEventClients: () => clients,
      });
      const push = createPushRuntime({
        fsPromises: { mkdir, readFile, writeFile },
        path,
        loadWebPush: async () => ({ ...webPush, sendNotification: sent }),
        PUSH_SUBSCRIPTIONS_FILE_PATH: subscriptionsPath,
        readSettingsFromDiskMigrated: async () => JSON.parse(await readFile(settingsPath, 'utf8')),
        writeSettingsToDisk: (next) => writeFile(settingsPath, JSON.stringify(next)),
      });
      const app = express();
      app.use(express.json());
      app.use('/api', auth.requireAuth);
      registerScheduledTaskRoutes(app, {
        getOpenChamberEventClients: () => clients,
        writeSseEvent: emitter.writeSseEvent,
      });
      registerNotificationRoutes(app, {
        ...push,
        uiAuthController: auth,
        readSettingsFromDiskMigrated: async () => settings,
        writeSettingsToDisk: async () => {},
      });
      const server = createServer(app);
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return {
        port: server.address().port,
        push,
        stop: async () => {
          for (const client of clients) client.end();
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          auth.dispose();
        },
      };
    };

    let backend = await startBackend();
    const base = `http://127.0.0.1:${backend.port}`;
    const dom = new Window({ url: base });
    const originals = new Map();
    const EventSourceFixture = createEventSource(browserFetch);
    const requestPermission = vi.fn();
    const localSubscribe = vi.fn();
    const unsubscribe = vi.fn(async () => true);
    const subscription = {
      endpoint: 'https://push.example/existing',
      options: { applicationServerKey: Uint8Array.from(Buffer.from(settings.vapidKeys.publicKey, 'base64url')).buffer },
      unsubscribe,
      toJSON: () => ({ endpoint: 'https://push.example/existing', keys: { p256dh: 'fixture-p256dh', auth: 'fixture-auth' } }),
    };
    Object.defineProperty(dom.navigator, 'serviceWorker', {
      value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription, subscribe: localSubscribe } }) },
    });
    Object.assign(dom, { __OPENCHAMBER_SURFACE__: surface, __OPENCHAMBER_RUNTIME_APIS__: { push: createWebPushAPI() } });
    for (const [name, value] of Object.entries({
      window: dom, document: dom.document, navigator: dom.navigator,
      Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
      Event: dom.Event, CustomEvent: dom.CustomEvent,
      EventSource: EventSourceFixture, Notification: { permission: 'granted', requestPermission },
      fetch: browserFetch, IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    configureRuntimeUrlResolver({ apiBaseUrl: base, realtimeBaseUrl: base });
    const runtimeKey = getRuntimeKey();
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const stopControlConsumer = subscribeOpenchamberEvents(() => {});
    try {
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))));
      await vi.waitFor(() => expect(getBrowserPushRegistrationState().status).toBe('confirmed'));
      expect(EventSourceFixture.instances).toHaveLength(1);
      await backend.push.sendPushToAllUiSessions({ title: 'Before restart' });
      expect(sent).toHaveBeenCalledTimes(1);

      const firstSource = EventSourceFixture.instances[0];
      const port = backend.port;
      await backend.stop();
      backend = await startBackend(port);
      // A passwordless restart changes the auth generation. Delivery resumes
      // after the page registers under the new server identity.
      await backend.push.sendPushToAllUiSessions({ title: 'Before reconnect' });
      expect(sent).toHaveBeenCalledTimes(1);
      await vi.waitFor(async () => {
        const store = JSON.parse(await readFile(subscriptionsPath, 'utf8'));
        expect(Object.values(store.registrationsByIdentity)).toHaveLength(1);
        expect(getBrowserPushRegistrationState().status).toBe('confirmed');
      }, { timeout: 5_000 });
      expect(getRuntimeKey()).toBe(runtimeKey);
      expect(firstSource.readyState).toBe(EventSourceFixture.CLOSED);
      expect(EventSourceFixture.instances).toHaveLength(2);

      await backend.push.sendPushToAllUiSessions({ title: 'After reconnect' });
      expect(sent).toHaveBeenCalledTimes(2);
      expect(localSubscribe).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(requestPermission).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      stopControlConsumer();
      configureRuntimeUrlResolver({});
      await backend.stop();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      await dom.happyDOM.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
