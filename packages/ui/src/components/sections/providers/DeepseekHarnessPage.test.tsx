import React, { act } from 'react';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { NativeAgentsAPI, NativeCapabilities } from '@/lib/api/types';
import type { DeepseekConfiguration, DeepseekConfigurationWrite, DeepseekSetupStatus } from '@/lib/native-agents/deepseek';

const browser = new Window({ url: 'https://remote-client.test' });
Object.defineProperty(browser, 'setTimeout', { value: globalThis.setTimeout.bind(globalThis), configurable: true });
Object.defineProperty(browser, 'clearTimeout', { value: globalThis.clearTimeout.bind(globalThis), configurable: true });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  Element: browser.Element, Event: browser.Event, Node: browser.Node, Text: browser.Text,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  // Background directory discovery runs on store import, before this page's
  // runtime is registered. Give it a location without making a network call.
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
const { NativeAgentsRequestError } = await import('@/lib/native-agents/errors');
const { getRuntimeKey, getRuntimeApiBaseUrl, initializeRuntimeEndpoint } = await import('@/lib/runtime-switch');

const configuration: DeepseekConfiguration = {
  revision: 1, writable: true, baseURL: null, modelIDs: ['model-a'], credential: { configured: true, writable: true },
};
const capabilities = (patch: Partial<NonNullable<NativeCapabilities['backends']['deepseek']>> = {}): NativeCapabilities => ({
  supported: true, registry: { reset: false }, backends: {
    claude: { cli: false }, codex: { cli: false },
    deepseek: { cli: true, blockedByEnterprise: false, actions: { revert: false, delete: false, fork: true }, ...patch },
  },
});
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
const render = async (methods: Partial<NativeAgentsAPI>) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
    capabilities: async () => capabilities(), deepseekConfiguration: async () => configuration,
    deepseekSetupStatus: async () => ({ state: 'idle' }),
    catalog: async () => ({ backends: { claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] }, deepseek: { status: 'ok', models: [] } } }),
    ...methods,
  }));
  registerRuntimeAPIs(apis);
  await act(async () => root?.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><DeepseekHarnessPage /></I18nProvider></RuntimeAPIContext.Provider>));
  return apis;
};
const input = (label: string) => {
  const element = container?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing input ${label}`);
  return element;
};
const type = async (label: string, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Input setter unavailable');
  await act(async () => {
    setter.call(input(label), value);
    input(label).dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submit = () => act(async () => { container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = null; container = null; });
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('remote settings save the endpoint, key and model IDs and clear the write-only key', async () => {
  const requests: DeepseekConfigurationWrite[] = [];
  await render({ saveDeepseekConfiguration: async (request) => {
    requests.push(request);
    return { status: 'saved', configuration: { ...configuration, revision: 2, baseURL: request.baseURL, modelIDs: request.modelIDs } };
  } });
  await type('API endpoint', 'https://gateway.test/anthropic');
  await type('API key', 'fixture-remote-key');
  await type('Model IDs', 'model-a, model-b');
  await submit();
  expect(requests).toEqual([{ revision: 1, baseURL: 'https://gateway.test/anthropic', apiKey: 'fixture-remote-key', modelIDs: ['model-a', 'model-b'] }]);
  expect(input('API key').value).toBe('');
  expect(input('Model IDs').value).toBe('model-a, model-b');
});

test('a credential failure keeps the typed key and retries using the committed settings revision', async () => {
  const requests: DeepseekConfigurationWrite[] = [];
  await render({ saveDeepseekConfiguration: async (request) => {
    requests.push(request);
    return { status: requests.length === 1 ? 'credential-error' : 'saved', configuration: { ...configuration, revision: request.revision + 1 } };
  } });
  await type('API key', 'fixture-retry-key');
  await submit();
  expect(container?.textContent).toContain('The endpoint and models were saved, but the API key could not be saved.');
  expect(input('API key').value).toBe('fixture-retry-key');
  await submit();
  expect(requests.map(({ revision }) => revision)).toEqual([1, 2]);
  expect(input('API key').value).toBe('');
});

test('a stale configuration keeps the draft and asks for a reload', async () => {
  await render({ saveDeepseekConfiguration: async () => { throw new NativeAgentsRequestError('stale', 409, 'NATIVE_DEEPSEEK_SETTINGS_CONFLICT'); } });
  await type('API endpoint', 'https://edited.test/anthropic');
  await submit();
  expect(container?.textContent).toContain('Reload before saving.');
  expect(input('API endpoint').value).toBe('https://edited.test/anthropic');
});

test('an environment-owned key is read-only while endpoint configuration remains available', async () => {
  await render({ deepseekConfiguration: async () => ({ ...configuration, credential: { configured: true, writable: false } }) });
  expect(input('API key').disabled).toBe(true);
  expect(input('API endpoint').closest('fieldset')?.disabled).toBe(false);
});

test('enterprise mode does not read or render provider configuration', async () => {
  let reads = 0;
  await render({ capabilities: async () => capabilities({ blockedByEnterprise: true }), deepseekConfiguration: async () => { reads += 1; return configuration; } });
  expect(reads).toBe(0);
  expect(container?.querySelector('form')).toBeNull();
  expect(container?.textContent).toContain('unavailable in enterprise mode');
});

test('a remote client can install the CLI with one click and open an independent configuration form', async () => {
  let installed = false;
  let reads = 0;
  let starts = 0;
  await render({
    capabilities: async () => capabilities({ cli: installed }),
    deepseekConfiguration: async () => { reads += 1; return { ...configuration, credential: { configured: false, writable: true } }; },
    setupDeepseek: async () => { starts += 1; installed = true; return { state: 'needs-key' }; },
    deepseekSetupStatus: async () => ({ state: installed ? 'needs-key' : 'idle' }),
  });
  expect(reads).toBe(0);
  const action = [...(container?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'One-click setup');
  if (!action) throw new Error('One-click setup action missing');
  await act(async () => action.click());
  expect(starts).toBe(1);
  expect(reads).toBe(1);
  expect(input('API key').value).toBe('');
  expect(input('API key').required).toBe(true);
  expect(input('Model IDs').value).toBe('model-a');
  expect(container?.textContent).not.toContain('npm install -g');
});

test('an active installation disables repeat clicks and displays its progress', async () => {
  let starts = 0;
  await render({
    capabilities: async () => capabilities({ cli: false }),
    setupDeepseek: async () => { starts += 1; return { state: 'installing' }; },
  });
  const action = [...(container?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'One-click setup');
  if (!action) throw new Error('One-click setup action missing');
  await act(async () => action.click());
  expect(action.disabled).toBe(true);
  expect(starts).toBe(1);
  expect(container?.textContent).toContain('Installing dsh on the server');
});

test('a setup failure explains a missing npm installation and offers a retry', async () => {
  await render({
    capabilities: async () => capabilities({ cli: false }),
    deepseekSetupStatus: async () => ({ state: 'error', code: 'NATIVE_DEEPSEEK_NPM_MISSING' }),
  });
  expect(container?.textContent).toContain('npm is missing on the server.');
  const action = [...(container?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'One-click setup');
  expect(action?.disabled).toBe(false);
});

test('switching servers clears pending setup state and ignores the previous server response', async () => {
  const previousKey = getRuntimeKey();
  const previousBase = getRuntimeApiBaseUrl();
  let switched = false;
  let finish: ((status: DeepseekSetupStatus) => void) | undefined;
  const pending = new Promise<DeepseekSetupStatus>((resolve) => { finish = resolve; });
  const apis = await render({
    capabilities: async () => {
      if (switched) throw new Error('Second server is offline');
      return capabilities({ cli: false });
    },
    setupDeepseek: () => pending,
  });
  const action = [...(container?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'One-click setup');
  if (!action) throw new Error('One-click setup action missing');
  await act(async () => action.click());
  expect(action.disabled).toBe(true);
  try {
    switched = true;
    initializeRuntimeEndpoint({ apiBaseUrl: 'https://second-server.test', runtimeKey: 'deepseek-setup-second-server' });
    await act(async () => root?.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><DeepseekHarnessPage /></I18nProvider></RuntimeAPIContext.Provider>));
    const currentAction = [...(container?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'One-click setup');
    expect(currentAction?.disabled).toBe(false);
    await act(async () => finish?.({ state: 'installing' }));
    expect(container?.textContent).not.toContain('Installing dsh on the server');
    expect(currentAction?.disabled).toBe(false);
  } finally {
    initializeRuntimeEndpoint({ apiBaseUrl: previousBase, runtimeKey: previousKey });
  }
});

test('progress polling stops when setup finishes or the page unmounts and does no work when idle', async () => {
  const originalSet = browser.setTimeout;
  const originalClear = browser.clearTimeout;
  let poll: (() => void) | undefined;
  Object.defineProperty(browser, 'setTimeout', { value: (callback: () => void, delay: number) => {
    if (delay !== 2000) return originalSet(callback, delay);
    poll = callback;
    return -1;
  } });
  Object.defineProperty(browser, 'clearTimeout', { value: (timer: number) => {
    if (timer === -1) poll = undefined;
    else globalThis.clearTimeout(timer);
  } });
  try {
    let started = false;
    let installed = false;
    let reads = 0;
    await render({
      capabilities: async () => capabilities({ cli: installed }),
      setupDeepseek: async () => { started = true; return { state: 'installing' }; },
      deepseekSetupStatus: async () => {
        reads += 1;
        if (!started) return { state: 'idle' };
        installed = true;
        return { state: 'needs-key' };
      },
    });
    expect(reads).toBe(1);
    expect(poll).toBeUndefined();
    const action = [...(container?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'One-click setup');
    if (!action) throw new Error('One-click setup action missing');
    await act(async () => action.click());
    const tick = poll;
    if (!tick) throw new Error('Active setup must schedule a progress read');
    await act(async () => tick());
    expect(reads).toBe(3);
    expect(poll).toBeUndefined();
    const retry = [...(container?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'One-click setup');
    if (!retry) throw new Error('Setup action missing after reload');
    await act(async () => retry.click());
    expect(poll).toBeDefined();
    await act(async () => root?.unmount());
    root = null;
    expect(poll).toBeUndefined();
  } finally {
    Object.defineProperty(browser, 'setTimeout', { value: originalSet });
    Object.defineProperty(browser, 'clearTimeout', { value: originalClear });
  }
});

test('shows an endpoint placeholder and a single setup label without the CLI heading', async () => {
  await render({});
  expect(input('API endpoint').placeholder).toBe('Leave blank to use the dsh default URL');
  const setupLabels = Array.from(container?.querySelectorAll('*') ?? []).filter((node) => node.textContent === 'One-click setup' && node.children.length === 0);
  expect(setupLabels).toHaveLength(1);
  expect(container?.querySelector('h3')?.textContent).not.toBe('dsh');
});
