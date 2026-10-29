import React, { act } from 'react';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { NativeAgentsAPI, NativeCapabilities } from '@/lib/api/types';

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
const { AntigravityPage } = await import('./AntigravityPage');

const model = {
  id: 'gemini-3-pro', name: 'Gemini 3 Pro', contextWindow: 1_000_000, outputLimit: 64_000,
  efforts: ['low', 'high'], defaultEffort: 'high', fast: false, input: { image: false, pdf: false },
};
const capabilities = (cli: boolean): NativeCapabilities => ({
  supported: true,
  backends: { claude: { cli: false }, codex: { cli: false }, antigravity: { cli } },
  registry: { reset: false },
});

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
const render = async (methods: Partial<NativeAgentsAPI>) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
    capabilities: async () => capabilities(true),
    catalog: async () => ({
      backends: {
        claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] },
        antigravity: { status: 'ok', models: [model] },
      },
    }),
    ...methods,
  }));
  registerRuntimeAPIs(apis);
  await act(async () => root?.render(
    <RuntimeAPIContext.Provider value={apis}><I18nProvider><AntigravityPage /></I18nProvider></RuntimeAPIContext.Provider>,
  ));
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

test('shows a missing CLI without reading its catalog, then reloads to ready', async () => {
  let installed = false;
  let catalogReads = 0;
  await render({
    capabilities: async () => capabilities(installed),
    catalog: async () => {
      catalogReads += 1;
      return {
        backends: {
          claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] },
          antigravity: { status: 'ok', models: [model] },
        },
      };
    },
  });
  expect(catalogReads).toBe(0);
  expect(container?.textContent).toContain('agy was not found on the server');
  expect(container?.textContent).toContain('Google does not support personal Google AI subscriptions');
  expect(container?.textContent).toContain('OpenChamber starts agy with full access');
  expect(container?.textContent).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');

  installed = true;
  const reload = [...(container?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Reload');
  if (!reload) throw new Error('Reload button missing');
  await act(async () => reload.click());
  expect(catalogReads).toBe(1);
  expect(container?.textContent).toContain('agy is installed and its model catalog is available');
  expect(container?.querySelector('[data-settings-item="providers.antigravity"]')).not.toBeNull();
});

test('distinguishes unauthenticated from other catalog failures', async () => {
  await render({
    catalog: async () => ({
      backends: {
        claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] },
        antigravity: { status: 'error', message: 'Sign in with agy first', reason: 'unauthenticated' },
      },
    }),
  });
  expect(container?.textContent).toContain('agy is installed but is not signed in');
  expect(container?.textContent).toContain('Sign in with agy first');
  expect(container?.textContent).toContain('Run these commands on the server that runs OpenChamber');
});

test('keeps other catalog errors in the error state and shows their diagnostic', async () => {
  await render({
    catalog: async () => ({
      backends: {
        claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] },
        antigravity: { status: 'error', message: 'agy models exited with status 2' },
      },
    }),
  });
  expect(container?.textContent).toContain('Could not confirm agy status');
  expect(container?.textContent).toContain('agy models exited with status 2');
  expect(container?.textContent).not.toContain('agy is installed but is not signed in');
});
