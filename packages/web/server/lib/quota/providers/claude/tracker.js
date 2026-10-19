import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { buildResult } from '../../utils/index.js';
import { toClaudeUsage } from './transforms.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const MAX_SAMPLE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

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
}).refine(value => (value.usage === null) === (value.sampledAt === null));

const hasUsage = (usage) => Object.keys(usage.windows).length > 0
  || Object.values(usage.models ?? {}).some(model => Object.keys(model.windows).length > 0);

const cachePathFor = (scope) => {
  const directory = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  const namespace = createHash('sha256').update(scope).digest('hex').slice(0, 24);
  return path.join(directory, 'quota', `claude-usage-${namespace}.json`);
};

const retryAfterMs = (response, now) => {
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

/** Owns Claude usage request frequency and restart continuity in both runtimes. */
export const createClaudeQuotaTracker = ({
  cacheScope,
  loadCredential,
  cacheFile = () => cachePathFor(cacheScope),
  now = () => Date.now(),
  fetchImpl = (...args) => fetch(...args),
}) => {
  let active = null;
  let warned = false;

  const warn = () => {
    if (warned) return;
    warned = true;
    console.warn('Claude usage cache could not be read or written; request limits remain active in memory.');
  };

  const removeCache = (file) => {
    try { fs.unlinkSync(file); } catch (error) {
      if (error?.code !== 'ENOENT') warn();
    }
  };

  const readSnapshot = (file, fingerprint) => {
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
    } catch (error) {
      if (error?.code !== 'ENOENT') warn();
      return null;
    }
  };

  const persist = (owner) => {
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
      try { fs.unlinkSync(temporary); } catch {}
    }
  };

  const expireSample = (snapshot) => {
    if (snapshot.sampledAt !== null
      && (now() - snapshot.sampledAt > MAX_SAMPLE_AGE_MS || snapshot.sampledAt > now())) {
      snapshot.usage = null;
      snapshot.sampledAt = null;
      if (snapshot.state === 'fresh') {
        snapshot.state = 'error';
        snapshot.error = 'No recent Claude usage is available.';
      }
      return true;
    }
    return false;
  };

  const resultFor = (snapshot, cached = false) => {
    return {
      ...buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: snapshot.state === 'fresh' && snapshot.usage !== null,
        configured: true,
        usage: snapshot.usage,
        planLabel: snapshot.planLabel,
        error: snapshot.error,
      }),
      refresh: {
        state: cached && snapshot.state === 'fresh' ? 'cached' : snapshot.state,
        sampledAt: snapshot.sampledAt,
        nextAttemptAt: snapshot.nextAttemptAt,
      },
    };
  };

  const requestUsage = async (owner, credential) => {
    const { snapshot } = owner;
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_, reject) => {
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
      } else if (response.status === 401 || response.status === 403) {
        snapshot.usage = null;
        snapshot.sampledAt = null;
        snapshot.state = 'error';
        snapshot.error = 'Claude session expired. Open Claude Code to sign in again.';
      } else if (!response.ok) {
        snapshot.state = 'error';
        snapshot.error = `API error: ${response.status}`;
      } else {
        const payload = await Promise.race([response.json(), deadline]);
        const usage = toClaudeUsage(payload);
        if (!hasUsage(usage)) {
          snapshot.state = 'error';
          snapshot.error = 'Unexpected response from Anthropic';
        } else {
          snapshot.usage = usage;
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
      expireSample(snapshot);
      persist(owner);
    }
    if (active !== owner) {
      return buildResult({ providerId: 'claude', providerName: 'Claude', configured: true, ok: false, error: 'Claude account changed. Refresh usage again.' });
    }
    return resultFor(snapshot);
  };

  const fetchQuota = async (readCredential = loadCredential) => {
    const credential = await readCredential();
    if (!credential) {
      removeCache(active?.file ?? cacheFile());
      active = null;
      return buildResult({ providerId: 'claude', providerName: 'Claude', configured: false, ok: false, error: 'Not configured' });
    }
    const fingerprint = createHash('sha256')
      .update(`${credential.accessToken}\0${credential.refreshToken ?? ''}`).digest('hex');
    if (active?.snapshot.fingerprint !== fingerprint) {
      const file = cacheFile();
      const saved = readSnapshot(file, fingerprint);
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
    if (expireSample(owner.snapshot)) persist(owner);
    if (owner.pending) return owner.pending;
    if (now() < owner.snapshot.nextAttemptAt) return resultFor(owner.snapshot, true);

    // Persist the attempt before sending it so a restart during the request
    // preserves the interval. Only a completed success updates the sample.
    owner.snapshot.nextAttemptAt = now() + REFRESH_INTERVAL_MS;
    persist(owner);
    owner.pending = requestUsage(owner, credential).finally(() => { owner.pending = null; });
    return owner.pending;
  };

  return { fetchQuota, reset: () => { active = null; warned = false; } };
};
