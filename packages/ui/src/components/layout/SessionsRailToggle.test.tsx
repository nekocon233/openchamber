import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import { SessionsRailToggle } from './SessionsRailToggle';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

const TOGGLE = '[data-sessions-toggle]';

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
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

async function renderToggle() {
  await act(async () => root.render(
    <I18nProvider>
      <TooltipProvider>
        <SessionsRailToggle tooltipSide="right" />
      </TooltipProvider>
    </I18nProvider>,
  ));
}

const toggle = () => document.querySelector<HTMLButtonElement>(TOGGLE);

describe('SessionsRailToggle', () => {
  test('reads as pressed while the session column is open and toggles it both ways', async () => {
    useUIStore.setState({ isSidebarOpen: true });
    await renderToggle();

    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle()?.getAttribute('aria-label')).toBe('Sessions');

    await act(async () => toggle()?.click());
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => toggle()?.click());
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
  });

  test('follows the store when the column is opened or closed elsewhere', async () => {
    useUIStore.setState({ isSidebarOpen: false });
    await renderToggle();
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => useUIStore.getState().setSidebarOpen(true));
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
  });
});
