import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('remount restores the chosen file and a new explicit request supersedes it once', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useWorkspaceViewStateStore, workspaceViewKey } = await import('@/stores/useWorkspaceViewStateStore');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { DiffView } = await import('./DiffView');
  const directory = '/restored-diff';
  const base = createWebAPIs();
  const reads: Array<{ path?: string; staged?: boolean }> = [];
  const status = { current: 'main', tracking: null, ahead: 0, behind: 0, isClean: false,
    files: ['a.bin', 'b.bin'].map(path => ({ path, index: 'M', working_dir: 'M' })) };
  const apis = { ...base, git: { ...base.git, checkIsGitRepository: async () => true, getGitStatus: async () => status,
    getGitDiff: async (_directory: string, options: { path?: string; staged?: boolean }) => {
      reads.push(options); return { diff: 'Binary files a/test.bin and b/test.bin differ', submodule: null };
    },
  } };
  useUIStore.setState({ diffFileListMode: 'tree' });
  const list = document.createElement('div');
  const body = document.createElement('div');
  document.body.append(list, body);
  let root = createRoot(body);
  const render = () => act(async () => root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>
    <SyncProvider sdk={opencodeClient.getSdkClient()} directory={directory}>
      <DiffView directory={directory} diffScope="working" targetFilePath="a.bin"
        fileListHost={{ host: list, visible: true, onSelect: () => {} }} />
    </SyncProvider>
  </RuntimeAPIContext.Provider></I18nProvider>));
  const selected = () => body.querySelector('[data-workspace-diff-path]')?.getAttribute('data-workspace-diff-path');
  const chooseB = async () => act(async () => {
    const button = list.querySelector<HTMLButtonElement>('button[title="b.bin"]');
    if (!button) throw new Error('Missing second file');
    button.click();
  });
  try {
    await render();
    expect(selected()).toBe('a.bin');
    await chooseB();
    expect(selected()).toBe('b.bin');
    await act(async () => root.unmount());
    root = createRoot(body);
    await render();
    expect(selected()).toBe('b.bin');
    await act(async () => useUIStore.getState().openContextDiff(directory, 'a.bin'));
    expect(selected()).toBe('a.bin');
    const key = workspaceViewKey(useGitStore.getState().runtimeKey, directory);
    expect(key && useWorkspaceViewStateStore.getState().diffNavigations[key]).toBeUndefined();
    await chooseB();
    expect(selected()).toBe('b.bin');
    await act(async () => useUIStore.getState().openContextDiff(directory, 'b.bin', true, 'staged'));
    expect(selected()).toBe('b.bin');
    expect(reads.some(read => read.path === 'b.bin' && read.staged === true)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
