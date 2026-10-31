import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { NativeAgentsAPI } from '@/lib/api/types';
import type { CliproxyapiConnectionWrite, CliproxyapiStatus } from '@/lib/native-agents/connections';
import { NativeAgentsRequestError } from '@/lib/native-agents/errors';

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
  loginProviders: ['codex', 'antigravity'], opusFailover: { enabled: false, ready: false },
  lastError: null, restarting: false, connection: null,
  ...patch,
});
const account = { provider: 'codex', name: 'codex-a.json', email: 'a@example.com', planType: 'pro', activeUntil: null, status: 'active', disabled: false };

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
const setInput = async (field: HTMLInputElement | null | undefined, value: string) => {
  await act(async () => {
    if (!field) return;
    // React tracks the value through its own setter, so set it the DOM way.
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

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
  test('saves Sonnet fallback independently and hides its control on an older Opus-only server', async () => {
    let current = status({ loginProviders: ['claude', 'antigravity'], opusFailover: { enabled: true, ready: true },
      sonnetFailover: { enabled: false, ready: false } });
    const choices: boolean[] = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => current,
      setCliproxyapiSonnetRoute: async (enabled) => {
        choices.push(enabled);
        current = { ...current, sonnetFailover: { enabled, ready: true } };
        return current;
      },
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { container?.querySelector<HTMLElement>('[data-settings-item="providers.cliproxyapi-sonnet"]')?.click(); });
    expect(choices).toEqual([true]);
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi-opus"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi-sonnet"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container?.textContent).toContain('Automatic Sonnet fallback');
    await act(async () => root?.unmount()); root = null;
    current = status({ loginProviders: ['claude', 'antigravity'] });
    await render(api, <CliProxyApiSection />);
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi-sonnet"]')).toBeNull();
  });

  test('offers Claude subscription login and saves the Opus fallback choice without losing existing accounts', async () => {
    const providers: string[] = [];
    const choices: boolean[] = [];
    const current = status({ accounts: [account], loginProviders: ['codex', 'antigravity', 'claude'] });
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => current,
      startCliproxyapiGateway: async () => current,
      setCliproxyapiOpusRoute: async (enabled) => {
        choices.push(enabled);
        return { ...current, opusFailover: { enabled, ready: false } };
      },
      beginCliproxyapiLogin: async (provider) => { providers.push(provider ?? 'codex'); return { state: 'claude123', url: 'https://claude.ai/oauth/authorize' }; },
      cancelCliproxyapiLogin: async () => true,
    });
    await render(api, <CliProxyApiSection />);
    const checkbox = container?.querySelector('[data-settings-item="providers.cliproxyapi-opus"]');
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox?.dispatchEvent(new Event('click', { bubbles: true })); });
    expect(choices).toEqual([true]);
    expect(container?.textContent).toContain('Sign in with Claude and Antigravity');
    await act(async () => { button('Sign in with Claude')?.click(); });
    expect(providers).toEqual(['claude']);
    expect(container?.textContent).toContain(account.email);
  });

  test('starts an Antigravity login while retaining the signed-in ChatGPT account', async () => {
    const providers: string[] = [];
    const current = status({ accounts: [account], ready: true, running: true, enabled: true, managementEnabled: true });
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => current,
      startCliproxyapiGateway: async () => current,
      beginCliproxyapiLogin: async (provider) => { providers.push(provider ?? 'codex'); return { state: 'ag123', url: 'https://accounts.google.com/o/oauth2/auth' }; },
      cancelCliproxyapiLogin: async () => true,
    });
    await render(api, <CliProxyApiSection />);
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi"]')?.textContent).toContain(account.email);
    await act(async () => { button('Sign in with Antigravity')?.click(); });
    expect(providers).toEqual(['antigravity']);
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi"]')?.textContent).toContain(account.email);
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi-antigravity"]')?.textContent).toContain('Finish the sign-in in your browser.');
  });

  test('groups accounts by their reported provider regardless of gateway order', async () => {
    const agy = { ...account, provider: 'antigravity', name: 'ag.json', email: 'google@example.com' };
    await render(createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status({ accounts: [agy, account] }) }), <CliProxyApiSection />);
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi"]')?.textContent).toContain(account.email);
    expect(container?.querySelector('[data-settings-item="providers.cliproxyapi-antigravity"]')?.textContent).toContain(agy.email);
    expect(button('Sign in with Antigravity')).toBeUndefined();
  });

  test('does not offer an Antigravity login on an older server', async () => {
    await render(createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status({ loginProviders: ['codex'] }) }), <CliProxyApiSection />);
    expect(button('Sign in with Antigravity')).toBeUndefined();
    expect(button('Sign in a ChatGPT account')).toBeDefined();
  });
  test('keeps the gateway controls hidden while nothing is wrong', async () => {
    const api = createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status() });
    await render(api, <CliProxyApiSection />);
    expect(button('Advanced')).toBeUndefined();
    expect(button('Start gateway')).toBeUndefined();
    expect(button('Sign in a ChatGPT account')?.disabled).toBe(false);
  });

  test('reveals the gateway controls when the gateway reports a failure', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ installedVersion: null, lastError: 'The gateway stopped on its own', install: { ...status().install, prepared: false, path: null } }),
    });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('The gateway stopped on its own');
    await act(async () => { button('Advanced')?.click(); });
    expect(button('Download and start')).toBeDefined();
  });

  test('shows the signed-in account on the row instead of the sign-in button', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ enabled: true, running: true, ready: true, runningVersion: '8.0.31', managementEnabled: true, accounts: [account] }),
    });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('a@example.com');
    expect(button('Sign in a ChatGPT account')).toBeUndefined();
    expect(button('Sign out')).toBeDefined();
    expect(button('Advanced')).toBeUndefined();
  });

  test('brings the sign-in button back after signing out', async () => {
    let accounts = [account];
    let refreshes = 0;
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ accounts }),
      removeCliproxyapiAccount: async () => { accounts = []; },
    });
    await render(api, <CliProxyApiSection onConnectionsChanged={async () => { refreshes += 1; }} />);
    expect(button('Sign in a ChatGPT account')).toBeUndefined();
    await act(async () => { button('Sign out')?.click(); });
    await act(async () => { button('Sign out')?.click(); });
    expect(button('Sign in a ChatGPT account')).toBeDefined();
    expect(text()).not.toContain('a@example.com');
    expect(refreshes).toBe(1);
  });

  test('refreshes accounts and models after a partial sign-out failure without hiding the error', async () => {
    let accounts = [account];
    let refreshes = 0;
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ accounts }),
      removeCliproxyapiAccount: async () => {
        accounts = [];
        throw new NativeAgentsRequestError('Model discovery failed after logout', 502, 'CLIPROXYAPI_REQUEST_FAILED');
      },
    });
    await render(api, <CliProxyApiSection onConnectionsChanged={async () => { refreshes += 1; }} />);
    await act(async () => { button('Sign out')?.click(); });
    await act(async () => { button('Sign out')?.click(); });
    expect(button('Sign in a ChatGPT account')).toBeDefined();
    expect(refreshes).toBe(1);
    expect(container?.querySelector('[role="alert"]')).not.toBeNull();
  });

  test('does not refresh a page that unmounted while sign-out was pending', async () => {
    let complete: () => void = () => {};
    let refreshes = 0;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ accounts: [account] }),
      removeCliproxyapiAccount: async () => pending,
    });
    await render(api, <CliProxyApiSection onConnectionsChanged={async () => { refreshes += 1; }} />);
    await act(async () => { button('Sign out')?.click(); });
    await act(async () => { button('Sign out')?.click(); });
    await act(async () => { root?.unmount(); });
    await act(async () => { complete(); });
    expect(refreshes).toBe(0);
  });

  test('names a target this computer cannot run', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ install: { supported: false, prepared: false, target: null, version: '8.0.31', path: null, error: 'unsupported' } }),
    });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('not a supported target');
    expect(button('Sign in a ChatGPT account')?.disabled).toBe(true);
    await act(async () => { button('Advanced')?.click(); });
    expect(button('Start gateway')?.disabled).toBe(true);
  });

  test('saves the upstream proxy', async () => {
    const saved: Array<string | null> = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ lastError: 'The gateway stopped on its own' }),
      setCliproxyapiProxy: async ({ upstreamProxy }) => {
        saved.push(upstreamProxy);
        return status({ upstreamProxy });
      },
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { button('Advanced')?.click(); });
    const field = container?.querySelector<HTMLInputElement>('input[type="url"]');
    expect(field).not.toBeNull();
    await setInput(field, 'http://127.0.0.1:7890');
    await act(async () => { button('Save')?.click(); });
    expect(saved).toEqual(['http://127.0.0.1:7890']);
  });

  test('polls a sign-in attempt and reloads the accounts it added', async () => {
    let polls = 0;
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true, accounts: polls === 0 ? [] : [account] }),
      startCliproxyapiGateway: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device' }),
      cliproxyapiLoginStatus: async () => (polls++ === 0 ? { status: 'pending', message: null } : { status: 'connected', message: null }),
      importCliproxyapiModels: async () => ({
        connection: {
          id: 'connection-1', revision: 1, hasKey: true, kind: 'anthropic', name: 'CLIProxyAPI',
          baseURL: 'http://127.0.0.1:8317', auth: 'api-key', models: [], quotaProviderId: null,
        },
        imported: 0,
        skipped: 0,
      }),
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
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: false }),
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
    await render(api, <CliProxyApiSection onConnectionsChanged={async () => { reported.push('refreshed'); }} />);
    await act(async () => { button('Advanced')?.click(); });
    await act(async () => { button('Import gateway models')?.click(); });
    expect(imports).toBe(1);
    expect(text()).toContain('Imported 9 models');
    expect(text()).toContain('skipped 5');
    expect(reported).toEqual(['refreshed']);
  });

  test('cancels a pending attempt when the page is left', async () => {
    const cancelled: string[] = [];
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      startCliproxyapiGateway: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
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
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: false }),
      saveCliproxyapiConnection: async (input) => {
        drafts.push(input);
        return {
          id: 'connection-1', revision: 1, hasKey: true, kind: 'anthropic', name: input.name,
          baseURL: 'http://127.0.0.1:8317', auth: 'api-key', models: input.models, quotaProviderId: null,
        };
      },
    });
    await render(api, <CliProxyApiSection onConnectionsChanged={async () => { reported.push('refreshed'); }} />);
    await act(async () => { button('Advanced')?.click(); });
    await act(async () => { button('Create connection')?.click(); });
    expect(drafts[0]).toMatchObject({ connectionId: null, name: 'CLIProxyAPI' });
    expect(drafts[0].models[0]).toMatchObject({
      modelID: 'gpt-6.1-sol', contextWindow: 872000, outputLimit: 128000, input: { image: true, pdf: false },
    });
    expect(reported).toEqual(['refreshed']);
  });

  test('submits a pasted callback address and finishes the sign-in', async () => {
    const submitted: Array<[string, string]> = [];
    let polls = 0;
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true, accounts: polls === 0 ? [] : [account] }),
      startCliproxyapiGateway: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device' }),
      submitCliproxyapiLoginCallback: async (state, url) => { submitted.push([state, url]); },
      cliproxyapiLoginStatus: async () => (polls++ === 0 ? { status: 'pending', message: null } : { status: 'connected', message: null }),
      importCliproxyapiModels: async () => ({
        connection: {
          id: 'connection-1', revision: 1, hasKey: true, kind: 'anthropic', name: 'CLIProxyAPI',
          baseURL: 'http://127.0.0.1:8317', auth: 'api-key', models: [], quotaProviderId: null,
        },
        imported: 0,
        skipped: 0,
      }),
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { button('Sign in a ChatGPT account')?.click(); });
    await setInput(container?.querySelector<HTMLInputElement>('input[aria-label="Callback address"]'), 'http://localhost:1455/auth/callback?code=xyz&state=abc123');
    await act(async () => { button('Use this address')?.click(); });
    expect(submitted).toEqual([['abc123', 'http://localhost:1455/auth/callback?code=xyz&state=abc123']]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    expect(text()).toContain('a@example.com');
  }, 15_000);

  test('ends the attempt when the gateway refuses the pasted link', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      startCliproxyapiGateway: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device' }),
      submitCliproxyapiLoginCallback: async () => { throw new NativeAgentsRequestError('unknown or expired state', 409, 'CLIPROXYAPI_LOGIN_CALLBACK_REJECTED'); },
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { button('Sign in a ChatGPT account')?.click(); });
    await setInput(container?.querySelector<HTMLInputElement>('input[aria-label="Callback address"]'), 'http://localhost:1455/auth/callback?code=xyz&state=abc123');
    await act(async () => { button('Use this address')?.click(); });
    expect(text()).toContain('The gateway did not accept that link.');
    expect(text()).toContain('unknown or expired state');
    expect(button('Sign in a ChatGPT account')).toBeDefined();
    expect(button('Use this address')).toBeUndefined();
  });

  test('shows the gateway reason under the failure line when the sign-in fails', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      startCliproxyapiGateway: async () => status({ ready: true, running: true, enabled: true, managementEnabled: true }),
      beginCliproxyapiLogin: async () => ({ state: 'abc123', url: 'https://auth.openai.com/codex/device' }),
      cliproxyapiLoginStatus: async () => ({ status: 'failed', message: 'Failed to exchange authorization code for tokens' }),
    });
    await render(api, <CliProxyApiSection />);
    await act(async () => { button('Sign in a ChatGPT account')?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    expect(text()).toContain('The sign-in did not complete. Try again.');
    expect(text()).toContain('Failed to exchange authorization code for tokens');
  }, 15_000);

  test('brings the gateway up and writes the connection on a one-click sign-in', async () => {
    const calls: string[] = [];
    let polls = 0;
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => {
        if (polls > 0) await new Promise((resolve) => setTimeout(resolve, 25));
        return status({ accounts: polls === 0 ? [] : [account] });
      },
      startCliproxyapiGateway: async () => { calls.push('start'); return status({ ready: true, running: true, enabled: true, managementEnabled: true }); },
      beginCliproxyapiLogin: async () => { calls.push('login'); return { state: 'abc123', url: 'https://auth.openai.com/codex/device' }; },
      cliproxyapiLoginStatus: async () => (polls++ === 0 ? { status: 'pending', message: null } : { status: 'connected', message: null }),
      importCliproxyapiModels: async () => {
        calls.push('import');
        return {
          connection: {
            id: 'connection-1', revision: 1, hasKey: true, kind: 'anthropic', name: 'CLIProxyAPI',
            baseURL: 'http://127.0.0.1:8317', auth: 'api-key', models: [], quotaProviderId: null,
          },
          imported: 9,
          skipped: 5,
        };
      },
    });
    await render(api, <CliProxyApiSection onConnectionsChanged={async () => { calls.push('refreshed'); }} />);
    await act(async () => { button('Sign in a ChatGPT account')?.click(); });
    expect(calls).toEqual(['start', 'login']);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
    expect(calls).toEqual(['start', 'login', 'import', 'refreshed']);
    expect(text()).toContain('Imported 9 models');
    expect(text()).toContain('a@example.com');
  }, 15_000);

  test('renders as the sign-in row named after the gateway connection', async () => {
    const api = createTestNativeAgentsAPI({
      cliproxyapiStatus: async () => status({ connection: { id: 'connection-1', name: 'CLIProxyAPI / ChatGPT' } }),
    });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('CLIProxyAPI / ChatGPT');
    expect(button('Sign in a ChatGPT account')).toBeDefined();
    expect(button('Edit')).toBeUndefined();
    expect(button('Delete')).toBeUndefined();
  });

  test('names the row CLIProxyAPI before any connection exists', async () => {
    const api = createTestNativeAgentsAPI({ cliproxyapiStatus: async () => status() });
    await render(api, <CliProxyApiSection />);
    expect(text()).toContain('CLIProxyAPI');
    expect(button('Sign in a ChatGPT account')).toBeDefined();
  });
});
