import { z } from 'zod';
import type { JsonObject, StreamEvent } from './contracts.js';
import { isJsonObject, isString } from './guards.js';

export const DELTA_COALESCE_WINDOW_MS = 50;
const MAX_DELTA_COALESCE_WINDOW_MS = 1000;
const DEFAULT_MAX_PENDING_CHARS = 64 * 1024;
const DEFAULT_MAX_PENDING_KEYS = 64;
const KEY_SEPARATOR = '\0';

export function resolveDeltaCoalesceWindowMs(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn) {
  const raw = (env.OPENCHAMBER_EVENT_DELTA_COALESCE_MS ?? '').trim();
  if (raw === '') return DELTA_COALESCE_WINDOW_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_DELTA_COALESCE_WINDOW_MS) {
    warn(`[event-stream] Ignoring OPENCHAMBER_EVENT_DELTA_COALESCE_MS=${JSON.stringify(raw)}: expected 0-${MAX_DELTA_COALESCE_WINDOW_MS}`);
    return DELTA_COALESCE_WINDOW_MS;
  }
  return value;
}

const DELTA_EVENT_TYPES = new Set(['session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta']);

const deltaEventSchema = z.object({
  envelope: z.object({ directory: z.string().nullish() }).nullish(),
  payload: z.object({
    type: z.enum(['session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta']),
    data: z.object({
      sessionID: z.string().default(''),
      assistantMessageID: z.string(),
      ordinal: z.number().int().nullish(),
      id: z.string().nullish(),
      delta: z.string(),
    }),
  }),
});

const nativeDeltaEventSchema = z.object({
  envelope: z.object({ source: z.literal('native'), directory: z.string().nullish() }),
  payload: z.object({
    type: z.literal('message.part.delta'),
    properties: z.object({
      sessionID: z.string(),
      messageID: z.string(),
      partID: z.string(),
      field: z.enum(['text', 'raw']),
      delta: z.string(),
    }),
  }),
});

type OpenCodeDeltaEvent = Omit<StreamEvent, 'payload'> & {
  payload: JsonObject & {
    type: z.input<typeof deltaEventSchema>['payload']['type'];
    data: JsonObject & z.input<typeof deltaEventSchema>['payload']['data'];
  };
};

type NativeDeltaEvent = Omit<StreamEvent, 'payload'> & {
  payload: JsonObject & {
    type: 'message.part.delta';
    properties: JsonObject & z.input<typeof nativeDeltaEventSchema>['payload']['properties'];
  };
};

type CoalescedDeltaEvent = OpenCodeDeltaEvent | NativeDeltaEvent;

const isOpenCodeDeltaEvent = (event: StreamEvent): event is OpenCodeDeltaEvent => deltaEventSchema.safeParse(event).success;
const isNativeDeltaEvent = (event: StreamEvent): event is NativeDeltaEvent => nativeDeltaEventSchema.safeParse(event).success;

interface PendingDelta {
  text: string;
  fragments: number;
  latest: CoalescedDeltaEvent;
  hasEnvelope: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;
const isObjectTimer = (timer: TimerHandle): timer is ReturnType<typeof setTimeout> => typeof timer !== 'number';

interface CoalescerOptions {
  emit: (event: StreamEvent) => void;
  windowMs?: number;
  maxPendingChars?: number;
  maxPendingKeys?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

export function createDeltaCoalescer({
  emit,
  windowMs = DELTA_COALESCE_WINDOW_MS,
  maxPendingChars = DEFAULT_MAX_PENDING_CHARS,
  maxPendingKeys = DEFAULT_MAX_PENDING_KEYS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: CoalescerOptions) {
  const pending = new Map<string, PendingDelta>();
  let pendingChars = 0;
  let lastDeltaEmitAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | null = null;

  const stopTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const flush = () => {
    stopTimer();
    if (pending.size === 0) return;
    const entries = Array.from(pending.values());
    pending.clear();
    pendingChars = 0;
    lastDeltaEmitAt = now();
    for (const entry of entries) {
      if (entry.fragments === 1) {
        emit(entry.latest);
        continue;
      }
      const payload = entry.latest.payload;
      const mergedPayload = payload.type === 'message.part.delta'
        ? { ...payload, properties: { ...payload.properties, delta: entry.text } }
        : { ...payload, data: { ...payload.data, delta: entry.text } };
      const envelope = entry.hasEnvelope ? { ...entry.latest.envelope, payload: mergedPayload } : entry.latest.envelope;
      emit({ ...entry.latest, envelope, payload: mergedPayload });
    }
  };

  const armTimer = () => {
    if (timer !== null) return;
    const delay = Math.max(0, lastDeltaEmitAt + windowMs - now());
    timer = setTimer(() => {
      timer = null;
      flush();
    }, Number.isFinite(delay) ? delay : 0);
    if (isObjectTimer(timer)) timer?.unref?.();
  };

  const push = (event: StreamEvent) => {
    const payloadType = isJsonObject(event?.payload) && isString(event.payload.type) ? event.payload.type : '';
    let coalescedEvent: CoalescedDeltaEvent | null = null;
    let deltaText = '';
    let key = '';

    if (windowMs > 0) {
      if (payloadType === 'message.part.delta' && isNativeDeltaEvent(event)) {
        coalescedEvent = event;
        const props = event.payload.properties;
        deltaText = props.delta;
        key = [
          event.envelope?.directory ?? '',
          payloadType,
          props.sessionID,
          props.messageID,
          '',
          `${props.partID}:${props.field}`,
        ].join(KEY_SEPARATOR);
      } else if (DELTA_EVENT_TYPES.has(payloadType) && isOpenCodeDeltaEvent(event)) {
        coalescedEvent = event;
        const delta = event.payload.data;
        deltaText = delta.delta;
        key = [
          event.envelope?.directory ?? '',
          payloadType,
          delta.sessionID ?? '',
          delta.assistantMessageID,
          delta.ordinal ?? '',
          delta.id ?? '',
        ].join(KEY_SEPARATOR);
      }
    }

    if (!coalescedEvent) {
      flush();
      emit(event);
      return;
    }

    const hasEnvelope = coalescedEvent.envelope != null;
    const existing = pending.get(key);

    if (!existing && pending.size === 0 && now() - lastDeltaEmitAt >= windowMs) {
      lastDeltaEmitAt = now();
      emit(coalescedEvent);
      return;
    }

    if (existing) {
      pending.delete(key);
      existing.text += deltaText;
      existing.fragments += 1;
      existing.latest = coalescedEvent;
      existing.hasEnvelope = hasEnvelope;
      pending.set(key, existing);
    } else {
      pending.set(key, { text: deltaText, fragments: 1, latest: coalescedEvent, hasEnvelope });
    }
    pendingChars += deltaText.length;

    if (pendingChars >= maxPendingChars || pending.size >= maxPendingKeys) {
      flush();
      return;
    }
    armTimer();
  };

  return {
    push,
    flush,
    pendingSize() {
      return { keys: pending.size, chars: pendingChars };
    },
  };
}
