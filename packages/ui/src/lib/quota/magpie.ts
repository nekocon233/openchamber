import type { I18nKey } from '@/lib/i18n';
import type { MagpieQuotaTrend } from '@/types/quota';

const errors = new Map<string, I18nKey>([
  ['MAGPIE_NOT_CONFIGURED', 'quota.magpie.error.notConfigured'],
  ['MAGPIE_SETTINGS_INVALID', 'quota.magpie.error.settings'],
  ['MAGPIE_UNAVAILABLE', 'quota.magpie.error.unavailable'],
  ['MAGPIE_FORBIDDEN', 'quota.magpie.error.forbidden'],
  ['MAGPIE_REQUEST_FAILED', 'quota.magpie.error.request'],
  ['MAGPIE_INVALID_RESPONSE', 'quota.magpie.error.invalid'],
  ['MAGPIE_TIMEOUT', 'quota.magpie.error.timeout'],
]);

export const formatMagpieError = (error: string, t: (key: I18nKey) => string): string => {
  const key = errors.get(error);
  return key ? t(key) : error;
};

export function magpieReferenceLeft(cycle: NonNullable<MagpieQuotaTrend['cycle']>, at: number) {
  return 100 * (cycle.reset - at) / (cycle.reset - cycle.start);
}

export const magpiePaceDifference = (reference: number, left: number): number =>
  Number((reference - left).toFixed(10));

export function magpieQuotaPace(trend: MagpieQuotaTrend | null | undefined, now: number): number | null {
  const cycle = trend?.cycle;
  const latest = trend?.points.at(-1);
  if (!cycle || !latest || !trend?.matchesSnapshot || now >= cycle.reset) return null;
  return magpiePaceDifference(magpieReferenceLeft(cycle, latest.at), latest.left);
}
