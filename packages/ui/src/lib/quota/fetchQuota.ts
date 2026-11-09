import { z } from 'zod';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { runtimeFetch } from '@/lib/runtime-fetch';

const windowSchema = z.object({
  usedPercent: z.number().nullable(),
  remainingPercent: z.number().nullable(),
  windowSeconds: z.number().nullable(),
  resetAfterSeconds: z.number().nullable(),
  resetAt: z.number().nullable(),
  resetAtFormatted: z.string().nullable(),
  resetAfterFormatted: z.string().nullable(),
  valueLabel: z.string().nullable().optional(),
  value: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('requests'), count: z.number().finite().nonnegative() }),
    z.object({ kind: z.literal('remaining'), amount: z.number().finite(), used: z.number().finite().nonnegative().optional(), unit: z.string() }),
    z.object({ kind: z.literal('unlimited') }),
    z.object({ kind: z.literal('spend'), spent: z.number().finite().nonnegative(), limit: z.number().finite().positive().nullable() }),
  ]).optional(),
  creditsUsed: z.number().finite().nonnegative().optional(),
  giftReset: z.object({ recordId: z.number(), expireAt: z.number() }).nullable().optional(),
});
const windowsSchema = z.record(z.string(), windowSchema);
const consoleBudgetsSchema = z.object({
  workspace: z.string().nullable(),
  budgets: z.array(z.object({
    id: z.string(),
    limit: z.number(),
    spent: z.number(),
    usedPercent: z.number(),
    reached: z.boolean(),
    resetsAt: z.number(),
    sharing: z.enum(['you', 'everyone', 'group']),
    perModel: z.boolean(),
    kind: z.enum(['all', 'vendors', 'price', 'models', 'each']),
    vendors: z.array(z.string()),
    models: z.array(z.string()),
    inputPriceAtLeast: z.number().nullable(),
  })),
});

export type QuotaGiftResetType = 'FIVE_HOUR' | 'WEEK';

interface QuotaReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  manual?: boolean;
}

function requestQuota(providerId: QuotaProviderId, options: QuotaReadOptions, cached: false): Promise<ProviderResult>;
function requestQuota(providerId: 'claude', options: QuotaReadOptions, cached: true): Promise<ProviderResult | null>;
/** The deadline covers response bodies too, including transports that ignore abort. */
async function requestQuota(
  providerId: QuotaProviderId,
  { signal, manual = false, timeoutMs = providerId === 'magpie' && manual ? 40_000 : 30_000 }: QuotaReadOptions,
  cached: boolean,
): Promise<ProviderResult | null> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Quota request timed out', 'TimeoutError')), timeoutMs);
  let rejectAborted: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAborted();
    else controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const readResult = async () => {
    controller.signal.throwIfAborted();
    const refreshMagpie = providerId === 'magpie' && manual;
    const route = cached ? '/api/quota/claude/cached'
      : `/api/quota/${encodeURIComponent(providerId)}${refreshMagpie ? '/refresh' : ''}`;
    const init: RequestInit = { signal: controller.signal };
    if (refreshMagpie) init.method = 'POST';
    const response = await runtimeFetch(route, init);
    const payload = await response.json();
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(payload);
      throw new Error(failure.success ? failure.data.error : `Failed to fetch quota (${response.status})`);
    }
    const schema = z.object({
      providerId: z.literal(providerId),
      providerName: z.string(),
      ok: z.boolean(),
      configured: z.boolean(),
      availability: z.enum(['available', 'unsupported']).optional(),
      error: z.string().optional(),
      planLabel: z.string().nullable().optional(),
      usage: z.object({
        windows: windowsSchema,
        models: z.record(z.string(), z.object({ windows: windowsSchema })).optional(),
        consoleBudgets: consoleBudgetsSchema.optional(),
        accounts: z.array(z.object({
          id: z.string(), providerId: z.string(), providerName: z.string(),
          accountLabel: z.string().nullable(), planLabel: z.string().nullable(),
          sampledAt: z.number().nullable(), error: z.string().nullable(),
          sharedBalance: z.string().optional(), windows: windowsSchema,
        })).optional(),
      }).nullable(),
      fetchedAt: z.number(),
      refresh: z.object({
        state: z.enum(['fresh', 'cached', 'rate-limited', 'error']),
        sampledAt: z.number().nonnegative().nullable(),
        nextAttemptAt: z.number().nonnegative(),
      }).optional(),
    });
    if (!cached) return schema.parse(payload);
    const parsed = schema.nullable().safeParse(payload);
    if (!parsed.success) throw new Error('Could not read saved Claude usage');
    return parsed.data;
  };
  try {
    return await Promise.race([readResult(), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAborted);
  }
}

export const fetchQuota = (providerId: QuotaProviderId, options: QuotaReadOptions = {}): Promise<ProviderResult> =>
  requestQuota(providerId, options, false);

/** Cache misses and unsupported older servers never fall back to a live query. */
export const readCachedClaudeQuota = (options: QuotaReadOptions = {}): Promise<ProviderResult | null> =>
  requestQuota('claude', options, true);

/** The deadline covers response bodies too, including transports that ignore abort. */
export const activateGiftReset = async (
  providerId: QuotaProviderId,
  recordId: number,
  resetType: QuotaGiftResetType,
  { signal, timeoutMs = 30_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Gift reset request timed out', 'TimeoutError')), timeoutMs);
  let rejectAborted: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAborted();
    else controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const readResult = async () => {
    controller.signal.throwIfAborted();
    const response = await runtimeFetch(`/api/quota/${encodeURIComponent(providerId)}/gift-reset/use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordId, resetType }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(payload);
      throw new Error(failure.success ? failure.data.error : `Failed to activate gift reset (${response.status})`);
    }
  };
  try {
    await Promise.race([readResult(), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAborted);
  }
};
