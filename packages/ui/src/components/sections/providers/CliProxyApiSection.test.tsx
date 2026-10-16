import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import type { NativeAgentsAPI } from '@/lib/api/types';
import type { CliproxyapiConnectionWrite, CliproxyapiStatus } from '@/lib/native-agents/connections';

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const browser = new Window({ url: 'http://runtime.test' });
// happy-dom keeps its own clock and never advances it on its own. The section
// polls with window.setTimeout, so drive those timers with the runner's.
Object.defineProperty(browser, 'setTimeout', { value: realSetTimeout, configurable: true, writable: true });
Object.defineProperty(browser, 'clearTimeout', { value: realClearTimeout, configurable: true, writable: true });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  Text: browser.Text,
  NodeList: browser.NodeList,
  customElements: browser.customElements,
  HTMLAnchorElement: browser.HTMLAnchorElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLInputElement: browser.HTMLInputElement,
  DocumentFragment: browser.DocumentFragment,
  ResizeObserver: browser.ResizeObserver,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterAll(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { createTestNativeAgentsAPI, createTestRuntimeAPIs } = await import('@/lib/native-agents/test-utils/runtime');
const { CliProxyApiSection } = await import('./CliProxyApiSection');

const status = (patch: Partial<CliproxyapiStatus> = {}): CliproxyapiStatus => ({
  configured: true, baseURL: 'http://127.0.0.1:8317', reachable: true, managementEnabled: true,
  keyRejected: false, accounts: [], clientKeys: [], localLogin: true, ...patch,
});
const account = { name: 'codex-a.json', email: 'a@example.com', planType: 'pro', activeUntil: null, status: 'active', disabled: false };

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

const render = async (api: NativeAgentsAPI, children: React.ReactNode) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const apis = createTestRuntimeAPIs(api);
  registerRuntimeAPIs(apis);
  await act(async () => root?.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider>{children}</I18nProvider></RuntimeAPIContext.Provider>));
};
const text = () => container?.textContent ?? '';
const button = (label: string) => [...(container?.querySelectorAll('button') ?? [])].find((node) => node.textContent === label);

beforeEach(() => {
  // Sign-in opens the browser; the test only cares that the attempt started.
  window.open = () => null;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('CLIProxyAPI section', () => {
  test('keeps a remote client read-only and says where the gateway is managed', async () => {
    const api = createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status({ localLogin: false }) });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('Manage the gateway on the computer');
    expect(button('Save')?.disabled).toBe(true);
    expect(button('Sign in a ChatGPT account')?.disabled).toBe(true);
  });

  test('names a gateway whose management API is off', async () => {
    const api = createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status({ configured: false, managementEnabled: false }) });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('management API is off');
    expect(button('Sign in a ChatGPT account')?.disabled).toBe(true);
  });

  test('names a saved management key the gateway rejects', async () => {
    const api = createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status({ keyRejected: true }) });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('rejected the saved management key');
  });

  test('polls a sign-in attempt and reloads the accounts it added', async () => {
    let polls = 0;
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ accounts: polls === 0 ? [] : [account] }),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device', expiresAt: Date.now() + 60_000 }),
      cliproxyapiLoginStatus: async () => (polls++ === 0 ? { status: 'pending', message: null } : { status: 'connected', message: null }),
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { button('Sign in a ChatGPT account')?.click(); });
    expect(text()).toContain('Finish the sign-in in your browser.');
    expect(polls).toBe(0);
    // Each act boundary applies the state a poll produced, which re-arms the
    // next poll; the second one reports the finished sign-in.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    expect(polls).toBeGreaterThan(1);
    expect(text()).toContain('a@example.com');
    expect(text()).not.toContain('Finish the sign-in in your browser.');
  }, 15_000);

  test('cancels a pending attempt when the page is left', async () => {
    const cancelled: string[] = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status(),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device', expiresAt: Date.now() + 60_000 }),
      cliproxyapiLoginStatus: async () => ({ status: 'pending', message: null }),
      cancelCliproxyapiLogin: async (state) => { cancelled.push(state); return true; },
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { button('Sign in a ChatGPT account')?.click(); });
    await act(async () => { root?.unmount(); });
    expect(cancelled).toEqual(['abc123']);
  });

  test('creates the gateway connection with the seeded model and reports it back', async () => {
    const drafts: CliproxyapiConnectionWrite[] = [];
    const reported: string[] = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status(),
      saveCliproxyapiConnection: async (input) => {
        drafts.push(input);
        return {
          id: 'connection-1', revision: 1, hasKey: true, kind: 'anthropic', name: input.name,
          baseURL: 'http://127.0.0.1:8317', auth: 'api-key', models: input.models, quotaProviderId: null,
        };
      },
    });
    await render(api, <CliProxyApiSection onConnectionSaved={(connection) => reported.push(connection.id)} />);
    await act(async () => { button('Create connection')?.click(); });
    expect(drafts[0]).toMatchObject({ connectionId: null, name: 'CLIProxyAPI', clientKey: { source: 'added' } });
    expect(drafts[0].models[0]).toMatchObject({
      modelID: 'gpt-6.1-sol', contextWindow: 872000, outputLimit: 128000, input: { image: true, pdf: false },
    });
    expect(reported).toEqual(['connection-1']);
  });
});
