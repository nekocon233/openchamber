import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { buildResult } from '../../utils/index.js';
import type { ProviderUsage, QuotaResult, UsageWindow } from '../../utils/contracts.js';
import { toClaudeUsage } from './transforms.js';
import { errorCodeOf } from '../../../shared/object-guards.js';
import { isString, isNumber } from '../../../shared/object-guards.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const MAX_CACHE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_EXPIRED_ERROR = 'Claude session expired. Open Claude Code to sign in again.';
const USAGE_DENIED_ERROR = 'Anthropic does not let this Claude token read usage. A token from `claude setup-token` cannot; a Claude Code sign-in (`/login`) can.';

const windowSchema = z.object({
  usedPercent: z.number().nullable(),
  remainingPercent: z.number().nullable(),
  windowSeconds: z.number().nullable(),
  resetAfterSeconds: z.number().nullable(),
  resetAt: z.number().nullable(),
  resetAtFormatted: z.string().nullable(),
  resetAfterFormatted: z.string().nullable(),
  valueLabel: z.string().nullable().optional(),
});
const windowsSchema = z.record(z.string(), windowSchema);
const usageSchema = z.object({
  windows: windowsSchema,
  models: z.record(z.string(), z.object({ windows: windowsSchema })).optional(),
});

type SnapshotWindow = z.infer<typeof windowSchema>;
type SnapshotUsage = z.infer<typeof usageSchema>;
export type ClaudeRefreshState = 'fresh' | 'cached' | 'rate-limited' | 'error';

const hasUsage = (usage: ProviderUsage | SnapshotUsage): boolean => (
  Object.keys(usage.windows).length > 0
  || Object.values(usage.models ?? {}).some((model) => Object.keys(model.windows).length > 0)
);

const snapshotSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  usage: usageSchema.nullable(),
  sampledAt: z.number().nonnegative().nullable(),
  planLabel: z.string().nullable(),
  nextAttemptAt: z.number().nonnegative(),
  rateLimitLevel: z.number().int().min(0).max(5),
  state: z.enum(['fresh', 'rate-limited', 'error']),
  error: z.string().nullable(),
}).refine((value) => (value.usage === null) === (value.sampledAt === null)
  && (value.usage === null || hasUsage(value.usage)));

type ClaudeSnapshot = z.infer<typeof snapshotSchema>;

export interface ClaudeQuotaCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt?: number | null;
  planLabel: string | null;
}

export type ClaudeCredentialReader = () => ClaudeQuotaCredential | null | Promise<ClaudeQuotaCredential | null>;

export interface ClaudeQuotaRefresh {
  state: ClaudeRefreshState;
  sampledAt: number | null;
  nextAttemptAt: number;
}

export interface ClaudeQuotaResult extends QuotaResult<'claude', 'Claude', ProviderUsage> {
  refresh?: ClaudeQuotaRefresh;
}

