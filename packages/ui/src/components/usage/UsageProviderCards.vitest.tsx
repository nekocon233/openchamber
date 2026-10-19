import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict as english } from '@/lib/i18n/messages/en';
import { dict as chinese } from '@/lib/i18n/messages/zh-CN';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUsageProviderGroups } from './usageGroups';
import { UsageProviderCards } from './UsageProviderCards';

const dom = new Window();
let root: Root;
let container: HTMLDivElement;
const SAMPLE = Date.parse('2026-10-19T08:00:00Z');

export const UsageProviderCardsFixture = () => <UsageProviderCards groups={useUsageProviderGroups()} displayMode="usage" timeFormatPreference="24h" />;

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, Event: dom.Event, Image: dom.Image,
  });
});
beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: english, loadingLocale: null });
  useQuotaStore.getState().resetForRuntimeSwitch();
  useQuotaStore.setState({
    dropdownProviderIds: ['claude'], refreshErrors: { claude: 'Claude usage query rate limited.' },
    results: [{
      providerId: 'claude', providerName: 'Claude', configured: true, ok: false, fetchedAt: SAMPLE + 300_000,
      refresh: { state: 'rate-limited', sampledAt: SAMPLE, nextAttemptAt: SAMPLE + 600_000 },
      usage: { windows: { '5h': {
        usedPercent: 12, remainingPercent: 88, windowSeconds: 18000, resetAt: null,
        resetAfterSeconds: null, resetAtFormatted: null, resetAfterFormatted: null,
      } } },
    }],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<I18nProvider><UsageProviderCardsFixture /></I18nProvider>));
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  useQuotaStore.getState().resetForRuntimeSwitch();
});

describe('Claude usage status alongside quota rows', () => {
  test('keeps the manual refresh surface reachable before the first Claude query', () => {
    flushSync(() => useQuotaStore.setState({ results: [], refreshErrors: {} }));
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).toContain('No usage data available yet.');
    expect(container.textContent).not.toContain('12%');
  });

  test('keeps the last measured percentage and displays its age and retry time', () => {
    expect(container.textContent).toContain('12%');
    expect(container.textContent).toContain('Usage query limited.');
    expect(container.textContent).toContain('Updated');
    expect(container.textContent).toContain('Manual refresh');
  });

  test('reports no saved usage when the runtime clears the sample for another account', () => {
    const current = useQuotaStore.getState().results[0];
    flushSync(() => useQuotaStore.setState({ results: [{
      ...current, usage: null, refresh: { state: 'rate-limited', sampledAt: null, nextAttemptAt: SAMPLE + 600_000 },
    }] }));
    expect(container.textContent).not.toContain('12%');
    expect(container.textContent).not.toContain('Updated');
    expect(container.textContent).toContain('No saved usage.');
  });

  test('reacts to a locale change while preserving the quota rows', () => {
    flushSync(() => useI18nStore.setState({ locale: 'zh-CN', dictionary: chinese, loadingLocale: null }));
    expect(container.textContent).toContain('用量查询受限');
    expect(container.textContent).toContain('手动刷新');
    expect(container.textContent).toContain('12%');
  });
});
