import React, { act } from 'react';
import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
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

const PROJECT = {
  provider: 'github' as const,
  instance: 'github.com',
  id: 'acme/app',
  owner: 'acme',
  name: 'app',
  url: 'https://github.com/acme/app',
};

const makeRun = (id: string, status: string, conclusion: string | null, branch = 'main') => ({
  provider: 'github' as const,
  instance: 'github.com',
  id,
  runNumber: Number(id),
  runAttempt: 1,
  project: PROJECT,
  workflowName: 'CI',
  title: `Commit for ${id}`,
  commitMessage: `Commit for ${id}`,
  status,
  conclusion,
  event: 'push',
  headBranch: branch,
  headSha: 'a'.repeat(40),
  url: `https://github.com/acme/app/actions/runs/${id}`,
  actor: USER,
  startedAt: '2026-11-10T10:00:00Z',
  completedAt: status === 'completed' ? '2026-11-10T10:02:00Z' : undefined,
  pullRequests: [{ number: 12, url: 'https://github.com/acme/app/pull/12' }],
  jobSummary: {
    state: conclusion === 'failure' ? 'failure' as const : status !== 'completed' ? 'pending' as const : 'success' as const,
    total: 3,
    success: status !== 'completed' ? 1 : conclusion === 'failure' ? 2 : 3,
    failure: conclusion === 'failure' ? 1 : 0,
    pending: status !== 'completed' ? 2 : 0,
  },
});

const dom = new Window({ url: 'http://localhost' });
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

