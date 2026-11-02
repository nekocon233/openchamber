import React, { act } from 'react';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { NativeAgentsAPI, NativeCapabilities, NativeCatalog } from '@/lib/api/types';
import type { NativeModelDescriptor } from '@/lib/native-agents/schemas';

const browser = new Window({ url: 'https://remote-client.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Event: browser.Event,
  Node: browser.Node, Text: browser.Text, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  fetch: () => Promise.resolve(Response.json({ directory: '/workspace', project: { directory: '/workspace' } })),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { createTestNativeAgentsAPI, createTestRuntimeAPIs } = await import('@/lib/native-agents/test-utils/runtime');
const { DeepseekHarnessPage } = await import('./DeepseekHarnessPage');

const model: NativeModelDescriptor = {
  id: 'magpie/deepseek%2Fdeepseek-flash', name: 'DeepSeek-V4.1-Flash · DeepSeek',
  contextWindow: null, outputLimit: null, efforts: ['low', 'high'], defaultEffort: 'low',
  fast: false, input: { image: false, pdf: false },
};
const capabilities = (cli: boolean, blockedByEnterprise = false): NativeCapabilities => ({
  supported: true,
  backends: { claude: { cli: false }, codex: { cli: false }, deepseek: { cli, blockedByEnterprise, actions: { revert: true, delete: false, fork: true } } },
  registry: { reset: false },
});
const catalog = (deepseek: NonNullable<NativeCatalog['backends']['deepseek']>): NativeCatalog => ({
  backends: { claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] }, deepseek },
});

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
const render = async (methods: Partial<NativeAgentsAPI>) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
    capabilities: async () => capabilities(true),
    catalog: async () => catalog({ status: 'ok', models: [model] }),
    deepseekSetupStatus: async () => ({ state: 'idle' }),
    ...methods,
  }));
  registerRuntimeAPIs(apis);
  await act(async () => root?.render(
    <RuntimeAPIContext.Provider value={apis}><I18nProvider><DeepseekHarnessPage /></I18nProvider></RuntimeAPIContext.Provider>,
  ));
};
const text = () => container?.textContent ?? '';
const button = (label: string) => [...(container?.querySelectorAll('button') ?? [])].find((node) => node.textContent === label);
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
  }
  throw new Error('condition did not settle');
};

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  registerRuntimeAPIs(null);
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('shows status without a model list or a model service form', async () => {
  await render({});
  expect(text()).toContain('dsh CLI detected');
  expect(text()).not.toContain(model.name);
  expect(text()).not.toContain(model.id);
  expect(container?.querySelector('input[aria-label="API key"]')).toBeNull();
  expect(container?.querySelector('input[aria-label="API endpoint"]')).toBeNull();
  expect(button('Save')).toBeUndefined();
});

test('installs a missing CLI once and then reads the catalog', async () => {
  let installed = false;
  let installs = 0;
  await render({
    capabilities: async () => capabilities(installed),
    deepseekSetupStatus: async () => ({ state: installed ? 'ready' : 'idle' }),
    setupDeepseek: async () => { installs += 1; installed = true; return { state: 'ready' }; },
  });
  expect(button('One-click setup')).toBeDefined();
  expect(text()).toContain('dsh was not found on the server');
  await act(async () => { button('One-click setup')?.click(); });
  await waitFor(() => text().includes('dsh CLI detected'));
  expect(installs).toBe(1);
  expect(button('One-click setup')).toBeUndefined();
  expect(text()).not.toContain(model.name);
});

test('reports a setup error without leaving a configuration form', async () => {
  await render({
    capabilities: async () => capabilities(false),
    setupDeepseek: async () => ({ state: 'error', code: 'NATIVE_DEEPSEEK_NPM_MISSING' }),
  });
  await act(async () => { button('One-click setup')?.click(); });
  await waitFor(() => text().includes('npm is missing'));
  expect(container?.querySelector('input')).toBeNull();
});

test('shows a catalog error as status, not a form', async () => {
  await render({ catalog: async () => catalog({ status: 'error', message: 'dsh catalog failed' }) });
  expect(text()).toContain('Could not load dsh status');
  expect(text()).toContain('dsh catalog failed');
  expect(container?.querySelector('input')).toBeNull();
});

test('keeps enterprise mode closed and does not read the catalog', async () => {
  let reads = 0;
  await render({
    capabilities: async () => capabilities(false, true),
    catalog: async () => { reads += 1; return catalog({ status: 'ok', models: [model] }); },
  });
  expect(text()).toContain('DeepSeek Harness is unavailable in enterprise mode');
  expect(reads).toBe(0);
});
