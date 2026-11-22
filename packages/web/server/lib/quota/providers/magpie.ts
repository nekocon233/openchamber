import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildResult, toUsageWindow } from '../utils/formatters.js';
import type { ProviderUsage, QuotaResult, QuotaResultInput, UsageWindow } from '../utils/contracts.js';
import { errorCodeOf } from '../../shared/object-guards.js';
import { magpieHistoryKey, magpieTrendFor, magpieHistorySchema, type MagpieHistory, type MagpieTrend } from './magpie-history.js';

export type MagpieWindowValue =
  | { kind: 'unlimited' }
  | { kind: 'remaining'; amount: number; used?: number; unit: string };

export interface MagpieUsageWindow extends UsageWindow {
  value?: MagpieWindowValue;
  magpieTrend?: MagpieTrend | null;
}

export interface MagpieAccount {
  id: string;
  providerId: string;
  providerName: string;
  accountLabel: string | null;
  planLabel: string | null;
  windows: Record<string, MagpieUsageWindow>;
  sampledAt: number | null;
  error: string | null;
  sharedBalance?: string | undefined;
}

export interface MagpieUsage extends ProviderUsage {
  windows: Record<string, MagpieUsageWindow>;
  accounts: MagpieAccount[];
}

export type MagpieQuotaResult = QuotaResult<'magpie', 'Magpie', MagpieUsage>;

export interface MagpieQuotaReaderOptions {
  fetchImpl?: typeof fetch | undefined;
  configDir?: string | undefined;
  timeoutMs?: number | undefined;
}

export type MagpieQuotaReader = (options?: { refresh?: boolean; history?: boolean }) => Promise<MagpieQuotaResult>;

const envelope = z.object({ object: z.literal('list'), data: z.array(z.unknown()) });
const cardSchema = z.object({
  provider: z.string().min(1), name: z.string(), kind: z.string(),
  user: z.string().optional(), alias: z.string().optional(), seat: z.string().optional(),
  from: z.string().optional(), plan: z.string().optional(),
  windows: z.array(z.unknown()), balance: z.string().optional(),
  sharedBalance: z.string().optional(), error: z.string().optional(),
  readAt: z.string().optional(), asOf: z.string().optional(), readDeferred: z.boolean().optional(),
});
const windowSchema = z.object({
  name: z.string().min(1), used: z.number().finite().optional(), remaining: z.number().finite().optional(),
  resetsAt: z.string().optional(), unlimited: z.boolean().optional(), text: z.boolean().optional(),
  pool: z.string().optional(), display: z.string().optional(), balance: z.number().finite().optional(),
  amount: z.number().finite().optional(), limit: z.number().finite().optional(), unit: z.string().optional(),
});

const timestamp = (value: string | undefined): number | null => (
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
);
const percent = (value: number | undefined): number | null => (
  value === undefined ? null : Math.min(100, Math.max(0, value))
);
const lineName = ({ pool, name }: z.infer<typeof windowSchema>) => pool ? `${pool} · ${name}` : name;

