import { describe, expect, mock, test } from 'bun:test';
import {
  getNotificationReconnectDelay,
  startWebNotificationStream,
  toNotificationPayload,
} from './useWebNotificationStream';

describe('web notification stream payloads', () => {
  test('preserves session routing fields from server events', () => {
    expect(toNotificationPayload({
      type: 'openchamber:notification',
      properties: {
        title: 'Ready',
        body: 'Done',
        tag: 'ready-ses_123',
        kind: 'ready',
        sessionId: 'ses_123',
        directory: '/workspace',
        requireHidden: true,
      },
    })).toEqual({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-ses_123',
      kind: 'ready',
      sessionId: 'ses_123',
      directory: '/workspace',
      requireHidden: true,
    });
  });

  test('rejects unrelated events', () => {
    expect(toNotificationPayload({ type: 'session.updated', properties: {} })).toBeNull();
  });
});

describe('web notification stream transport', () => {
  test('uses the shared runtime path and aborts the old stream on runtime switch', async () => {
    const encoder = new TextEncoder();
    const fetchCalls: Array<{ input: string; signal: AbortSignal; credentials: RequestCredentials | undefined }> = [];
    const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    let triggerRuntimeChange = () => {};
    let unsubscribed = false;
    const received: unknown[] = [];

    const fetcher = mock(async (input: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamControllers.push(controller);
          signal.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('Aborted', 'AbortError'));
            } catch {
              // The stream may already be closed by the test.
            }
          }, { once: true });
        },
      });
      fetchCalls.push({ input, signal, credentials: init.credentials });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const stop = startWebNotificationStream({
      fetcher,
      heartbeatTimeoutMs: 60_000,
      onEvent: (value) => received.push(value),
      subscribeRuntimeChanged: (callback) => {
        triggerRuntimeChange = callback;
        return () => {
          unsubscribed = true;
          triggerRuntimeChange = () => {};
        };
      },
    });
    await Promise.resolve();

    expect(fetchCalls[0]?.input).toBe('/api/notifications/stream');
    expect(fetchCalls[0]?.credentials).toBe('same-origin');
    streamControllers[0]?.enqueue(encoder.encode(
      'data: {"type":"openchamber:notification-stream-ready","properties":{}}\n\n'
      + 'data: {"type":"openchamber:notification","properties":{"sessionId":"ses_a"}}\n\n',
    ));
    await Promise.resolve();
    await Promise.resolve();
    expect(received.find((value) => (
      value
      && typeof value === 'object'
      && (value as { type?: string }).type === 'openchamber:notification'
    ))).toEqual({
      type: 'openchamber:notification',
      properties: { sessionId: 'ses_a' },
    });

    triggerRuntimeChange();
    await Promise.resolve();
    expect(fetchCalls[0]?.signal.aborted).toBe(true);
    expect(fetchCalls).toHaveLength(2);

    stop();
    expect(fetchCalls[1]?.signal.aborted).toBe(true);
    expect(unsubscribed).toBe(true);
  });

  test('backs off exponentially with bounded long delays when hidden, offline, or unauthorized', () => {
    expect(getNotificationReconnectDelay(1)).toBe(1_000);
    expect(getNotificationReconnectDelay(10)).toBe(30_000);
    expect(getNotificationReconnectDelay(1, { visible: false })).toBe(30_000);
    expect(getNotificationReconnectDelay(10, { online: false })).toBe(300_000);
    expect(getNotificationReconnectDelay(1, { status: 401 })).toBe(60_000);
    expect(getNotificationReconnectDelay(1, { status: 429 })).toBe(1_000);
  });

  test('removes wake listeners and lets only one orphaned wake callback reconnect', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const activeWindowListeners = new Map<string, Set<() => void>>();
    const activeDocumentListeners = new Map<string, Set<() => void>>();
    const capturedOnline: Array<() => void> = [];
    const capturedVisibility: Array<() => void> = [];
    const add = (
      target: Map<string, Set<() => void>>,
      type: string,
      listener: () => void,
      captured: Array<() => void>,
    ) => {
      const listeners = target.get(type) ?? new Set<() => void>();
      listeners.add(listener);
      target.set(type, listeners);
      captured.push(listener);
    };
    const remove = (target: Map<string, Set<() => void>>, type: string, listener: () => void) => {
      target.get(type)?.delete(listener);
    };
    let fetchCalls = 0;
    let stop: (() => void) | null = null;

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          addEventListener: (type: string, listener: () => void) => add(activeWindowListeners, type, listener, capturedOnline),
          removeEventListener: (type: string, listener: () => void) => remove(activeWindowListeners, type, listener),
        },
      });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          visibilityState: 'visible',
          addEventListener: (type: string, listener: () => void) => add(activeDocumentListeners, type, listener, capturedVisibility),
          removeEventListener: (type: string, listener: () => void) => remove(activeDocumentListeners, type, listener),
        },
      });
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: true },
      });

      stop = startWebNotificationStream({
        fetcher: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 401 });
        },
        onEvent: () => {},
        subscribeRuntimeChanged: () => () => {},
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchCalls).toBe(1);

      const staleOnline = capturedOnline[0];
      const staleVisibility = capturedVisibility[0];
      staleOnline?.();
      staleVisibility?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchCalls).toBe(2);
      stop();
      stop = null;
      expect(activeWindowListeners.get('online')?.size ?? 0).toBe(0);
      expect(activeDocumentListeners.get('visibilitychange')?.size ?? 0).toBe(0);
    } finally {
      stop?.();
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});
