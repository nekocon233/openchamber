import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';
import { GLOBAL_EVENT_SOURCE_NATIVE } from '../event-stream/global-hub.js';

export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
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

  // `onPayload` consumers speak the server's own event vocabulary, so the v2
  // wire payload is translated here rather than in each consumer.
  const emitTranslated = (payload, directory) => {
    for (const translated of translateWireEvent(payload)) onPayload(translated, directory);
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
        for (const item of translated) onPayload(item, normalizeEventDirectory(event.directory));
      }, { sources: eventSources, spaces: true });
      unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
        if (signal.aborted) {
          return;
        }
        if (status.type === 'connect') {
          console.log('[PushWatcher] connected');
          return;
        }
        if (status.type === 'error' || status.type === 'initial-error') {
          console.warn('[PushWatcher] disconnected', status.error?.error?.message ?? status.error?.message ?? status.error);
        }
      });
      await waitForOpenCodePort();
      if (signal.aborted) {
        return;
      }
      globalEventHub.start();
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
      },
      onEvent(event) {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload || typeof payload !== 'object') {
          return;
        }
        emitTranslated(payload, normalizeEventDirectory(event.directory));
      },
      onError(error) {
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
