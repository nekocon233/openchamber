import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useBrowserPushSubscriptionReconciliation } from './useBrowserPushSubscriptionReconciliation';

for (const runtime of ['disabled', 'electron', 'vscode', 'capacitor', 'unsupported']) {
  test(`does not start browser push reconciliation in the ${runtime} runtime`, async () => {
    const dom = new Window({ url: 'http://push-runtime.test' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    let registrationReads = 0;
    const getRegistration = async () => {
      registrationReads += 1;
      return null;
    };
    if (runtime !== 'unsupported') {
      Object.defineProperty(dom.navigator, 'serviceWorker', { value: { getRegistration } });
    }
    if (runtime === 'electron') {
      Object.assign(dom, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron' } });
    }
    if (runtime === 'vscode') {
      Object.assign(dom, { __VSCODE_CONFIG__: { workspaceFolder: '/repo', workspaceFolders: [] } });
    }
    if (runtime === 'capacitor') {
      Object.assign(dom, { Capacitor: { isNativePlatform: () => true } });
    }
    for (const [name, value] of Object.entries({
      window: dom, document: dom.document, navigator: dom.navigator,
      Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
      Event: dom.Event, CustomEvent: dom.CustomEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    function Probe() {
      useBrowserPushSubscriptionReconciliation({ enabled: runtime !== 'disabled' });
      return null;
    }
    try {
      await act(async () => root.render(<Probe />));
      expect(registrationReads).toBe(0);
    } finally {
      await act(async () => root.unmount());
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      await dom.happyDOM.close();
    }
  });
}
