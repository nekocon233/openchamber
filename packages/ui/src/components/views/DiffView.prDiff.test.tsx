import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import type { GitStatus } from '@/lib/api/types';
import type {
  ChangeRequest, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext, SourceControlUser,
} from '@/lib/source-control/types';

const headSha = 'a'.repeat(40);
const endpoint = { displayUrl: 'https://github.com/team/project', fingerprint: 'fetch' };
const repository = { repositoryId: 'repo-1', configRevision: 'config', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] };
const BINDING = {
  repository, revision: 4,
  binding: { repositoryId: 'repo-1', configRevision: 'config', revision: 4, state: 'bound',
    providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin', readiness: 'ready', endpoint }],
    remotes: [], auxiliary: [] },
};
const CONTEXT: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', accountId: 'github.com#7', repositoryId: 'repo-1',
  bindingRevision: 4, directory: '/repo', primaryRemote: 'origin',
};
const USER: SourceControlUser = { provider: 'github', instance: 'github.com', id: '7', username: 'octocat' };
const CONNECTED: SourceControlAuthStatus = {
  provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: USER,
  accounts: [{
    id: CONTEXT.accountId, credentialId: CONTEXT.accountId, credentialRevision: 1, providerUserId: 'github.com#7',
    providerUserStatus: 'available', user: USER, current: true, source: 'oauth', status: 'valid',
  }],
};
const IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };
const PROJECT: Project = { ...IDENTITY, id: 'team/project', owner: 'team', name: 'project', url: 'https://github.com/team/project' };
const PR: ChangeRequest = {
  ...IDENTITY, id: 'team/project#17', number: 17, project: PROJECT, title: 'PR 17',
  url: 'https://github.com/team/project/pull/17', state: 'open', draft: false, base: 'main', head: 'feature-17', headSha,
};

const STATUS: GitStatus = { current: 'feature-17', tracking: null, ahead: 0, behind: 0, files: [], isClean: true };
const mergeRequestSchema = z.object({
  repositoryId: z.string(),
  bindingRevision: z.number(),
  primaryRemote: z.string(),
  method: z.string(),
  target: z.object({
    project: z.object({ owner: z.string(), name: z.string() }),
    number: z.number(),
    head: z.string(),
    base: z.string(),
    headSha: z.string(),
  }),
});
type MergeRequestBody = z.infer<typeof mergeRequestSchema>;

