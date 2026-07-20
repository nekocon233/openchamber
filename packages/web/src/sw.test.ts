import { afterEach, describe, expect, it, vi } from 'vitest';

type NotificationClickHandler = (event: {
  notification: {
    close(): void;
    data?: unknown;
    tag?: string;
  };
  waitUntil(promise: Promise<unknown>): void;
}) => void;

type PushHandler = (event: {
  data?: { json(): unknown };
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

const createAcknowledgingPostMessage = (installed: boolean | undefined) => vi.fn((_message: unknown, transfer?: Transferable[]) => {
  const port = transfer?.[0] as MessagePort | undefined;
  port?.postMessage({
    type: 'openchamber:notification-click-ack',
    ...(installed === undefined ? {} : { installed }),
  });
});

const installServiceWorker = async (clients: ClientMock[] = []) => {
  const listeners = new Map<string, unknown>();
  const openWindow = vi.fn(async () => null);
  const matchAll = vi.fn(async () => clients);
  const showNotification = vi.fn(async () => undefined);

  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: {
      __WB_MANIFEST: [],
      location: { origin: 'https://openchamber.example' },
      registration: { showNotification },
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
    clickHandler: listeners.get('notificationclick') as NotificationClickHandler,
    matchAll,
    openWindow,
    pushHandler: listeners.get('push') as PushHandler,
    showNotification,
  };
};

const pushNotification = async (handler: PushHandler, payload: unknown) => {
  let pending: Promise<unknown> | undefined;
  handler({
    data: { json: () => payload },
    waitUntil: (promise) => {
      pending = promise;
    },
  });
  await pending;
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
  it('focuses an existing window without reloading after the app accepts the intent', async () => {
    const client = {
      focused: true,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
      postMessage: createAcknowledgingPostMessage(false),
    };
    client.navigate.mockResolvedValue(client);
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, {
      data: {
        url: '/?session=ses_123&directory=%2Fworkspace',
        sessionId: 'ses_123',
        directory: '/workspace',
        type: 'ready',
      },
      tag: 'ready-ses_123',
    });

    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith(
      {
        type: 'openchamber:notification-click',
        url: 'https://openchamber.example/?session=ses_123&directory=%2Fworkspace',
        sessionId: 'ses_123',
        directory: '/workspace',
      },
      [expect.anything()],
    );
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('uses one focus operation after a browser client acknowledges the intent', async () => {
    const calls: string[] = [];
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => {
        calls.push('focus');
        return client;
      }),
      postMessage: vi.fn((_message: unknown, transfer?: Transferable[]) => {
        calls.push('postMessage');
        const port = transfer?.[0] as MessagePort | undefined;
        setTimeout(() => {
          calls.push('ack');
          port?.postMessage({ type: 'openchamber:notification-click-ack', installed: false });
        }, 0);
      }),
    };
    client.navigate.mockResolvedValue(client);
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, { data: { sessionId: 'ses_windows' }, tag: 'ready-ses_windows' });

    expect(calls).toEqual(['postMessage', 'ack', 'focus']);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('retries another client when the acknowledged client closes before focus', async () => {
    const closingClient = {
      focused: true,
      visibilityState: 'visible' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => {
        throw new Error('client closed');
      }),
      postMessage: createAcknowledgingPostMessage(false),
    };
    const fallbackClient = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => fallbackClient),
      postMessage: createAcknowledgingPostMessage(false),
    };
    const { clickHandler, openWindow } = await installServiceWorker([closingClient, fallbackClient]);

    await clickNotification(clickHandler, {
      data: { sessionId: 'ses_retry', directory: '/workspace/retry' },
      tag: 'ready-ses_retry',
    });

    expect(closingClient.focus).toHaveBeenCalledTimes(1);
    expect(fallbackClient.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ses_retry',
        directory: '/workspace/retry',
      }),
      [expect.anything()],
    );
    expect(fallbackClient.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens the unchanged target after every acknowledged client disappears', async () => {
    const createClosingClient = () => ({
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => null),
      postMessage: createAcknowledgingPostMessage(false),
    });
    const first = createClosingClient();
    const second = createClosingClient();
    const { clickHandler, openWindow } = await installServiceWorker([first, second]);

    await clickNotification(clickHandler, {
      data: { sessionId: 'ses_open_fallback', directory: '/workspace/original' },
      tag: 'ready-ses_open_fallback',
    });

    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(second.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(
      'https://openchamber.example/?session=ses_open_fallback&directory=%2Fworkspace%2Foriginal',
    );
  });

  it('uses one openWindow operation for an installed PWA client', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
      postMessage: createAcknowledgingPostMessage(true),
    };
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, {
      data: { sessionId: 'ses_windows_pwa', directory: '/workspace' },
      tag: 'ready-ses_windows_pwa',
    });

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(
      'https://openchamber.example/?session=ses_windows_pwa&directory=%2Fworkspace',
    );
    expect(client.focus).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
  });

  it('uses the launcher-safe path for an old client acknowledgement without display mode', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
      postMessage: createAcknowledgingPostMessage(undefined),
    };
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, { data: { sessionId: 'ses_legacy_ack' }, tag: 'ready-ses_legacy_ack' });

    expect(openWindow).toHaveBeenCalledWith('https://openchamber.example/?session=ses_legacy_ack');
    expect(client.focus).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
  });

  it('opens the target once when an app client does not acknowledge', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
      postMessage: vi.fn(),
    };
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, { data: { sessionId: 'ses_no_ack' }, tag: 'ready-ses_no_ack' });

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith('https://openchamber.example/?session=ses_no_ack');
    expect(client.focus).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
  });

  it('focuses an installed PWA in place for a targetless notification', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
      postMessage: createAcknowledgingPostMessage(true),
    };
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, { data: { url: '/' }, tag: 'openchamber-test' });

    expect(client.postMessage).not.toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
  });

  it('recovers a session deep link from a legacy permission notification tag', async () => {
    const client = {
      focused: false,
      visibilityState: 'visible' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => client),
    };
    client.navigate.mockResolvedValue(client);
    const { clickHandler } = await installServiceWorker([client]);

    await clickNotification(clickHandler, { tag: 'permission-ses_456:req_1' });

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
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, { tag: 'test-notification' });

    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens one same-origin window when no existing client can be focused', async () => {
    const { clickHandler, openWindow } = await installServiceWorker();

    await clickNotification(clickHandler, { data: { sessionId: 'ses_789' }, tag: 'ready-ses_789' });

    expect(openWindow).toHaveBeenCalledWith('https://openchamber.example/?session=ses_789');
  });

  it('uses explicit session target fields when the payload URL conflicts', async () => {
    const { clickHandler, openWindow } = await installServiceWorker();

    await clickNotification(clickHandler, {
      data: {
        url: '/?session=ses_stale&directory=%2Fstale',
        sessionId: 'ses_current',
        directory: '/current',
      },
      tag: 'ready-ses_current',
    });

    expect(openWindow).toHaveBeenCalledWith(
      'https://openchamber.example/?session=ses_current&directory=%2Fcurrent',
    );
  });

  it('opens the durable target once when intent delivery fails', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(async () => {
        throw new Error('navigation unsupported');
      }),
      focus: vi.fn(async () => client),
      postMessage: vi.fn(() => {
        throw new Error('client not ready');
      }),
    };
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, { data: { sessionId: 'ses_ios' }, tag: 'ready-ses_ios' });

    expect(client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'openchamber:notification-click',
        sessionId: 'ses_ios',
      }),
      [expect.anything()],
    );
    expect(client.focus).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith('https://openchamber.example/?session=ses_ios');
  });

  it('ignores nested frame clients and targets the top-level app window', async () => {
    const nested = {
      focused: true,
      visibilityState: 'visible' as const,
      frameType: 'nested' as const,
      navigate: vi.fn(),
      focus: vi.fn(),
      postMessage: createAcknowledgingPostMessage(false),
    };
    const topLevel = {
      focused: false,
      visibilityState: 'hidden' as const,
      frameType: 'top-level' as const,
      navigate: vi.fn(),
      focus: vi.fn(async () => topLevel),
      postMessage: createAcknowledgingPostMessage(false),
    };
    topLevel.navigate.mockResolvedValue(topLevel);
    const { clickHandler } = await installServiceWorker([nested, topLevel]);

    await clickNotification(clickHandler, { data: { sessionId: 'ses_top' }, tag: 'ready-ses_top' });

    expect(nested.postMessage).not.toHaveBeenCalled();
    expect(nested.navigate).not.toHaveBeenCalled();
    expect(topLevel.postMessage).toHaveBeenCalled();
    expect(topLevel.focus).toHaveBeenCalledTimes(1);
  });

  it('opens the durable target when navigation returns no client', async () => {
    const client = {
      focused: false,
      visibilityState: 'hidden' as const,
      navigate: vi.fn(async () => null),
      focus: vi.fn(async () => client),
    };
    const { clickHandler, openWindow } = await installServiceWorker([client]);

    await clickNotification(clickHandler, {
      data: { sessionId: 'ses_null', directory: '/workspace' },
      tag: 'ready-ses_null',
    });

    expect(client.focus).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith('https://openchamber.example/?session=ses_null&directory=%2Fworkspace');
  });

  it('keeps a targetless notification targetless when opening the app', async () => {
    const { clickHandler, openWindow } = await installServiceWorker();

    await clickNotification(clickHandler, { tag: 'openchamber-test' });

    expect(openWindow).toHaveBeenCalledWith('https://openchamber.example/');
  });
});

