import type { I18nKey } from '@/lib/i18n';
import type { ProviderResult } from '@/types';

export const formatQuotaRefreshStatus = (
  result: ProviderResult | null | undefined,
  t: (key: I18nKey) => string,
  refreshError?: string,
): string | null => {
  const refresh = result?.refresh;
  if (!refresh) return null;
  if (refresh.state === 'rate-limited') {
    return t('usage.refresh.limited');
  }
  return refreshError ?? result.error ?? null;
};
