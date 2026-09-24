import { GLOBAL_EVENT_SOURCE_NATIVE, GLOBAL_EVENT_SOURCE_OPENCODE } from './global-hub.js';
import { sendMessageStreamWsEvent, sendMessageStreamWsFrame, sendSerializedMessageStreamWsFrame, serializeMessageStreamWsEvent } from './protocol.js';

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
}

export function createGlobalMessageStreamWsBridge({
  globalHub,
  ownsGlobalHub,
  wsClients,
  processForwardedEventPayload,
  triggerHealthCheck,
  heartbeatIntervalMs,
}) {
  const clients = new Set();
  const clientLastEventIds = new Map();
  const readyClients = new Set();

  const removeClient = (socket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
  };

  const replayEvents = (socket, entries) => {
    for (const entry of entries) {
      const sent = entry && typeof entry.serializedFrame === 'string'
        ? sendSerializedMessageStreamWsFrame(socket, entry.serializedFrame)
        : sendMessageStreamWsEvent(socket, entry.payload, {
          directory: entry.directory,
          eventId: entry.eventId,
        });
      if (!sent) {
        removeClient(socket);
        return false;
      }
    }
    return true;
  };

  const markReady = (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    globalHub.flushPending();
    const replay = globalHub.replayAfter(requestedLastEventId);
    if (replay === null) {
      // The cursor fell out of the retained suffix: declare the gap on the
      // ready frame instead of replaying across it.
      const sent = sendMessageStreamWsFrame(socket, {
        type: 'ready',
        scope: 'global',
        replayReset: true,
      });
      if (!sent) {
        removeClient(socket);
        return;
      }
      readyClients.add(socket);
      wsClients.add(socket);
      return;
    }

    if (typeof globalHub.resolveReplay === 'function') {
      // Recoverable replay events precede the browser-facing ready frame so
      // the browser commits them before starting authoritative reconnect repair.
      const resolved = globalHub.resolveReplay(requestedLastEventId);
      if (resolved.gap) {
        const sent = sendMessageStreamWsFrame(socket, { type: 'replay-gap', scope: 'global' });
        if (!sent) {
          removeClient(socket);
          return;
        }
      }
      if (!replayEvents(socket, resolved.events)) return;
      const sent = sendMessageStreamWsFrame(socket, {
        type: 'ready',
        scope: 'global',
      });
      if (!sent) {
        removeClient(socket);
        return;
      }
      readyClients.add(socket);
      wsClients.add(socket);
      return;
    }

    const sent = sendMessageStreamWsFrame(socket, {
      type: 'ready',
      scope: 'global',
    });
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    replayEvents(socket, replay);
  };

  const stopHubIfUnused = () => {
    if (ownsGlobalHub && clients.size === 0) {
      globalHub.stop();
    }
  };

  const closeClientsWithInitialError = ({ message, closeReason = message, triggerHealthCheckFor = null }) => {
    for (const socket of Array.from(clients)) {
      sendMessageStreamWsFrame(socket, { type: 'error', message });
      try {
        socket.close(1011, closeReason);
      } catch {
      }
      removeClient(socket);
    }

    if (triggerHealthCheckFor === true || (triggerHealthCheckFor && shouldTriggerUpstreamHealthCheck(triggerHealthCheckFor))) {
      triggerHealthCheck?.();
    }

    if (ownsGlobalHub) {
      globalHub.stop();
    }
  };

  const broadcastEvent = (payload, options, serializedFrame) => {
    const frame = serializedFrame ?? serializeMessageStreamWsEvent(payload, options);
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      const sent = sendSerializedMessageStreamWsFrame(socket, frame);
      if (!sent) {
        removeClient(socket);
      }
    }
  };

  // Browsers render native CLI sessions from the same stream as OpenCode ones.
  const unsubscribeEvent = globalHub.subscribeEvent((event) => {
    const { payload, directory, eventId } = event;
    broadcastEvent(payload, { directory, eventId }, event.serialize());

    processForwardedEventPayload(payload, (syntheticPayload) => {
      if (readyClients.size === 0) return;
      broadcastEvent(syntheticPayload, { directory: 'global' });
    });
  }, { sources: [GLOBAL_EVENT_SOURCE_OPENCODE, GLOBAL_EVENT_SOURCE_NATIVE] });

  const unsubscribeStatus = globalHub.subscribeStatus((status) => {
    if (status.type === 'connect') {
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          markReady(socket, clientLastEventIds.get(socket) ?? '');
          continue;
        }

        if (status.wasReady) {
          const sent = sendMessageStreamWsFrame(socket, {
            type: 'ready',
            scope: 'global',
          });
          if (!sent) {
            removeClient(socket);
          }
        }
      }
      return;
    }

    if (status.type === 'initial-error') {
      const error = status.error;
      if (error?.type === 'upstream_unavailable') {
        closeClientsWithInitialError({
          message: `OpenCode event stream unavailable (${error.status})`,
          closeReason: 'OpenCode event stream unavailable',
          triggerHealthCheckFor: error.response,
        });
        return;
      }

      const message = status.buildUrlFailed
        ? 'OpenCode service unavailable'
        : 'Failed to connect to OpenCode event stream';
      closeClientsWithInitialError({
        message,
        closeReason: message,
        triggerHealthCheckFor: !status.buildUrlFailed,
      });
      return;
    }

    if (status.type === 'error' && status.error?.type === 'stream_error') {
      console.warn('Message stream WS proxy error:', status.error.error);
    }
  });

  const accept = (socket, { requestedLastEventId = '' } = {}) => {
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, heartbeatIntervalMs);

    const heartbeatInterval = setInterval(() => {
      if (!globalHub.isConnected()) {
        return;
      }

      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      removeClient(socket);
      stopHubIfUnused();
    });

    socket.on('error', () => {
      void 0;
    });

    clients.add(socket);
    clientLastEventIds.set(socket, requestedLastEventId);
    globalHub.start();
    if (globalHub.isConnected()) {
      markReady(socket, requestedLastEventId);
    }
  };

  const close = () => {
    unsubscribeEvent();
    unsubscribeStatus();
    if (ownsGlobalHub) {
      globalHub.stop();
    }
    for (const socket of Array.from(clients)) {
      removeClient(socket);
    }
  };

  return {
    accept,
    close,
  };
}
