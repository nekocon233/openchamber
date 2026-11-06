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

test('file type filtering follows project ownership and hides details without changing Git status', async () => {
  const restoreDom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { DiffView } = await import('./DiffView');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { useDiffFileFilterStore, diffFileFilterKey } = await import('@/stores/useDiffFileFilterStore');
  const runtime = useGitStore.getState().runtimeKey;
  const previousProjects = useProjectsStore.getState().projects;
  const previousWorktrees = useSessionUIStore.getState().availableWorktreesByProject;
  useProjectsStore.setState({ projects: [{ id: 'a', path: '/project-a' }, { id: 'b', path: '/project-b' }] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([
    ['/project-a', [{ path: '/project-a-worktree', projectDirectory: '/project-a', branch: 'feature', label: 'feature' }]],
  ]) });
  let directory = '/project-a';
  let patchReads = 0;
  let detailsVisible = false;
  let targetPath: string | null = null;
  useUIStore.setState({ diffFileListMode: 'tree' });
  const status = { current: 'main', tracking: null, ahead: 0, behind: 0,
    files: [{ path: 'visible.png', index: ' ', working_dir: 'M' }, { path: 'hidden.bin', index: ' ', working_dir: 'M' }],
    isClean: false, diffStats: { staged: {}, working: {} } };
  const base = createWebAPIs();
  const apis = { ...base, git: { ...base.git,
    checkIsGitRepository: async () => true, getGitStatus: async () => status,
    getGitDiff: async () => { patchReads++; return { diff: 'Binary files a/test.bin and b/test.bin differ', submodule: null }; },
  } };
  const listHost = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(container, listHost);
  const root = createRoot(container);
  const render = () => act(async () => root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>
    <SyncProvider sdk={opencodeClient.getSdkClient()} directory={directory}>
      <DiffView directory={directory} visible={detailsVisible} targetFilePath={targetPath} diffScope="working" stackedDefaultCollapsedAll
        fileListHost={{ host: listHost, visible: true, onSelect: () => {} }} />
    </SyncProvider>
  </RuntimeAPIContext.Provider></I18nProvider>));
  try {
    await render();
    expect(listHost.textContent).toContain('hidden.bin');
    await act(async () => useDiffFileFilterStore.getState().setExcludedTypes(diffFileFilterKey(runtime, '/project-a'), ['json']));
    detailsVisible = true;
    targetPath = 'visible.png';
    await render();
    const secondFile = [...listHost.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('hidden.bin'));
    expect(secondFile).toBeDefined();
    await act(async () => secondFile?.click());
    expect(container.querySelector('[data-diff-virtual-content]')?.textContent).toContain('hidden.bin');
    await act(async () => useDiffFileFilterStore.getState().setExcludedTypes(diffFileFilterKey(runtime, '/project-a'), []));
    expect(container.querySelector('[data-diff-virtual-content]')?.textContent).toContain('hidden.bin');
    detailsVisible = false;
    targetPath = null;
    await render();
    patchReads = 0;
    await act(async () => useDiffFileFilterStore.getState().setExcludedTypes(diffFileFilterKey(runtime, '/project-a'), ['bin']));
    expect(listHost.textContent).not.toContain('hidden.bin');
    expect(listHost.textContent).toContain('visible.png');
    expect(status.files.length).toBe(2);
    directory = '/project-b';
    await render();
    expect(listHost.textContent).toContain('hidden.bin');
    directory = '/project-a-worktree';
    await render();
    expect(listHost.textContent).not.toContain('hidden.bin');
    await act(async () => useDiffFileFilterStore.getState().setExcludedTypes(diffFileFilterKey(runtime, '/project-a'), ['bin', 'png']));
    expect(listHost.querySelector('[data-diff-filter-empty]')).not.toBeNull();
    expect(listHost.querySelector('[data-diff-file-filter]')).not.toBeNull();
    expect(patchReads).toBe(0);
    const restore = listHost.querySelector<HTMLButtonElement>('[data-diff-filter-empty] button');
    await act(async () => restore?.click());
    expect(listHost.textContent).toContain('hidden.bin');
    expect(listHost.textContent).toContain('visible.png');
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState({ projects: previousProjects });
    useSessionUIStore.setState({ availableWorktreesByProject: previousWorktrees });
    restoreDom();
  }
});
