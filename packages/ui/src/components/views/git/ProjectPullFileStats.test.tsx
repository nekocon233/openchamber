import { test, expect } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { ChangeRequestFileStats, GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';

const context: SourceControlReadContext = { provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo', accountId: 'account', bindingRevision: 1, primaryRemote: 'origin' };
const pull = (number: number): GitHubPullReference => ({ kind: 'pull', number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`, body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0, sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'a'.repeat(40), headRepo: null });
const result = (number: number): ChangeRequestFileStats => ({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), files: [{ path: 'a.ts', additions: number, deletions: 1 }, { path: 'b.md', additions: 20, deletions: 2 }] });

test('statistics bound concurrency, stop hidden queued reads, survive cache scale and refilter without requests', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const values = { window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage, Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, Event: dom.Event, CustomEvent: dom.CustomEvent, MutationObserver: dom.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => Response.json({ home: "/fixture", data: [], directory: "/fixture", project: { id: "fixture", directory: "/fixture", canonical: "/fixture" } }) };
  const originals = Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useI18nStore } = await import('@/lib/i18n/store');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const { ProjectPullFileStats } = await import('./ProjectPullFileStats');
  switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'file-stats-test' });
  useI18nStore.getState().setLocale('en');
  const base = createWebAPIs();
  const asked: Array<{ number: number; account: string }> = [];
  const pending: Array<() => void> = [];
  let maximum = 0, fail = 0;
  const apis = { ...base, sourceControl: { ...base.sourceControl, changeRequestFileStats: async (read: SourceControlReadContext, number: number) => {
    asked.push({ number, account: read.accountId });
    await new Promise<void>(resolve => pending.push(resolve));
    if (number === fail) throw new Error('Provider unavailable');
    return result(number);
  } } };
  const node = document.createElement('div');document.body.append(node);const root = createRoot(node);
  const pulls = Array.from({ length: 55 }, (_, index) => pull(index + 1));
  const render = async (shown = pulls, excludedTypes: string[] = [], read = context, refreshVersion = 0) => act(async () => {
    root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider>{shown.map(reference => <section key={reference.number} data-number={reference.number}><ProjectPullFileStats context={read} pull={reference} excludedTypes={excludedTypes} refreshVersion={refreshVersion} /></section>)}</I18nProvider></RuntimeAPIContext.Provider>);
  });
  const drain = async () => {
    for (let round = 0; round < 100; round++) {
      maximum = Math.max(maximum, pending.length);
      if (!pending.length) break;
      await act(async () => { const answers = pending.splice(0);answers.forEach(resolve => resolve()); });
    }
  };
  const row = (number: number) => document.querySelector(`[data-number="${number}"]`)?.textContent;
  try {
    await render();expect(asked).toHaveLength(2);
    await render([]);await drain();expect(asked).toHaveLength(2);
    await render();await drain();expect(asked).toHaveLength(55);expect(maximum).toBe(2);
    expect(row(55)).toContain('2 files·+75−3');
    await render(pulls, ['md']);await drain();expect(asked).toHaveLength(55);expect(row(55)).toContain('1 file·+55−1');
    await render(pulls, ['md', 'ts']);expect(row(1)).toContain('0 files·+0−0');
    fail = 1;await render(pulls.slice(0, 2), [], { ...context, accountId: 'other-account' });await drain();
    expect(row(1)).toContain('File statistics unavailable');expect(row(2)).toContain('2 files·+22−3');
    expect(asked.slice(-2).every(read => read.account === 'other-account')).toBe(true);
    fail = 0;await render(pulls.slice(0, 2), [], { ...context, accountId: 'other-account' }, 1);await drain();expect(row(1)).toContain('2 files·+21−3');
    await render(pulls.slice(0, 2), [], context, 2);
    const beforeSwitch = asked.length;
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'file-stats-other-runtime' });
    await render(pulls.slice(0, 2), [], context, 2);expect(row(1)).toContain('Loading file statistics');
    await drain();expect(asked).toHaveLength(beforeSwitch + 2);expect(row(1)).toContain('2 files·+21−3');
  } finally {
    await act(async () => root.unmount());await drain();await dom.happyDOM.close();
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor);else Reflect.deleteProperty(globalThis, name); }
  }
});
