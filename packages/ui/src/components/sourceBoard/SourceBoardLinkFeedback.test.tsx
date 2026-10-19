import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
const { I18nProvider } = await import('@/lib/i18n');
const { SourceBoardLinkFeedback } = await import('./SourceBoardLinkFeedback');

test('failed links stay visible and open externally only on an explicit click', async () => {
  const url = 'https://github.com/org/repo/pull/12';
  const opened: string[] = [];
  Object.defineProperty(dom, 'open', { value: (target: string) => { opened.push(target); return dom; } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let retries = 0;
  try {
    await act(async () => root.render(<I18nProvider>
      <SourceBoardLinkFeedback url={url} state="error" error="Permission denied" onRetry={() => { retries++; }} />
    </I18nProvider>));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Permission denied');
    expect(host.textContent).toContain(url);
    expect(opened).toEqual([]);
    await act(async () => host.querySelectorAll('button')[0]?.click());
    expect(retries).toBe(1);
    expect(opened).toEqual([]);
    await act(async () => host.querySelectorAll('button')[1]?.click());
    expect(opened).toEqual([url]);

    await act(async () => root.render(<I18nProvider><SourceBoardLinkFeedback url={url} state="loading" /></I18nProvider>));
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(opened).toEqual([url]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
