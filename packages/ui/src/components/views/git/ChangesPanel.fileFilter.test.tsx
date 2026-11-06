import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('hiding file types leaves group and directory bulk actions complete', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { ChangesPanel } = await import('./ChangesPanel');
  const previousView = useUIStore.getState().gitChangesViewMode;
  useUIStore.setState({ gitChangesViewMode: 'tree' });
  const calls: string[][] = [];
  const rootNode = document.createElement('div');
  document.body.append(rootNode);
  const root = createRoot(rootNode);
  try {
    await act(async () => root.render(<I18nProvider><ChangesPanel groups={[{
      id: 'unstaged', title: 'Changes', entries: [
        { path: 'src/visible.ts', index: ' ', working_dir: 'M' },
        { path: 'src/hidden.json', index: ' ', working_dir: 'M' },
        { path: 'elsewhere/hidden.json', index: ' ', working_dir: 'M' },
      ], statsScope: 'working', actionSymbol: '+', actionAllLabel: 'Stage all', getActionLabel: (path) => `Stage ${path}`,
      onActionFile: () => {}, onActionAll: (paths) => { calls.push(paths); }, onViewDiff: () => {}, onRevertFile: () => {},
    }]} diffStats={{ staged: {}, working: {} }} revertingPaths={new Set()}
      isFileVisible={(path) => !path.endsWith('.json')} /></I18nProvider>));
    expect(rootNode.textContent).toContain('visible.ts');
    expect(rootNode.textContent).not.toContain('hidden.json');
    expect(rootNode.textContent).not.toContain('elsewhere');
    await act(async () => rootNode.querySelector<HTMLButtonElement>('[aria-label="Stage all"]')?.click());
    expect(calls[0]).toEqual(['src/visible.ts', 'src/hidden.json', 'elsewhere/hidden.json']);
    const directoryStage = [...rootNode.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label')?.includes('Stage all changes in src'));
    expect(directoryStage).toBeDefined();
    await act(async () => directoryStage?.click());
    expect(calls[1]).toEqual(['src/visible.ts', 'src/hidden.json']);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ gitChangesViewMode: previousView });
    dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
