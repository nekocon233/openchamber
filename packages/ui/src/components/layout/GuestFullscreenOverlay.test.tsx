import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

test('GuestFullscreenOverlay keeps hosts mounted, toggles via GuestHeaderControls, and ignores Escape inside iframes', async () => {
  const dom = new Window({ url: 'http://fullscreen.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLIFrameElement: dom.HTMLIFrameElement,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const { I18nProvider } = await import('@/lib/i18n');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { useGuestsStore } = await import('@/lib/guests/store');
  const { DESKTOP_GUEST_ID } = await import('@/lib/workspace/editorTabs');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useWorkspaceHosts } = await import('./workspaceHosts');
  const { GuestFullscreenOverlay } = await import('./GuestFullscreenOverlay');
  const { GuestHeaderControls } = await import('./GuestHeaderControls');
  const { useGuestFullscreen } = await import('./useGuestFullscreen');

  const runtimeKey = getRuntimeKey();
  const initialUI = useUIStore.getState();
  useUIStore.setState({ ...useUIStore.getInitialState(), guestFullscreen: null }, true);
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([
    {
      id: DESKTOP_GUEST_ID,
      name: 'Remote Desktop',
      icon: 'computer',
      entry: 'panel/index.html',
      pageEntry: 'panel/index.html',
      source: 'bundled',
      enabled: true,
      capabilities: { requested: [], granted: [] },
    },
  ], runtimeKey);

  const Harness: React.FC<{ active: boolean }> = ({ active }) => {
    const { isFullscreen, toggleFullscreen } = useGuestFullscreen(DESKTOP_GUEST_ID, 'panel', active);
    const events: string[] = [];
    return (
      <>
        <GuestHeaderControls
          controls={{
            controls: [{ kind: 'button', id: 'connection', label: 'Connect' }],
            dispatch: ({ id }) => events.push(id),
          }}
          fullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
        />
        <GuestFullscreenOverlay />
      </>
    );
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(<I18nProvider><Harness active /></I18nProvider>));
    const overlay = container.querySelector<HTMLElement>('[data-guest-fullscreen]');
    if (!overlay) throw new Error('Fullscreen overlay did not mount');
    expect(overlay.dataset.guestFullscreen).toBe('closed');
    expect(overlay.className).toContain('hidden');
    expect(useWorkspaceHosts.getState().fullscreenBody).not.toBeNull();
    expect(useWorkspaceHosts.getState().fullscreenHeader).not.toBeNull();

    const enterButton = container.querySelector<HTMLButtonElement>('[data-guest-fullscreen-toggle="enter"]');
    if (!enterButton) throw new Error('Fullscreen toggle button did not render');
    await act(async () => enterButton.click());
    expect(useUIStore.getState().guestFullscreen).toEqual({ id: DESKTOP_GUEST_ID, surface: 'panel' });
    expect(overlay.dataset.guestFullscreen).toBe('open');
    expect(overlay.className).not.toContain('hidden');

    // Escape inside a remote desktop iframe must stay inside the iframe.
    const iframe = document.createElement('iframe');
    useWorkspaceHosts.getState().fullscreenBody?.append(iframe);
    iframe.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useUIStore.getState().guestFullscreen).toEqual({ id: DESKTOP_GUEST_ID, surface: 'panel' });

    // Escape when a menu is open must close the menu rather than exiting fullscreen.
    enterButton.focus();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useUIStore.getState().guestFullscreen).toEqual({ id: DESKTOP_GUEST_ID, surface: 'panel' });
    menu.remove();

    // Escape from the outer host exits fullscreen.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useUIStore.getState().guestFullscreen).toBeNull();
    expect(overlay.dataset.guestFullscreen).toBe('closed');

    // Becoming inactive clears panel fullscreen automatically.
    await act(async () => enterButton.click());
    expect(useUIStore.getState().guestFullscreen).toEqual({ id: DESKTOP_GUEST_ID, surface: 'panel' });
    await act(async () => root.render(<I18nProvider><Harness active={false} /></I18nProvider>));
    expect(useUIStore.getState().guestFullscreen).toBeNull();

    // Disabling the extension clears fullscreen.
    await act(async () => root.render(<I18nProvider><Harness active /></I18nProvider>));
    await act(async () => useUIStore.getState().setGuestFullscreen({ id: DESKTOP_GUEST_ID, surface: 'panel' }));
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([
        {
          id: DESKTOP_GUEST_ID,
          name: 'Remote Desktop',
          icon: 'computer',
          entry: 'panel/index.html',
          pageEntry: 'panel/index.html',
          source: 'bundled',
          enabled: false,
          capabilities: { requested: [], granted: [] },
        },
      ], runtimeKey);
    });
    expect(useUIStore.getState().guestFullscreen).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useWorkspaceHosts.setState({ fullscreenHeader: null, fullscreenBody: null });
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    useUIStore.setState(initialUI, true);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
