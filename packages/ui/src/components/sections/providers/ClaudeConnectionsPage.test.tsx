import React, { act } from 'react';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ClaudeConnection, CliproxyapiStatus } from '@/lib/native-agents/connections';

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const browser = new Window({ url: 'http://runtime.test' });
// happy-dom keeps its own clock and never advances it on its own. The page
// schedules nothing by itself, but the API context expects the same globals as
// the section tests, so drive them with the runner's timers.
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
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  // Background stores probe the OpenCode API on import; answer instead of
  // letting the requests reach DNS.
  fetch: () => Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
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
const { ClaudeConnectionsPage } = await import('./ClaudeConnectionsPage');

const connection = (patch: Partial<ClaudeConnection> = {}): ClaudeConnection => ({
  id: 'connection-1', revision: 1, hasKey: true, kind: 'anthropic', name: 'kimi',
  baseURL: 'https://example.test/anthropic', auth: 'api-key',
  models: [{
    id: '5b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f', name: 'Kimi', modelID: 'kimi-for-coding',
    contextWindow: 262144, outputLimit: 32000, input: { image: false, pdf: false }, efforts: [],
  }],
  quotaProviderId: null,
  ...patch,
});

const status = (patch: Partial<CliproxyapiStatus> = {}): CliproxyapiStatus => ({
  configured: true, enabled: false, running: false, ready: false,
  baseURL: 'http://127.0.0.1:8317', port: 8317, authDir: '/auth', upstreamProxy: null,
  installedVersion: '8.0.31', runningVersion: null,
  install: { supported: true, prepared: true, target: 'darwin-arm64', version: '8.0.31', path: '/managed/cli-proxy-api', error: null },
  managementEnabled: false, keyRejected: false, accounts: [], clientKeys: [],
  lastError: null, restarting: false, connection: null,
  ...patch,
});

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

const render = async (api: Parameters<typeof createTestNativeAgentsAPI>[0], page: React.ReactNode = <ClaudeConnectionsPage />) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI(api), {
    sidebarState: { supported: false, load: async () => null, mutate: async () => null },
  });
  registerRuntimeAPIs(apis);
  await act(async () => root?.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider>{page}</I18nProvider></RuntimeAPIContext.Provider>));
};
const text = () => container?.textContent ?? '';
const buttons = (label: string) => [...(container?.querySelectorAll('button') ?? [])].filter((node) => node.textContent === label);
const button = (label: string) => buttons(label)[0];

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('Claude connections page', () => {
  test('shows the gateway as its sign-in row instead of an editable connection', async () => {
    const api = {
      listClaudeConnections: async () => [connection(), connection({ id: 'connection-2', name: 'CLIProxyAPI' })],
      cliproxyapiStatus: async () => status({ connection: { id: 'connection-2', name: 'CLIProxyAPI' } }),
    };
    await render(api);
    expect(text()).toContain('kimi');
    expect(text()).toContain('CLIProxyAPI');
    expect(button('Sign in a ChatGPT account')).toBeDefined();
    // Only the plain connection offers edit and delete; the gateway row never does.
    expect(buttons('Edit')).toHaveLength(1);
    expect(buttons('Delete')).toHaveLength(1);
  });

  test('keeps the sign-in row when no gateway connection exists yet', async () => {
    const api = {
      listClaudeConnections: async () => [],
      cliproxyapiStatus: async () => status(),
    };
    await render(api);
    expect(text()).toContain('CLIProxyAPI');
    expect(button('Sign in a ChatGPT account')).toBeDefined();
  });

  test('opens the editor for a plain connection', async () => {
    const api = {
      listClaudeConnections: async () => [connection()],
      cliproxyapiStatus: async () => status(),
    };
    await render(api);
    await act(async () => { button('Edit')?.click(); });
    expect(button('Save')).toBeDefined();
    expect(button('Add custom connection')).toBeUndefined();
  });

  test("renders the back control the providers page hands it", async () => {
    const api = {
      listClaudeConnections: async () => [],
      cliproxyapiStatus: async () => status(),
    };
    await render(api, <ClaudeConnectionsPage titleLeading={<button type="button">Back</button>} />);
    expect(button('Back')).toBeDefined();
  });
});