describe('service worker push delivery', () => {
  it('shows push when a top-level window is visible but unfocused', async () => {
    const client = {
      focused: false,
      visibilityState: 'visible' as const,
      frameType: 'top-level' as const,
      navigate: vi.fn(),
      focus: vi.fn(),
    };
    const { pushHandler, showNotification } = await installServiceWorker([client]);

    await pushNotification(pushHandler, { title: 'Ready', body: 'Done', tag: 'ready-ses_1' });

    expect(showNotification).toHaveBeenCalledWith('Ready', expect.objectContaining({
      body: 'Done',
      tag: 'ready-ses_1',
    }));
  });

  it('suppresses push for a focused top-level window even if visibility reports hidden', async () => {
    const client = {
      focused: true,
      visibilityState: 'hidden' as const,
      frameType: 'top-level' as const,
      navigate: vi.fn(),
      focus: vi.fn(),
    };
    const { pushHandler, showNotification } = await installServiceWorker([client]);

    await pushNotification(pushHandler, { title: 'Ready' });

    expect(showNotification).not.toHaveBeenCalled();
  });

  it('does not let a focused nested frame suppress push', async () => {
    const nested = {
      focused: true,
      visibilityState: 'visible' as const,
      frameType: 'nested' as const,
      navigate: vi.fn(),
      focus: vi.fn(),
    };
    const { pushHandler, showNotification } = await installServiceWorker([nested]);

    await pushNotification(pushHandler, { title: 'Ready' });

    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});
