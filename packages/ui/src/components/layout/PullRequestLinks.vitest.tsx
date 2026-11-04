import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitHubPullReference, SourceControlAuthAccount } from '@/lib/api/types';
import type { NewSessionDraftState } from '@/sync/session-ui-store';

test('linked PRs preserve the workspace and normal pane while source accounts and late reads stay isolated', async () => {
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
  const external: string[] = [];
  Object.defineProperty(dom, 'open', { value: (url: string) => { external.push(url); return dom; } });
  let failLookup = true;
  let wrongRepository = true;
  let sourceAccount = 'github.com#8';
  let bindingRevision = 1;
  let releaseSlow: (() => void) | undefined;
  const takeSlowRead = () => {
    if (!releaseSlow) throw new Error('Missing deferred read');
    const release = releaseSlow;
    releaseSlow = undefined;
    return release;
  };
  const pull = (owner: string, number: number, account: string): GitHubPullReference => ({
    kind: 'pull', number, title: `${owner} PR ${number} via ${account}`, url: `https://github.com/${owner}/app/pull/${number}`,
    body: `Review ${owner} changes`, bodyTruncated: false, createdAt: null, updatedAt: null,
    author: null, labels: [], commentCount: 0, sourceRepo: { owner, repo: 'app', source: 'origin' },
    state: number === 77 ? 'merged' : 'open', draft: false, head: 'feature', base: 'main', headSha: 'a'.repeat(40), headRepo: null,
  });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    requests.push(url);
    const owner = url.searchParams.get('directory') === '/source' ? 'other' : 'acme';
    const accountId = owner === 'other' ? sourceAccount : 'github.com#7';
    const endpoint = { displayUrl: `https://github.com/${owner}/app`, fingerprint: `${owner}-origin` };
    if (url.pathname.endsWith('/location')) return Response.json({ directory: '/repo', project: { id: 'fixture', directory: '/repo', canonical: '/repo' } });
    if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (url.pathname === '/api/source-control/binding') return Response.json({ status: 'bound', revision: bindingRevision,
      repository: { supported: true, repositoryId: `${owner}-repo`, configRevision: 'rev', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] },
      binding: { repositoryId: `${owner}-repo`, configRevision: 'rev', revision: bindingRevision, state: 'bound',
        providers: [{ provider: 'github', instance: 'github.com', accountId, primaryRemote: 'origin', readiness: 'ready', endpoint }], remotes: [], auxiliary: [] },
    });
    if (url.pathname.endsWith('/references')) {
      const query = url.searchParams.get('query') ?? '';
      const number = query.startsWith('https://') ? Number(new URL(query).pathname.split('/')[4]) : 7;
      const requestedAccount = url.searchParams.get('accountId') ?? '';
      if (number === 405) return Response.json({ error: 'Automatic lookup failed' }, { status: 503 });
      if (number === 404 && failLookup) return Response.json({ error: 'Fixture read failed' }, { status: 503 });
      if (number === 90 || (number === 92 && requestedAccount === 'github.com#8')) await new Promise<void>(resolve => { releaseSlow = resolve; });
      return Response.json({ connected: true, scope: url.searchParams.get('scope') ?? 'network', repo: { owner, repo: 'app', url: endpoint.displayUrl },
        items: [pull(number === 99 && wrongRepository ? 'unrelated' : owner, number, requestedAccount)], cursor: null, hasMore: false, total: 1 });
    }
    if (url.pathname.endsWith('/references/status')) return Response.json({ connected: true, statuses: [] });
    if (url.pathname.endsWith('/references/detail')) return Response.json({ connected: true,
      detail: { number: Number(url.searchParams.get('number')), comments: [], commentTotal: 0, pull: null } });
    if (url.pathname.endsWith('/pr/review/pending')) return Response.json({ headSha: 'a'.repeat(40), open: true, ownPull: false, review: null });
    if (url.pathname.endsWith('/repo/upstream')) return Response.json({ connected: true, isFork: false, upstream: null });
    if (url.pathname.endsWith('/themes')) return Response.json({ themes: [] });
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
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { usePullRequestSelectionStore, pullRequestNavigationKey } = await import('@/stores/usePullRequestSelectionStore');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const { repositoryBindingOwner } = await import('@/lib/source-control/repository-binding');
  const { getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const { ContextSurfacePanes } = await import('./ContextSurfacePanes');
  const { setZoneBody } = await import('./zoneHosts');
  const { revalidateReferences } = await import('@/components/references/referenceCache');
  const { ChatPrLinkProbe } = await import('./__tests__/fixtures/ChatPrLinkProbe');
  const account = (id: number): SourceControlAuthAccount => ({ id: `github.com#${id}`, credentialId: `github.com#${id}`, credentialRevision: 1,
    providerUserId: `github.com#${id}`, providerUserStatus: 'available', user: { provider: 'github', instance: 'github.com', id: String(id), username: `account-${id}` },
    current: id === 7, source: 'oauth', status: 'valid' });
  const accounts = [account(7), account(8), account(9)];
  useSourceControlAuthStore.setState({ entries: { [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: { hasChecked: true, isLoading: false,
    status: { provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: accounts[0].user, accounts },
  } } });
  useDirectoryStore.setState({ currentDirectory: '/repo' });
  useProjectsStore.setState({ projects: [{ id: 'host', path: '/repo', addedAt: 1 }, { id: 'source', path: '/source', addedAt: 2 }], activeProjectId: 'host' });
  useSessionUIStore.setState({ currentSessionId: 'conversation-A', currentSessionDirectory: '/repo', newSessionDraft: { ...useSessionUIStore.getInitialState().newSessionDraft } });
  useUIStore.setState({ workspaceLayout: 'classic', contextPanelByDirectory: {}, contextSurfaceZones: {} });
  const base = createWebAPIs();
  const apis = { ...base, git: { ...base.git, checkIsGitRepository: async () => true,
    getGitStatus: async () => ({ current: 'feature', tracking: 'origin/feature', isClean: true, files: [], ahead: 0, behind: 0 }),
    getGitBranches: async () => ({ all: ['main', 'feature', 'remotes/origin/main'], branches: {}, current: 'feature', defaultBranches: { origin: 'main' } }),
  } };
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: globalThis.fetch });
  const left = document.createElement('div');
  const right = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(left, right, container);
  setZoneBody('left', left);
  setZoneBody('right', right);
  const root = createRoot(container);
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(predicate()).toBe(true);
  };
  const openLink = async (number: number, suffix = '', failureBehavior: 'manual' | 'automatic' = 'manual') => act(async () => {
    usePullRequestSelectionStore.getState().requestOpen({ workspaceDirectory: '/repo', sourceDirectory: '/source', url: `https://github.com/other/app/pull/${number}${suffix}`, failureBehavior });
    useUIStore.getState().openContextPanelTab('/repo', { mode: 'pr' });
  });
  const linked = () => document.querySelector<HTMLElement>('[data-linked-pull-request-url]');
  const fill = async (input: HTMLInputElement | HTMLTextAreaElement, text: string) => act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const goBack = async () => act(async () => linked()?.querySelector('button')?.click());
  const changesAndReturn = async (number: number) => {
    const changes = [...(linked()?.querySelectorAll('button') ?? [])].find(button => button.textContent?.trim() === 'Changes');
    if (!changes) throw new Error('Missing linked Changes action');
    await act(async () => changes.click());
    await until(() => Boolean(document.querySelector(`[aria-label="Back to PR #${number}"]`)));
    const back = document.querySelector<HTMLButtonElement>(`[aria-label="Back to PR #${number}"]`);
    if (!back) throw new Error('Missing linked PR return');
    await act(async () => back.click());
  };
  const initialRuntime = getRuntimeKey();
  try {
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><SyncProvider sdk={sdk} directory="/repo"><ThemeSystemProvider><I18nProvider><ChatPrLinkProbe directory="/repo" url="https://github.com/acme/app/pull/12/files#diff-1" /><ContextSurfacePanes /></I18nProvider></ThemeSystemProvider></SyncProvider></RuntimeAPIContext.Provider>));
    await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'pr' }));
    await until(() => Boolean(right.querySelector('[role="option"]')));
    const search = right.querySelector('input');
    if (!search) throw new Error('Missing normal PR search');
    await fill(search, 'retained search');
    await until(() => requests.some(url => url.searchParams.get('query') === 'retained search'));
    const normalRow = right.querySelector<HTMLElement>('[role="option"]');
    if (!normalRow) throw new Error('Missing normal PR row');
    await act(async () => normalRow.click());
    await until(() => Boolean(right.querySelector('textarea')));
    const originalReply = right.querySelector('textarea');
    if (!originalReply) throw new Error('Missing normal reply');
    await fill(originalReply, 'normal PR draft');

    // An already-visited source pane keeps its binding ready while another workspace hosts the link.
    await act(async () => {
      useDirectoryStore.setState({ currentDirectory: '/source' });
      useSessionUIStore.setState({ currentSessionId: 'conversation-B', currentSessionDirectory: '/source' });
      useUIStore.getState().openContextPanelTab('/source', { mode: 'pr' });
    });
    await until(() => Boolean(right.querySelector('[data-pull-request-directory="/source"] [role="option"]')));
    await act(async () => {
      useDirectoryStore.setState({ currentDirectory: '/repo' });
      useSessionUIStore.setState({ currentSessionId: 'conversation-A', currentSessionDirectory: '/repo' });
    });

    // A normal PR return must still win after another link preview opened over its Changes tab.
    const normalChanges = [...(right.querySelector('[data-pull-request-directory="/repo"]')?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent?.trim() === 'Changes');
    if (!normalChanges) throw new Error('Missing normal PR Changes');
    await act(async () => normalChanges.click());
    await until(() => Boolean(document.querySelector('[aria-label="Back to PR #7"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-chat-pr-link]')?.click());
    await until(() => Boolean(linked()?.querySelector('textarea')));
    await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'diff', diffScope: 'pr' }));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Back to PR #7"]')?.click());
    expect(linked()).toBeNull();
    expect(right.querySelector('textarea')).toBe(originalReply);
    expect(originalReply.value).toBe('normal PR draft');

    // Exercise the reported path through the actual chat entry, rather than the project PR list.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-chat-pr-link]')?.click());
    await until(() => Boolean(linked()?.querySelector('textarea')));
    const chatReply = linked()?.querySelector('textarea');
    if (!chatReply) throw new Error('Missing chat PR reply');
    await fill(chatReply, 'chat PR draft');
    const changes = [...(linked()?.querySelectorAll('button') ?? [])].find(button => button.textContent?.trim() === 'Changes');
    if (!changes) throw new Error('Missing linked PR Changes action');
    await act(async () => changes.click());
    await until(() => Boolean(document.querySelector('[aria-label="Back to PR #12"]')));
    const returnToChatPr = document.querySelector<HTMLButtonElement>('[aria-label="Back to PR #12"]');
    if (!returnToChatPr) throw new Error('Missing linked PR return action');
    await act(async () => returnToChatPr.click());
    await until(() => linked()?.querySelector('textarea') === chatReply);
    expect(chatReply.value).toBe('chat PR draft');
    expect(linked()?.textContent).toContain('acme PR 12');
    await goBack();

    await openLink(77, '/files?view=split#diff-1');
    await until(() => Boolean(linked()?.querySelector('textarea')));
    expect(linked()?.textContent).toContain('other PR 77 via github.com#8');
    expect(useDirectoryStore.getState().currentDirectory).toBe('/repo');
    expect(useSessionUIStore.getState().currentSessionId).toBe('conversation-A');
    expect(useProjectsStore.getState().activeProjectId).toBe('host');
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
    const sourceReads = requests.filter(url => url.pathname.includes('/references') && url.searchParams.get('directory') === '/source');
    expect(sourceReads.length).toBeGreaterThan(0);
    expect(sourceReads.every(url => url.searchParams.get('accountId') === 'github.com#8')).toBe(true);
    expect(usePullRequestSelectionStore.getState().openRequests.has(pullRequestNavigationKey(getRuntimeKey(), '/repo'))).toBe(false);
    const reply = linked()?.querySelector('textarea');
    if (!reply) throw new Error('Missing linked reply');
    await fill(reply, 'linked PR draft');
    const reading = linked()?.querySelector<HTMLElement>('.overlay-scrollbar-target');
    if (!reading) throw new Error('Missing linked detail scroll');
    await act(async () => { reading.scrollTop = 160; reading.dispatchEvent(new Event('scroll')); });
    await changesAndReturn(77);
    await until(() => useSessionUIStore.getState().currentSessionId === 'conversation-A');
    expect(useDirectoryStore.getState().currentDirectory).toBe('/repo');
    expect(useProjectsStore.getState().activeProjectId).toBe('host');
    expect(linked()?.querySelector('textarea')).toBe(reply);
    expect(reply.value).toBe('linked PR draft');
    expect(reading.scrollTop).toBe(160);

    const draft: NewSessionDraftState = { ...useSessionUIStore.getInitialState().newSessionDraft, draftId: 314, open: true,
      target: 'project', selectedProjectId: 'host', directoryOverride: '/repo', title: 'original draft', parentID: 'parent-session' };
    await act(async () => useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: draft }));
    await changesAndReturn(77);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
    expect(linked()?.querySelector('textarea')).toBe(reply);
    expect(reply.value).toBe('linked PR draft');
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'conversation-A', currentSessionDirectory: '/repo', newSessionDraft: { ...useSessionUIStore.getInitialState().newSessionDraft } }));
    await openLink(77);
    expect(linked()?.querySelector('textarea')).toBe(reply);
    expect(reply.value).toBe('linked PR draft');
    await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'notes' }));
    const beforeHidden = requests.length;
    await act(async () => { revalidateReferences(); window.dispatchEvent(new Event('focus')); });
    expect(requests.length).toBe(beforeHidden);
    await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'pr' }));
    expect(linked()?.querySelector('textarea')).toBe(reply);
    await act(async () => useUIStore.getState().moveContextSurfaceToZone('pr', 'left'));
    expect(left.contains(reply)).toBe(true);
    await goBack();
    expect(left.querySelector('textarea')).toBe(originalReply);
    expect(originalReply.value).toBe('normal PR draft');
    expect(left.querySelector('input')).toBe(search);
    expect(search.value).toBe('retained search');

    const branch = [...left.querySelectorAll('button')].find(button => button.textContent === 'Current branch');
    if (!branch) throw new Error('Missing branch tab');
    await act(async () => branch.click());
    await openLink(90);
    await until(() => Boolean(releaseSlow));
    const releaseOld = takeSlowRead();
    await openLink(91);
    await until(() => linked()?.textContent?.includes('other PR 91') === true);
    await act(async () => releaseOld());
    expect(linked()?.textContent).not.toContain('other PR 90');
    await goBack();
    expect(branch.getAttribute('aria-selected')).toBe('true');

    await openLink(99);
    await until(() => Boolean(linked()?.querySelector('[role="alert"]')));
    expect(linked()?.textContent).not.toContain('unrelated PR');
    wrongRepository = false;
    const retryWrong = [...(linked()?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Retry');
    if (!retryWrong) throw new Error('Missing retry for unmatched repository');
    await act(async () => retryWrong.click());
    await until(() => linked()?.textContent?.includes('other PR 99') === true);
    await openLink(404);
    await until(() => linked()?.textContent?.includes('Fixture read failed') === true);
    expect(external).toEqual([]);
    failLookup = false;
    const retry = [...(linked()?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing read retry');
    await act(async () => retry.click());
    await until(() => linked()?.textContent?.includes('other PR 404') === true);

    for (let i = 0; i < 2; i += 1) {
      await openLink(405, '', 'automatic');
      await until(() => external.length === i + 1);
      expect(linked()).toBeNull();
    }

    releaseSlow = undefined;
    await openLink(92);
    await until(() => Boolean(releaseSlow));
    const releaseOldAccount = takeSlowRead();
    sourceAccount = 'github.com#9';
    bindingRevision += 1;
    await act(async () => { await repositoryBindingOwner.reconcile(repositoryBindingOwner.scope('/source'), apis.sourceControl); });
    await until(() => linked()?.textContent?.includes('other PR 92 via github.com#9') === true);
    await act(async () => releaseOldAccount());
    expect(linked()?.textContent).not.toContain('github.com#8');

    await act(async () => {
      usePullRequestSelectionStore.getState().requestOpen({ workspaceDirectory: '/repo', sourceDirectory: '/source', url: 'https://github.com/other/app/pull/93', failureBehavior: 'manual' });
      switchRuntimeEndpoint({ apiBaseUrl: 'http://other-runtime', runtimeKey: 'other-runtime' });
      useGitStore.getState().resetForRuntimeSwitch('other-runtime');
      usePullRequestSelectionStore.getState().resetOpenRequests();
    });
    expect(linked()).toBeNull();
    expect(usePullRequestSelectionStore.getState().openRequests.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: initialRuntime });
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
