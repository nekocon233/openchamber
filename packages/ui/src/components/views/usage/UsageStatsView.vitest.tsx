import React from 'react';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { UsageStats } from '@/lib/opencode/session-stats';
import type { Locale } from '@/lib/i18n';

const dom = new Window({ url: 'http://localhost' });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
  KeyboardEvent: dom.KeyboardEvent,
})) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
// Imported stores may bootstrap directory information; this fixture uses only
// the cached report and never reaches a real server.
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json({ home: '/work', path: '/work' }), originalFetch);

const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { useUsageStatsStore, usageStatsKey } = await import('./usageStatsStore');
const { UsageStatsView } = await import('./UsageStatsView');

const changeLocale = (locale: Locale) => new Promise<void>((resolve) => {
  const unsubscribe = useI18nStore.subscribe((state) => {
    if (state.locale === locale && state.loadingLocale === null) { unsubscribe(); resolve(); }
  });
  useI18nStore.getState().setLocale(locale);
  if (useI18nStore.getState().loadingLocale === null) { unsubscribe(); resolve(); }
});

const roots: ReturnType<typeof createRoot>[] = [];
const report = (): UsageStats => ({
  range: { from: Date.now() - 86_400_000, to: Date.now() }, sessions: 1, subagents: 0, prompts: 1, steps: 1,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
  tools: { mode: 'none' }, activeDays: 1, streak: 1, activity: [], models: [],
  coverage: { tokens: { known: 0, missing: 1 }, cost: { known: 0, missing: 1 }, reasoning: { known: 0, missing: 1 }, failedSessions: 0, undated: 0 },
  sources: [{ source: 'deepseek', status: 'ok' }],
});

const render = async (stats: UsageStats) => {
  useProjectsStore.setState({ projects: [] });
  const key = usageStatsKey(getRuntimeKey(), { range: '30d', projectDirectory: null });
  useUsageStatsStore.setState({ entries: { [key]: { stats, fetchedAt: Date.now(), loading: false, error: null } }, toolsRequested: false, toolEntries: {} });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(<I18nProvider><UsageStatsView /></I18nProvider>));
  return container;
};

afterEach(async () => {
  flushSync(() => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  useUsageStatsStore.getState().reset();
  await changeLocale('en');
});

afterAll(() => {
  dom.happyDOM.cancelAsync();
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('unknown native metrics never render a zero cost or token breakdown', async () => {
  const container = await render(report());
  expect(container.textContent).toContain('Unknown');
  expect(container.textContent).not.toContain('did not record');
  expect(container.textContent).not.toContain('$0.00');
  expect(container.textContent).not.toContain('In 0');
});

test('a recorded zero stays zero', async () => {
  const stats = report();
  stats.coverage = undefined;
  stats.sources = [{ source: 'opencode', status: 'ok' }];
  const container = await render(stats);
  expect(container.textContent).toContain('$0.00');
  expect(container.textContent).not.toContain('Unknown');
});

test('a failed source cannot turn readable empty data into an authoritative empty screen', async () => {
  const stats = report();
  stats.steps = 0; stats.prompts = 0;
  stats.sources = [{ source: 'claude', status: 'error' }];
  const container = await render(stats);
  expect(container.textContent).toContain('Some statistics from Claude Code could not be read.');
  expect(container.textContent).not.toContain('No activity in this period');
});

test('source failures translate in place and follow RTL direction without missing-metric notices', async () => {
  const stats = report();
  stats.sources = [{ source: 'deepseek', status: 'partial' }];
  const container = await render(stats);
  expect(container.textContent).toContain('Some statistics from DeepSeek could not be read.');
  await changeLocale('zh-CN');
  flushSync(() => roots[0].render(<I18nProvider><UsageStatsView /></I18nProvider>));
  expect(container.textContent).toContain('无法读取 DeepSeek 的部分统计');
  expect(container.textContent).not.toContain('未记录');
  expect(container.textContent).not.toContain('未单独记录');
  await changeLocale('ar');
  flushSync(() => roots[0].render(<I18nProvider><UsageStatsView /></I18nProvider>));
  expect(document.documentElement.dir).toBe('rtl');
  expect(container.textContent).not.toContain('Some statistics');
  expect(container.textContent).not.toContain('did not record');
  expect(container.textContent).toContain('DeepSeek');
});

test('daily bars and keyboard tooltips show tokens independently of step counts', async () => {
  const stats = report();
  stats.range = { from: new Date(2026, 9, 17).getTime(), to: new Date(2026, 9, 19).getTime() };
  stats.activity = [
    { date: '2026-10-17', steps: 1, tokens: 10_000, tokensComplete: true },
    { date: '2026-10-18', steps: 100, tokens: 1_000, tokensComplete: true },
  ];
  stats.coverage = undefined;
  stats.sources = [{ source: 'opencode', status: 'ok' }];
  const container = await render(stats);
  const chart = container.querySelector<HTMLElement>('[role="group"][aria-label="Tokens per day"]')!;
  expect(chart).toBeTruthy();
  expect(Array.from(chart.querySelectorAll<HTMLElement>('[style]'), (element) => element.style.height)).toEqual(['100%', '10%']);
  flushSync(() => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(chart.querySelector('[aria-live]')?.textContent).toContain('tokens: 10,000');
  flushSync(() => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(chart.querySelector('[aria-live]')?.textContent).toContain('tokens: 1,000');
});

test('partial usage, unknown days and recorded zero have distinct accessible descriptions', async () => {
  const stats = report();
  stats.range = { from: new Date(2026, 9, 17).getTime(), to: new Date(2026, 9, 20).getTime() };
  stats.activity = [
    { date: '2026-10-17', steps: 1, tokens: 10_000, tokensComplete: false },
    { date: '2026-10-18', steps: 1, tokens: null, tokensComplete: false },
    { date: '2026-10-19', steps: 1, tokens: 0, tokensComplete: true },
  ];
  const container = await render(stats);
  const chart = container.querySelector<HTMLElement>('[role="group"][aria-label="Tokens per day"]')!;
  expect(chart.querySelectorAll('.border-dashed')).toHaveLength(1);
  expect(container.textContent).toContain('Dashed bars indicate unknown token usage.');
  flushSync(() => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(chart.querySelector('[aria-live]')?.textContent).toContain('recorded tokens: 10,000');
  flushSync(() => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(chart.querySelector('[aria-live]')?.textContent).toContain('token usage unknown');
  flushSync(() => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(chart.querySelector('[aria-live]')?.textContent).toContain('tokens: 0');
});
