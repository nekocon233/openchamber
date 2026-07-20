import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';

type MockNotificationConstructor = {
  new (title: string, options?: NotificationOptions): Notification;
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};

const originalNotification = globalThis.Notification;
const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

const installNotificationMock = (onCreate: (title: string, options?: NotificationOptions) => void) => {
  const createdNotifications: Notification[] = [];
  const MockNotification = function Notification(this: Notification, title: string, options?: NotificationOptions) {
    Object.assign(this, { close: vi.fn(), onclick: null });
    createdNotifications.push(this);
    onCreate(title, options);
    return this;
  } as unknown as MockNotificationConstructor;
  MockNotification.permission = 'granted';
  MockNotification.requestPermission = vi.fn(async () => 'granted' as NotificationPermission);

  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
  return { getLastNotification: () => createdNotifications.at(-1) ?? null };
};

const installWindowMock = () => {
  const storage = new Map<string, string>();
  const focus = vi.fn();
  const assign = vi.fn();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      focus,
      location: {
        href: 'https://openchamber.example/',
        origin: 'https://openchamber.example',
        protocol: 'https:',
        assign,
      },
    },
  });
  return { assign, focus };
};

const createPushSubscription = (): PushSubscription => ({
  endpoint: 'https://push.example/subscription',
  expirationTime: null,
  options: { applicationServerKey: null, userVisibleOnly: true },
  getKey: vi.fn(() => null),
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({
    endpoint: 'https://push.example/subscription',
    keys: { p256dh: 'p256dh', auth: 'auth' },
  }),
} as unknown as PushSubscription);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: originalNotification });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('web notifications API', () => {
  it('deduplicates repeated foreground notifications by tag', async () => {
    installWindowMock();
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-session',
      kind: 'ready',
      sessionId: 'session',
      directory: '/workspace',
    })).resolves.toBe(true);
    await expect(api.notifyAgentCompletion({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-session',
      kind: 'ready',
      sessionId: 'session',
      directory: '/workspace',
    })).resolves.toBe(true);

    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('Ready');
  });

  it('focuses and navigates when the main-thread notification fallback is clicked', async () => {
    const { assign, focus } = installWindowMock();
    const { getLastNotification } = installNotificationMock(() => undefined);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

    const { createWebNotificationsAPI } = await import('./notifications');
    await expect(createWebNotificationsAPI().notifyAgentCompletion({
      title: 'Ready',
      tag: 'ready-actionable-fallback',
      kind: 'ready',
      sessionId: 'session-actionable',
      directory: '/workspace',
    })).resolves.toBe(true);

    const notification = getLastNotification();
    expect(notification?.onclick).toBeTypeOf('function');
    notification?.onclick?.call(notification, new Event('click'));

    expect(notification?.close).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/?session=session-actionable&directory=%2Fworkspace');
  });

  it('keeps local delivery eligible when a hidden page has only an unconfirmed local subscription', async () => {
    installWindowMock();
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));
    const showNotification = vi.fn(async () => undefined);
    const visibilityState: DocumentVisibilityState = 'hidden';
    const focused = false;

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        get visibilityState() {
          return visibilityState;
        },
        hasFocus: () => focused,
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification,
            pushManager: {
              getSubscription: vi.fn(async () => ({ endpoint: 'https://push.example/subscription' })),
            },
          })),
        },
      },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-session',
      kind: 'ready',
      sessionId: 'session',
      directory: '/workspace',
    })).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith('Ready', expect.objectContaining({
      body: 'Done',
      tag: 'ready-session',
      data: {
        url: '/?session=session&directory=%2Fworkspace',
        sessionId: 'session',
        directory: '/workspace',
        type: 'ready',
      },
    }));
    expect(created).toHaveLength(0);
  });

  it('defers hidden-page local delivery only after the active runtime confirms registration', async () => {
    installWindowMock();
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));
    const showNotification = vi.fn(async () => undefined);
    const subscription = createPushSubscription();

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        visibilityState: 'hidden',
        hasFocus: () => false,
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification,
            pushManager: { getSubscription: vi.fn(async () => subscription) },
          })),
        },
      },
    });

    const { registerRuntimeAPIs } = await import('@openchamber/ui/contexts/runtimeAPIRegistry');
    registerRuntimeAPIs({
      runtime: { platform: 'web', isDesktop: false, isVSCode: false },
      push: { subscribe: vi.fn(async () => ({ ok: true })) },
    } as unknown as RuntimeAPIs);
    const { registerBrowserPushSubscriptionWithActiveRuntime } = await import('@openchamber/ui/lib/browserPushRegistration');
    await expect(registerBrowserPushSubscriptionWithActiveRuntime(subscription)).resolves.toBe(true);

    const { createWebNotificationsAPI } = await import('./notifications');
    await expect(createWebNotificationsAPI().notifyAgentCompletion({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-confirmed-session',
      sessionId: 'session',
    })).resolves.toBe(true);

    expect(showNotification).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('falls back to local delivery when active-runtime registration fails', async () => {
    installWindowMock();
    installNotificationMock(() => undefined);
    const showNotification = vi.fn(async () => undefined);
    const subscription = createPushSubscription();

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'hidden', hasFocus: () => false },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification,
            pushManager: { getSubscription: vi.fn(async () => subscription) },
          })),
        },
      },
    });

    const { registerRuntimeAPIs } = await import('@openchamber/ui/contexts/runtimeAPIRegistry');
    registerRuntimeAPIs({
      runtime: { platform: 'web', isDesktop: false, isVSCode: false },
      push: { subscribe: vi.fn(async () => null) },
    } as unknown as RuntimeAPIs);
    const { registerBrowserPushSubscriptionWithActiveRuntime } = await import('@openchamber/ui/lib/browserPushRegistration');
    await expect(registerBrowserPushSubscriptionWithActiveRuntime(subscription)).resolves.toBe(false);

    const { createWebNotificationsAPI } = await import('./notifications');
    await expect(createWebNotificationsAPI().notifyAgentCompletion({
      title: 'Failed registration fallback',
      tag: 'ready-failed-registration',
    })).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('preserves hidden-only policy for a focused client with stale hidden visibility', async () => {
    installWindowMock();
    installNotificationMock(() => undefined);
    const showNotification = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'hidden', hasFocus: () => true },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({ active: {}, showNotification })),
        },
      },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();
    await expect(api.notifyAgentCompletion({
      title: 'Hidden only',
      tag: 'hidden-only-focused',
      requireHidden: true,
    })).resolves.toBe(true);
    expect(showNotification).not.toHaveBeenCalled();

    await expect(api.notifyAgentCompletion({
      title: 'Always',
      tag: 'always-focused',
      requireHidden: false,
    })).resolves.toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('leaves Electron notification runtime identity to the main process', async () => {
    installWindowMock();
    const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ command, args });
      return null;
    });
    Object.assign(globalThis.window, {
      __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:3000',
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3000',
      __OPENCHAMBER_DESKTOP__: { invoke },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    await expect(createWebNotificationsAPI().notifyAgentCompletion({
      title: 'Ready',
      sessionId: 'session-local',
      directory: '/local/repo',
    })).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith('desktop_notify', {
      payload: expect.objectContaining({
        sessionId: 'session-local',
        directory: '/local/repo',
      }),
    });
    const sentPayload = invokeCalls[0]?.args?.payload as Record<string, unknown> | undefined;
    expect(sentPayload).not.toHaveProperty('runtimeKey');
  });
});
