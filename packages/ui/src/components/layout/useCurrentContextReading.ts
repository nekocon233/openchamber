import { DEFAULT_CONTEXT_LIMIT } from '@/components/chat/work-status/contextUsage';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import type { Message } from '@/lib/opencode/model';
import { findLatestContextFill } from '@/stores/utils/tokenUtils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessagesSelector } from '@/sync/sync-context';

type ContextFillReading =
  | { state: 'measured'; totalTokens: number; contextWindow: number | undefined }
  | { state: 'compacted'; contextWindow: number | undefined }
  | null;

const selectContextFill = (messages: Message[]): ContextFillReading => {
  const fill = findLatestContextFill(messages);
  if (!fill) return null;
  const message = messages[fill.index];
  const contextWindow = message?.role === 'assistant' ? message.contextWindow : undefined;
  return fill.state === 'measured'
    ? { state: 'measured', totalTokens: fill.totalTokens, contextWindow }
    : { state: 'compacted', contextWindow };
};

const isSameContextFill = (a: ContextFillReading, b: ContextFillReading): boolean => {
  if (a === null || b === null) return a === b;
  if (a.state !== b.state || a.contextWindow !== b.contextWindow) return false;
  return a.state === 'compacted' || (b.state === 'measured' && a.totalTokens === b.totalTokens);
};

/**
 * The current session's context fill. A streamed step replaces the message
 * list many times while the fill stays the same, so callers re-render only
 * when a response reports a new token count or a compaction finishes.
 */
export const useCurrentContextReading = () => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useSessionUIStore((state) => state.currentSessionDirectory) ?? undefined;
  const fill = useSessionMessagesSelector(sessionId ?? '', directory, selectContextFill, isSameContextFill);
  const { context } = useContextWindowLimits(sessionId, directory);
  const reported = fill?.contextWindow ?? context;
  const limit = reported > 0 ? reported : DEFAULT_CONTEXT_LIMIT;
  return { sessionId, fill, limit };
};
