import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

test('panel and page frames publish titlebar controls across project switches while headless frames refuse them', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    Event: dom.Event,
    MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/frame-grant')) return Response.json({ grant: 'grant-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const pathname = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(pathname.endsWith('/session/active') ? {} : { data: [] });
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const desktop: InstalledGuest = {
    id: 'openchamber-builtin-desktop',
    name: 'Remote Desktop',
    icon: 'computer',
    entry: 'panel/index.html',
    pageEntry: 'panel/index.html',
    source: 'bundled',
    capabilities: { requested: [], granted: [] },
  };
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([desktop], runtimeKey);

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const restores: Array<() => void> = [];
  const bindings: Array<GuestStatusControlBinding | null> = [];
  const render = (directory: string, surface: 'panel' | 'page', headless = false) => act(async () => root.render(
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory={directory}>
        <PluginPane
          mode="plugin:openchamber-builtin-desktop"
          surface={surface}
          headless={headless}
          item={null}
          onStatusControls={(binding) => bindings.push(binding)}
        />
      </SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>,
  ));

  try {
    await render('/project-a', 'panel');
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Panel frame did not mount');
    const guestWindow = new Window();
    restores.push(() => { void guestWindow.happyDOM.close(); });
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
    const frameWindow = frame.contentWindow;
    if (!frameWindow) throw new Error('Guest window is missing');
    const received: HostMessage[] = [];
    const post = spyOn(frameWindow, 'postMessage').mockImplementation((data) => { received.push(hostMessageSchema.parse(data)); });
    restores.push(() => post.mockRestore());
    const send = async (message: GuestMessage) => {
      await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: message })); });
    };

    await send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
    expect(received.find((message) => message.type === 'ready')).toMatchObject({
      payload: { surface: 'panel', features: { statusControls: true } },
    });

    await send({
      channel: 'openchamber.sdk',
      v: 1,
      type: 'status-controls',
      id: 'controls-1',
      payload: { controls: [{ kind: 'button', id: 'connection', label: 'Connect' }] },
    });
    expect(received.find((message) => message.type === 'result' && message.id === 'controls-1')).toMatchObject({ ok: true });
    expect(bindings.at(-1)?.controls).toEqual([{ kind: 'button', id: 'connection', label: 'Connect' }]);

    // Switching projects keeps panel header controls alive and interactive.
    await render('/project-b', 'panel');
    expect(bindings.at(-1)?.controls).toEqual([{ kind: 'button', id: 'connection', label: 'Connect' }]);
    bindings.at(-1)?.dispatch({ id: 'connection' });
    expect(received.find((message) => message.type === 'status-control-event')).toEqual({
      channel: 'openchamber.sdk',
      v: 1,
      type: 'status-control-event',
      payload: { id: 'connection' },
    });

    // Headless frames do not advertise or accept header controls.
    await act(async () => root.render(null));
    expect(bindings.at(-1)).toBeNull();

    await render('/project-b', 'panel', true);
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const headlessFrame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!headlessFrame) throw new Error('Headless frame did not mount');
    const headlessWindow = new Window();
    restores.push(() => { void headlessWindow.happyDOM.close(); });
    Object.defineProperty(headlessFrame, 'contentWindow', { configurable: true, value: headlessWindow });
    const headlessFrameWindow = headlessFrame.contentWindow;
    if (!headlessFrameWindow) throw new Error('Headless guest window is missing');
    const headlessReceived: HostMessage[] = [];
    const headlessPost = spyOn(headlessFrameWindow, 'postMessage').mockImplementation((data) => { headlessReceived.push(hostMessageSchema.parse(data)); });
    restores.push(() => headlessPost.mockRestore());
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: headlessFrameWindow, data: { channel: 'openchamber.sdk', v: 1, type: 'hello' } }));
    });
    const headlessReady = headlessReceived.find((message) => message.type === 'ready');
    expect(headlessReady?.payload.features?.statusControls).toBeUndefined();
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: headlessFrameWindow,
        data: { channel: 'openchamber.sdk', v: 1, type: 'status-controls', id: 'controls-headless', payload: { controls: [] } },
      }));
    });
    expect(headlessReceived.find((message) => message.type === 'result' && message.id === 'controls-headless'))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  } finally {
    await act(async () => root.unmount());
    for (const restore of restores) restore();
    fetch.mockRestore();
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
