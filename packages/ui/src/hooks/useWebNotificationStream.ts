import React from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import type { NotificationPayload } from '@/lib/api/types';
import { handleSidebarStateGlobalEvent } from '@/stores/useSidebarStateStore';

const NOTIFICATION_STREAM_PATH = '/api/notifications/stream';
const NOTIFICATION_STREAM_HEARTBEAT_TIMEOUT_MS = 45_000;
const NORMAL_RECONNECT_CAP_MS = 30_000;
const CONSTRAINED_RECONNECT_CAP_MS = 300_000;

type NotificationStreamFetcher = (input: string, init: RequestInit) => Promise<Response>;

type WebNotificationStreamOptions = {
  onEvent(value: unknown): void;
  fetcher?: NotificationStreamFetcher;
  subscribeRuntimeChanged?: (callback: () => void) => () => void;
  heartbeatTimeoutMs?: number;
};

class NotificationStreamResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Notification stream request failed with status ${status}`);
    this.status = status;
  }
}

const isFocused = () => {
  if (typeof document === 'undefined') return true;
  return document.hasFocus();
};

const isPermanentClientError = (status?: number): boolean => (
  typeof status === 'number'
  && status >= 400
  && status < 500
  && status !== 408
  && status !== 429
);

export const getNotificationReconnectDelay = (
  attempt: number,
  options: { status?: number; online?: boolean; visible?: boolean } = {},
): number => {
  const normalizedAttempt = Math.max(1, Math.min(Math.trunc(attempt) || 1, 10));
  const exponentialDelay = 1_000 * (2 ** (normalizedAttempt - 1));
  const constrained = options.online === false
    || options.visible === false
    || isPermanentClientError(options.status);
  if (!constrained) return Math.min(exponentialDelay, NORMAL_RECONNECT_CAP_MS);

  const floor = isPermanentClientError(options.status) ? 60_000 : 30_000;
  return Math.min(Math.max(exponentialDelay, floor), CONSTRAINED_RECONNECT_CAP_MS);
};

const parseSseBlock = (block: string): string | null => {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== 'data') continue;
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    data.push(rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue);
  }
  return data.length > 0 ? data.join('\n') : null;
};

const consumeSseStream = async (
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
  onData: (data: string) => void,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
        buffer = buffer.slice(boundary + separator.length);
        const data = parseSseBlock(block);
        if (data !== null) onData(data);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }

    buffer += decoder.decode();
    const data = parseSseBlock(buffer);
    if (data !== null) onData(data);
  } finally {
    reader.releaseLock();
  }
};

export const startWebNotificationStream = (options: WebNotificationStreamOptions): (() => void) => {
  const fetcher = options.fetcher ?? ((input, init) => runtimeFetch(input, init));
  const subscribeRuntimeChanged = options.subscribeRuntimeChanged
    ?? ((callback) => subscribeRuntimeEndpointChanged(callback));
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? NOTIFICATION_STREAM_HEARTBEAT_TIMEOUT_MS;

  let disposed = false;
  let generation = 0;
  let reconnectAttempt = 0;
  let activeAbort: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let removeWakeListeners: (() => void) | null = null;

  const clearReconnectWait = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    removeWakeListeners?.();
    removeWakeListeners = null;
  };

  const scheduleReconnect = (expectedGeneration: number, status?: number) => {
    if (disposed || generation !== expectedGeneration || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = getNotificationReconnectDelay(reconnectAttempt, {
      status,
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      visible: typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
    });

    const reconnect = () => {
      // Timeout, online, and visibility callbacks can already be queued together.
      // Only the first callback may consume this reconnect wait.
      if (reconnectTimer === null) return;
      if (disposed || generation !== expectedGeneration) return;
      clearReconnectWait();
      connect(expectedGeneration);
    };

    reconnectTimer = setTimeout(reconnect, delay);
    if (typeof window !== 'undefined') {
      const handleOnline = () => reconnect();
      const handleVisibility = () => {
        if (document.visibilityState === 'visible') reconnect();
      };
      window.addEventListener('online', handleOnline);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility);
      removeWakeListeners = () => {
        window.removeEventListener('online', handleOnline);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility);
      };
    }
  };

  const connect = (expectedGeneration: number) => {
    if (disposed || generation !== expectedGeneration) return;
    const controller = new AbortController();
    activeAbort = controller;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let healthy = false;
    let responseStatus: number | undefined;

    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => controller.abort(), heartbeatTimeoutMs);
    };

    void (async () => {
      try {
        resetHeartbeat();
        const response = await fetcher(NOTIFICATION_STREAM_PATH, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: controller.signal,
        });
        responseStatus = response.status;
        if (!response.ok) throw new NotificationStreamResponseError(response.status);
        if (!response.body) throw new Error('Notification stream response body missing');
        resetHeartbeat();

        await consumeSseStream(response.body, resetHeartbeat, (raw) => {
          let value: unknown;
          try {
            value = JSON.parse(raw) as unknown;
          } catch {
            return;
          }

          if (
            value
            && typeof value === 'object'
            && (value as Record<string, unknown>).type === 'openchamber:notification-stream-ready'
          ) {
            healthy = true;
            reconnectAttempt = 0;
          }

          try {
            handleSidebarStateGlobalEvent(value);
            options.onEvent(value);
          } catch {
            // A consumer failure must not tear down the shared runtime stream.
          }
        });
      } catch (error) {
        if (error instanceof NotificationStreamResponseError) responseStatus = error.status;
      } finally {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (activeAbort === controller) activeAbort = null;
      }

      if (disposed || generation !== expectedGeneration) return;
      if (healthy) reconnectAttempt = 0;
      scheduleReconnect(expectedGeneration, responseStatus);
    })();
  };

  const restart = () => {
    generation += 1;
    clearReconnectWait();
    activeAbort?.abort();
    activeAbort = null;
    reconnectAttempt = 0;
    connect(generation);
  };

  const unsubscribeRuntimeChanged = subscribeRuntimeChanged(restart);
  restart();

  return () => {
    disposed = true;
    generation += 1;
    unsubscribeRuntimeChanged();
    clearReconnectWait();
    activeAbort?.abort();
    activeAbort = null;
  };
};

export const toNotificationPayload = (value: unknown): NotificationPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const properties = record.properties && typeof record.properties === 'object'
    ? record.properties as Record<string, unknown>
    : null;
  if (record.type !== 'openchamber:notification' || !properties) return null;
  return {
    title: typeof properties.title === 'string' ? properties.title : undefined,
    body: typeof properties.body === 'string' ? properties.body : undefined,
    tag: typeof properties.tag === 'string' ? properties.tag : undefined,
    kind: typeof properties.kind === 'string' ? properties.kind : undefined,
    sessionId: typeof properties.sessionId === 'string' ? properties.sessionId : undefined,
    directory: typeof properties.directory === 'string' ? properties.directory : undefined,
    requireHidden: properties.requireHidden === true,
  };
};

export const useWebNotificationStream = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;

  React.useEffect(() => {
    if (!enabled || isDesktopShell() || !isWebRuntime() || typeof window === 'undefined') return;

    return startWebNotificationStream({
      onEvent: (data) => {
        const payload = toNotificationPayload(data);
        if (!payload) return;

        const settings = useUIStore.getState();
        if (!settings.nativeNotificationsEnabled) return;
        if (settings.notificationMode !== 'always' && isFocused()) return;

        const apis = getRegisteredRuntimeAPIs();
        void apis?.notifications?.notifyAgentCompletion(payload);
      },
    });
  }, [enabled]);
};
