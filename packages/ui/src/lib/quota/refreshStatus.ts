import type { I18nKey } from '@/lib/i18n';
import type { ProviderResult } from '@/types';
import { formatMagpieError } from './magpie';

export const formatQuotaRefreshStatus = (
  result: ProviderResult | null | undefined,
  t: (key: I18nKey) => string,
  refreshError?: string,
): string | null => {
  if (result?.providerId === 'magpie') {
    if (result.availability === 'unsupported') return t('quota.magpie.error.unsupported');
    const error = refreshError ?? result.error;
    return error ? formatMagpieError(error, t) : null;
  }
  const refresh = result?.refresh;
  if (!refresh) return null;
  if (refresh.state === 'rate-limited') {
    return t('usage.refresh.limited');
  }
  return refreshError ?? result.error ?? null;
};
