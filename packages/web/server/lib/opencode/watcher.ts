import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';
import { GLOBAL_EVENT_SOURCE_NATIVE } from '../event-stream/global-hub.js';
import type { JsonObject, JsonValue, TimeoutMs } from '../event-stream/contracts.js';
import type { GlobalEventSource, createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { UpstreamFetch } from '../event-stream/upstream-reader.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';

export interface OpenCodeWatcherConnectContext {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface OpenCodeWatcherPayloadContext {
  directory?: string | undefined;
  spaceId: string | null;
}

export interface OpenCodeWatcherDependencies {
  waitForOpenCodePort: () => Promise<number | null | void>;
  buildOpenCodeUrl: (route: string, prefix: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  onPayload: (payload: TranslatedEvent, options: OpenCodeWatcherPayloadContext) => void;
  onConnect?: ((context: OpenCodeWatcherConnectContext) => void | Promise<void>) | null;
  onDisconnect?: (() => void) | null;
  onWirePayload?: ((payload: JsonValue, options: { spaceId: string | null }) => void) | null;
  fetchImpl?: UpstreamFetch;
  upstreamStallTimeoutMs?: TimeoutMs;
  upstreamReconnectDelayMs?: TimeoutMs;
  globalEventHub?: Pick<ReturnType<typeof createGlobalMessageStreamHub>, 'subscribeEvent' | 'subscribeStatus' | 'start' | 'isConnected'> | null;
  eventSources?: readonly GlobalEventSource[] | undefined;
}

const isEventObject = (value: JsonValue | undefined): value is JsonObject => Boolean(value && typeof value === 'object');
const isString = (value: unknown): value is string => typeof value === 'string';
const isNativeTranslatedEvent = (value: unknown): value is TranslatedEvent => (
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'type' in value && typeof value.type === 'string'
);
const hasErrorFields = (value: unknown): value is { error?: unknown; message?: unknown } => value != null;
const errorFields = <Value>(value: Value) => hasErrorFields(value) ? value : undefined;

export const createOpenCodeWatcherRuntime = (deps: OpenCodeWatcherDependencies) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
    onConnect = null,
    onDisconnect = null,
    onWirePayload = null,
    fetchImpl = fetch,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs = 1000,
    globalEventHub = null,
    eventSources,
  } = deps;

  let abortController: AbortController | null = null;
  let reader: ReturnType<typeof createUpstreamSseReader> | null = null;
  let unsubscribeEvent: (() => void) | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  let connectController: AbortController | null = null;

  const retireConnectionRead = () => {
    connectController?.abort();
    connectController = null;
  };

  const emitTranslated = (payload: JsonValue, directory?: string, spaceId: string | null = null) => {
    onWirePayload?.(payload, { spaceId });
    for (const translated of translateWireEvent(payload)) onPayload(translated, { directory, spaceId });
  };

  const notifyConnected = () => {
    if (!onConnect || !abortController || abortController.signal.aborted) return;
    retireConnectionRead();
    const controller = new AbortController();
    connectController = controller;
    const isCurrent = () => connectController === controller && !controller.signal.aborted && !abortController?.signal.aborted;
    void Promise.resolve().then(() => (isCurrent() ? onConnect({ signal: controller.signal, isCurrent }) : undefined)).catch((error) => {
      if (!isCurrent()) return;
      console.warn('[PushWatcher] could not recover running sessions:', errorFields(error)?.message ?? error);
    });
  };

  const unwrapGlobalEventPayload = (eventData: JsonValue) => {
    if (!isEventObject(eventData)) {
      return null;
    }

    if (isEventObject(eventData.payload)) {
      return eventData.payload;
    }

    return eventData;
  };

  const normalizeEventDirectory = (directory: string | null | undefined): string | undefined => (
    isString(directory) && directory.length > 0 && directory !== 'global'
      ? directory
      : undefined
  );

  const start = async () => {
    if (abortController) {
      return;
    }

    abortController = new AbortController();
    const signal = abortController.signal;

    if (globalEventHub) {
      const subscriptionOptions = eventSources !== undefined
        ? { sources: eventSources, spaces: true }
        : { spaces: true };
      unsubscribeEvent = globalEventHub.subscribeEvent((event) => {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload) {
          return;
        }
        const spaceId = event.spaceId ?? null;
        onWirePayload?.(payload, { spaceId });
        const translated = event.translated?.() ?? (
          event.source === GLOBAL_EVENT_SOURCE_NATIVE
            ? (isNativeTranslatedEvent(payload) ? [payload] : [])
            : translateWireEvent(payload)
        );
        for (const item of translated) {
          onPayload(item, { directory: normalizeEventDirectory(event.directory), spaceId });
        }
      }, subscriptionOptions);
      unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
        if (signal.aborted) {
          return;
        }
        if (status.type === 'connect') {
          console.log('[PushWatcher] connected');
          notifyConnected();
          return;
        }
        if (status.type === 'disconnect') retireConnectionRead();
        if (status.type === 'error' || status.type === 'initial-error') {
          retireConnectionRead();
          console.warn('[PushWatcher] disconnected', errorFields(errorFields(status.error)?.error)?.message ?? errorFields(status.error)?.message ?? status.error);
        }
        if (status.type === 'disconnect' || status.type === 'error' || status.type === 'initial-error') onDisconnect?.();
      });
      await waitForOpenCodePort();
      if (signal.aborted) {
        return;
      }
      globalEventHub.start();
      if (globalEventHub.isConnected()) notifyConnected();
      return;
    }

    await waitForOpenCodePort();
    if (signal.aborted) {
      return;
    }

    reader = createUpstreamSseReader({
      signal,
      buildUrl: () => buildOpenCodeUrl('/api/event', ''),
      getHeaders: getOpenCodeAuthHeaders,
      fetchImpl,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      onConnect() {
        console.log('[PushWatcher] connected');
        notifyConnected();
      },
      onEvent(event) {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload) {
          return;
        }
        emitTranslated(payload, normalizeEventDirectory(event.directory), null);
      },
      onDisconnect() {
        retireConnectionRead();
        onDisconnect?.();
      },
      onError(error) {
        retireConnectionRead();
        if (signal.aborted) {
          return;
        }
        console.warn('[PushWatcher] disconnected', errorFields(errorFields(error)?.error)?.message ?? errorFields(error)?.message ?? error);
        onDisconnect?.();
      },
    });

    void reader.start();
  };

  const stop = () => {
    if (!abortController) {
      return;
    }
    try {
      retireConnectionRead();
      abortController.abort();
      reader?.stop();
      unsubscribeEvent?.();
      unsubscribeStatus?.();
    } catch {
      reader = null;
    }
    reader = null;
    unsubscribeEvent = null;
    unsubscribeStatus = null;
    abortController = null;
  };

  return {
    start,
    stop,
  };
};
