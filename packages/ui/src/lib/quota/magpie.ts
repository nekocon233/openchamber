import type { I18nKey } from '@/lib/i18n';

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
