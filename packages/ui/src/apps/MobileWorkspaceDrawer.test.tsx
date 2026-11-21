import React, { act } from 'react';
import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { DedicatedMobileAppProvider } from './mobileAppContext';
import type { MobileWorkspaceTab } from './MobileWorkspaceDrawer';
import type { SourceControlAuthStatus } from '@/lib/source-control/types';

const ACCOUNT_ID = 'github.com#7';
const ENDPOINT = { displayUrl: 'https://github.com/acme/app', fingerprint: 'origin-fetch' };
const USER = { provider: 'github' as const, instance: 'github.com', id: '7', username: 'octocat' };
const CONNECTED: SourceControlAuthStatus = {
  provider: 'github',
  instance: 'github.com',
  status: 'connected',
  connected: true,
  user: USER,
  accounts: [{
    id: ACCOUNT_ID,
    credentialId: ACCOUNT_ID,
    credentialRevision: 1,
    providerUserId: 'github.com#7',
    providerUserStatus: 'available',
    user: USER,
    current: true,
    source: 'oauth',
    status: 'valid',
  }],
};

const DISCONNECTED: SourceControlAuthStatus = {
  provider: 'github',
  instance: 'github.com',
  status: 'disconnected',
  connected: false,
  accounts: [],
};

const PROJECT = {
  provider: 'github' as const,
  instance: 'github.com',
  id: 'acme/app',
  owner: 'acme',
  name: 'app',
  url: 'https://github.com/acme/app',
};

const SYNC_SDK = OpenCode.make({
  baseUrl: 'http://opencode.test',
  fetch: async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://opencode.test');
    if (url.pathname.endsWith('/event')) {
      return new Promise<Response>(() => {});
    }
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  },
});

