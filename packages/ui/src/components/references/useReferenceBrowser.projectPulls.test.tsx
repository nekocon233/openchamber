import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitHubPullReference } from '@/lib/api/types';
import type { SourceControlAuthStatus } from '@/lib/source-control/types';
import type { ReferenceBrowser } from './useReferenceBrowser';

const ACCOUNT_ID = 'github.com#7';
const ENDPOINT = { displayUrl: 'https://github.com/acme/app', fingerprint: 'origin-fetch' };
const USER = { provider: 'github' as const, instance: 'github.com', id: '7', username: 'octocat' };
const CONNECTED: SourceControlAuthStatus = {
  provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: USER,
  accounts: [{ id: ACCOUNT_ID, credentialId: ACCOUNT_ID, credentialRevision: 1, providerUserId: 'github.com#7',
    providerUserStatus: 'available', user: USER, current: true, source: 'oauth', status: 'valid' }],
};
const pull = (number: number, owner = 'acme'): GitHubPullReference => ({
  kind: 'pull', number, title: `PR ${number}`, url: `https://github.com/${owner}/app/pull/${number}`,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner, repo: 'app', source: 'origin' }, state: owner === 'upstream' ? number === 2 ? 'merged' : 'closed' : 'open', draft: false,
  head: `branch-${number}`, base: 'main', headSha: `sha-${number}`, headRepo: null,
});

