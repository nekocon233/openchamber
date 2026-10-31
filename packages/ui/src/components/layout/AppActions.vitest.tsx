import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('app actions work with the session list closed and retain the update dialog', async () => {
  const win = new Window({ url: 'http://localhost' });
  const globals = {
    window: win, document: win.document, navigator: win.navigator, location: win.location, localStorage: win.localStorage,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement,
    HTMLInputElement: win.HTMLInputElement, HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
    Document: win.Document, DocumentFragment: win.DocumentFragment, MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver, Event: win.Event, CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
    getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { AppActions } = await import('./AppActions');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useUpdateStore } = await import('@/stores/useUpdateStore');
  const previousUI = useUIStore.getState();
  const previousUpdate = useUpdateStore.getState();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-app-actions] button')];
  const click = async (index: number) => act(async () => {
    const button = buttons()[index];
    if (!button) throw new Error('Missing app action');
    button.click();
  });
  try {
    useUIStore.setState({ isSidebarOpen: false, isSettingsDialogOpen: false, isUsageStatsPageOpen: false, isHelpDialogOpen: false, isAboutDialogOpen: false });
    useUpdateStore.setState({ available: false, runtimeType: 'web', info: null });
    await act(async () => root.render(<I18nProvider><AppActions /></I18nProvider>));
    expect(buttons()).toHaveLength(4);
    await click(0);
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
    await click(0);
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    await click(1);
    expect(useUIStore.getState().isUsageStatsPageOpen).toBe(true);
    expect(buttons()[1].getAttribute('aria-pressed')).toBe('true');
    await click(1);
    expect(useUIStore.getState().isUsageStatsPageOpen).toBe(false);
    await click(2);
    expect(useUIStore.getState().isHelpDialogOpen).toBe(true);
    await click(2);
    expect(useUIStore.getState().isHelpDialogOpen).toBe(false);
    await click(3);
    expect(useUIStore.getState().isAboutDialogOpen).toBe(true);
    await click(3);
    expect(useUIStore.getState().isAboutDialogOpen).toBe(false);
    expect(useUIStore.getState().isSidebarOpen).toBe(false);

    await act(async () => useUpdateStore.setState({ available: true, info: { available: true, currentVersion: '1.0.0', version: '1.0.1' } }));
    expect(buttons()).toHaveLength(4);
    expect(buttons()[3].getAttribute('aria-label')).toBe('Update');
    await click(3);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useUIStore.getState().isAboutDialogOpen).toBe(false);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState(previousUI, true);
    useUpdateStore.setState(previousUpdate, true);
    await win.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
