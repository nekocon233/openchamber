import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('PR windows retain independent project state across conversation, tool and zone switches', async () => {
  const dom = new Window({ url: 'http://localhost' });
  dom.document.write('<!doctype html><html><head></head><body></body></html>');
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    requests.push(url);
    const owner = url.searchParams.get('directory') === '/other-repo' ? 'other' : 'acme';
    const endpoint = { displayUrl: `https://github.com/${owner}/app`, fingerprint: `${owner}-origin` };
    if (url.pathname.endsWith('/location')) return Response.json({ directory: '/repo', project: { id: 'fixture', directory: '/repo', canonical: '/repo' } });
    if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (url.pathname === '/api/source-control/binding') return Response.json({ status: 'bound', revision: 1,
      repository: { supported: true, repositoryId: `${owner}-repo`, configRevision: 'rev', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] },
      binding: { repositoryId: `${owner}-repo`, configRevision: 'rev', revision: 1, state: 'bound', providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin', readiness: 'ready', endpoint }], remotes: [], auxiliary: [] },
    });
    if (url.pathname.endsWith('/references')) return Response.json({ connected: true, scope: 'repository', repo: { owner, repo: 'app', url: `https://github.com/${owner}/app` },
      items: [{ kind: 'pull', number: 7, title: `${owner} pull request`, url: `https://github.com/${owner}/app/pull/7`, body: `Review ${owner} changes`, bodyTruncated: false,
        createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0, sourceRepo: { owner, repo: 'app', source: 'origin' },
        state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'a'.repeat(40), headRepo: null }], cursor: null, hasMore: false, total: 1,
    });
    if (url.pathname.endsWith('/references/status')) return Response.json({ connected: true, statuses: [] });
    if (url.pathname.endsWith('/pr/review/pending')) return Response.json({ headSha: 'a'.repeat(40), open: true, ownPull: false, review: null });
    if (url.pathname.endsWith('/references/detail')) return Response.json({ connected: true, detail: { number: 7, comments: [], commentTotal: 0, pull: null } });
    if (url.pathname.endsWith('/repo/upstream')) return Response.json({ connected: true, isFork: false, upstream: null });
    if (url.pathname.endsWith('/themes')) return Response.json({ themes: [] });
    // Unrelated session bootstrap remains pending; this fixture exercises repository UI only.
    return new Promise<Response>(() => {});
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { OpenCode } = await import('@opencode/client');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const { ContextSurfacePanes } = await import('./ContextSurfacePanes');
  const { setZoneBody } = await import('./zoneHosts');
  const { revalidateReferences } = await import('@/components/references/referenceCache');
  const account = { provider: 'github' as const, instance: 'github.com', id: '7', username: 'octocat' };
  useSourceControlAuthStore.setState({ entries: { [getSourceControlAuthKey(account)]: { hasChecked: true, isLoading: false,
    status: { provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: account,
      accounts: [{ id: 'github.com#7', credentialId: 'github.com#7', credentialRevision: 1, providerUserId: 'github.com#7', providerUserStatus: 'available', user: account, current: true, source: 'oauth', status: 'valid' }] },
  } } });
  useDirectoryStore.setState({ currentDirectory: '/repo' });
  useUIStore.setState({ workspaceLayout: 'classic', contextPanelByDirectory: {}, contextSurfaceZones: {} });
  const base = createWebAPIs();
  const apis = { ...base, git: { ...base.git, checkIsGitRepository: async () => true } };
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: globalThis.fetch });
  const left = document.createElement('div');
  const right = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(left, right, container);
  setZoneBody('left', left);
  setZoneBody('right', right);
  const root = createRoot(container);
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(predicate()).toBe(true);
  };
  const open = async (mode: 'pr' | 'notes') => act(async () => { useUIStore.getState().openContextPanelTab('/repo', { mode }); });
  const referenceReads = () => requests.filter((url) => url.pathname.includes('/references')).length;
  const projectView = (directory: string) => right.querySelector<HTMLElement>(`[data-pull-request-directory="${directory}"]`);
  const switchConversation = async (directory: string) => act(async () => {
    useDirectoryStore.setState({ currentDirectory: directory });
    useSessionUIStore.getState().setCurrentSession(`conversation:${directory}`, directory);
  });
  const fill = async (input: HTMLInputElement | HTMLTextAreaElement, text: string) => act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  try {
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><SyncProvider sdk={sdk} directory="/repo"><ThemeSystemProvider><I18nProvider><ContextSurfacePanes /></I18nProvider></ThemeSystemProvider></SyncProvider></RuntimeAPIContext.Provider>));
    await open('pr');
    await until(() => right.querySelector('[role="option"]') !== null);
    expect(requests.find(url => url.pathname.endsWith('/references'))?.searchParams.get('people')).toBe('reviewRequested');
    const input = right.querySelector('input');
    if (!input) throw new Error('Missing PR search');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'retained query');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(() => requests.some((url) => url.searchParams.get('query') === 'retained query'));
    const row = right.querySelector<HTMLElement>('[role="option"]');
    if (!row) throw new Error('Missing PR row');
    await act(async () => row.click());
    await until(() => right.querySelector('textarea') !== null);
    const reply = right.querySelector('textarea');
    if (!reply) throw new Error('Missing reply box');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reply, 'unsent review');
      reply.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await open('notes');
    const hiddenReads = referenceReads();
    await act(async () => { revalidateReferences(); window.dispatchEvent(new Event('focus')); await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(referenceReads()).toBe(hiddenReads);
    expect(right.querySelector('textarea')).toBe(reply);
    await open('pr');
    await until(() => right.textContent?.includes('Back to list') === true);
    expect(right.querySelector('textarea')).toBe(reply);
    expect(reply.value).toBe('unsent review');
    expect(right.querySelector('input')).toBe(input);
    expect(input.value).toBe('retained query');

    await act(async () => { useUIStore.getState().closeContextZone('/repo', 'right'); });
    await open('pr');
    expect(right.querySelector('textarea')).toBe(reply);
    expect(reply.value).toBe('unsent review');

    await act(async () => { useUIStore.getState().moveContextSurfaceToZone('pr', 'left'); });
    expect(left.querySelector('textarea')).toBe(reply);
    expect(left.querySelector('input')).toBe(input);
    expect(right.querySelector('textarea')).toBeNull();
    await act(async () => { useUIStore.getState().moveContextSurfaceToZone('pr', 'right'); });
    expect(right.querySelector('textarea')).toBe(reply);

    const back = [...right.querySelectorAll('button')].find((button) => button.textContent?.includes('Back to list'));
    if (!back) throw new Error('Missing back action');
    await act(async () => back.click());
    const scroller = right.querySelector<HTMLElement>('.overlay-scrollbar-target');
    if (!scroller) throw new Error('Missing list scroll container');
    const retainedRow = right.querySelector<HTMLElement>('[role="option"]');
    if (!retainedRow) throw new Error('Missing retained list row');
    // Happy DOM has no layout: model the browser's scroll movement if the old highlight scrolls again.
    retainedRow.scrollIntoView = () => { scroller.scrollTop = 0; };
    await act(async () => { scroller.scrollTop = 240; scroller.dispatchEvent(new Event('scroll')); });
    await open('notes');
    await open('pr');
    expect(right.querySelector('.overlay-scrollbar-target')).toBe(scroller);
    expect(scroller.scrollTop).toBe(240);

    // A conversation in a project with no PR tab must not unload this project's window.
    await switchConversation('/other-repo');
    expect(projectView('/repo')?.querySelector('input')).toBe(input);
    expect(projectView('/other-repo')).toBeNull();
    await switchConversation('/repo');
    expect(projectView('/repo')?.querySelector('input')).toBe(input);
    expect(input.value).toBe('retained query');
    expect(scroller.scrollTop).toBe(240);

    await act(async () => retainedRow.click());
    await until(() => Boolean(projectView('/repo')?.querySelector('textarea')));
    const replyA = projectView('/repo')?.querySelector('textarea');
    if (!replyA) throw new Error('Missing first project reply');
    await fill(replyA, 'project A draft');
    const detailScrollerA = projectView('/repo')?.querySelector<HTMLElement>('.overlay-scrollbar-target');
    if (!detailScrollerA) throw new Error('Missing first project detail scroll');
    await act(async () => { detailScrollerA.scrollTop = 180; detailScrollerA.dispatchEvent(new Event('scroll')); });

    await switchConversation('/other-repo');
    // A browser can drop the DOM offset when an inactive pane moves to another host.
    await act(async () => { detailScrollerA.scrollTop = 0; detailScrollerA.dispatchEvent(new Event('scroll')); });
    const readsBeforeB = requests.filter((url) => url.pathname.includes('/references') && url.searchParams.get('directory') === '/repo').length;
    await act(async () => useUIStore.getState().openContextPanelTab('/other-repo', { mode: 'pr' }));
    await until(() => Boolean(projectView('/other-repo')?.querySelector('[role="option"]')));
    const inputB = projectView('/other-repo')?.querySelector('input');
    if (!inputB) throw new Error('Missing second project search');
    expect(inputB.value).toBe('');
    expect(projectView('/other-repo')?.textContent).toContain('other pull request');
    await fill(inputB, 'other project query');
    await until(() => requests.some((url) => url.searchParams.get('directory') === '/other-repo' && url.searchParams.get('query') === 'other project query'));
    const rowB = projectView('/other-repo')?.querySelector<HTMLElement>('[role="option"]');
    if (!rowB) throw new Error('Missing second project PR');
    await act(async () => rowB.click());
    await until(() => Boolean(projectView('/other-repo')?.querySelector('textarea')));
    const replyB = projectView('/other-repo')?.querySelector('textarea');
    if (!replyB) throw new Error('Missing second project reply');
    await fill(replyB, 'project B draft');
    await act(async () => { revalidateReferences(); window.dispatchEvent(new Event('focus')); await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(requests.filter((url) => url.pathname.includes('/references') && url.searchParams.get('directory') === '/repo')).toHaveLength(readsBeforeB);

    for (let i = 0; i < 3; i += 1) {
      await switchConversation('/repo');
      expect(projectView('/repo')?.querySelector('input')).toBe(input);
      expect(projectView('/repo')?.querySelector('textarea')).toBe(replyA);
      expect(input.value).toBe('retained query');
      expect(replyA.value).toBe('project A draft');
      expect(detailScrollerA.scrollTop).toBe(180);
      expect(projectView('/repo')?.textContent).toContain('acme pull request');
      await switchConversation('/other-repo');
      expect(projectView('/other-repo')?.querySelector('input')).toBe(inputB);
      expect(projectView('/other-repo')?.querySelector('textarea')).toBe(replyB);
      expect(inputB.value).toBe('other project query');
      expect(replyB.value).toBe('project B draft');
      expect(projectView('/other-repo')?.textContent).toContain('other pull request');
    }

    // Saved tabs never visited in this runtime do not eagerly read another repository.
    await act(async () => useUIStore.getState().openContextPanelTab('/unvisited', { mode: 'pr' }, { reveal: false }));
    expect(projectView('/unvisited')).toBeNull();
    expect(requests.some((url) => url.pathname.includes('/source-control/') && url.searchParams.get('directory') === '/unvisited')).toBe(false);

    const tabA = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.find((tab) => tab.mode === 'pr');
    if (!tabA) throw new Error('Missing first project tab');
    await act(async () => useUIStore.getState().closeContextPanelTab('/repo', tabA.id));
    expect(projectView('/repo')).toBeNull();
    expect(replyA.isConnected).toBe(false);
    expect(projectView('/other-repo')?.querySelector('textarea')).toBe(replyB);
    expect(replyB.value).toBe('project B draft');
  } finally {
    await act(async () => root.unmount());
    setZoneBody('left', null);
    setZoneBody('right', null);
    globalThis.fetch = originalFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
