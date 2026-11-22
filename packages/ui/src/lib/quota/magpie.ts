import type { I18nKey } from '@/lib/i18n';
import type { MagpieQuotaTrend, UsageWindow } from '@/types/quota';

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

const FIVE_HOURS_SECONDS = 5 * 3600;
const FIVE_HOUR_NAMES = new Set(['5h', '5 hour', '5-hour', '5 hours', 'five_hour', '5 小时', '5 小時', '5小时', '5小時']);

export function magpieWorkStatusTrend(
  name: string,
  { windowSeconds, magpieTrend }: Pick<UsageWindow, 'windowSeconds' | 'magpieTrend'>,
): MagpieQuotaTrend | null | undefined {
  const fiveHourRow = windowSeconds === null
    ? name.split(' · ').some(part => FIVE_HOUR_NAMES.has(part.trim().toLowerCase()))
    : windowSeconds === FIVE_HOURS_SECONDS;
  const cycle = magpieTrend?.cycle;
  const fiveHourChart = cycle && cycle.reset - cycle.start === FIVE_HOURS_SECONDS * 1000;
  return fiveHourRow || fiveHourChart ? undefined : magpieTrend;
}

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
