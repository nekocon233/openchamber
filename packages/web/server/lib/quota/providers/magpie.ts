import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildResult, toUsageWindow } from '../utils/formatters.js';
import type { ProviderUsage, QuotaResult, QuotaResultInput, UsageWindow } from '../utils/contracts.js';
import { errorCodeOf } from '../../shared/object-guards.js';

export type MagpieWindowValue =
  | { kind: 'unlimited' }
  | { kind: 'remaining'; amount: number; used?: number; unit: string };

export interface MagpieUsageWindow extends UsageWindow {
  value?: MagpieWindowValue;
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

export type MagpieQuotaReader = (options?: { refresh?: boolean }) => Promise<MagpieQuotaResult>;

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
  display: z.string().optional(), balance: z.number().finite().optional(),
  amount: z.number().finite().optional(), limit: z.number().finite().optional(), unit: z.string().optional(),
});

const timestamp = (value: string | undefined): number | null => (
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
);
const percent = (value: number | undefined): number | null => (
  value === undefined ? null : Math.min(100, Math.max(0, value))
);
function accountsFrom(payload: Parameters<typeof envelope.parse>[0]): MagpieAccount[] {
  return envelope.parse(payload).data.map((raw, index): MagpieAccount => {
    const parsed = cardSchema.safeParse(raw);
    if (!parsed.success) {
      const identity = z.object({ provider: z.string(), name: z.string().optional() }).safeParse(raw);
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
    const windows: Record<string, MagpieUsageWindow> = {};
    let error = card.error || null;
    for (const [windowIndex, rawWindow] of card.windows.entries()) {
      const parsedWindow = windowSchema.safeParse(rawWindow);
      if (!parsedWindow.success) { error ||= 'MAGPIE_INVALID_RESPONSE'; continue; }
      const source = parsedWindow.data;
      const isPercent = !source.text && !source.unlimited && source.balance === undefined;
      const remaining = isPercent
        ? percent(source.remaining ?? (source.used === undefined ? undefined : 100 - source.used))
        : null;
      const window: MagpieUsageWindow = toUsageWindow({
        usedPercent: remaining === null ? null : 100 - remaining,
        windowSeconds: null,
        resetAt: timestamp(source.resetsAt),
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
      const key = Object.hasOwn(windows, source.name) ? `${source.name} · ${windowIndex + 1}` : source.name;
      windows[key] = window;
    }
    const sharedBalance = card.sharedBalance && card.sharedBalance !== card.user ? card.sharedBalance : null;
    if (card.balance && !sharedBalance) {
      windows.credits_balance = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: card.balance });
    }
    return {
      id,
      providerId: card.provider,
      providerName: card.name || card.provider,
      accountLabel: card.alias || card.user || card.seat || null,
      planLabel: card.plan || null,
      windows,
      sampledAt: timestamp(card.readAt || card.asOf),
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
  return ({ refresh = false } = {}) => {
    const directory = configDir ?? defaultConfigDirectory();
    const existing = pending.get(directory);
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
        decode: (payload: Parameters<typeof envelope.parse>[0]) => Result,
      ): Promise<Result> => {
        const response = await fetchImpl(endpoint + url, {
          method,
          headers: { Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
        });
        if (response.status === 401 || response.status === 403) throw new Error('MAGPIE_FORBIDDEN');
        if (!response.ok) throw new Error('MAGPIE_REQUEST_FAILED');
        try {
          return decode(await response.json());
        } catch {
          throw new Error('MAGPIE_INVALID_RESPONSE');
        }
      };
      try {
        const operation = async (): Promise<MagpieQuotaResult> => {
          if (refresh) await request('/v1/magpie/quotas/refresh', 'POST', () => undefined);
          const accounts = await request('/v1/magpie/quotas?kept=1', 'GET', accountsFrom);
          return result({ ok: true, usage: { windows: {}, accounts } });
        };
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('MAGPIE_TIMEOUT')), { once: true });
        });
        return await Promise.race([operation(), aborted]);
      } catch (error: unknown) {
        const code = error instanceof Error && error.message.startsWith('MAGPIE_') ? error.message : 'MAGPIE_UNAVAILABLE';
        return result({ ok: false, error: controller.signal.aborted ? 'MAGPIE_TIMEOUT' : code });
      } finally {
        clearTimeout(timer);
      }
    })();
    const entry = { refresh, promise };
    pending.set(directory, entry);
    return promise.finally(() => { if (pending.get(directory) === entry) pending.delete(directory); });
  };
}

export const fetchMagpieQuota: MagpieQuotaReader = createMagpieQuotaReader();