test('ProjectCiList queries CI runs, opens detail, views logs, attaches failed checks, and handles requestCiRun', async () => {
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/source-control/binding') {
      return Response.json({
        status: 'bound',
        revision: 1,
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
          revision: 1,
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
    if (url.pathname === '/api/source-control/github/ci/runs') {
      const status = url.searchParams.get('status');
      const items = status === 'failure'
        ? [makeRun('42', 'completed', 'failure')]
        : [makeRun('43', 'in_progress', null), makeRun('42', 'completed', 'failure')];
      return Response.json({ project: PROJECT, items, page: 1, hasMore: false });
    }
    if (url.pathname === '/api/source-control/github/ci/run') {
      const runId = url.searchParams.get('runId') ?? '42';
      return Response.json({
        identity: { provider: 'github', instance: 'github.com' },
        project: PROJECT,
        run: makeRun(runId, 'completed', 'failure'),
        ci: {
          summary: { state: 'failure', total: 2, success: 1, failure: 1, pending: 0 },
          runs: [
            {
              provider: 'github',
              instance: 'github.com',
              id: '801',
              name: 'lint',
              status: 'completed',
              conclusion: 'success',
              job: { runId, jobId: '801', name: 'lint', workflowName: 'CI', steps: [] },
            },
            {
              provider: 'github',
              instance: 'github.com',
              id: '802',
              name: 'unit-tests',
              status: 'completed',
              conclusion: 'failure',
              detailsUrl: 'https://github.com/acme/app/actions/runs/42/job/802',
              annotations: [{ path: 'src/index.ts', startLine: 19, level: 'failure', title: 'Test failed', message: 'Expected true' }],
              job: {
                runId,
                jobId: '802',
                name: 'unit-tests',
                workflowName: 'CI',
                steps: [{ name: 'Run bun test', status: 'completed', conclusion: 'failure', number: 3 }],
              },
            },
          ],
        },
      });
    }
    if (url.pathname === '/api/source-control/github/ci/job-log') {
      return Response.json({
        identity: { provider: 'github', instance: 'github.com' },
        jobId: url.searchParams.get('jobId') ?? '802',
        available: true,
        content: 'FAIL src/index.ts:19\nAssertionError: Expected true\n',
        truncated: true,
      });
    }
    if (url.pathname.endsWith('/location')) {
      return Response.json({ directory: '/repo', project: { id: 'fixture', directory: '/repo', canonical: '/repo' } });
    }
    if (url.pathname.endsWith('/session/active')) {
      return Response.json({});
    }
    return Response.json({ data: [] });
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
  const { I18nProvider } = await import('@/lib/i18n');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  const { ProjectCiList } = await import('./ProjectCiList');

  useSourceControlAuthStore.setState({
    entries: {
      [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: {
        status: CONNECTED,
        isLoading: false,
        hasChecked: true,
      },
    },
  });
  useDirectoryStore.setState({ currentDirectory: '/repo' });
  useSessionUIStore.setState({ currentSessionId: 'ses_test_ci', currentSessionDirectory: '/repo' });

  const apis = createWebAPIs();
  registerRuntimeAPIs(apis);

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const flush = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  };

  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={apis}>
        <I18nProvider>
          <ProjectCiList directory="/repo" workspaceDirectory="/repo" active />
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    );
  });
  await flush();

  expect(container.textContent).toContain('Commit for 43');
  expect(container.textContent).toContain('1/3 jobs');

  // Filter to Failed runs.
  const failedTab = [...container.querySelectorAll('button')].find((btn) => btn.textContent?.trim() === 'Failed');
  expect(failedTab).toBeTruthy();
  await act(async () => {
    failedTab?.click();
  });
  await flush();

  const option = container.querySelector<HTMLElement>('[role="option"]');
  expect(option?.textContent).toContain('Commit for 42');

  // Click into detail view.
  await act(async () => {
    option?.click();
  });
  await flush();

  // Failed job auto-expanded showing failed step and annotation.
  expect(container.textContent).toContain('unit-tests');
  expect(container.textContent).toContain('Expected true');
  expect(container.textContent).toContain('Run bun test');

  // Load job log on demand.
  const viewLogBtn = [...container.querySelectorAll('button')].find((btn) => btn.textContent?.includes('View log'));
  expect(viewLogBtn).toBeTruthy();
  await act(async () => {
    viewLogBtn?.click();
  });
  await flush();

  expect(container.textContent).toContain('FAIL src/index.ts:19');
  expect(container.textContent).toContain('128 KB');

  // Attach failed checks (including loaded log tail) to active session composer.
  const attachBtn = [...container.querySelectorAll('button')].find((btn) => btn.textContent?.includes('Attach failed checks'));
  expect(attachBtn).toBeTruthy();
  await act(async () => {
    attachBtn?.click();
  });
  const drafts = useInlineCommentDraftStore.getState().getDrafts({ directory: '/repo', sessionKey: 'ses_test_ci' });
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.source).toBe('pr-check');
  expect(drafts[0]?.code).toContain('FAIL src/index.ts:19');

  // Back to list restores the list view.
  const backBtn = [...container.querySelectorAll('button')].find((btn) => btn.textContent?.includes('Back to list'));
  expect(backBtn).toBeTruthy();
  await act(async () => {
    backBtn?.click();
  });
  await flush();
  expect(container.querySelector('[role="listbox"]')).toBeTruthy();

  // Direct navigation via requestCiRun opens the target run detail immediately.
  await act(async () => {
    usePullRequestSelectionStore.getState().requestCiRun('/repo', '/repo', '42');
  });
  await flush();
  expect(container.textContent).toContain('unit-tests');

  await act(async () => {
    root.unmount();
  });
  registerRuntimeAPIs(null);
});

