// The `/api/global/event` SSE route forwards OpenCode's stream byte for byte.
// Native CLI sessions have no upstream of their own, so their events are
// written into that same response, and only between SSE blocks: a frame
// written in the middle of an upstream block would corrupt both.
//
// Frames wait while the upstream is mid-block and go out as soon as a block
// boundary is reached. The wait is bounded; a stream that stays mid-block
// longer than the bounds allow is ended, and the client's reconnect repair
// reloads state instead of this route dropping frames silently.

const DEFAULT_MAX_PENDING_FRAMES = 4096;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * Serializes a native hub event the way OpenCode's global stream frames its
 * own events: `data: {"directory", "payload"}` followed by a blank line.
 * @param {{ directory: string, payload: object }} event
 */
export const formatGlobalSseFrame = ({ directory, payload }) => `data: ${JSON.stringify({ directory, payload })}\n\n`;

/**
 * @param {object} options
 * @param {(listener: (event: { directory: string, payload: object }) => void) => () => void} options.subscribe
 * @param {() => boolean} options.isAtBoundary Whether everything written so far ends an SSE block.
 * @param {(text: string) => unknown} options.write Queues text after previously written bytes.
 * @param {() => void} options.onOverflow Ends the response when pending frames exceed the bounds.
 */
export const createSseNativeEventInjector = ({
  subscribe,
  isAtBoundary,
  write,
  onOverflow,
  maxPendingFrames = DEFAULT_MAX_PENDING_FRAMES,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
}) => {
  let pending = [];
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
    /** Writes pending frames if the stream is at a block boundary. */
    flush,
    stop: unsubscribe,
  };
};
