import type { I18nKey } from '@/lib/i18n';

const errors: ReadonlyArray<{ code: string; key: I18nKey }> = [
  { code: 'subscription_sharing_usage_limit_exceeded', key: 'settings.chatgpt.limitReached' },
  { code: 'subscription_sharing_user_not_eligible', key: 'settings.chatgpt.notEligible' },
  { code: 'chatpass_v2_scope_not_authorized', key: 'settings.chatgpt.permissionRequired' },
  { code: 'CHATGPT_PERMISSION_REQUIRED', key: 'settings.chatgpt.permissionRequired' },
  { code: 'CHATGPT_REAUTH_REQUIRED', key: 'settings.chatgpt.reauthorize' },
];

/** Only translate explicit bridge/upstream error codes, not guessed HTTP failures. */
export const chatgptErrorLabel = (message: string): I18nKey | null => (
  errors.find((error) => message.includes(error.code))?.key ?? null
);
