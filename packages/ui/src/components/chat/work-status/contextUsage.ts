
import { computeCacheHitRate, findLatestContextFill, resolveContextReadingLimits, type ContextFillMessage } from '@/stores/utils/tokenUtils';

type WorkStatusContextUsage =
  | {
    state: 'measured';
    totalTokens: number;
    limit: number;
    /** Unrounded, so the panel and the header cannot disagree by a rounding step. */
    percent: number | null;
    window: number;
    compactionThreshold?: number;
  }
  /** Compacted since the last response that reported tokens: the fill is unknown, not zero. */
  | { state: 'compacted'; limit: number; window: number; compactionThreshold?: number };

export const DEFAULT_CONTEXT_LIMIT = 200_000;

export const computeContextUsage = (
  messages: readonly ContextFillMessage[],
  contextLimit: number,
): WorkStatusContextUsage | null => {
  const fill = findLatestContextFill(messages);
  if (!fill) return null;

  const limits = resolveContextReadingLimits(messages[fill.index], contextLimit, fill.state === 'measured' ? DEFAULT_CONTEXT_LIMIT : 0);
  if (fill.state === 'compacted') return { state: 'compacted', ...limits };

  return { state: 'measured', totalTokens: fill.totalTokens, ...limits,
    percent: limits.limit > 0 ? (fill.totalTokens / limits.limit) * 100 : null };
};

export const computeLastReplyCacheHit = (messages: readonly ContextFillMessage[]): number | null => {
  const fill = findLatestContextFill(messages);
  if (fill?.state !== 'measured') return null;
  const hitRate = computeCacheHitRate(messages[fill.index]?.tokens);
  return hitRate.hasInput ? hitRate.percent : null;
};

type SessionTokenRecord = {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
};

type SessionTokenTotals = {
  prompt: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent: number | null;
};

export const computeSessionTokenTotals = (session: SessionTokenRecord | null | undefined): SessionTokenTotals | null => {
  const tokens = session?.tokens;
  if (!tokens) return null;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  const totals = {
    prompt: (tokens.input ?? 0) + cacheRead + cacheWrite,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead,
    cacheWrite,
  };
  if (totals.prompt + totals.output + totals.reasoning <= 0) return null;
  const hitRate = computeCacheHitRate(tokens);
  return { ...totals, cacheHitPercent: hitRate.hasInput ? hitRate.percent : null };
};