export interface ClaudeQuotaTrackerOptions {
  cacheScope: string;
  loadCredential: ClaudeCredentialReader;
  cacheFile?: () => string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface ClaudeQuotaTracker {
  fetchQuota: (loadCredential?: ClaudeCredentialReader) => Promise<ClaudeQuotaResult>;
  readCachedQuota: (loadCredential?: ClaudeCredentialReader) => Promise<ClaudeQuotaResult | null>;
  reset: () => void;
}

interface TrackerOwner {
  file: string;
  pending: Promise<ClaudeQuotaResult> | null;
  snapshot: ClaudeSnapshot;
}

const toProviderWindow = (window: SnapshotWindow): UsageWindow => {
  const result: UsageWindow = {
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    windowSeconds: window.windowSeconds,
    resetAfterSeconds: window.resetAfterSeconds,
    resetAt: window.resetAt,
    resetAtFormatted: window.resetAtFormatted,
    resetAfterFormatted: window.resetAfterFormatted,
  };
  if (isString(window.valueLabel) && window.valueLabel.length > 0) {
    result.valueLabel = window.valueLabel;
  }
  return result;
};

const toProviderUsage = (usage: SnapshotUsage | null): ProviderUsage | null => {
  if (!usage) return null;
  const windows: Record<string, UsageWindow> = {};
  for (const [key, window] of Object.entries(usage.windows)) {
    windows[key] = toProviderWindow(window);
  }
  if (!usage.models) return { windows };
  const models: Record<string, ProviderUsage> = {};
  for (const [modelName, model] of Object.entries(usage.models)) {
    const modelWindows: Record<string, UsageWindow> = {};
    for (const [key, window] of Object.entries(model.windows)) {
      modelWindows[key] = toProviderWindow(window);
    }
    models[modelName] = { windows: modelWindows };
  }
  return { windows, models };
};

const toSnapshotWindow = (window: UsageWindow): SnapshotWindow => {
  const usedPercent = isNumber(window.usedPercent) && Number.isFinite(window.usedPercent)
    ? window.usedPercent
    : null;
  const resetAt = isNumber(window.resetAt) && Number.isFinite(window.resetAt)
    ? window.resetAt
    : null;
  const base: SnapshotWindow = {
    usedPercent,
    remainingPercent: window.remainingPercent,
    windowSeconds: window.windowSeconds,
    resetAfterSeconds: window.resetAfterSeconds,
    resetAt,
    resetAtFormatted: window.resetAtFormatted,
    resetAfterFormatted: window.resetAfterFormatted,
  };
  if (window.valueLabel !== undefined) {
    base.valueLabel = window.valueLabel;
  }
  return base;
};

const toSnapshotUsage = (usage: ProviderUsage): SnapshotUsage => {
  const windows: Record<string, SnapshotWindow> = {};
  for (const [key, window] of Object.entries(usage.windows)) {
    windows[key] = toSnapshotWindow(window);
  }
  if (!usage.models || Object.keys(usage.models).length === 0) {
    return { windows };
  }
  const models: Record<string, { windows: Record<string, SnapshotWindow> }> = {};
  for (const [modelName, model] of Object.entries(usage.models)) {
    const modelWindows: Record<string, SnapshotWindow> = {};
    for (const [key, window] of Object.entries(model.windows)) {
      modelWindows[key] = toSnapshotWindow(window);
    }
    models[modelName] = { windows: modelWindows };
  }
  return { windows, models };
};

const cachePathFor = (scope: string): string => {
  const directory = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  const namespace = createHash('sha256').update(scope).digest('hex').slice(0, 24);
  return path.join(directory, 'quota', `claude-usage-${namespace}.json`);
};

const retryAfterMs = (response: Response, now: number): number => {
  const raw = response.headers.get('retry-after');
  if (!raw?.trim()) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1000;
    return Number.isFinite(now + milliseconds) ? milliseconds : 0;
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
};

export const createClaudeQuotaTracker = ({
  cacheScope,
  loadCredential,
  cacheFile = () => cachePathFor(cacheScope),
  now = () => Date.now(),
  fetchImpl = (...args) => fetch(...args),
}: ClaudeQuotaTrackerOptions): ClaudeQuotaTracker => {
  let active: TrackerOwner | null = null;
  let warned = false;

  const warn = () => {
    if (warned) return;
    warned = true;
    console.warn('Claude usage cache could not be read or written; request limits remain active in memory.');
  };

  const removeCache = (file: string) => {
    try { fs.unlinkSync(file); } catch (error: unknown) {
      if (errorCodeOf(error) !== 'ENOENT') warn();
    }
  };

  const readSnapshot = (file: string, fingerprint: string): ClaudeSnapshot | null => {
    try {
      if (fs.statSync(file).size > MAX_CACHE_BYTES) {
        warn();
        return null;
      }
      const parsed = snapshotSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) {
        warn();
        return null;
      }
      if (parsed.data.fingerprint !== fingerprint) return null;
      return parsed.data;
    } catch (error: unknown) {
      if (errorCodeOf(error) === 'ENOENT') return null;
      warn();
      throw error;
    }
  };

