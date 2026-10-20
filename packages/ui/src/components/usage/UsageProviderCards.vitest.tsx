import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict as english } from '@/lib/i18n/messages/en';
import { dict as chinese } from '@/lib/i18n/messages/zh-CN';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult } from '@/types';
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
  test('restores saved usage without a live refresh or an empty-data message', async () => {
    const current = useQuotaStore.getState().results[0];
    const saved: ProviderResult = { ...current, ok: true,
      refresh: { state: 'cached', sampledAt: SAMPLE, nextAttemptAt: SAMPLE + 600_000 } };
    flushSync(() => useQuotaStore.setState({ results: [], refreshErrors: {} }));
    const network = spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(input.toString()).toBe('/api/quota/claude/cached');
      return Response.json(saved);
    });
    try {
      await useQuotaStore.getState().loadCachedClaudeQuota();
      flushSync(() => root.render(<I18nProvider><UsageProviderCardsFixture /></I18nProvider>));
      expect(container.textContent).toContain('12%');
      expect(container.textContent).not.toContain('No usage data available yet.');
      expect(container.textContent).not.toContain('Updated');
      expect(network.mock.calls).toHaveLength(1);
    } finally {
      network.mockRestore();
    }
  });

  test('keeps the manual refresh surface reachable before the first Claude query', () => {
    flushSync(() => useQuotaStore.setState({ results: [], refreshErrors: {} }));
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).not.toContain('No usage data available yet.');
    expect(container.textContent).not.toContain('12%');
  });

  test('shows successful usage without an update or manual-refresh timing hint', () => {
    const current = useQuotaStore.getState().results[0];
    flushSync(() => useQuotaStore.setState({ refreshErrors: {}, results: [{
      ...current, ok: true, refresh: { state: 'cached', sampledAt: SAMPLE, nextAttemptAt: SAMPLE + 600_000 },
    }] }));
    expect(container.textContent).toContain('12%');
    expect(container.textContent).not.toContain('Updated');
    expect(container.textContent).not.toContain('Manual refresh');
    expect(container.textContent).not.toContain('Usage query limited.');
  });

  test('reports no saved usage when the runtime clears the sample for another account', () => {
    const current = useQuotaStore.getState().results[0];
    flushSync(() => useQuotaStore.setState({ results: [{
      ...current, usage: null, refresh: { state: 'rate-limited', sampledAt: null, nextAttemptAt: SAMPLE + 600_000 },
    }] }));
    expect(container.textContent).not.toContain('12%');
    expect(container.textContent).not.toContain('Updated');
    expect(container.textContent).toContain('Usage query limited.');
    expect(container.textContent).not.toContain('Manual refresh');
  });

  test('reacts to a locale change while preserving the quota rows', () => {
    flushSync(() => useI18nStore.setState({ locale: 'zh-CN', dictionary: chinese, loadingLocale: null }));
    expect(container.textContent).toContain('用量查询受限');
    expect(container.textContent).not.toContain('手动刷新');
    expect(container.textContent).not.toContain('更新于');
    expect(container.textContent).toContain('12%');
  });
});
