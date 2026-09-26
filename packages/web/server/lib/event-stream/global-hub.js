import { randomUUID } from 'node:crypto';

import { createUpstreamSseReader } from './upstream-reader.js';
import { serializeMessageStreamWsEvent } from './protocol.js';
import { translateWireEvent } from './translate-v2.js';
import { createDeltaCoalescer, DELTA_COALESCE_WINDOW_MS } from './delta-coalescer.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const MESSAGE_STREAM_GLOBAL_REPLAY_BYTES = 8 * 1024 * 1024;

// Events either come from the OpenCode upstream or are published by
// OpenChamber's native CLI runtime. Both share one committed sequence, so
// replay, coalescing and browser fan-out treat them alike. Server-side
// subscribers written against OpenCode sessions must never act on a native
// session, so a subscriber receives OpenCode events only unless it opts in.
export const GLOBAL_EVENT_SOURCE_OPENCODE = 'opencode';
export const GLOBAL_EVENT_SOURCE_NATIVE = 'native';
const DEFAULT_SUBSCRIBER_SOURCES = new Set([GLOBAL_EVENT_SOURCE_OPENCODE]);

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  replayByteLimit = MESSAGE_STREAM_GLOBAL_REPLAY_BYTES,
  deltaCoalesceWindowMs = DELTA_COALESCE_WINDOW_MS,
}) {
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 0 || !Number.isSafeInteger(replayByteLimit) || replayByteLimit < 0) {
    throw new RangeError('Replay limits must be nonnegative safe integers');
  }
  // subscriber -> the event sources it accepts
  const eventSubscribers = new Map();
  const spaceSubscribers = new Set();
  const statusSubscribers = new Set();
  const replay = [];
  let replayBytes = 0;
  let latestEventId;
  let replayPredecessorEventId = null;
  // OpenCode's event stream carries no SSE ids (verified on 1.18.30: not one
  // frame in a full response), and an event without an id never entered the
  // replay buffer, so a reconnecting browser had no cursor and every event in
  // the gap was gone. The replay log is this hub's own, so the hub numbers
  // what upstream leaves unnumbered. The per-process prefix makes a cursor
  // from before a restart miss instead of matching an unrelated sequence
  // number, which reports `replayReset` and sends the client to repair.
  const replayIdPrefix = `oc-${randomUUID().slice(0, 8)}-`;
  let replaySequence = 0;

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const notifyStatus = (status) => {
    for (const subscriber of Array.from(statusSubscribers)) {
      notifySubscriber('status', subscriber, status);
    }
  };

  const normalizeEvent = ({ envelope, payload }) => {
    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = typeof envelope?.eventId === 'string' && envelope.eventId.length > 0
      ? envelope.eventId
      : `${replayIdPrefix}${String(++replaySequence).padStart(12, '0')}`;
    // The marker lives on the envelope because the delta coalescer rebuilds
    // merged events from `{ envelope, payload }` only.
    const source = envelope?.source === GLOBAL_EVENT_SOURCE_NATIVE
      ? GLOBAL_EVENT_SOURCE_NATIVE
      : GLOBAL_EVENT_SOURCE_OPENCODE;
    // An event of an isolated space carries the space's id; subscribers see it only when they
    // asked for space events, because a consumer that acts on the host's OpenCode by
    // directory must never act on a space's directory.
    const spaceId = typeof envelope?.spaceId === 'string' && envelope.spaceId.length > 0 ? envelope.spaceId : null;
    let serializedFrame;
    let translated;
    return {
      envelope,
      payload,
      directory,
      eventId,
      source,
      spaceId,
      serialize() {
        serializedFrame ??= serializeMessageStreamWsEvent(payload, { directory, eventId });
        return serializedFrame;
      },
      // Browser clients receive the raw wire payload and translate it
      // themselves; server-side subscribers read this instead. Translating
      // lazily keeps the cost off the WS fan-out path when nothing listens.
      translated() {
        translated ??= source === GLOBAL_EVENT_SOURCE_NATIVE ? [payload] : translateWireEvent(payload);
        return translated;
      },
    };
  };

  // Replay and fan-out see the same committed sequence: an event enters the
  // replay buffer in the same step that delivers it, so a client's cursor
  // always names a frame the buffer can find.
  const commitEvent = (event) => {
    const normalized = normalizeEvent(event);
    latestEventId = normalized.eventId;
    const serializedFrame = normalized.serialize();
    const bytes = Buffer.byteLength(serializedFrame);
    if (bytes > replayByteLimit) {
      // An oversized live event creates a hole: retain only a contiguous
      // suffix after it, never replay an older prefix across the gap.
      replay.length = 0;
      replayBytes = 0;
      replayPredecessorEventId = null;
    } else {
      replay.push({ eventId: normalized.eventId, serializedFrame, bytes });
      replayBytes += bytes;
      while (replay.length > replayLimit || replayBytes > replayByteLimit) {
        const byteLimitExceeded = replayBytes > replayByteLimit;
        const removed = replay.shift();
        replayPredecessorEventId = byteLimitExceeded ? null : removed.eventId;
        replayBytes -= removed.bytes;
      }
    }

    for (const [subscriber, sources] of Array.from(eventSubscribers)) {
      if (!sources.has(normalized.source)) continue;
      if (normalized.spaceId !== null && !spaceSubscribers.has(subscriber)) continue;
      notifySubscriber('event', subscriber, normalized);
    }
  };

  const coalescer = createDeltaCoalescer({ emit: commitEvent, windowMs: deltaCoalesceWindowMs });

  const start = () => {
    if (reader) {
      return;
    }

    controller = new AbortController();
    reader = createUpstreamSseReader({
      signal: controller.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      buildUrl: () => {
        buildUrlFailed = false;
        try {
          return new URL(buildOpenCodeUrl('/api/event', ''));
        } catch {
          buildUrlFailed = true;
          throw new Error('OpenCode service unavailable');
        }
      },
      getHeaders: getOpenCodeAuthHeaders,
      onConnect() {
        connected = true;
        const wasReady = everConnected;
        everConnected = true;
        notifyStatus({ type: 'connect', wasReady });
      },
      onDisconnect({ reason }) {
        connected = false;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent(event) {
        coalescer.push(event);
      },
      onError(error) {
        if (controller?.signal.aborted) {
          return;
        }

        notifyStatus({
          type: everConnected ? 'error' : 'initial-error',
          error,
          buildUrlFailed,
        });
      },
    });

    void reader.start();
  };

  const stop = () => {
    connected = false;
    // Text that already arrived belongs in the retained replay suffix.
    coalescer.flush();
    reader?.stop();
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    reader = null;
    controller = null;
    everConnected = false;
    buildUrlFailed = false;
  };

  const replayAfter = (eventId) => {
    if (!eventId) {
      return [];
    }

    const index = replay.findIndex((entry) => entry.eventId === eventId);
    if (eventId === latestEventId) return [];
    if (index !== -1) return replay.slice(index + 1);
    if (eventId === replayPredecessorEventId) return [...replay];
    return null;
  };

  const resolveReplay = (eventId) => {
    if (!eventId) return { events: [], gap: false };
    const index = replay.findIndex((entry) => entry.eventId === eventId);
    if (index !== -1) return { events: replay.slice(index + 1), gap: false };
    if (eventId === latestEventId) return { events: [], gap: false };
    if (eventId === replayPredecessorEventId) return { events: [...replay], gap: false };
    return { events: [], gap: true };
  };

  return {
    start,
    stop,
    isConnected() {
      return connected;
    },
    hasConnected() {
      return everConnected;
    },
    /**
     * @param {(event: object) => void} subscriber
     * @param {{ sources?: string[], spaces?: boolean }} [options] Event sources to receive.
     *   Defaults to OpenCode events only.
     */
    subscribeEvent(subscriber, options = {}) {
      eventSubscribers.set(subscriber, options.sources ? new Set(options.sources) : DEFAULT_SUBSCRIBER_SOURCES);
      if (options.spaces) spaceSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
        spaceSubscribers.delete(subscriber);
      };
    },
    /**
     * Commits an event produced by the native CLI runtime into the same
     * sequence as upstream events: it is numbered, coalesced, retained for
     * replay and delivered to subscribers that accept native events.
     * @param {{ directory: string, payload: object }} event
     */
    publishNativeEvent({ directory, payload }) {
      coalescer.push({ envelope: { directory, source: GLOBAL_EVENT_SOURCE_NATIVE, payload }, payload });
    },
    /**
     * One event of an isolated space, from that space's own connection, entered here as if it
     * had arrived upstream: numbered, coalesced, replayed and fanned out with the host's, so
     * a client keeps one cursor for everything. `directory` is the space's, `spaceId` marks it.
     */
    injectEvent({ payload, directory, spaceId }) {
      coalescer.push({ envelope: { directory, spaceId }, payload });
    },
    subscribeStatus(subscriber) {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },
    resolveReplay,
    replayAfter,
    // A client that becomes ready must not receive text from before it was
    // ready merged into its first live delta, so the bridge commits pending
    // deltas before it reads the replay tail.
    flushPending() {
      coalescer.flush();
    },
  };
}
