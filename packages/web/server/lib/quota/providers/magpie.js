import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildResult, toUsageWindow } from '../utils/formatters.js';

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
const timestamp = (value) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const percent = (value) => value === undefined ? null : Math.min(100, Math.max(0, value));

// The gateway's kept report includes every window and never asks a vendor.
// Parse cards independently so one broken vendor cannot erase the others.
function accountsFrom(payload) {
  return envelope.parse(payload).data.map((raw, index) => {
    const parsed = cardSchema.safeParse(raw);
    if (!parsed.success) {
      const identity = z.object({ provider: z.string(), name: z.string().optional() }).safeParse(raw);
      return { id: `invalid-${index}`, providerId: identity.success ? identity.data.provider : '',
        providerName: identity.success ? identity.data.name || identity.data.provider : 'Magpie',
        accountLabel: null, planLabel: null, windows: {}, sampledAt: null, error: 'MAGPIE_INVALID_RESPONSE' };
    }
    const card = parsed.data;
    const id = createHash('sha256').update(JSON.stringify([
      card.provider, card.kind, card.user || card.alias || card.seat || card.name, card.from || '',
    ])).digest('hex').slice(0, 24);
    const windows = {};
    let error = card.error || null;
    for (const [index, rawWindow] of card.windows.entries()) {
      const parsedWindow = windowSchema.safeParse(rawWindow);
      if (!parsedWindow.success) { error ||= 'MAGPIE_INVALID_RESPONSE'; continue; }
      const source = parsedWindow.data;
      const isPercent = !source.text && !source.unlimited && source.balance === undefined;
      const remaining = isPercent ? percent(source.remaining ?? (source.used === undefined ? undefined : 100 - source.used)) : null;
      const window = toUsageWindow({
        usedPercent: remaining === null ? null : 100 - remaining,
        windowSeconds: null, resetAt: timestamp(source.resetsAt),
        valueLabel: source.text ? source.display || null : null,
      });
      if (source.unlimited) window.value = { kind: 'unlimited' };
      else if (source.balance !== undefined) window.value = { kind: 'remaining', amount: source.balance, unit: source.unit || '' };
      else if (!source.text && source.limit > 0) {
        // Magpie omits zero amounts from JSON with Go's omitempty.
        window.value = { kind: 'remaining', amount: Math.max(0, source.limit - Math.max(0, source.amount ?? 0)), unit: source.unit || '' };
      }
      const key = Object.hasOwn(windows, source.name) ? `${source.name} · ${index + 1}` : source.name;
      windows[key] = window;
    }
    // Magpie also marks the representative key with its own user name.
    const sharedBalance = card.sharedBalance && card.sharedBalance !== card.user ? card.sharedBalance : null;
    if (card.balance && !sharedBalance) {
      windows.credits_balance = toUsageWindow({ usedPercent: null, resetAt: null, valueLabel: card.balance });
    }
    return { id, providerId: card.provider, providerName: card.name || card.provider,
      accountLabel: card.alias || card.user || card.seat || null, planLabel: card.plan || null,
      windows, sampledAt: timestamp(card.readAt || card.asOf), error,
      sharedBalance: sharedBalance ?? undefined,
    };
  });
}

async function localEndpoint(configDir) {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf8'));
    const port = z.object({ port: z.number().int().min(0).max(65535).optional() }).parse(settings).port || 3425;
    return `http://127.0.0.1:${port}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('MAGPIE_SETTINGS_INVALID');
    try { await fs.access(path.join(configDir, 'providers.json')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('MAGPIE_SETTINGS_INVALID');
    }
    return 'http://127.0.0.1:3425';
  }
}

/** One owner per runtime process; simultaneous readouts share the manual refresh. */
export function createMagpieQuotaReader({ fetchImpl = fetch, configDir, timeoutMs } = {}) {
  const pending = new Map();
  return ({ refresh = false } = {}) => {
    const directory = configDir ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie');
    const existing = pending.get(directory);
    if (existing && (!refresh || existing.refresh)) return existing.promise;
    const promise = (async () => {
      const result = (fields) => buildResult({ providerId: 'magpie', providerName: 'Magpie', configured: true, ...fields });
      let endpoint;
      try {
        endpoint = await localEndpoint(directory);
      } catch { return result({ ok: false, error: 'MAGPIE_SETTINGS_INVALID' }); }
      if (!endpoint) return result({ ok: false, configured: false, error: 'MAGPIE_NOT_CONFIGURED' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? (refresh ? 38_000 : 5_000));
      const request = async (url, method = 'GET') => {
        const response = await fetchImpl(endpoint + url, { method, headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
        if (response.status === 401 || response.status === 403) throw new Error('MAGPIE_FORBIDDEN');
        if (!response.ok) throw new Error('MAGPIE_REQUEST_FAILED');
        try { return await response.json(); }
        catch { throw new Error('MAGPIE_INVALID_RESPONSE'); }
      };
      try {
        const operation = async () => {
          if (refresh) await request('/v1/magpie/quotas/refresh', 'POST');
          const payload = await request('/v1/magpie/quotas?kept=1');
          let accounts;
          try { accounts = accountsFrom(payload); }
          catch { throw new Error('MAGPIE_INVALID_RESPONSE'); }
          return result({ ok: true, usage: { windows: {}, accounts } });
        };
        const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('MAGPIE_TIMEOUT')), { once: true }));
        return await Promise.race([operation(), aborted]);
      } catch (error) {
        const code = error instanceof Error && error.message.startsWith('MAGPIE_') ? error.message : 'MAGPIE_UNAVAILABLE';
        return result({ ok: false, error: controller.signal.aborted ? 'MAGPIE_TIMEOUT' : code });
      } finally { clearTimeout(timer); }
    })();
    const entry = { refresh, promise };
    pending.set(directory, entry);
    return promise.finally(() => { if (pending.get(directory) === entry) pending.delete(directory); });
  };
}

export const fetchMagpieQuota = createMagpieQuotaReader();
