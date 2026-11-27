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
  const { useGuestItemStore } = await import('@/lib/guests/item-store');
  const { DESKTOP_GUEST_ID } = await import('@/lib/workspace/editorTabs');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useWorkspaceHosts } = await import('./workspaceHosts');
  const { GuestFullscreenOverlay } = await import('./GuestFullscreenOverlay');
  const { GuestHeaderControls } = await import('./GuestHeaderControls');
  const { useGuestFullscreen } = await import('@/hooks/useGuestFullscreen');

  const runtimeKey = getRuntimeKey();
  const initialUI = useUIStore.getState();
  const pendingItem = {
    providerId: DESKTOP_GUEST_ID,
    id: 'preview',
    title: 'Preview',
    url: 'http://localhost:5173/',
  };
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

  let dismissed = false;
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
          onClose={() => { dismissed = true; }}
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
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull();
    expect(overlay.className).toContain('hidden');
    expect(useWorkspaceHosts.getState().fullscreenBody).not.toBeNull();
    expect(useWorkspaceHosts.getState().fullscreenHeader).not.toBeNull();

    await act(async () => useGuestItemStore.getState().setPendingItem(DESKTOP_GUEST_ID, pendingItem));
    expect(overlay.dataset.guestFullscreen).toBe('open');
    await act(async () => { useGuestItemStore.getState().takePendingItem(DESKTOP_GUEST_ID); });
    const exitButton = container.querySelector<HTMLButtonElement>('[data-guest-fullscreen-toggle="exit"]');
    if (!exitButton) throw new Error('Fullscreen exit button did not render');
    await act(async () => exitButton.click());
    expect(overlay.dataset.guestFullscreen).toBe('closed');

    const enterButton = container.querySelector<HTMLButtonElement>('[data-guest-fullscreen-toggle="enter"]');
    if (!enterButton) throw new Error('Fullscreen toggle button did not render');
    await act(async () => enterButton.click());
    expect(useUIStore.getState().guestFullscreen).toEqual({ id: DESKTOP_GUEST_ID, surface: 'panel' });
    expect(overlay.dataset.guestFullscreen).toBe('open');
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    if (!close) throw new Error('Fullscreen close button did not render');
    await act(async () => close.click());
    expect(dismissed).toBe(true);
    expect(overlay.className).not.toContain('hidden');
    const headerBar = overlay.querySelector<HTMLElement>('header > div');
    expect(headerBar?.style.paddingInlineStart).toBe('calc(0.75rem + var(--oc-wco-left-inset, 0px))');
    expect(headerBar?.style.paddingInlineEnd).toBe('calc(0.75rem + var(--oc-wco-right-inset, 0px))');
    expect(headerBar?.style.height || headerBar?.getAttribute('style')).toContain('max(2.5rem, var(--oc-wco-titlebar-height, 0px))');

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
    await act(async () => useGuestItemStore.getState().setPendingItem(DESKTOP_GUEST_ID, pendingItem));
    expect(overlay.dataset.guestFullscreen).toBe('closed');
    await act(async () => { useGuestItemStore.getState().takePendingItem(DESKTOP_GUEST_ID); });

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
    useGuestItemStore.getState().takePendingItem(DESKTOP_GUEST_ID);
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    useUIStore.setState(initialUI, true);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('resolveTitlebarInsets clears PWA WCO, tablet standalone PWA, and macOS traffic lights across LTR and RTL', async () => {
  const { resolveTitlebarInsets } = await import('./titlebarInsets');

  expect(resolveTitlebarInsets({
    direction: 'ltr',
    isDesktopApp: false,
    isMacPlatform: false,
    isTabletStandalonePwa: false,
    usesFramelessChrome: false,
  })).toEqual({
    titlebarStartInset: 'calc(0.75rem + var(--oc-wco-left-inset, 0px))',
    titlebarEndInset: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
  });

  expect(resolveTitlebarInsets({
    direction: 'rtl',
    isDesktopApp: false,
    isMacPlatform: false,
    isTabletStandalonePwa: false,
    usesFramelessChrome: false,
  })).toEqual({
    titlebarStartInset: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
    titlebarEndInset: 'calc(0.75rem + var(--oc-wco-left-inset, 0px))',
  });

  expect(resolveTitlebarInsets({
    direction: 'rtl',
    isDesktopApp: false,
    isMacPlatform: false,
    isTabletStandalonePwa: true,
    usesFramelessChrome: false,
  })).toEqual({
    titlebarStartInset: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
    titlebarEndInset: 'max(calc(0.75rem + var(--oc-wco-left-inset, 0px)), 5.5rem)',
  });

  expect(resolveTitlebarInsets({
    direction: 'rtl',
    isDesktopApp: true,
    isMacPlatform: true,
    isDesktopWindowFullscreen: false,
    isTabletStandalonePwa: false,
    usesFramelessChrome: false,
  })).toEqual({
    titlebarStartInset: '0.75rem',
    titlebarEndInset: '88px',
  });

  expect(resolveTitlebarInsets({
    direction: 'ltr',
    isDesktopApp: true,
    isMacPlatform: true,
    isDesktopWindowFullscreen: true,
    isTabletStandalonePwa: false,
    usesFramelessChrome: false,
  })).toEqual({
    titlebarStartInset: '0.75rem',
    titlebarEndInset: '0.75rem',
  });
});
