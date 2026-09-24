import type { Message, Part } from '@opencode-ai/sdk/v2';

export type LastMessageState = {
  role: Message['role'];
  timestamp: number;
  hasError: boolean;
  /** A prompt waits for a reply; a compaction, recorded as a user message, does not. */
  awaitsReply: boolean;
} | null;

/**
 * A store message as SessionErrorNotice reads it.
 *
 * Only an assistant message finishes a turn, so only its `time.completed`
 * counts. An optimistic user message carries `completed: 0` until the server
 * echoes it back (session-actions materializes it that way); reading that as a
 * timestamp made every fresh send look unanswered since the epoch and flashed
 * the no-reply notice whenever the server acknowledged slower than a frame.
 */
export const readLastMessageState = (last: Message | null | undefined, parts: readonly Part[] = []): LastMessageState => {
  if (!last) return null;
  if (last.role === 'assistant') {
    const completed = last.time.completed ?? 0;
    return {
      role: last.role,
      timestamp: completed > 0 ? completed : last.time.created,
      hasError: Boolean(last.error),
      awaitsReply: false,
    };
  }
  // Codex answers a compaction with nothing at all.
  const awaitsReply = !parts.some((part) => part.type === 'compaction');
  return { role: last.role, timestamp: last.time.created, hasError: false, awaitsReply };
};
