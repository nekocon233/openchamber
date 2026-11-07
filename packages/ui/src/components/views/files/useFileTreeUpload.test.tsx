import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { I18nContextValue } from '@/lib/i18n/react-context';

test('scope changes release busy state and old completions cannot clear a newer upload', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { I18nContext } = await import('@/lib/i18n/react-context');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { useFileTreeUpload } = await import('./useFileTreeUpload');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const apis = createWebAPIs();
  const releases: Array<() => void> = [];
  const uploaded: string[] = [];
  apis.files.uploadFile = async (path) => {
    uploaded.push(path);
    await new Promise<void>((resolve) => releases.push(resolve));
    return { success: true, path };
  };
  const refreshed: string[][] = [];
  const refreshDirectories = async (directories: string[]) => { refreshed.push(directories); };
  const i18n: I18nContextValue = { locale: 'en', direction: 'ltr', locales: ['en'], setLocale() {}, label: (locale) => locale, t: (key) => key };
  let uploader: ReturnType<typeof useFileTreeUpload> | undefined;
  function Harness({ directory, onRefresh }: { directory: string; onRefresh: typeof refreshDirectories }) {
    uploader = useFileTreeUpload({ root: directory, refreshDirectories: onRefresh });
    return <div>{uploader.uploadingDirectory}{uploader.uploadElements}</div>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (directory: string, onRefresh = refreshDirectories) => {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={apis}><I18nContext.Provider value={i18n}><Harness directory={directory} onRefresh={onRefresh} /></I18nContext.Provider></RuntimeAPIContext.Provider>,
    ));
  };
  const drop = (name: string) => ({
    items: [], files: [new File(['data'], name)],
  });
  try {
    await render('/first');
    let first: Promise<void> | undefined;
    await act(async () => { first = uploader!.uploadDroppedFiles('/first', drop('old.txt')); });
    expect(uploader!.uploadingDirectory).toBe('/first');
    await render('/second');
    expect(uploader!.uploadingDirectory).toBeNull();
    let second: Promise<void> | undefined;
    await act(async () => { second = uploader!.uploadDroppedFiles('/second', drop('new.txt')); });
    expect(uploader!.uploadingDirectory).toBe('/second');
    await act(async () => { releases[0](); await first; });
    expect(uploader!.uploadingDirectory).toBe('/second');
    expect(refreshed).toEqual([]);
    let refreshedWithCurrentView = false;
    await render('/second', async (directories) => {
      refreshedWithCurrentView = true;
      refreshed.push(directories);
    });
    await act(async () => { releases[1](); await second; });
    expect(uploader!.uploadingDirectory).toBeNull();
    expect(refreshed).toEqual([['/second']]);
    expect(refreshedWithCurrentView).toBe(true);
    expect(uploaded).toEqual(['/first/old.txt', '/second/new.txt']);

    // A picker opened on the old project cannot dispatch after changing roots.
    await act(async () => uploader!.pickFiles('/second'));
    await render('/third');
    const input = container.querySelector('input[type=file]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['data'], 'stale.txt')] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(uploaded).toHaveLength(2);
    expect(uploader!.uploadingDirectory).toBeNull();

    let switched: Promise<void> | undefined;
    await act(async () => { switched = uploader!.uploadDroppedFiles('/third', drop('switch.txt')); });
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: 'other' }));
    expect(uploader!.uploadingDirectory).toBeNull();
    await act(async () => { releases[2](); await switched; });
    expect(refreshed).toEqual([['/second']]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
