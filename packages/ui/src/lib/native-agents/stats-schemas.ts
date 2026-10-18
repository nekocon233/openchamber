import { z } from 'zod';
import type { UsageStats } from '@/lib/opencode/session-stats';

const count = z.number().finite().nonnegative();
const metric = z.object({ known: count, missing: count });
const coverage = z.object({ tokens: metric, cost: metric, reasoning: metric, undated: count, failedSessions: count });
const tokens = z.object({ input: count, output: count, reasoning: count, cacheRead: count, cacheWrite: count, total: count });
const totals = z.object({ calls: count, succeeded: count, failed: count, unfinished: count });
const report = z.object({
  range: z.object({ from: count, to: count }), sessions: count, subagents: count, prompts: count, steps: count,
  tokens, cost: count, coverage,
  tools: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('detail'), totals, usage: z.array(z.object({
      name: z.string(), calls: count, succeeded: count, failed: count, unfinished: count, durationP50: count.nullable(),
    })) }),
  ]),
  activeDays: count, streak: count, activity: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), steps: count,
    tokens: count.nullable().default(null), tokensComplete: z.boolean().default(false),
  }).refine((day) => day.tokens !== null || !day.tokensComplete)),
  models: z.array(z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().nullable(), steps: count, tokens, cost: count, coverage })),
}) satisfies z.ZodType<UsageStats>;

const source = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), stats: report }),
  z.object({ status: z.literal('partial'), stats: report }),
  z.object({ status: z.literal('error'), message: z.string(), code: z.string() }),
  z.object({ status: z.literal('unavailable'), message: z.string(), code: z.string() }),
]);

export const nativeStatisticsSchema = z.object({ backends: z.object({ claude: source, codex: source, deepseek: source }) });
export type NativeStatistics = z.infer<typeof nativeStatisticsSchema>;
export type NativeStatisticsQuery = { from?: number; to: number; timezone: string; directory?: string; tools: 'none' | 'detail' };
