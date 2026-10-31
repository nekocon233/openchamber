import { z } from 'zod';
import { buildResult, toUsageWindow } from '../../quota/utils/formatters.js';

const windows = new Map([
  ['Five Hour Limit Remaining', { key: '5h', seconds: 5 * 3600 }],
  ['Weekly Limit Remaining', { key: 'weekly', seconds: 7 * 86400 }],
]);
const families = new Map([['Gemini Models', 'gemini'], ['Claude and GPT models', 'claude-gpt']]);
const percent = z.number().min(0).max(100);

/** agy answers /usage itself as tab-separated rows, without a model turn. */
export const parseAntigravityQuota = (output) => {
  const models = new Map();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [family, label, remaining, reset, ...extra] = line.split('\t');
    const window = windows.get(label);
    if (!family || !window || extra.length > 0 || !remaining) throw new Error('Invalid `agy --print /usage` output');
    const disabled = remaining.toLowerCase() === 'disabled';
    const parsed = percent.safeParse(/^\d+(?:\.\d+)?%$/.test(remaining) ? Number(remaining.slice(0, -1)) : NaN);
    const resetAt = reset ? Date.parse(reset) : null;
    if ((!disabled && !parsed.success) || (resetAt !== null && !Number.isFinite(resetAt))) throw new Error('Invalid Antigravity quota value');
    const key = families.get(family) ?? family;
    const model = models.get(key) ?? { windows: {} };
    if (model.windows[window.key]) throw new Error('Duplicate Antigravity quota window');
    const usageWindow = toUsageWindow({
      usedPercent: disabled ? null : 100 - parsed.data,
      windowSeconds: window.seconds, resetAt,
    });
    if (disabled) usageWindow.valueLabel = remaining;
    model.windows[window.key] = usageWindow;
    models.set(key, model);
  }
  if (models.size === 0) throw new Error('Antigravity reported no quota data');
  return { windows: {}, models: Object.fromEntries(models) };
};

/** All consumers share one bounded CLI read. OAuth stays owned by agy. */
export const createAntigravityQuota = ({ resolveExecutable, readUsage }) => {
  let pending = null;
  const fetch = async () => {
    const base = { providerId: 'antigravity-cli', providerName: 'Antigravity CLI' };
    if (!await resolveExecutable()) return buildResult({ ...base, ok: false, configured: false, error: 'Antigravity CLI is not installed' });
    try {
      return buildResult({ ...base, ok: true, configured: true, usage: parseAntigravityQuota(await readUsage()) });
    } catch (error) {
      return buildResult({ ...base, ok: false, configured: true,
        error: error instanceof Error ? error.message : 'Could not read Antigravity quota' });
    }
  };
  return () => {
    pending ??= fetch().finally(() => { pending = null; });
    return pending;
  };
};
