import { z } from 'zod';

const count = z.number().int().nonnegative();
const validCounts = (value: {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}) => (
  value.inputTokens >= value.cachedInputTokens + value.cacheWriteInputTokens
  && value.outputTokens >= value.reasoningOutputTokens
  && value.totalTokens === value.inputTokens + value.outputTokens
);
const wireCounts = z.object({
  inputTokens: count,
  cachedInputTokens: count,
  cacheWriteInputTokens: count.default(0),
  outputTokens: count,
  reasoningOutputTokens: count,
  totalTokens: count,
}).refine(validCounts);
const normalizedCounts = z.object({
  inputTokens: count,
  cachedInputTokens: count,
  cacheWriteInputTokens: count,
  outputTokens: count,
  reasoningOutputTokens: count,
  totalTokens: count,
}).refine(validCounts);
const persistedCounts = z.object({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count.default(0),
  output_tokens: count,
  reasoning_output_tokens: count,
  total_tokens: count,
}).transform((value) => ({
  inputTokens: value.input_tokens,
  cachedInputTokens: value.cached_input_tokens,
  cacheWriteInputTokens: value.cache_write_input_tokens,
  outputTokens: value.output_tokens,
  reasoningOutputTokens: value.reasoning_output_tokens,
  totalTokens: value.total_tokens,
})).pipe(normalizedCounts);

export type CodexTokenCounts = z.infer<typeof wireCounts>;

export interface CodexNormalizedTokens {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface CodexUsageSegment {
  tokens: CodexNormalizedTokens;
  contextWindow: number | undefined;
}

export interface CodexUsageState {
  segments: Map<string, CodexUsageSegment>;
  lastTotal: CodexTokenCounts | null;
}

export interface CodexUsageObservation {
  total: CodexTokenCounts;
  last: CodexTokenCounts;
  modelContextWindow?: number | null | undefined;
}

export const codexUsageNotification = z.object({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z.object({
    total: wireCounts,
    last: wireCounts,
    modelContextWindow: count.positive().nullish(),
  }),
});

export const codexPersistedUsage = z.object({
  turn_id: z.string(),
  thread_id: z.string().optional(),
  response_id: z.string().optional(),
  usage: persistedCounts,
  thread_token_usage: persistedCounts,
});

export const codexLegacyUsage = z.object({
  info: z.object({
    total_token_usage: persistedCounts,
    last_token_usage: persistedCounts,
    model_context_window: count.positive().nullish(),
  }),
});

export const createCodexUsage = (): CodexUsageState => ({ segments: new Map(), lastTotal: null });

export const observeCodexUsage = (
  state: CodexUsageState,
  segment: string,
  { total, last, modelContextWindow }: CodexUsageObservation,
): boolean => {
  if (state.lastTotal && total.totalTokens <= state.lastTotal.totalTokens) return false;
  const delta = state.lastTotal ? {
    inputTokens: total.inputTokens - state.lastTotal.inputTokens,
    cachedInputTokens: total.cachedInputTokens - state.lastTotal.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens - state.lastTotal.cacheWriteInputTokens,
    outputTokens: total.outputTokens - state.lastTotal.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens - state.lastTotal.reasoningOutputTokens,
    totalTokens: total.totalTokens - state.lastTotal.totalTokens,
  } : last;
  const valid = wireCounts.safeParse(delta);
  if (!valid.success) return false;
  const value = valid.data;
  const previous = state.segments.get(segment)?.tokens;
  const tokens: CodexNormalizedTokens = {
    total: last.totalTokens,
    input: (previous?.input ?? 0) + value.inputTokens - value.cachedInputTokens - value.cacheWriteInputTokens,
    output: (previous?.output ?? 0) + value.outputTokens - value.reasoningOutputTokens,
    reasoning: (previous?.reasoning ?? 0) + value.reasoningOutputTokens,
    cache: {
      read: (previous?.cache.read ?? 0) + value.cachedInputTokens,
      write: (previous?.cache.write ?? 0) + value.cacheWriteInputTokens,
    },
  };
  state.lastTotal = total;
  state.segments.set(segment, {
    tokens,
    contextWindow: modelContextWindow ?? state.segments.get(segment)?.contextWindow,
  });
  return true;
};
