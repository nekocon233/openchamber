import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { RepositoryChangeRequestReference } from '@/lib/api/types';
import type { SourceControlAuthStatus, SourceControlUser } from '@/lib/source-control/types';

const ACCOUNT_ID = 'github.com#7';
const ENDPOINT = { displayUrl: 'https://github.com/acme/app', fingerprint: 'origin-fetch' };
const USER: SourceControlUser = { provider: 'github', instance: 'github.com', id: '7', username: 'octocat' };
const CONNECTED: SourceControlAuthStatus = {
  provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: USER,
  accounts: [{
    id: ACCOUNT_ID, credentialId: ACCOUNT_ID, credentialRevision: 1, providerUserId: 'github.com#7',
    providerUserStatus: 'available', user: USER, current: true, source: 'oauth', status: 'valid',
  }],
};

const pull = (number: number): RepositoryChangeRequestReference => ({
  provider: 'github',
  kind: 'pull', number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: `branch-${number}`, base: 'main', headSha: `sha-${number}`, headRepo: null,
});

test('a list that mounts while its statuses are already on the way shows them when they land, asking once', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const answers: Array<() => void> = [];
  const asked: string[] = [];
  let failLastBatch = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    switch (url.pathname) {
      case '/api/fs/home': return Response.json({ home: '/fixture-home' });
      case '/api/session': return Response.json({ data: [] });
      case '/api/location': return Response.json({ directory: '/repo', project: { directory: '/repo' } });
      case '/api/source-control/binding': return Response.json({
        status: 'bound', revision: 1,
        repository: { repositoryId: 'repo-1', configRevision: 'rev', bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }] },
        binding: { repositoryId: 'repo-1', configRevision: 'rev', revision: 1, state: 'bound',
          providers: [{ provider: 'github', instance: 'github.com', accountId: ACCOUNT_ID, primaryRemote: 'origin',
            readiness: 'ready', endpoint: ENDPOINT }], remotes: [], auxiliary: [] },
      });
      case '/api/source-control/github/references/status': {
        asked.push(url.searchParams.get('pulls') ?? '');
        // Held until the test lets it answer, like a slow GitHub.
        await new Promise<void>((resolve) => { answers.push(resolve); });
        if (failLastBatch && url.searchParams.get('pulls')?.startsWith('acme/app#21')) {
          return Response.json({ error: 'Checks unavailable' }, { status: 503 });
        }
        return Response.json({ connected: true, statuses: (url.searchParams.get('pulls') ?? '').split(',').map((entry) => ({
          owner: 'acme', repo: 'app', number: Number(entry.split('#')[1]),
          checks: { state: 'success', total: 3, success: 3, failure: 0, pending: 0 }, mergeable: true, mergeableState: 'clean',
        })) });
      }
      default: return Response.json({});
    }
  }, originalFetch);

  try {
    const { createRoot } = await import('react-dom/client');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
    const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
    const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
    const { forgetRepositoryPullStatuses, useRepositoryPullStatuses } = await import('./referenceSources');
    const { revalidateReferences } = await import('./referenceCache');
    const baseDescriptor = githubLikeDescriptor();
    const descriptor = { ...baseDescriptor, features: { ...baseDescriptor.features, listStatuses: true } };
    useSourceControlProviderRegistry.setState({
      ordered: [descriptor],
      byId: new Map([[descriptor.id, descriptor]]),
      status: 'ready',
      holdsList: true,
    });
    useSourceControlAuthStore.setState({
      entries: { [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: { status: CONNECTED, isLoading: false, hasChecked: true } },
    });
    const apis = createWebAPIs();
    const pulls = Array.from({ length: 23 }, (_, index) => pull(index + 1));
    const closed = { ...pull(24), state: 'closed' } as const;
    const candidates = [...pulls, closed];
    const Probe: React.FC = () => {
      const statusOf = useRepositoryPullStatuses('/repo', candidates);
      const status = statusOf(pulls[0]);
      return <><span id="status">{status.status === 'ready' ? `ready:${status.value?.checks?.total}` : status.status}</span>
        <span id="last-status">{statusOf(pulls[22]).status}</span>
        <span id="closed-status">{statusOf(closed).status}</span></>;
    };
    // Lets the held answer go while the probe renders: it lands after that
    // render but before React runs the probe's effects.
    const ReleaseDuringRender: React.FC = () => {
      for (const answer of answers.splice(0)) answer();
      return null;
    };
    const tree = (children: React.ReactNode) => <RuntimeAPIContext.Provider value={apis}>{children}</RuntimeAPIContext.Provider>;

    // A list shown earlier asked for the statuses and is gone again.
    const first = createRoot(document.createElement('div'));
    await act(async () => { first.render(tree(<Probe />)); });
    for (let tries = 0; tries < 50 && answers.length === 0; tries += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(asked.map((batch) => batch.split(',').length)).toEqual([10, 10, 3]);
    expect(asked.flatMap((batch) => batch.split(','))).toEqual(pulls.map((item) => `acme/app#${item.number}`));
    await act(async () => { first.unmount(); });

    // The board opens on the same list while that answer is still on its way.
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: false });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    root.render(tree(<><Probe /><ReleaseDuringRender /></>));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(asked).toHaveLength(3);
    expect(container.querySelector('#status')?.textContent).toBe('ready:3');
    expect(container.querySelector('#last-status')?.textContent).toBe('ready');
    expect(container.querySelector('#closed-status')?.textContent).toBe('idle');

    failLastBatch = true;
    forgetRepositoryPullStatuses();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(6);
    for (const answer of answers.splice(0)) answer();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector('#last-status')?.textContent).toBe('error');
    expect(container.querySelector('#status')?.textContent).toBe('ready:3');
    expect(asked).toHaveLength(6);

    // Refresh retries the failed batch once and reuses successful results.
    failLastBatch = false;
    revalidateReferences();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(7);
    expect(asked[6]).toBe('acme/app#21,acme/app#22,acme/app#23');
    for (const answer of answers.splice(0)) answer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('#last-status')?.textContent).toBe('ready');
    expect(asked).toHaveLength(7);
    root.unmount();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