const verifyPullRequestDiff = async (servesDiff: boolean) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const mergePayloads: MergeRequestBody[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    paths.push(url.pathname);
    if (url.pathname === '/api/source-control/binding') return Response.json(BINDING);
    if (url.pathname === '/api/git/status') return Response.json(STATUS);
    if (url.pathname === '/api/git/projects') return Response.json({ projects: [{ directory: '/repo', isGitRepository: true, status: STATUS }] });
    if (url.pathname === '/api/source-control/github/pulls/list') {
      return Response.json({ items: [PR], page: 1, hasMore: false } satisfies PageResult<ChangeRequest>);
    }
    if (url.pathname.endsWith('/capabilities')) {
      return Response.json({ identity: IDENTITY, authentication: true, authenticationMethods: {}, multipleAccounts: true,
        projects: true, issues: true, changeRequests: true, draftChangeRequests: true, mergeChangeRequests: true,
        mergeMethods: ['merge', 'squash'], ci: true });
    }
    if (url.pathname.endsWith('/pr/merge')) {
      const body = mergeRequestSchema.parse(await new Response(init?.body).json());
      mergePayloads.push(body);
      return Response.json({
        status: 'succeeded',
        actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#7' },
        replayed: false,
        result: { merged: true },
        target: {
          repositoryId: body.repositoryId,
          bindingRevision: body.bindingRevision,
          primaryRemote: body.primaryRemote,
          project: { id: PROJECT.id, owner: PROJECT.owner, name: PROJECT.name },
          number: PR.number,
          head: PR.head,
          base: PR.base,
          headSha,
        },
      });
    }
    if (url.pathname.endsWith('/pr/review/state')) {
      return Response.json({ connected: true, viewerIsAuthor: false, headSha, draft: null, threads: [],
        viewerCommentedPaths: ['src/fixture.bin'], truncated: false });
    }
    if (url.pathname.endsWith('/pr/review/pending')) {
      return Response.json({ headSha, open: true, ownPull: false, review: null });
    }
    if (url.pathname.startsWith('/api/walkthrough/')) {
      if (servesDiff) {
        const patch = 'diff --git a/src/fixture.bin b/src/fixture.bin\nBinary files a/src/fixture.bin and b/src/fixture.bin differ\n';
        return Response.json({
          mode: 'files',
          headSha,
          files: [{ path: 'src/fixture.bin', status: 'M', insertions: 0, deletions: 0, patch }],
        });
      }
      return Response.json({ error: 'This source control provider does not offer change request walkthroughs', code: 'UNSUPPORTED_WALKTHROUGH_PROVIDER' }, { status: 422 });
    }
    // Git, status and the rest stay unanswered: the pull request scope does not wait on them.
    return new Promise<Response>(() => {});
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { OpenCode } = await import('@opencode/client');
  const { SyncProvider } = await import('@/sync/sync-context');
  // OpenCode stays unanswered: the walkthrough's pull request scope does not need it.
  const sdk = OpenCode.make({ baseUrl: 'http://walkthrough.test', fetch: () => new Promise<Response>(() => undefined) });
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  useSourceControlAuthStore.setState({
    entries: { [getSourceControlAuthKey(CONTEXT)]: { status: CONNECTED, isLoading: false, hasChecked: true } },
  });
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const github = githubLikeDescriptor();
  const descriptor = { ...github, features: { ...github.features, changeRequestPatch: servesDiff, reviewDrafts: servesDiff, referenceDetail: servesDiff } };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  // Opened on a pull request from the board, through the project's folder.
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  usePullRequestSelectionStore.getState().requestDiff('/repo', { kind: 'pr', number: 17, sourceRepo: { owner: 'team', repo: 'project' } });
  const { DiffView } = await import('./DiffView');
  const { useUIStore } = await import('@/stores/useUIStore');
  const originalFileListMode = useUIStore.getState().diffFileListMode;
  useUIStore.setState({ diffFileListMode: 'tree' });
  const container = document.createElement('div');
  const listHost = document.createElement('div');
  document.body.append(container, listHost);
  const root = createRoot(container);
  const apis = createWebAPIs();
  const render = (tool?: { isZoneOpen: boolean; visible: boolean }) => act(async () => {
    root.render(<SyncProvider sdk={sdk} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <DiffView directory="/repo" diffScope="pr" fileListHost={tool ? { host: listHost, ...tool, onSelect: () => {} } : undefined} />
    </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
  });
  try {
    await render(servesDiff ? { isZoneOpen: true, visible: true } : undefined);
    // The repository check is batched on a timer; let it and the reads after it land.
    for (let round = 0; round < 4; round += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    if (servesDiff) {
      expect(container.textContent).toContain('fixture.bin');
      const marked = [...listHost.querySelectorAll('[data-tree-disclosure-path]:has(button[aria-description="Your review comments"])')]
        .map((row) => row.getAttribute('data-tree-disclosure-path'));
      expect(marked).toEqual(['src', 'src/fixture.bin']);
      const editorDiff = container.querySelector('[data-diff-virtual-content]');
      expect(editorDiff).not.toBeNull();
      expect(container.querySelectorAll('[data-tree-disclosure-path]').length).toBe(0);
      await render({ isZoneOpen: true, visible: false });
      expect(container.querySelectorAll('[data-tree-disclosure-path]').length).toBe(0);
      expect(container.querySelectorAll('[data-diff-file-filter]').length).toBe(0);
      expect(container.querySelector('[data-diff-virtual-content]') === editorDiff).toBe(true);
      await render({ isZoneOpen: false, visible: false });
      expect(container.querySelector('[data-tree-disclosure-path="src/fixture.bin"]')).not.toBeNull();
      expect(container.querySelector('[data-diff-virtual-content]') === editorDiff).toBe(true);
      expect(container.querySelector('button[aria-label="Review"]')).not.toBeNull();
      expect(paths.filter((path) => /\/pr\/review\/(state|pending)$/.test(path))).toEqual(['/api/source-control/github/pr/review/state']);
      const squash = container.querySelector<HTMLButtonElement>('button[aria-label="Squash and merge"]');
      expect(squash).not.toBeNull();
      await act(async () => { squash?.click(); });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(paths).not.toContain('/api/source-control/github/references/detail');
      expect(paths).toContain('/api/source-control/github/pr/merge');
      expect(mergePayloads).toHaveLength(1);
      expect(mergePayloads[0]).toMatchObject({
        method: 'squash',
        target: { project: { owner: 'team', name: 'project' }, number: 17, head: 'feature-17', base: 'main', headSha },
      });
      return;
    }
    expect(container.textContent).toContain("GitHub doesn't serve pull request diffs");
    expect(container.textContent).not.toContain('does not offer change request walkthroughs');
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Retry');
    // The diff is not asked of the host.
    expect(paths.filter((path) => path.startsWith('/api/walkthrough/'))).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ diffFileListMode: originalFileListMode });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, value] of originals) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('a host without change-request diffs says so and offers no retry', () => verifyPullRequestDiff(false), 30_000);
test('PR Changes keeps the editor layout across tool switches and dispatches squash directly', () => verifyPullRequestDiff(true), 30_000);
