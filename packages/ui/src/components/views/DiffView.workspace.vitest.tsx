import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const installDom = () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), previousFetch);
  return () => {
    globalThis.fetch = previousFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
};

test('the workspace list reveals retained details without reading hidden file patches', async () => {
  const restoreDom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { DiffView } = await import('./DiffView');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useGitStore } = await import('@/stores/useGitStore');
  const directory = '/workspace-diff-fixture';
  const originalDirectory = useDirectoryStore.getState();
  const originalUi = useUIStore.getState();
  const originalGit = useGitStore.getState();
  useDirectoryStore.setState({ currentDirectory: directory });
  useUIStore.setState({ diffFileListMode: 'tree' });
  let statusReads = 0;
  let patchReads = 0;
  let detailsVisible = false;
  let listVisible = true;
  const base = createWebAPIs();
  const apis = { ...base, git: { ...base.git,
    checkIsGitRepository: async () => true,
    getGitStatus: async () => {
      statusReads++;
      return { current: 'main', tracking: null, ahead: 0, behind: 0,
        files: [{ path: 'test.bin', index: ' ', working_dir: 'M' }], isClean: false,
        diffStats: { staged: {}, working: { 'test.bin': { insertions: 1, deletions: 0 } } } };
    },
    getGitDiff: async () => { patchReads++; return { diff: 'Binary files a/test.bin and b/test.bin differ', submodule: null }; },
  } };
  const container = document.createElement('div');
  const listHost = document.createElement('div');
  document.body.append(container, listHost);
  const root = createRoot(container);
  const onSelect = () => { detailsVisible = true; };
  const render = () => act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={directory}>
        <DiffView visible={detailsVisible} diffScope="working" stackedDefaultCollapsedAll
          fileListHost={{ host: listHost, visible: listVisible, onSelect }} />
      </SyncProvider>
    </RuntimeAPIContext.Provider></I18nProvider>);
  });
  try {
    await render();
    expect(statusReads).toBe(1);
    expect(patchReads).toBe(0);
    expect(listHost.textContent).toContain('test.bin');
    const item = listHost.querySelector<HTMLButtonElement>('button');
    expect(item).not.toBeNull();
    await act(async () => item?.click());
    expect(detailsVisible).toBe(true);
    await render();
    expect(patchReads).toBe(1);
    expect(container.textContent).toContain('Content of this file cannot be viewed.');
    expect(listHost.textContent).not.toContain('Content of this file cannot be viewed.');
    const content = container.querySelector('[data-diff-virtual-content]');
    detailsVisible = false;
    await render();
    expect(listHost.querySelector('[data-editor-diff-list]')?.classList.contains('hidden')).toBe(false);
    expect(patchReads).toBe(1);
    listVisible = false;
    detailsVisible = true;
    await render();
    expect(listHost.querySelector('[data-editor-diff-list]')?.classList.contains('hidden')).toBe(true);
    expect(container.querySelector('[data-diff-virtual-content]')).toBe(content);
    expect(patchReads).toBe(1);
    expect(statusReads).toBe(1);
  } finally {
    await act(async () => root.unmount());
    useDirectoryStore.setState(originalDirectory, true);
    useUIStore.setState(originalUi, true);
    useGitStore.setState(originalGit, true);
    restoreDom();
  }
});
