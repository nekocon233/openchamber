import type { I18nKey, I18nParams } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import type { ProviderResult } from '@/types';

export const formatQuotaRefreshStatus = (
  result: ProviderResult | null | undefined,
  t: (key: I18nKey, params?: I18nParams) => string,
  preference: TimeFormatPreference,
  refreshError?: string,
): string | null => {
  const refresh = result?.refresh;
  if (!refresh) return null;
  const time = (value: number) => formatDateTimeForPreference(value, preference, {
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const next = time(refresh.nextAttemptAt);
  const updated = refresh.sampledAt === null ? null : time(refresh.sampledAt);
  if (refresh.state === 'rate-limited') {
    return updated === null
      ? t('usage.refresh.limitedWithoutSample', { next })
      : t('usage.refresh.limitedWithSample', { updated, next });
  }
  const timing = updated === null
    ? t('usage.refresh.nextAttempt', { next })
    : t('usage.refresh.updated', { updated, next });
  const error = refreshError ?? result.error;
  return error ? `${error} ${timing}` : timing;
};