  const persist = (owner: TrackerOwner) => {
    if (active !== owner) return;
    const serialized = `${JSON.stringify(owner.snapshot)}\n`;
    if (Buffer.byteLength(serialized) > MAX_CACHE_BYTES) {
      removeCache(owner.file);
      warn();
      return;
    }
    const directory = path.dirname(owner.file);
    const temporary = `${owner.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (fs.mkdirSync(directory, { recursive: true, mode: 0o700 })) fs.chmodSync(directory, 0o700);
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, owner.file);
    } catch {
      warn();
    } finally {
      try { fs.unlinkSync(temporary); } catch { void 0; }
    }
  };

  const clearInvalidSample = (snapshot: ClaudeSnapshot): boolean => {
    if (snapshot.sampledAt !== null && snapshot.sampledAt > now()) {
      snapshot.usage = null;
      snapshot.sampledAt = null;
      if (snapshot.state === 'fresh') {
        snapshot.state = 'error';
        snapshot.error = 'Saved Claude usage has an invalid timestamp.';
      }
      return true;
    }
    return false;
  };

  const resultFor = (
    snapshot: ClaudeSnapshot,
    state: ClaudeRefreshState = snapshot.state,
    error: string | null = snapshot.error,
  ): ClaudeQuotaResult => ({
    ...buildResult({
      providerId: 'claude' as const,
      providerName: 'Claude' as const,
      ok: (state === 'fresh' || state === 'cached') && snapshot.usage !== null,
      configured: true,
      usage: toProviderUsage(snapshot.usage),
      planLabel: snapshot.planLabel,
      error,
    }),
    refresh: {
      state,
      sampledAt: snapshot.sampledAt,
      nextAttemptAt: snapshot.nextAttemptAt,
    },
  });

  const requestUsage = async (owner: TrackerOwner, credential: ClaudeQuotaCredential): Promise<ClaudeQuotaResult> => {
    const { snapshot } = owner;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Claude usage request timed out'));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        fetchImpl('https://api.anthropic.com/api/oauth/usage', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          signal: controller.signal,
        }),
        deadline,
      ]);
      snapshot.nextAttemptAt = now() + REFRESH_INTERVAL_MS;
      if (response.status === 429) {
        snapshot.rateLimitLevel = Math.min(5, snapshot.rateLimitLevel + 1);
        const backoff = Math.min(MAX_BACKOFF_MS, REFRESH_INTERVAL_MS * 2 ** (snapshot.rateLimitLevel - 1));
        snapshot.nextAttemptAt = now() + Math.max(backoff, retryAfterMs(response, now()));
        snapshot.state = 'rate-limited';
        snapshot.error = 'Claude usage query rate limited.';
      } else if (response.status === 401) {
        snapshot.usage = null;
        snapshot.sampledAt = null;
        snapshot.state = 'error';
        snapshot.error = SESSION_EXPIRED_ERROR;
      } else if (response.status === 403) {
        snapshot.usage = null;
        snapshot.sampledAt = null;
        snapshot.state = 'error';
        snapshot.error = USAGE_DENIED_ERROR;
      } else if (!response.ok) {
        snapshot.state = 'error';
        snapshot.error = `API error: ${response.status}`;
      } else {
        const payload: unknown = await Promise.race([response.json(), deadline]);
        const usage = toClaudeUsage(payload);
        if (!hasUsage(usage)) {
          snapshot.state = 'error';
          snapshot.error = 'Unexpected response from Anthropic';
        } else {
          snapshot.usage = toSnapshotUsage(usage);
          snapshot.sampledAt = now();
          snapshot.rateLimitLevel = 0;
          snapshot.state = 'fresh';
          snapshot.error = null;
        }
      }
    } catch {
      snapshot.state = 'error';
      snapshot.error = 'Claude usage request failed.';
    } finally {
      clearTimeout(timeout);
      snapshot.nextAttemptAt = Math.max(snapshot.nextAttemptAt, now() + REFRESH_INTERVAL_MS);
      clearInvalidSample(snapshot);
      persist(owner);
    }
    if (active !== owner) {
      return buildResult({
        providerId: 'claude' as const,
        providerName: 'Claude' as const,
        configured: true,
        ok: false,
        error: 'Claude account changed. Refresh usage again.',
      });
    }
    return resultFor(snapshot);
  };

  const loadOwner = async (readCredential: ClaudeCredentialReader, cachedOnly = false): Promise<{ owner: TrackerOwner; credential: ClaudeQuotaCredential } | null> => {
    const credential = await readCredential();
    if (!credential) {
      removeCache(active?.file ?? cacheFile());
      active = null;
      return null;
    }
    const fingerprint = createHash('sha256')
      .update(`${credential.accessToken}\0${credential.refreshToken ?? ''}`).digest('hex');
    if (active?.snapshot.fingerprint !== fingerprint) {
      const file = cacheFile();
      let saved: ClaudeSnapshot | null = null;
      try { saved = readSnapshot(file, fingerprint); } catch {
        if (cachedOnly) throw new Error('Could not read saved Claude usage');
      }
      if (!saved) removeCache(file);
      active = {
        file,
        pending: null,
        snapshot: saved ?? {
          version: 1,
          fingerprint,
          usage: null,
          sampledAt: null,
          planLabel: credential.planLabel,
          nextAttemptAt: 0,
          rateLimitLevel: 0,
          state: 'error',
          error: null,
        },
      };
    }
    const owner = active;
    owner.snapshot.planLabel = credential.planLabel ?? owner.snapshot.planLabel;
    if (clearInvalidSample(owner.snapshot)) persist(owner);
    return { owner, credential };
  };

  const readCachedQuota = async (readCredential: ClaudeCredentialReader = loadCredential): Promise<ClaudeQuotaResult | null> => {
    const loaded = await loadOwner(readCredential, true);
    if (!loaded?.owner.snapshot.usage) return null;
    return resultFor(loaded.owner.snapshot, 'cached', null);
  };

  const fetchQuota = async (readCredential: ClaudeCredentialReader = loadCredential): Promise<ClaudeQuotaResult> => {
    const loaded = await loadOwner(readCredential);
    if (!loaded) {
      return buildResult({
        providerId: 'claude' as const,
        providerName: 'Claude' as const,
        configured: false,
        ok: false,
        error: 'Not configured',
      });
    }
    const { owner, credential } = loaded;
    const expiresAt = credential.expiresAt ?? null;
    if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now()) {
      return buildResult({
        providerId: 'claude' as const,
        providerName: 'Claude' as const,
        configured: true,
        ok: false,
        error: SESSION_EXPIRED_ERROR,
      });
    }
    if (owner.pending) return owner.pending;
    if (now() < owner.snapshot.nextAttemptAt) {
      return resultFor(owner.snapshot, owner.snapshot.state === 'fresh' ? 'cached' : owner.snapshot.state);
    }

    owner.snapshot.nextAttemptAt = now() + REFRESH_INTERVAL_MS;
    persist(owner);
    owner.pending = requestUsage(owner, credential).finally(() => { owner.pending = null; });
    return owner.pending;
  };

  return {
    fetchQuota,
    readCachedQuota,
    reset: () => {
      active = null;
      warned = false;
    },
  };
};