test('ProjectCiList holds requestCiRun until cold repository binding finishes resolving', async () => {
  const bindingDeferred = { resolve: () => {} };
  const bindingGate = new Promise<void>((resolve) => {
    bindingDeferred.resolve = resolve;
  });

  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/git-dirs') {
      return Response.json({ repositories: [] });
    }
    if (url.pathname === '/api/git/check') {
      return Response.json({ isGitRepository: true });
    }
    if (url.pathname === '/api/source-control/binding') {
      await bindingGate;
      return Response.json({
        status: 'bound',
        revision: 1,
        repository: {
          supported: true,
          repositoryId: 'repo-cold',
          configRevision: 'rev',
          bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }],
        },
        binding: {
          repositoryId: 'repo-cold',
          configRevision: 'rev',
          revision: 1,
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
    if (url.pathname === '/api/source-control/github/ci/run') {
      return Response.json({
        identity: { provider: 'github', instance: 'github.com' },
        project: PROJECT,
        run: makeRun('77', 'completed', 'failure'),
        ci: {
          summary: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 },
          runs: [{
            provider: 'github',
            instance: 'github.com',
            id: '901',
            name: 'cold-target-job',
            status: 'completed',
            conclusion: 'failure',
            job: { runId: '77', jobId: '901', name: 'cold-target-job', workflowName: 'CI', steps: [] },
          }],
        },
      });
    }
    if (url.pathname === '/api/source-control/github/ci/runs') {
      return Response.json({ project: PROJECT, items: [], page: 1, hasMore: false });
    }
    return Response.json({});
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
  const { I18nProvider } = await import('@/lib/i18n');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  const { PullRequestView } = await import('@/components/views/PullRequestView');

  useSourceControlAuthStore.setState({
    entries: {
      [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: {
        status: CONNECTED,
        isLoading: false,
        hasChecked: true,
      },
    },
  });

  const apis = createWebAPIs();
  registerRuntimeAPIs(apis);

  usePullRequestSelectionStore.getState().requestCiRun('/repo-cold', '/repo-cold', '77');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={apis}>
        <I18nProvider>
          <PullRequestView directory="/repo-cold" visible />
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });

  // Release the cold binding read; the queued CI request must survive the remount and open run #77.
  bindingDeferred.resolve();
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(container.textContent).toContain('cold-target-job');

  await act(async () => {
    root.unmount();
  });
  container.remove();
  registerRuntimeAPIs(null);
});

test('useBranchLatestCiRun loads branch CI when no PR is open and stays idle when disabled', async () => {
  const seenUrls: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    seenUrls.push(`${url.pathname}?${url.searchParams.toString()}`);
    if (url.pathname === '/api/source-control/binding') {
      return Response.json({
        status: 'bound',
        revision: 1,
        repository: {
          supported: true,
          repositoryId: 'repo-branch',
          configRevision: 'rev',
          bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }],
        },
        binding: {
          repositoryId: 'repo-branch',
          configRevision: 'rev',
          revision: 1,
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
    if (url.pathname === '/api/source-control/github/ci/runs') {
      return Response.json({
        project: PROJECT,
        items: [makeRun('88', 'completed', 'success', 'feat/no-pr')],
        page: 1,
        hasMore: false,
      });
    }
    return Response.json({});
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const { useBranchLatestCiRun, useCiRunsStore } = await import('./ciRunsStore');

  useCiRunsStore.getState().resetForRuntimeSwitch();
  useSourceControlAuthStore.setState({
    entries: {
      [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: {
        status: CONNECTED,
        isLoading: false,
        hasChecked: true,
      },
    },
  });

  const apis = createWebAPIs();
  registerRuntimeAPIs(apis);

  const Probe: React.FC<{ enabled: boolean }> = ({ enabled }) => {
    const state = useBranchLatestCiRun('/repo-branch', 'feat/no-pr', enabled);
    return <div data-run={state.run ? `${state.run.workflowName}#${state.run.runNumber}:${state.run.jobSummary?.success}/${state.run.jobSummary?.total}` : 'none'} />;
  };

  const host = document.createElement('div');
  const root = createRoot(host);

  await act(async () => {
    root.render(<RuntimeAPIContext.Provider value={apis}><Probe enabled={false} /></RuntimeAPIContext.Provider>);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  expect(seenUrls.some((u) => u.startsWith('/api/source-control/github/ci/runs'))).toBe(false);

  await act(async () => {
    root.render(<RuntimeAPIContext.Provider value={apis}><Probe enabled /></RuntimeAPIContext.Provider>);
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(host.querySelector('[data-run]')?.getAttribute('data-run')).toBe('CI#88:3/3');

  await act(async () => {
    root.unmount();
  });
  registerRuntimeAPIs(null);
});
