import { randomUUID } from 'node:crypto';

import { createUpstreamSseReader } from './upstream-reader.js';
import { serializeMessageStreamWsEvent } from './protocol.js';
import { translateWireEvent } from './translate-v2.js';
import { createDeltaCoalescer, DELTA_COALESCE_WINDOW_MS } from './delta-coalescer.js';
import type { JsonValue, StreamEvent, UpstreamConnection } from './contracts.js';
import type { UpstreamDisconnect, UpstreamError } from './upstream-reader.js';
import type { TranslatedEvent } from './translate-v2.js';

export const GLOBAL_EVENT_SOURCE_OPENCODE = 'opencode' as const;
export const GLOBAL_EVENT_SOURCE_NATIVE = 'native' as const;
export type GlobalEventSource = typeof GLOBAL_EVENT_SOURCE_OPENCODE | typeof GLOBAL_EVENT_SOURCE_NATIVE;

const DEFAULT_SUBSCRIBER_SOURCES = new Set<GlobalEventSource>([GLOBAL_EVENT_SOURCE_OPENCODE]);

interface HubOptions extends UpstreamConnection {
  replayLimit?: number;
  replayByteLimit?: number;
  deltaCoalesceWindowMs?: number;
  isHiddenPayload?: (payload: JsonValue) => boolean;
}

export interface ReplayEntry {
  eventId: string;
  serializedFrame: string;
  bytes: number;
}

export interface GlobalStreamEvent extends StreamEvent {
  directory: string;
  eventId: string;
  source: GlobalEventSource;
  spaceId: string | null;
  serialize: () => string;
  translated: () => TranslatedEvent[];
}

export type GlobalStreamStatus =
  | { type: 'connect'; wasReady: boolean }
  | { type: 'disconnect'; reason: UpstreamDisconnect['reason'] }
  | { type: 'error' | 'initial-error'; error: UpstreamError; buildUrlFailed: boolean };

export interface SubscribeEventOptions {
  sources?: readonly GlobalEventSource[];
  spaces?: boolean;
}

type Subscriber<T> = ((event: T) => void) | ((event: T) => Promise<void>);

const hasRejectionHandler = (value: unknown): value is Pick<Promise<void>, 'catch'> =>
  value !== null && (typeof value === 'object' || typeof value === 'function')
  && 'catch' in value && typeof value.catch === 'function';

const isNativeTranslatedEvent = (value: unknown): value is TranslatedEvent =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'type' in value && typeof value.type === 'string';

