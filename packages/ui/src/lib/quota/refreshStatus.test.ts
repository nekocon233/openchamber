import { describe, expect, test } from 'bun:test';
import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n';
import { dict as english } from '@/lib/i18n/messages/en';
import type { ProviderResult } from '@/types';
import { formatQuotaRefreshStatus } from './refreshStatus';

const translate = (key: I18nKey) => formatMessage(useI18nStore.getState().dictionary, key);

const result = (): ProviderResult => ({
  providerId: 'claude', providerName: 'Claude', ok: false, configured: true, usage: null, fetchedAt: 999,
  refresh: { state: 'rate-limited', sampledAt: 100_000, nextAttemptAt: 400_000 },
});

describe('quota refresh status', () => {
  test('successful and cached samples add no timing hint', () => {
    for (const state of ['fresh', 'cached'] as const) {
      const value = { ...result(), ok: true, refresh: { state, sampledAt: 100_000, nextAttemptAt: 400_000 } };
      expect(formatQuotaRefreshStatus(value, translate)).toBeNull();
    }
  });

  test('rate limits show only a short error, with or without a saved sample', () => {
    const value = result();
    expect(formatQuotaRefreshStatus(value, translate)).toBe('Usage query limited.');
    if (value.refresh) value.refresh.sampledAt = null;
    expect(formatQuotaRefreshStatus(value, translate)).toBe('Usage query limited.');
  });

  test('keeps specific errors and supports legacy results', () => {
    const value = result();
    if (value.refresh) value.refresh.state = 'error';
    value.error = 'Open Claude Code to sign in again.';
    expect(formatQuotaRefreshStatus(value, translate)).toContain(value.error);
    delete value.refresh;
    expect(formatQuotaRefreshStatus(value, translate)).toBeNull();
  });

  test('every shipped locale translates the short rate-limit status', async () => {
    const keys = ['usage.refresh.limited'] as const;
    const locales = ['de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
    for (const locale of locales) {
      const { dict } = await import(`../i18n/messages/${locale}.ts`);
      for (const key of keys) {
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe(english[key]);
        expect(dict[key]).not.toContain('{');
      }
    }
    useI18nStore.getState().setLocale('zh-CN');
    while (useI18nStore.getState().loadingLocale) await new Promise(resolve => setTimeout(resolve, 1));
    expect(formatQuotaRefreshStatus(result(), translate)).toContain('用量查询受限');
    useI18nStore.getState().setLocale('en');
  });
});
