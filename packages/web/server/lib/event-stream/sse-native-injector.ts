import type { JsonValue } from './contracts.js';

const DEFAULT_MAX_PENDING_FRAMES = 4096;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface NativeSseEvent {
  directory: string;
  payload: JsonValue;
}

export interface SseNativeEventInjectorOptions {
  subscribe: (listener: (event: NativeSseEvent) => void) => () => void;
  isAtBoundary: () => boolean;
  write: (text: string) => void;
  onOverflow: () => void;
  maxPendingFrames?: number;
  maxPendingBytes?: number;
}

export interface SseNativeEventInjector {
  flush: () => void;
  stop: () => void;
}

export const formatGlobalSseFrame = ({ directory, payload }: NativeSseEvent): string => (
  `data: ${JSON.stringify({ directory, payload })}\n\n`
);

export const createSseNativeEventInjector = ({
  subscribe,
  isAtBoundary,
  write,
  onOverflow,
  maxPendingFrames = DEFAULT_MAX_PENDING_FRAMES,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
}: SseNativeEventInjectorOptions): SseNativeEventInjector => {
  let pending: string[] = [];
  let pendingBytes = 0;
  let overflowed = false;

  const flush = () => {
    if (overflowed || pending.length === 0 || !isAtBoundary()) return;
    const frames = pending;
    pending = [];
    pendingBytes = 0;
    write(frames.join(''));
  };

  const unsubscribe = subscribe((event) => {
    if (overflowed) return;
    const frame = formatGlobalSseFrame(event);
    pending.push(frame);
    pendingBytes += Buffer.byteLength(frame);
    if (pending.length > maxPendingFrames || pendingBytes > maxPendingBytes) {
      overflowed = true;
      pending = [];
      pendingBytes = 0;
      onOverflow();
      return;
    }
    flush();
  });

  return {
    flush,
    stop: unsubscribe,
  };
};
