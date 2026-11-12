import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';
import { GLOBAL_EVENT_SOURCE_NATIVE } from '../event-stream/global-hub.js';

export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
    onConnect,
    fetchImpl = fetch,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs = 1000,
    globalEventHub = null,
    // Hub event sources forwarded to onPayload; see GLOBAL_EVENT_SOURCE_* in
    // event-stream/global-hub.js. Undefined keeps the hub default.
    eventSources,
  } = deps;

  let abortController = null;
  let reader = null;
  let unsubscribeEvent = null;
  let unsubscribeStatus = null;
  let connectController = null;
  const retireConnectionRead = () => {
    connectController?.abort();
    connectController = null;
  };

  // `onPayload` consumers speak the server's own event vocabulary, so the v2
  // wire payload is translated here rather than in each consumer.
  const emitTranslated = (payload, directory) => {
    for (const translated of translateWireEvent(payload)) onPayload(translated, { directory, spaceId: null });
  };

  const notifyConnected = () => {
    if (!onConnect || !abortController || abortController.signal.aborted) return;
    retireConnectionRead();
    const controller = new AbortController();
    connectController = controller;
    const isCurrent = () => connectController === controller && !controller.signal.aborted && !abortController?.signal.aborted;
    void Promise.resolve().then(() => isCurrent() ? onConnect({ signal: controller.signal, isCurrent }) : undefined).catch((error) => {
      if (!isCurrent()) return;
      console.warn('[PushWatcher] could not recover running sessions:', error?.message ?? error);
    });
  };

  const unwrapGlobalEventPayload = (eventData) => {
    if (!eventData || typeof eventData !== 'object') {
      return null;
    }

    if (eventData.payload && typeof eventData.payload === 'object') {
      return eventData.payload;
    }

    return eventData;
  };

  const normalizeEventDirectory = (directory) => (
    typeof directory === 'string' && directory.length > 0 && directory !== 'global'
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
      // Subscribe before OpenCode is reachable: native CLI sessions publish
      // into the hub without depending on the OpenCode upstream.
      // The events of isolated spaces feed this watcher too, so live status, unread marks and
      // notifications work for a space's sessions as for the host's.
      unsubscribeEvent = globalEventHub.subscribeEvent((event) => {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload || typeof payload !== 'object') {
          return;
        }
        const translated = event.translated?.() ?? (event.source === GLOBAL_EVENT_SOURCE_NATIVE ? [payload] : translateWireEvent(payload));
        for (const item of translated) onPayload(item, { directory: normalizeEventDirectory(event.directory), spaceId: event.spaceId ?? null });
      }, { sources: eventSources, spaces: true });
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
          console.warn('[PushWatcher] disconnected', status.error?.error?.message ?? status.error?.message ?? status.error);
        }
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
      onDisconnect() {
        retireConnectionRead();
      },
      onEvent(event) {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload || typeof payload !== 'object') {
          return;
        }
        emitTranslated(payload, normalizeEventDirectory(event.directory));
      },
      onError(error) {
        retireConnectionRead();
        if (signal.aborted) {
          return;
        }
        console.warn('[PushWatcher] disconnected', error?.error?.message ?? error?.message ?? error);
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
