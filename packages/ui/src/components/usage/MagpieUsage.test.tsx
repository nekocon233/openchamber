import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import type { QuotaAccount } from '@/types/quota';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event });
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { MagpieUsage } = await import('./MagpieUsage');
const { I18nProvider } = await import('@/lib/i18n');
const { useQuotaStore } = await import('@/stores/useQuotaStore');
const window = { usedPercent: 20, remainingPercent: 80, windowSeconds: null, resetAt: null, resetAfterSeconds: null, resetAtFormatted: null, resetAfterFormatted: null };
const accounts: QuotaAccount[] = [
  { id: 'one', providerId: 'codex', providerName: 'Codex', accountLabel: 'work', planLabel: 'pro', sampledAt: 1, error: null,
    windows: {
      '5h': window,
      '7d': { ...window, usedPercent: 100, remainingPercent: 0 },
      credits: { ...window, usedPercent: 20, remainingPercent: 80, value: { kind: 'remaining', amount: 20, used: 5, unit: 'credits' } },
      wallet: { ...window, usedPercent: null, remainingPercent: null, value: { kind: 'remaining', amount: 12, unit: 'points' } },
      credits_balance: { ...window, usedPercent: null, remainingPercent: null, valueLabel: '¥0.00' },
    } },
  { id: 'two', providerId: 'vendor', providerName: 'Custom', accountLabel: 'personal', planLabel: null, sampledAt: null, error: 'vendor offline', windows: {} },
];
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => { for (const root of roots.splice(0)) flushSync(() => root.unmount()); document.body.replaceChildren(); });

for (const compact of [false, true]) test(`switches percentage and counted Magpie windows between remaining and used while keeping wallet balances, compact=${compact}`, () => {
  useQuotaStore.setState({ displayMode: 'remaining' });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container); roots.push(root);
  flushSync(() => root.render(<I18nProvider><MagpieUsage accounts={accounts} compact={compact} /></I18nProvider>));
  expect(container.textContent).toContain('Codex · work · pro');
  expect(container.textContent).toContain('80%');
  expect(container.textContent).toContain('0%');
  expect(container.textContent).toContain('20 credits');
  expect(container.textContent).toContain('12 points');
  expect(container.textContent).toContain('¥0.00');
  expect(container.textContent).toContain('Custom · personal');
  expect(container.textContent).toContain('vendor offline');
  expect(container.textContent).not.toContain('20%');
  expect(container.textContent).not.toContain('5 credits');
  if (!compact) expect([...container.querySelectorAll('[role="progressbar"]')].map(element => element.getAttribute('aria-valuenow'))).toEqual(['80', '0', '80']);

  flushSync(() => useQuotaStore.setState({ displayMode: 'usage' }));
  expect(container.textContent).toContain('20%');
  expect(container.textContent).toContain('100%');
  expect(container.textContent).toContain('5 credits');
  expect(container.textContent).toContain('12 points');
  expect(container.textContent).toContain('¥0.00');
  expect(container.textContent).not.toContain('80%');
  expect(container.textContent).not.toContain('20 credits');
  if (!compact) expect([...container.querySelectorAll('[role="progressbar"]')].map(element => element.getAttribute('aria-valuenow'))).toEqual(['20', '100', '20']);
});