test('project PR browsing isolates filters, pagination and late reads and pauses while hidden', async () => {
  const dom = new Window({ url: 'http://localhost' });
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    MutationObserver: dom.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  let failNextPage = false;
  let failRefresh = false;
  let oldServer = false;
  let releaseOld: (() => void) | undefined;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/source-control/binding') return Response.json({
      status: 'bound', revision: 1,
      repository: { supported: true, repositoryId: 'repo', configRevision: 'rev', bare: false,
        remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }] },
      binding: { repositoryId: 'repo', configRevision: 'rev', revision: 1, state: 'bound',
        providers: [{ provider: 'github', instance: 'github.com', accountId: ACCOUNT_ID, primaryRemote: 'origin', readiness: 'ready', endpoint: ENDPOINT }], remotes: [], auxiliary: [] },
    });
    if (url.pathname === '/api/source-control/github/references') {
      if (failRefresh || (failNextPage && url.searchParams.has('cursor'))) return Response.json({ error: 'fixture unavailable' }, { status: 503 });
      const query = url.searchParams.get('query');
      if (query === 'old') await new Promise<void>((resolve) => { releaseOld = resolve; });
      const owner = url.searchParams.get('scope') === 'network' ? 'upstream' : 'acme';
      const items = query === 'terminal' ? [{ ...pull(92, owner), state: 'merged' }, { ...pull(93, owner), state: 'closed' }]
        : query ? [pull(query === 'old' ? 90 : 91, owner)] : url.searchParams.has('cursor') ? [pull(3, owner)] : [pull(1, owner), pull(2, owner)];
      return Response.json({ connected: true, scope: oldServer ? undefined : url.searchParams.get('scope'), repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' }, items,
        cursor: query || url.searchParams.has('cursor') ? null : 'next', hasMore: !query && !url.searchParams.has('cursor'), total: query ? 1200 : 3 });
    }
    if (url.pathname === '/api/source-control/github/references/detail') return Response.json({ connected: true,
      detail: { number: Number(url.searchParams.get('number')), comments: [], commentTotal: 0, pull: null } });
    if (url.pathname === '/api/source-control/github/references/status') return Response.json({ connected: true,
      statuses: (url.searchParams.get('pulls') ?? '').split(',').map((ref) => ({ owner: 'acme', repo: 'app', number: Number(ref.split('#')[1]),
        checks: { state: 'success', total: 2, success: 2, failure: 0, pending: 0 }, mergeable: null, mergeableState: null })) });
    if (url.pathname.endsWith('/location')) return Response.json({ directory: '/repo', project: { id: 'fixture', directory: '/repo', canonical: '/repo' } });
    if (url.pathname.endsWith('/session/active')) return Response.json({});
    return Response.json({ data: [] });
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { I18nProvider } = await import('@/lib/i18n');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const { useReferenceBrowser } = await import('./useReferenceBrowser');
  const { revalidateReferences } = await import('./referenceCache');
  const { referencePickerItemKey } = await import('./referencePickerItems');
  useSourceControlAuthStore.setState({ entries: {
    [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: { status: CONNECTED, isLoading: false, hasChecked: true },
  } });
  const apis = createWebAPIs();
  let project: ReferenceBrowser | undefined;
  let board: ReferenceBrowser | undefined;
  const current = () => { if (!project) throw new Error('Project browser has not mounted'); return project; };
  const boardBrowser = () => { if (!board) throw new Error('Board has not mounted'); return board; };
  const Probe: React.FC<{ mode: 'references' | 'project-pulls'; active?: boolean; directory?: string }> = ({ mode, active = true, directory = '/repo' }) => {
    const browser = useReferenceBrowser({ source: 'github', directory, isMobile: false, initialGitHubKind: 'pull', mode, active });
    if (mode === 'project-pulls') project = browser;
    else board = browser;
    return <div>{browser.items.map(referencePickerItemKey).join(',')}</div>;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = async (active = true, directory = '/repo') => {
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider>
      <Probe mode="references" /><Probe mode="project-pulls" active={active} directory={directory} />
    </I18nProvider></RuntimeAPIContext.Provider>));
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 120 && !predicate(); i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(predicate()).toBe(true);
  };
  const listRequests = () => requests.filter((url) => url.pathname.endsWith('/references') && url.searchParams.get('scope') === 'repository');
  const numbers = () => current().items.flatMap((item) => item.source === 'github' ? [item.reference.number] : []);

  try {
    await render();
    await until(() => current().list.status === 'ready');
    expect(current().githubFilter).toEqual({ state: 'open', people: 'reviewRequested' });
    expect(listRequests()).toHaveLength(1);
    expect(listRequests()[0]?.searchParams.get('kind')).toBe('pull');
    expect(listRequests()[0]?.searchParams.get('state')).toBe('open');
    expect(listRequests()[0]?.searchParams.get('people')).toBe('reviewRequested');
    const listed = current().items[0];
    expect(listed?.source === 'github' ? listed.reference.sourceRepo.owner : null).toBe('acme');
    expect(current().previewItem).toBeNull();
    expect(requests.some((url) => url.pathname.endsWith('/references/detail') && url.searchParams.get('owner') === 'acme')).toBe(false);
    await until(() => current().pullStatusOf(pull(2)).status === 'ready');
    expect(current().pullStatusOf(pull(1))).toMatchObject({ status: 'ready', value: { checks: { state: 'success', total: 2 } } });
    expect(requests.filter((url) => url.pathname.endsWith('/references/status')).map((url) => url.searchParams.get('pulls'))).toEqual(['acme/app#1,acme/app#2']);
    expect(boardBrowser().pullStatusOf(pull(2, 'upstream')).status).toBe('idle');

    await act(async () => boardBrowser().selectGitHubFilter({ state: 'open', people: 'created' }));
    expect(current().githubFilter).toEqual({ state: 'open', people: 'reviewRequested' });
    failNextPage = true;
    await act(async () => current().list.loadMore());
    await until(() => Boolean(current().list.error));
    expect(numbers()).toEqual([1, 2]);
    failNextPage = false;
    await act(async () => current().list.loadMore());
    await until(() => current().list.items.length === 3);
    expect(current().list.hasMore).toBe(false);

    failRefresh = true;
    await act(async () => { await current().list.retry(); });
    expect(current().list.status).toBe('ready');
    expect(current().list.items).toHaveLength(3);
    expect(current().list.error).toContain('fixture unavailable');
    failRefresh = false;

    const laterPageItem = current().items[2];
    if (!laterPageItem) throw new Error('Expected a PR from the second page');
    await act(async () => current().showItem(referencePickerItemKey(laterPageItem)));
    await act(async () => { await current().list.retry(); });
    expect(numbers()).toEqual([1, 2]);
    expect(current().previewItem).toEqual(laterPageItem);
    await act(async () => current().closeMobilePreview());

    const first = current().items[0];
    if (!first) throw new Error('Expected a listed PR');
    await act(async () => current().showItem(referencePickerItemKey(first)));
    await until(() => current().githubDetail.status === 'ready');
    const detailRequest = requests.find((url) => url.pathname.endsWith('/references/detail') && url.searchParams.get('owner') === 'acme' && url.searchParams.get('number') === '1');
    expect(detailRequest?.searchParams.get('owner')).toBe('acme');
    expect(detailRequest?.searchParams.get('number')).toBe('1');
    await act(async () => current().closeMobilePreview());
    expect(current().previewItem).toBeNull();

    const returned = { source: 'github' as const, reference: pull(500) };
    await act(async () => current().openItem(returned));
    expect(current().previewItem).toEqual(returned);
    expect(numbers()).not.toContain(500);
    await act(async () => current().closeMobilePreview());

    await act(async () => current().selectGitHubFilter({ state: 'closed', people: 'reviewRequested' }));
    await until(() => listRequests().some(url => url.searchParams.get('people') === 'reviewRequested'));
    expect(current().githubFilter).toEqual({ state: 'open', people: 'reviewRequested' });
    await act(async () => current().selectGitHubFilter({ people: 'created' }));
    await until(() => listRequests().some(url => url.searchParams.get('people') === 'created'));
    expect(current().githubFilter).toEqual({ state: 'open', people: 'created' });
    await act(async () => current().selectGitHubKind('issue'));
    expect(current().githubKind).toBe('pull');
    await render(false); await render(true);
    expect(current().githubFilter.people).toBe('created');
    await act(async () => current().selectGitHubFilter({ people: 'assigned', state: 'merged' }));
    expect(current().githubFilter).toEqual({ state: 'open', people: 'any' });
    expect(listRequests().every(url => url.searchParams.get('state') === 'open')).toBe(true);

    await act(async () => current().setQuery('terminal'));
    await until(() => current().list.items.some(item => 'number' in item && item.number === 92));
    expect(current().items).toEqual([]);
    expect(requests.filter(url => url.pathname.endsWith('/references/status')).some(url => /#9[23]/.test(url.searchParams.get('pulls') ?? ''))).toBe(false);

    await act(async () => current().setQuery('old'));
    await until(() => releaseOld !== undefined);
    await act(async () => current().setQuery('new'));
    await until(() => numbers()[0] === 91);
    await act(async () => releaseOld?.());
    expect(numbers()[0]).toBe(91);
    expect(current().list.total).toBe(1200);

    await render(false);
    const count = listRequests().length;
    await act(async () => { current().setQuery('hidden'); revalidateReferences(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(listRequests()).toHaveLength(count);
    await render(true);
    await until(() => listRequests().length > count);
    expect(current().query).toBe('hidden');

    await render(true, '/other-repo');
    await until(() => listRequests().some((url) => url.searchParams.get('directory') === '/other-repo'));
    expect(current().directory).toBe('/other-repo');
    oldServer = true;
    await render(true, '/older-server-repo');
    await until(() => current().list.status === 'error');
    expect(current().list.items).toHaveLength(0);
    expect(current().list.error).toContain('Restart OpenChamber');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.happyDOM.cancelAsync();
  }
});
