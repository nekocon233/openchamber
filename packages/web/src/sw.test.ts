import { afterEach, describe, expect, it, vi } from 'vitest';

type NotificationClickHandler = (event: {
  notification: {
    close(): void;
    data?: unknown;
    tag?: string;
  };
  waitUntil(promise: Promise<unknown>): void;
}) => void;

type ClientMock = {
  focused: boolean;
  visibilityState: 'hidden' | 'visible';
  frameType?: 'top-level' | 'nested';
  navigate: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  postMessage?: ReturnType<typeof vi.fn>;
};

const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');

const installServiceWorker = async (clients: ClientMock[] = []) => {
  const listeners = new Map<string, unknown>();
  const openWindow = vi.fn(async () => null);
  const matchAll = vi.fn(async () => clients);

  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: {
      __WB_MANIFEST: [],
      location: { origin: 'https://openchamber.example' },
      registration: { showNotification: vi.fn(async () => undefined) },
      clients: {
        claim: vi.fn(async () => undefined),
        matchAll,
        openWindow,
      },
      skipWaiting: vi.fn(async () => undefined),
      addEventListener: (type: string, listener: unknown) => listeners.set(type, listener),
    },
  });

  vi.resetModules();
  await import('./sw');

  return {
    handler: listeners.get('notificationclick') as NotificationClickHandler,
    matchAll,
    openWindow,
  };
};

const clickNotification = async (
  handler: NotificationClickHandler,
  notification: { data?: unknown; tag?: string },
) => {
  let pending: Promise<unknown> | undefined;
  const close = vi.fn();
  handler({
    notification: { ...notification, close },
    waitUntil: (promise) => {
      pending = promise;
    },
  });
  await pending;
  return { close };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalSelf) {
    Object.defineProperty(globalThis, 'self', originalSelf);
  } else {
    Reflect.deleteProperty(globalThis, 'self');
  }
});

describe('service worker notification clicks', () => {
  it('navigates and focuses an existing window without opening another one', async () => {
    const client = {
      focused: true,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
      postMessage: vi.fn(),
    };
    client.navigate.mockResolvedValue(client);
    const { handler, openWindow } = await installServiceWorker([client]);

    await clickNotification(handler, {
      data: {
        url: '/?session=ses_123&directory=%2Fworkspace',
        sessionId: 'ses_123',
        directory: '/workspace',
        type: 'ready',
      },
      tag: 'ready-ses_123',
    });

    expect(client.navigate).toHaveBeenCalledWith('https://openchamber.example/?session=ses_123&directory=%2Fworkspace');
    expect(client.postMessage).toHaveBeenCalledWith({
      type: 'openchamber:notification-click',
      url: 'https://openchamber.example/?session=ses_123&directory=%2Fworkspace',
      sessionId: 'ses_123',
      directory: '/workspace',
    });
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('recovers a session deep link from a legacy permission notification tag', async () => {
    const client = {
      focused: false,
      visibilityState: 'visible' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
    };
    client.navigate.mockResolvedValue(client);
    const { handler } = await installServiceWorker([client]);

    await clickNotification(handler, { tag: 'permission-ses_456:req_1' });

    expect(client.navigate).toHaveBeenCalledWith('https://openchamber.example/?session=ses_456');
    expect(client.focus).toHaveBeenCalledTimes(1);
  });

  it('focuses the existing page without navigating when no deep link exists', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
    };
    const { handler, openWindow } = await installServiceWorker([client]);

    await clickNotification(handler, { tag: 'test-notification' });

    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens one same-origin window when no existing client can be focused', async () => {
    const { handler, openWindow } = await installServiceWorker();

    await clickNotification(handler, { data: { sessionId: 'ses_789' }, tag: 'ready-ses_789' });

    expect(openWindow).toHaveBeenCalledWith('https://openchamber.example/?session=ses_789');
  });

  it('posts the session intent and focuses the app when client navigation is rejected', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(async () => {
        throw new Error('navigation unsupported');
      }),
      focus: vi.fn(async () => client),
      postMessage: vi.fn(),
    };
    const { handler, openWindow } = await installServiceWorker([client]);

    await clickNotification(handler, { data: { sessionId: 'ses_ios' }, tag: 'ready-ses_ios' });

    expect(client.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openchamber:notification-click',
      sessionId: 'ses_ios',
    }));
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('ignores nested frame clients and targets the top-level app window', async () => {
    const nested = {
      focused: true,
      visibilityState: 'visible' as const,
      frameType: 'nested' as const,
      navigate: vi.fn(),
      focus: vi.fn(),
      postMessage: vi.fn(),
    };
    const topLevel = {
      focused: false,
      visibilityState: 'hidden' as const,
      frameType: 'top-level' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => topLevel),
      postMessage: vi.fn(),
    };
    topLevel.navigate.mockResolvedValue(topLevel);
    const { handler } = await installServiceWorker([nested, topLevel]);

    await clickNotification(handler, { data: { sessionId: 'ses_top' }, tag: 'ready-ses_top' });

    expect(nested.postMessage).not.toHaveBeenCalled();
    expect(nested.navigate).not.toHaveBeenCalled();
    expect(topLevel.postMessage).toHaveBeenCalled();
    expect(topLevel.focus).toHaveBeenCalledTimes(1);
  });
});
