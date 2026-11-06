import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { SourceControlAuthStatus, SourceControlReadContext } from '@/lib/source-control/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

// Keep the unrelated chat shell behind its font gate. The mobile root's
// connection effects, provider registry and auth store stay real.
mock.module('./useFontsReady', () => ({ useFontsReady: () => false }));

class EventSourceFixture {
  static CLOSED = 2;
  static instances: EventSourceFixture[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { EventSourceFixture.instances.push(this); }
  close() { this.readyState = EventSourceFixture.CLOSED; }
  emit(type: string) { this.onmessage?.({ data: JSON.stringify({ type, properties: {} }) }); }
}

test('the mobile root loads PR providers on connect, refreshes on events and retires old runtime reads', async () => {
  const dom = new Window({ url: 'http://localhost/mobile.html' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), EventSource: EventSourceFixture, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  EventSourceFixture.instances = [];
  const { createRoot } = await import('react-dom/client');
  const { MobileApp } = await import('./MobileApp');
  const { I18nProvider } = await import('@/lib/i18n');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useConfigStore } = await import('@/stores/useConfigStore');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const configBefore = useConfigStore.getState();
  useConfigStore.setState({ isConnected: false, isInitialized: false,
    initializeApp: async () => {}, loadProviders: async () => {}, loadAgents: async () => true,
  });
  useDirectoryStore.setState({ currentDirectory: '' });
  useSourceControlProviderRegistry.getState().resetForRuntimeSwitch(getRuntimeKey());
  const context: SourceControlReadContext = { provider: 'github', instance: 'github.com', accountId: 'github.com#7',
    repositoryId: 'repo', bindingRevision: 1, primaryRemote: 'origin', directory: '/repo' };
  const user = { provider: 'github', instance: 'github.com', id: '7', username: 'fixture' };
  const auth: SourceControlAuthStatus = { provider: 'github', instance: 'github.com', status: 'connected', connected: true, user,
    accounts: [{ id: context.accountId, credentialId: context.accountId, credentialRevision: 1,
      providerUserId: '7', providerUserStatus: 'available', user, current: true, source: 'oauth', status: 'valid' }],
  };
  let descriptors = [githubLikeDescriptor()];
  let heldRead: Promise<SourceControlProviderDescriptor[]> | null = null;
  let releaseRead: (value: SourceControlProviderDescriptor[]) => void = () => {};
  const providerReads: string[] = [];
  const base = createWebAPIs();
  const apis = { ...base, sourceControl: { ...base.sourceControl,
    providers: async () => { providerReads.push(getRuntimeKey()); return heldRead ?? descriptors; },
    authInstances: async () => [{ provider: 'github', instance: 'github.com' }],
    authStatus: async () => auth,
  } };
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  try {
    await act(async () => root.render(<I18nProvider><MobileApp apis={apis} /></I18nProvider>));
    expect(providerReads).toHaveLength(0);
    await act(async () => { useConfigStore.setState({ isConnected: true }); });
    expect(providerReads.length).toBeGreaterThan(0);
    expect(useSourceControlProviderRegistry.getState().holdsList).toBe(true);
    expect(getSourceControlReadContextAuthState(
      useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(context)], context,
    ).connected).toBe(true);

    const stream = EventSourceFixture.instances.find(source => source.readyState !== EventSourceFixture.CLOSED);
    if (!stream) throw new Error('Missing control stream');
    descriptors = [{ ...githubLikeDescriptor(), label: 'Updated provider' }];
    await act(async () => stream.emit('openchamber:source-control-providers-changed'));
    expect(useSourceControlProviderRegistry.getState().byId.get('github')?.label).toBe('Updated provider');
    descriptors = [{ ...githubLikeDescriptor(), label: 'Reconnected provider' }];
    await act(async () => stream.emit('openchamber:event-stream-ready'));
    expect(useSourceControlProviderRegistry.getState().byId.get('github')?.label).toBe('Reconnected provider');

    heldRead = new Promise(resolve => { releaseRead = resolve; });
    await act(async () => stream.emit('openchamber:source-control-providers-changed'));
    heldRead = null;
    descriptors = [{ ...githubLikeDescriptor(), label: 'Second runtime' }];
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://second-runtime.test', runtimeKey: 'host:second' });
      useConfigStore.setState({ isConnected: true });
    });
    expect(providerReads).toContain('host:second');
    expect(useSourceControlProviderRegistry.getState().runtimeKey).toBe('host:second');
    await act(async () => releaseRead([{ ...githubLikeDescriptor(), label: 'Obsolete answer' }]));
    expect(useSourceControlProviderRegistry.getState().byId.get('github')?.label).toBe('Second runtime');
  } finally {
    await act(async () => root.unmount());
    useConfigStore.setState(configBefore, true);
    globalThis.fetch = originalFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