const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const MESSAGE_STREAM_GLOBAL_REPLAY_BYTES = 8 * 1024 * 1024;

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  replayByteLimit = MESSAGE_STREAM_GLOBAL_REPLAY_BYTES,
  deltaCoalesceWindowMs = DELTA_COALESCE_WINDOW_MS,
  isHiddenPayload = () => false,
}: HubOptions) {
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 0 || !Number.isSafeInteger(replayByteLimit) || replayByteLimit < 0) {
    throw new RangeError('Replay limits must be nonnegative safe integers');
  }
  const eventSubscribers = new Map<Subscriber<GlobalStreamEvent>, Set<GlobalEventSource>>();
  const spaceSubscribers = new Set<Subscriber<GlobalStreamEvent>>();
  const statusSubscribers = new Set<Subscriber<GlobalStreamStatus>>();
  const replay: ReplayEntry[] = [];
  let replayBytes = 0;
  let latestEventId: string | undefined;
  let upstreamConnectedBefore = false;
  const replayIdPrefix = `oc-${randomUUID().slice(0, 8)}-`;
  let replaySequence = 0;
  let replayEpoch = 0;
  let replayStartId = `${replayIdPrefix}start-${replayEpoch}`;
  let replayTrimmed = false;

  let controller: AbortController | null = null;
  let reader: ReturnType<typeof createUpstreamSseReader> | null = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

  const notifySubscriber = <T>(kind: 'event' | 'status', subscriber: Subscriber<T>, payload: T) => {
    try {
      const result = subscriber(payload);
      if (result && hasRejectionHandler(result)) {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const notifyStatus = (status: GlobalStreamStatus) => {
    for (const subscriber of Array.from(statusSubscribers)) {
      notifySubscriber('status', subscriber, status);
    }
  };

  const normalizeEvent = ({ envelope, payload }: StreamEvent): GlobalStreamEvent => {
    const directory =
      envelope?.directory && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = envelope?.eventId && envelope.eventId.length > 0
      ? envelope.eventId
      : `${replayIdPrefix}${String(++replaySequence).padStart(12, '0')}`;
    const source: GlobalEventSource = envelope?.source === GLOBAL_EVENT_SOURCE_NATIVE
      ? GLOBAL_EVENT_SOURCE_NATIVE
      : GLOBAL_EVENT_SOURCE_OPENCODE;
    const spaceId = envelope?.spaceId && envelope.spaceId.length > 0 ? envelope.spaceId : null;
    let serializedFrame: string | undefined;
    let translated: TranslatedEvent[] | undefined;
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
      translated() {
        translated ??= source === GLOBAL_EVENT_SOURCE_NATIVE
          ? (isNativeTranslatedEvent(payload) ? [payload] : [])
          : translateWireEvent(payload);
        return translated;
      },
    };
  };

  const commitEvent = (event: StreamEvent) => {
    const normalized = normalizeEvent(event);
    latestEventId = normalized.eventId;
    const serializedFrame = normalized.serialize();
    const bytes = Buffer.byteLength(serializedFrame);
    if (bytes > replayByteLimit) {
      replay.length = 0;
      replayBytes = 0;
      replayTrimmed = true;
    } else {
      replay.push({ eventId: normalized.eventId, serializedFrame, bytes });
      replayBytes += bytes;
      while (replay.length > replayLimit || replayBytes > replayByteLimit) {
        const oldest = replay.shift();
        if (!oldest) throw new Error('Replay entry missing');
        replayBytes -= oldest.bytes;
        replayTrimmed = true;
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
        if (upstreamConnectedBefore) {
          replay.length = 0;
          replayBytes = 0;
          latestEventId = undefined;
          replayStartId = `${replayIdPrefix}start-${++replayEpoch}`;
          replayTrimmed = false;
        }
        upstreamConnectedBefore = true;
        notifyStatus({ type: 'connect', wasReady });
      },
      onDisconnect({ reason }) {
        connected = false;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent(event) {
        if (isHiddenPayload(event?.payload)) return;
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

  return {
    start,
    stop,
    isConnected() {
      return connected;
    },
    isHiddenPayload,
    hasConnected() {
      return everConnected;
    },
    subscribeEvent(subscriber: Subscriber<GlobalStreamEvent>, { sources, spaces = false }: SubscribeEventOptions = {}) {
      eventSubscribers.set(subscriber, sources ? new Set(sources) : DEFAULT_SUBSCRIBER_SOURCES);
      if (spaces) spaceSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
        spaceSubscribers.delete(subscriber);
      };
    },
    publishNativeEvent({ directory, payload }: { directory: string; payload: JsonValue }) {
      coalescer.push({ envelope: { directory, source: GLOBAL_EVENT_SOURCE_NATIVE, payload }, payload });
    },
    injectEvent({ payload, directory, spaceId }: { payload: JsonValue; directory: string; spaceId: string | null }) {
      coalescer.push({ envelope: { directory, spaceId }, payload });
    },
    subscribeStatus(subscriber: Subscriber<GlobalStreamStatus>) {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },
    flushPending() {
      coalescer.flush();
    },
    cursor() {
      return latestEventId ?? replayStartId;
    },
    replayAfter(eventId: string) {
      if (!eventId) {
        return [];
      }
      if (eventId === replayStartId) return replayTrimmed ? null : replay.slice();

      const index = replay.findIndex((entry) => entry.eventId === eventId);
      if (eventId === latestEventId) return [];
      return index === -1 ? null : replay.slice(index + 1);
    },
  };
}

export type GlobalMessageStreamHub = ReturnType<typeof createGlobalMessageStreamHub>;
