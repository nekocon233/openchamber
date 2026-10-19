import { describe, expect, test } from 'bun:test';
import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';
import { dict as english } from '@/lib/i18n/messages/en';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { ProviderResult } from '@/types';
import { formatQuotaRefreshStatus } from './refreshStatus';

const translate = (key: I18nKey, params?: I18nParams) => formatMessage(useI18nStore.getState().dictionary, key, params);

const result = (): ProviderResult => ({
  providerId: 'claude', providerName: 'Claude', ok: false, configured: true, usage: null, fetchedAt: 999,
  refresh: { state: 'rate-limited', sampledAt: 100_000, nextAttemptAt: 400_000 },
});

describe('quota refresh status', () => {
  test('explains a rate limit with the true sample time and next attempt', () => {
    const value = result();
    const status = formatQuotaRefreshStatus(value, translate, '24h');
    expect(status).toContain('Usage query limited.');
    expect(status).toContain(formatDateTimeForPreference(100_000, '24h', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    expect(status).toContain('Manual refresh');
  });

  test('does not invent an update time when no successful sample exists', () => {
    const value = result();
    if (value.refresh) value.refresh.sampledAt = null;
    const status = formatQuotaRefreshStatus(value, translate, '24h');
    expect(status).toContain('No saved usage.');
    expect(status).not.toContain('Updated');
  });

  test('keeps specific errors alongside the retry time and supports legacy results', () => {
    const value = result();
    if (value.refresh) value.refresh.state = 'error';
    value.error = 'Open Claude Code to sign in again.';
    expect(formatQuotaRefreshStatus(value, translate, '12h')).toContain(value.error);
    delete value.refresh;
    expect(formatQuotaRefreshStatus(value, translate, '24h')).toBeNull();
  });

  test('every shipped locale translates each new status and keeps its placeholders', async () => {
    const keys = ['usage.refresh.updated', 'usage.refresh.limitedWithSample', 'usage.refresh.limitedWithoutSample', 'usage.refresh.nextAttempt'] as const;
    const locales = ['de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
    for (const locale of locales) {
      const { dict } = await import(`../i18n/messages/${locale}.ts`);
      for (const key of keys) {
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe(english[key]);
        expect(dict[key].match(/\{\w+\}/g)?.sort()).toEqual(english[key].match(/\{\w+\}/g)?.sort());
      }
    }
    useI18nStore.getState().setLocale('zh-CN');
    while (useI18nStore.getState().loadingLocale) await new Promise(resolve => setTimeout(resolve, 1));
    expect(formatQuotaRefreshStatus(result(), translate, '24h')).toContain('用量查询受限');
    useI18nStore.getState().setLocale('en');
  });
});
