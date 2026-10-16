import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  Event: browser.Event,
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
  configured: true, enabled: false, running: false, ready: false,
  baseURL: 'http://127.0.0.1:8317', port: 8317, authDir: '/auth', upstreamProxy: null,
  installedVersion: '8.0.31', runningVersion: null,
  install: { supported: true, prepared: true, target: 'darwin-arm64', version: '8.0.31', path: '/managed/cli-proxy-api', error: null },
  managementEnabled: false, keyRejected: false, accounts: [], clientKeys: [],
  lastError: null, restarting: false, connection: null,
  ...patch,
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
  test('offers to start a gateway that is not running', async () => {
    const api = createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status() });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('Stopped');
    expect(text()).toContain('CLIProxyAPI 8.0.31');
    expect(button('Start gateway')).toBeDefined();
    expect(button('Stop gateway')).toBeUndefined();
  });

  test('asks to download first when nothing is installed yet', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ installedVersion: null, install: { ...status().install, prepared: false, path: null } }),
    });
    await render(api, <CliProxyApiSection />);
    expect(button('Download and start')).toBeDefined();
  });

  test('reports a running gateway, its version and its accounts', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ enabled: true, running: true, ready: true, runningVersion: '8.0.31', managementEnabled: true, accounts: [account] }),
    });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('Running');
    expect(text()).toContain('a@example.com');
    expect(button('Stop gateway')).toBeDefined();
    expect(button('Sign in a ChatGPT account')?.disabled).toBe(false);
  });

  test('names a target this computer cannot run', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ install: { supported: false, prepared: false, target: null, version: '8.0.31', path: null, error: 'unsupported' } }),
    });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('not a supported target');
    expect(button('Start gateway')?.disabled).toBe(true);
  });

  test('saves the upstream proxy', async () => {
    const saved: Array<string | null> = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status(),
      setCliproxyapiProxy: async ({ upstreamProxy }) => {
        saved.push(upstreamProxy);
        return status({ upstreamProxy });
      },
    });
    await render(api, <CliProxyApiSection />);
    const field = container?.querySelector<HTMLInputElement>('input[type="url"]');
    expect(field).not.toBeNull();
    await act(async () => {
      if (!field) return;
      // React tracks the value through its own setter, so set it the DOM way.
      const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(field, 'http://127.0.0.1:7890');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Save')?.click(); });
    expect(saved).toEqual(['http://127.0.0.1:7890']);
  });

  test('polls a sign-in attempt and reloads the accounts it added', async () => {
    let polls = 0;
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true, accounts: polls === 0 ? [] : [account] }),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device' }),
      cliproxyapiLoginStatus: async () => (polls++ === 0 ? { status: 'pending', message: null } : { status: 'connected', message: null }),
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { button('Sign in a ChatGPT account')?.click(); });
    expect(text()).toContain('Finish the sign-in in your browser.');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    expect(polls).toBeGreaterThan(1);
    expect(text()).toContain('a@example.com');
  }, 15_000);

  test('imports the gateway models and reports what it skipped', async () => {
    let imports = 0;
    const reported: string[] = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      importCliproxyapiModels: async () => {
        imports += 1;
        return {
          connection: {
            id: 'connection-1', revision: 1, hasKey: true, kind: 'anthropic', name: 'CLIProxyAPI',
            baseURL: 'http://127.0.0.1:8317', auth: 'api-key', models: [{
              id: '5b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f', name: 'GPT-6.1-Sol', modelID: 'gpt-6.1-sol',
              contextWindow: 872000, outputLimit: 128000, input: { image: true, pdf: false }, efforts: ['low', 'max'],
            }], quotaProviderId: null,
          },
          imported: 9,
          skipped: 5,
        };
      },
    });
    await render(api, <CliProxyApiSection onConnectionSaved={(connection) => reported.push(connection.id)} />);
    await act(async () => { button('Import gateway models')?.click(); });
    expect(imports).toBe(1);
    expect(text()).toContain('Imported 9 models');
    expect(text()).toContain('skipped 5');
    expect(reported).toEqual(['connection-1']);
  });

  test('cancels a pending attempt when the page is left', async () => {
    const cancelled: string[] = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device' }),
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
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
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
    expect(drafts[0]).toMatchObject({ connectionId: null, name: 'CLIProxyAPI' });
    expect(drafts[0].models[0]).toMatchObject({
      modelID: 'gpt-6.1-sol', contextWindow: 872000, outputLimit: 128000, input: { image: true, pdf: false },
    });
    expect(reported).toEqual(['connection-1']);
  });
});