const dom = new Window({ url: 'http://localhost' });
dom.happyDOM.setWindowSize({ width: 390, height: 844 });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Node: dom.Node,
  customElements: dom.customElements,
  CSSStyleSheet: dom.CSSStyleSheet,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const originalFetch = globalThis.fetch;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('MobileWorkspaceDrawer exposes standalone PR and CI tabs, retains visited panes, and hands linked PRs back to PR tab', async () => {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (
      url.pathname === '/api/fs/home'
      || url.pathname === '/api/session-folders'
      || url.pathname.includes('native')
      || url.pathname.endsWith('/event')
    ) {
      return new Promise<Response>(() => {});
    }
    if (url.pathname === '/api/fs/git-dirs') {
      return Response.json({ repositories: [] });
    }
    if (url.pathname === '/api/source-control/binding') {
      const directory = url.searchParams.get('directory');
      if (directory === '/repo-unbound') {
        return Response.json({
          status: 'unbound',
          revision: 1,
          repository: {
            supported: true,
            repositoryId: 'repo-unbound',
            configRevision: 'rev',
            bare: false,
            remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }],
          },
          binding: null,
        });
      }
      return Response.json({
        status: 'bound',
        revision: 2,
        repository: {
          supported: true,
          repositoryId: 'repo',
          configRevision: 'rev',
          bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }],
        },
        binding: {
          repositoryId: 'repo',
          configRevision: 'rev',
          revision: 2,
          state: 'bound',
          providers: [{
            provider: 'github',
            instance: 'github.com',
            accountId: ACCOUNT_ID,
            primaryRemote: 'origin',
            readiness: 'ready',
            endpoint: ENDPOINT,
          }],
          remotes: [],
          auxiliary: [],
        },
      });
    }
    if (url.pathname === '/api/source-control/github/references') {
      return Response.json({
        connected: true,
        scope: 'repository',
        repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
        items: [{
          kind: 'pull',
          number: 12,
          title: 'Separate CI runs surface',
          url: 'https://github.com/acme/app/pull/12',
          body: 'PR body',
          bodyTruncated: false,
          state: 'open',
          draft: false,
          head: 'feat/ci',
          base: 'main',
          headSha: 'a'.repeat(40),
          headRepo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', cloneUrl: 'https://github.com/acme/app.git' },
          sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
          author: { login: 'octocat' },
          createdAt: '2026-11-10T09:00:00Z',
          updatedAt: '2026-11-10T10:00:00Z',
          labels: [],
          commentCount: 0,
        }],
        cursor: null,
        hasMore: false,
        total: 1,
      });
    }
    if (url.pathname === '/api/source-control/github/references/status') {
      return Response.json({ statuses: {} });
    }
    if (url.pathname === '/api/source-control/github/ci/runs') {
      return Response.json({
        project: PROJECT,
        items: [{
          provider: 'github',
          instance: 'github.com',
          id: '99',
          runNumber: 99,
          runAttempt: 1,
          project: PROJECT,
          workflowName: 'CI',
          title: 'Build and test',
          commitMessage: 'Build and test',
          status: 'completed',
          conclusion: 'failure',
          event: 'pull_request',
          headBranch: 'feat/ci',
          headSha: 'a'.repeat(40),
          url: 'https://github.com/acme/app/actions/runs/99',
          actor: USER,
          startedAt: '2026-11-10T10:00:00Z',
          completedAt: '2026-11-10T10:02:00Z',
          pullRequests: [{ number: 12, url: 'https://github.com/acme/app/pull/12' }],
          jobSummary: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 },
        }],
        page: 1,
        hasMore: false,
      });
    }
    if (url.pathname === '/api/source-control/github/ci/run') {
      return Response.json({
        identity: { provider: 'github', instance: 'github.com' },
        project: PROJECT,
        run: {
          provider: 'github',
          instance: 'github.com',
          id: '99',
          runNumber: 99,
          runAttempt: 1,
          project: PROJECT,
          workflowName: 'CI',
          title: 'Build and test',
          commitMessage: 'Build and test',
          status: 'completed',
          conclusion: 'failure',
          event: 'pull_request',
          headBranch: 'feat/ci',
          headSha: 'a'.repeat(40),
          url: 'https://github.com/acme/app/actions/runs/99',
          actor: USER,
          startedAt: '2026-11-10T10:00:00Z',
          completedAt: '2026-11-10T10:02:00Z',
          pullRequests: [{ number: 12, url: 'https://github.com/acme/app/pull/12' }],
          jobSummary: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 },
        },
        ci: {
          summary: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 },
          runs: [],
        },
      });
    }
    return Response.json({});
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { useGuestsStore } = await import('@/lib/guests/store');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { MobileWorkspaceDrawer } = await import('./MobileWorkspaceDrawer');

  const servedGitHub = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({
    ordered: [servedGitHub],
    byId: new Map([[servedGitHub.id, servedGitHub]]),
    status: 'ready',
    holdsList: true,
  });
  useGuestsStore.setState({ guests: [] });

  const seedRepo = (directory: string) => {
    useDirectoryStore.setState({ currentDirectory: directory });
    useGitStore.getState().setActiveDirectory(directory);
    const baseGitState = useGitStore.getState().getDirectoryState(directory);
    if (baseGitState) {
      const directories = new Map(useGitStore.getState().directories);
      directories.set(directory, {
        ...baseGitState,
        isGitRepo: true,
        status: { current: 'feat/ci', tracking: null, ahead: 0, behind: 0, files: [], isClean: true, diffStats: { staged: {}, working: {} } },
        lastStatusFetch: Date.now(),
      });
      useGitStore.setState({ directories });
    }
  };

  // Start disconnected: mobile workspace strip still keeps the CI tab and shows the connect notice inside the pane.
  seedRepo('/repo-unbound');
  useSourceControlAuthStore.setState({
    entries: {
      [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: {
        status: DISCONNECTED,
        isLoading: false,
        hasChecked: true,
      },
    },
  });

  const apis = createWebAPIs();
  registerRuntimeAPIs(apis);
  const openedTabs: MobileWorkspaceTab[] = [];
  let currentTab: MobileWorkspaceTab = 'ci';
  let activeDirectory = '/repo-unbound';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const renderDrawer = async () => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={SYNC_SDK} directory={activeDirectory}>
          <I18nProvider>
            <RuntimeAPIContext.Provider value={apis}>
              <DedicatedMobileAppProvider
                actions={{
                  openChanges: () => {},
                  openFiles: () => {},
                  openSourceBoard: () => {},
                  openWorkspaceTab: (next) => {
                    openedTabs.push(next);
                    currentTab = next;
                  },
                  openChangeRequest: () => {},
                  closeWorkStatusSheet: () => {}, openPlan: () => {}, openReceivedPage: () => {},
                }}
              >
                <MobileWorkspaceDrawer
                  open
                  onClose={() => {}}
                  tab={currentTab}
                  onTabChange={(next) => {
                    currentTab = next;
                  }}
                  pendingChangesDiff={null}
                  onOpenPlan={() => {}}
                  variant="panel"
                />
              </DedicatedMobileAppProvider>
            </RuntimeAPIContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
  };

  const flush = async (rounds = 6) => {
    for (let index = 0; index < rounds; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  };

  try {
    await renderDrawer();
    await flush();

    const workspaceTablist = container.querySelector('[role="tablist"]');
    const stripButtons = [...(workspaceTablist?.querySelectorAll('[role="tab"]') ?? [])];
    expect(stripButtons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim())).toEqual([
      'Git',
      'Pull Request',
      'CI runs',
      'Files',
      'Terminal',
      'Project knowledge',
    ]);
    expect(container.textContent).toContain('Connect a GitHub account in Settings to browse CI workflow runs.');

    // Connect GitHub and bind the repository, then verify PR and CI panes work independently and stay retained.
    await act(async () => {
      activeDirectory = '/repo';
      seedRepo('/repo');
      useSourceControlAuthStore.setState({
        entries: {
          [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: {
            status: CONNECTED,
            isLoading: false,
            hasChecked: true,
          },
        },
      });
    });
    currentTab = 'pr';
    await renderDrawer();
    await flush();

    expect(container.textContent).toContain('Mine');
    expect(container.textContent).toContain('All');
    expect(container.textContent).toContain('Separate CI runs surface');

    currentTab = 'ci';
    await renderDrawer();
    await flush();

    expect(container.textContent).toContain('All runs');
    expect(container.textContent).toContain('Build and test');
    // Visited PR pane remains mounted alongside CI (hidden while CI is active).
    expect(container.querySelector('[data-pull-request-directory="/repo"]')).not.toBeNull();
    expect(container.querySelector('[data-ci-runs-directory="/repo"]')).not.toBeNull();

    const runRow = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent?.includes('Build and test'));
    expect(runRow).toBeDefined();
    await act(async () => {
      runRow?.click();
    });
    await flush();

    const prBadge = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '#12');
    expect(prBadge).toBeDefined();
    await act(async () => {
      prBadge?.click();
    });
    expect(openedTabs).toEqual(['pr']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
