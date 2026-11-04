import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import { Sidebar } from './Sidebar';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { ChatSessionActions } from './ChatSessionActions';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

const OVERLAY_SELECTOR = 'div.app-region-no-drag.absolute.inset-s-0.top-0';

beforeEach(() => {
  useUIStore.getState().setWorkspaceLayout('classic');
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    InputEvent: browser.InputEvent,
    KeyboardEvent: browser.KeyboardEvent,
    PointerEvent: browser.PointerEvent,
    MouseEvent: browser.MouseEvent,
    ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function renderControls(children: React.ReactNode = <TitlebarLeftControls />) {
  await act(async () => root.render(
    <I18nProvider>
      <TooltipProvider>
        {children}
      </TooltipProvider>
    </I18nProvider>,
  ));
}

describe('TitlebarLeftControls', () => {
  test('session actions belong to the conversation header in both layouts', async () => {
    for (const layout of ['classic', 'editor'] as const) {
      await act(async () => useUIStore.getState().setWorkspaceLayout(layout));
      await renderControls(<><TitlebarLeftControls /><ChatSessionActions /></>);
      expect(document.querySelector(`${OVERLAY_SELECTOR} [data-session-picker-trigger]`)).toBeNull();
      expect(document.querySelector(`${OVERLAY_SELECTOR} [data-new-session-trigger]`)).toBeNull();
      const group = document.querySelector('[data-chat-session-actions]');
      expect(group?.querySelectorAll('button')).toHaveLength(2);
      expect(group?.querySelector('[data-session-picker-trigger]')?.getAttribute('aria-pressed')).toBe('false');
      expect(group?.querySelector('[data-session-picker-trigger]')?.getAttribute('aria-haspopup')).toBe('dialog');
    }
  });

  test('caps the overlay to the sidebar width when the sidebar is open', async () => {
    useUIStore.getState().setSidebarOpen(true);
    await renderControls();

    const overlay = document.querySelector<HTMLElement>(OVERLAY_SELECTOR);
    expect(overlay).not.toBeNull();
    expect(overlay!.style.maxWidth).toBe('var(--oc-left-sidebar-width, 100%)');
  });

  test('is reachable by the attribute the sidebar drag writes to', async () => {
    useUIStore.getState().setSidebarOpen(true);
    await renderControls();

    // `Sidebar.applyLiveWidth` finds the overlay by this attribute during a
    // drag. A rename would leave the drag working and the overlay snapping
    // only at settle, with every test green.
    const overlay = document.querySelector<HTMLElement>('[data-titlebar-left-controls]');
    expect(overlay).not.toBeNull();
    expect(overlay).toBe(document.querySelector(OVERLAY_SELECTOR));
  });

  test('keeps its cap after a sidebar drag settles', async () => {
    useUIStore.getState().setSidebarOpen(true);
    useUIStore.getState().setSidebarWidth(300);
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <TitlebarLeftControls />
          <Sidebar isOpen isMobile={false}>content</Sidebar>
        </TooltipProvider>
      </I18nProvider>,
    ));

    const overlay = document.querySelector<HTMLElement>(OVERLAY_SELECTOR);
    const handle = document.querySelector<HTMLElement>('[role="separator"]');
    expect(overlay).not.toBeNull();
    expect(handle).not.toBeNull();
    const pointer = (type: string, clientX: number) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX });
    await act(async () => { handle!.dispatchEvent(pointer('pointerdown', 100)); });
    await act(async () => { handle!.dispatchEvent(pointer('pointermove', 160)); });
    // During the drag the overlay carries the live width itself.
    expect(overlay!.style.getPropertyValue('--oc-left-sidebar-width')).toBe('360px');
    await act(async () => { handle!.dispatchEvent(pointer('pointerup', 160)); });

    // Settled: the root variable is the source again and the cap is intact.
    expect(overlay!.style.getPropertyValue('--oc-left-sidebar-width')).toBe('');
    expect(overlay!.style.maxWidth).toBe('var(--oc-left-sidebar-width, 100%)');
    expect(document.documentElement.style.getPropertyValue('--oc-left-sidebar-width')).toBe('360px');
  });

  test('drops the cap when the sidebar is closed', async () => {
    useUIStore.getState().setSidebarOpen(false);
    await renderControls();

    const overlay = document.querySelector<HTMLElement>(OVERLAY_SELECTOR);
    expect(overlay).not.toBeNull();
    expect(overlay!.style.maxWidth).toBe('');
  });

  test('keeps the same compact session buttons when the sidebar opens and closes', async () => {
    useUIStore.getState().setSidebarOpen(true);
    await renderControls(<ChatSessionActions />);
    const picker = document.querySelector('[data-session-picker-trigger]');
    const create = document.querySelector('[data-new-session-trigger]');
    expect(picker).not.toBeNull();
    expect(create?.getAttribute('aria-label')).toBe('New session');
    await act(async () => useUIStore.getState().setSidebarOpen(false));
    expect(document.querySelector('[data-session-picker-trigger]')).toBe(picker);
    expect(document.querySelector('[data-new-session-trigger]')).toBe(create);
  });
});