function accountsFrom(payload: z.infer<typeof envelope>, history: MagpieHistory | null | undefined): MagpieAccount[] {
  const cards = payload.data.map(raw => cardSchema.safeParse(raw));
  const historyKeys = new Map<string, number>();
  if (history) {
    for (const card of cards) {
      if (!card.success) continue;
      const key = magpieHistoryKey(card.data.provider, card.data.user);
      historyKeys.set(key, (historyKeys.get(key) ?? 0) + 1);
    }
  }
  return cards.map((parsed, index): MagpieAccount => {
    if (!parsed.success) {
      const identity = z.object({ provider: z.string(), name: z.string().optional() }).safeParse(payload.data[index]);
      return {
        id: `invalid-${index}`,
        providerId: identity.success ? identity.data.provider : '',
        providerName: identity.success ? identity.data.name || identity.data.provider : 'Magpie',
        accountLabel: null,
        planLabel: null,
        windows: {},
        sampledAt: null,
        error: 'MAGPIE_INVALID_RESPONSE',
      };
    }
    const card = parsed.data;
    const id = createHash('sha256').update(JSON.stringify([
      card.provider, card.kind, card.user || card.alias || card.seat || card.name, card.from || '',
    ])).digest('hex').slice(0, 24);
    const sampledAt = timestamp(card.readAt || card.asOf);
    const historyKey = magpieHistoryKey(card.provider, card.user);
    const accountHistory = !card.from && historyKeys.get(historyKey) === 1 ? history?.get(historyKey) : undefined;
    const windows = new Map<string, MagpieUsageWindow>();
    let error = card.error || null;
    for (const [windowIndex, rawWindow] of card.windows.entries()) {
      const parsedWindow = windowSchema.safeParse(rawWindow);
      if (!parsedWindow.success) { error ||= 'MAGPIE_INVALID_RESPONSE'; continue; }
      const source = parsedWindow.data;
      const isPercent = !source.text && !source.unlimited && source.balance === undefined;
      const remaining = isPercent
        ? percent(source.remaining ?? (source.used === undefined ? undefined : 100 - source.used))
        : null;
      const resetAt = timestamp(source.resetsAt);
      const window: MagpieUsageWindow = toUsageWindow({
        usedPercent: remaining === null ? null : 100 - remaining,
        windowSeconds: null,
        resetAt,
        valueLabel: source.text ? source.display || null : null,
      });
      if (source.unlimited) {
        window.value = { kind: 'unlimited' };
      } else if (source.balance !== undefined) {
        window.value = { kind: 'remaining', amount: source.balance, unit: source.unit || '' };
      } else if (!source.text && source.limit !== undefined && source.limit > 0) {
        const used = Math.max(0, source.amount ?? 0);
        window.value = { kind: 'remaining', amount: Math.max(0, source.limit - used), used, unit: source.unit || '' };
      }
      const name = lineName(source);
      const points = accountHistory?.get(name);
      if (remaining !== null && points) {
        const trend = magpieTrendFor(points, { sampledAt, remaining, resetAt });
        if (trend) window.magpieTrend = trend;
      } else if (remaining !== null && history === null) {
        window.magpieTrend = null;
      }
      const duplicate = windows.get(name);
      if (duplicate) delete duplicate.magpieTrend;
      const key = duplicate ? `${name} · ${windowIndex + 1}` : name;
      if (duplicate) delete window.magpieTrend;
      windows.set(key, window);
    }
    const sharedBalance = card.sharedBalance && card.sharedBalance !== card.user ? card.sharedBalance : null;
    if (card.balance && !sharedBalance) {
      windows.set('credits_balance', toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: card.balance }));
    }
    return {
      id,
      providerId: card.provider,
      providerName: card.name || card.provider,
      accountLabel: card.alias || card.user || card.seat || null,
      planLabel: card.plan || null,
      windows: Object.fromEntries(windows),
      sampledAt,
      error,
      sharedBalance: sharedBalance ?? undefined,
    };
  });
}

async function localEndpoint(configDir: string): Promise<string | null> {
  try {
    const settings: unknown = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf8'));
    const port = z.object({ port: z.number().int().min(0).max(65535).optional() }).parse(settings).port || 3425;
    return `http://127.0.0.1:${port}`;
  } catch (error: unknown) {
    if (errorCodeOf(error) !== 'ENOENT') throw new Error('MAGPIE_SETTINGS_INVALID');
    try {
      await fs.access(path.join(configDir, 'providers.json'));
    } catch (accessError: unknown) {
      if (errorCodeOf(accessError) === 'ENOENT') return null;
      throw new Error('MAGPIE_SETTINGS_INVALID');
    }
    return 'http://127.0.0.1:3425';
  }
}

const defaultConfigDirectory = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie');

