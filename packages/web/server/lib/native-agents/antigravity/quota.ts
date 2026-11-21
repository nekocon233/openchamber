import { z } from 'zod';
import { buildResult, toUsageWindow } from '../../quota/utils/formatters.js';
import type { ProviderUsage, QuotaResult, UsageWindow } from '../../quota/utils/contracts.js';

export interface AgyQuotaDependencies {
  resolveExecutable: () => Promise<string | null>;
  readUsage: () => Promise<string>;
}

const windows = new Map<string, { key: string; seconds: number }>([
  ['Five Hour Limit Remaining', { key: '5h', seconds: 5 * 3600 }],
  ['Weekly Limit Remaining', { key: 'weekly', seconds: 7 * 86400 }],
]);
const families = new Map<string, string>([
  ['Gemini Models', 'gemini'],
  ['Claude and GPT models', 'claude-gpt'],
]);
const percent = z.number().min(0).max(100);

export const parseAntigravityQuota = (output: string): ProviderUsage => {
  const models = new Map<string, ProviderUsage>();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [family, label, remaining, reset, ...extra] = line.split('\t');
    const window = label !== undefined ? windows.get(label) : undefined;
    if (!family || !window || extra.length > 0 || !remaining) throw new Error('Invalid `agy --print /usage` output');
    const disabled = remaining.toLowerCase() === 'disabled';
    const parsed = percent.safeParse(/^\d+(?:\.\d+)?%$/.test(remaining) ? Number(remaining.slice(0, -1)) : NaN);
    const resetAt = reset ? Date.parse(reset) : null;
    if ((!disabled && !parsed.success) || (resetAt !== null && !Number.isFinite(resetAt))) {
      throw new Error('Invalid Antigravity quota value');
    }
    const key = families.get(family) ?? family;
    const model = models.get(key) ?? { windows: {} };
    if (model.windows[window.key]) throw new Error('Duplicate Antigravity quota window');
    const usageWindow: UsageWindow = toUsageWindow({
      usedPercent: disabled ? null : parsed.success ? 100 - parsed.data : null,
      windowSeconds: window.seconds,
      resetAt,
    });
    if (disabled) usageWindow.valueLabel = remaining;
    model.windows[window.key] = usageWindow;
    models.set(key, model);
  }
  if (models.size === 0) throw new Error('Antigravity reported no quota data');
  return { windows: {}, models: Object.fromEntries(models) };
};

export const createAntigravityQuota = ({
  resolveExecutable,
  readUsage,
}: AgyQuotaDependencies): (() => Promise<QuotaResult<'antigravity-cli', 'Antigravity CLI'>>) => {
  let pending: Promise<QuotaResult<'antigravity-cli', 'Antigravity CLI'>> | null = null;
  const fetch = async (): Promise<QuotaResult<'antigravity-cli', 'Antigravity CLI'>> => {
    const base = { providerId: 'antigravity-cli', providerName: 'Antigravity CLI' } as const;
    if (!await resolveExecutable()) {
      return buildResult({ ...base, ok: false, configured: false, error: 'Antigravity CLI is not installed' });
    }
    try {
      return buildResult({ ...base, ok: true, configured: true, usage: parseAntigravityQuota(await readUsage()) });
    } catch (error) {
      return buildResult({
        ...base,
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : 'Could not read Antigravity quota',
      });
    }
  };
  return () => {
    pending ??= fetch().finally(() => { pending = null; });
    return pending;
  };
};
