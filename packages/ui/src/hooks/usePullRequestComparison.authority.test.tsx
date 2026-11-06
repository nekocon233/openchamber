import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { SourceControlReadContext, ChangeRequest } from '@/lib/source-control/types';

test('restored PR choices and pending handoffs remain with their bound account and revision', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    location: dom.location, localStorage: dom.localStorage, Event: dom.Event, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { I18nProvider } = await import('@/lib/i18n');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { useSourceControlAuthStore, getSourceControlAuthKey } = await import('@/stores/useSourceControlAuthStore');
  const { usePullRequestComparison } = await import('./usePullRequestComparison');
  const account = { provider: 'github' as const, instance: 'github.com', id: '1', username: 'first' };
  useSourceControlAuthStore.setState({ entries: { [getSourceControlAuthKey(account)]: { hasChecked: true, isLoading: false,
    status: { provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: account,
      accounts: ['1', '2'].map(id => ({ id: `github.com#${id}`, credentialId: `github.com#${id}`, credentialRevision: 1,
        providerUserId: id, providerUserStatus: 'available', user: { ...account, id }, current: id === '1', source: 'oauth', status: 'valid' })) },
  } } });
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([['github', descriptor]]), status: 'ready', holdsList: true });
  const directory = '/authority-project';
  const first: SourceControlReadContext = { provider: 'github', instance: 'github.com', accountId: 'github.com#1',
    repositoryId: 'same-repository', bindingRevision: 1, primaryRemote: 'origin', directory };
  const second = { ...first, accountId: 'github.com#2' };
  const source = { kind: 'pr' as const, number: 12, sourceRepo: { owner: 'acme', repo: 'project' } };
  usePullRequestSelectionStore.getState().requestDiff(directory, source, undefined, first);
  const base = createWebAPIs();
  const apis = { ...base, sourceControl: { ...base.sourceControl,
    changeRequestsList: async () => ({ items: [], page: 1, hasMore: false }),
  } };
  let current: ReturnType<typeof usePullRequestComparison> | null = null;
  const Probe: React.FC<{ context: SourceControlReadContext; handoff: boolean }> = ({ context, handoff }) => {
    const pending = usePullRequestSelectionStore(state => state.diffRequests.get(directory));
    current = usePullRequestComparison(directory, 'feature', context, true, handoff ? pending : undefined);
    return null;
  };
  const host = document.createElement('div'); document.body.append(host);
  let root = createRoot(host);
  const render = (context: SourceControlReadContext, handoff = true) => act(async () => root.render(
    <RuntimeAPIContext.Provider value={apis}><I18nProvider><Probe context={context} handoff={handoff} /></I18nProvider></RuntimeAPIContext.Provider>,
  ));
  const selected = () => { if (!current) throw new Error('Missing comparison'); return current; };
  try {
    await render(first);
    expect(selected().selectedSource?.number).toBe(12);
    await render(second);
    expect(selected().selectedSource).toBeNull();
    await render(first);
    expect(selected().selectedSource?.number).toBe(12);
    const chosen: ChangeRequest = { provider: 'github', instance: 'github.com', id: 'acme/project#7', number: 7,
      project: { provider: 'github', instance: 'github.com', id: 'acme/project', owner: 'acme', name: 'project', url: 'https://github.com/acme/project' },
      title: 'Chosen', url: 'https://github.com/acme/project/pull/7', state: 'open', draft: false, head: 'feature', base: 'main' };
    await act(async () => selected().select(chosen));
    expect(selected().selectedSource?.number).toBe(7);
    await act(async () => root.unmount());
    usePullRequestSelectionStore.setState({ selections: new Map(), diffRequests: new Map() });
    root = createRoot(host);
    await render(first, false);
    expect(selected().selectedSource?.number).toBe(7);
    await render(second, false);
    expect(selected().selectedSource).toBeNull();
    await render({ ...first, bindingRevision: 2 }, false);
    expect(selected().selectedSource).toBeNull();
    await render(first, false);
    await act(async () => usePullRequestSelectionStore.getState().requestDiff(directory, { ...source, number: 99 }));
    await render(first, true);
    expect(selected().selectedSource?.number).toBe(99);
    await render(second, true);
    expect(selected().selectedSource).toBeNull();
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