export const isMagpieQuotaConfigured = async () => Boolean(await localEndpoint(defaultConfigDirectory()));

export function createMagpieQuotaReader({ fetchImpl = fetch, configDir, timeoutMs }: MagpieQuotaReaderOptions = {}): MagpieQuotaReader {
  const pending = new Map<string, { refresh: boolean; promise: Promise<MagpieQuotaResult> }>();
  return ({ refresh = false, history = true } = {}) => {
    const directory = configDir ?? defaultConfigDirectory();
    const key = JSON.stringify([directory, history]);
    const existing = pending.get(key);
    if (existing && (!refresh || existing.refresh)) return existing.promise;
    const promise: Promise<MagpieQuotaResult> = (async () => {
      const result = (
        fields: Omit<QuotaResultInput<'magpie', 'Magpie', MagpieUsage>, 'providerId' | 'providerName' | 'configured'> & { configured?: boolean },
      ): MagpieQuotaResult => buildResult<'magpie', 'Magpie', MagpieUsage>({
        providerId: 'magpie',
        providerName: 'Magpie',
        configured: true,
        ...fields,
      });
      let endpoint: string | null;
      try {
        endpoint = await localEndpoint(directory);
      } catch {
        return result({ ok: false, error: 'MAGPIE_SETTINGS_INVALID' });
      }
      if (!endpoint) return result({ ok: false, configured: false, error: 'MAGPIE_NOT_CONFIGURED' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? (refresh ? 38_000 : 5_000));
      const request = async <Result>(
        url: string,
        method: 'GET' | 'POST',
        schema: z.ZodType<Result>,
        signal = controller.signal,
      ): Promise<Result> => {
        const response = await fetchImpl(endpoint + url, {
          method,
          headers: { Accept: 'application/json' },
          signal,
          redirect: 'error',
        });
        if (response.status === 401 || response.status === 403) throw new Error('MAGPIE_FORBIDDEN');
        if (!response.ok) throw new Error('MAGPIE_REQUEST_FAILED');
        try {
          return schema.parse(await response.json());
        } catch {
          throw new Error('MAGPIE_INVALID_RESPONSE');
        }
      };
      try {
        const readSnapshot = async () => {
          if (refresh) await request('/v1/magpie/quotas/refresh', 'POST', z.unknown());
          return request('/v1/magpie/quotas?kept=1', 'GET', envelope);
        };
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('MAGPIE_TIMEOUT')), { once: true });
        });
        const report = await Promise.race([readSnapshot(), aborted]);
        let trends: MagpieHistory | null | undefined;
        if (history && report.data.length > 0) {
          const historyController = new AbortController();
          let historyTimer: ReturnType<typeof setTimeout> | undefined;
          const historyDeadline = new Promise<null>(resolve => {
            historyTimer = setTimeout(() => {
              historyController.abort();
              resolve(null);
            }, 750);
          });
          try {
            trends = await Promise.race([
              request('/v1/magpie/quotas/history?days=45', 'GET', magpieHistorySchema,
                AbortSignal.any([controller.signal, historyController.signal])),
              historyDeadline,
              aborted,
            ]).catch(() => null);
          } finally {
            clearTimeout(historyTimer);
          }
        }
        return result({ ok: true, usage: { windows: {}, accounts: accountsFrom(report, trends) } });
      } catch (error: unknown) {
        const code = error instanceof Error && error.message.startsWith('MAGPIE_') ? error.message : 'MAGPIE_UNAVAILABLE';
        return result({ ok: false, error: controller.signal.aborted ? 'MAGPIE_TIMEOUT' : code });
      } finally {
        clearTimeout(timer);
      }
    })();
    const entry = { refresh, promise };
    pending.set(key, entry);
    return promise.finally(() => { if (pending.get(key) === entry) pending.delete(key); });
  };
}

export const fetchMagpieQuota: MagpieQuotaReader = createMagpieQuotaReader();
