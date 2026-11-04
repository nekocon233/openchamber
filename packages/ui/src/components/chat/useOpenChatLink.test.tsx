import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSurfaceMode } from './chatSurfaceContextValue';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent,
  CustomEvent: dom.CustomEvent, MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// Store bootstrap is unrelated to the click; pending transport keeps it out of this fixture.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { useOpenChatLink } = await import('./useOpenChatLink');
const { ChatSurfaceContext } = await import('./chatSurfaceContextValue');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { usePullRequestSelectionStore, pullRequestNavigationKey } = await import('@/stores/usePullRequestSelectionStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { useOpenOnBoard } = await import('@/components/sourceBoard/openOnBoard');
const { useWorkStatusNavigation } = await import('./work-status/useWorkStatusNavigation');
const { useSourceBoardStore } = await import('@/stores/useSourceBoardStore');
const { useLinearAuthStore } = await import('@/stores/useLinearAuthStore');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const apis = createWebAPIs();

const external: string[] = [];
Object.defineProperty(dom, 'open', { value: (url: string) => { external.push(url); return dom; } });
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  external.length = 0;
  Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
  Reflect.deleteProperty(dom, '__VSCODE_CONFIG__');
  useUIStore.setState({ isMobile: false, openTrackerLinksOnBoard: true, openLinksInBrowserPanel: false, isSourceBoardOpen: false, contextPanelByDirectory: {}, workspaceLayout: 'classic', contextSurfaceZones: {} });
  useDirectoryStore.setState({ currentDirectory: '/repo' });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...useSessionUIStore.getInitialState().newSessionDraft } });
  useProjectsStore.setState({ projects: [{ id: 'p1', path: '/repo', addedAt: 1 }], activeProjectId: 'p1' });
  usePullRequestSelectionStore.getState().resetOpenRequests();
  useSourceBoardStore.setState({ choices: {}, repositoryFocus: null, linearFocus: null });
  useLinearAuthStore.setState({ status: { connected: true } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function clickLink(url: string, directory = '/repo', surface: ChatSurfaceMode = 'default', entry: 'chat' | 'badge' | 'status' | 'status-without-url' = 'chat', modifiers: Pick<MouseEventInit, 'ctrlKey' | 'metaKey'> = {}) {
  function Probe() {
    const open = useOpenChatLink(directory);
    const openBadge = useOpenOnBoard();
    const status = useWorkStatusNavigation(directory);
    return <button onClick={(event) => {
      if (entry === 'badge') openBadge(url, directory, event);
      else if (entry === 'status' || entry === 'status-without-url') status.openChangeRequest({ provider: 'github', number: 12, repo: { owner: 'org', repo: 'repo' }, url: entry === 'status-without-url' ? null : url });
      else open(url);
    }}>Open</button>;
  }
  await act(async () => root.render(
    <I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <ChatSurfaceContext.Provider value={surface}><Probe /></ChatSurfaceContext.Provider>
    </RuntimeAPIContext.Provider></I18nProvider>,
  ));
  await act(async () => host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers })));
}

describe('chat tracker link destinations', () => {
  const urls = [
    'https://github.com/org/repo/pull/12',
    'https://github.com/org/repo/issues/13',
    'https://gitlab.com/group/repo/-/merge_requests/14',
    'https://linear.app/workspace/issue/PROJ-15/example',
  ];
  for (const openLinksInBrowserPanel of [false, true]) {
    test(`external tracker links skip both internal destinations with browser preference ${openLinksInBrowserPanel}`, async () => {
      useUIStore.setState({ openTrackerLinksOnBoard: false, openLinksInBrowserPanel });
      for (const url of urls) await clickLink(url);
      expect(external).toEqual(urls);
      expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
      expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
      expect(useSourceBoardStore.getState().repositoryFocus).toBeNull();
      expect(useSourceBoardStore.getState().linearFocus).toBeNull();
    });

    test(`internal tracker links request manual failure handling with browser preference ${openLinksInBrowserPanel}`, async () => {
      useUIStore.setState({ openTrackerLinksOnBoard: true, openLinksInBrowserPanel });
      await clickLink(urls[0]);
      expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
      expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs).toMatchObject([{ mode: 'pr' }]);
      expect(usePullRequestSelectionStore.getState().openRequests.get(pullRequestNavigationKey(getRuntimeKey(), '/repo'))).toMatchObject({ sourceDirectory: '/repo', url: urls[0], failureBehavior: 'manual' });
      for (const url of urls.slice(1)) await clickLink(url);
      expect(external).toEqual([]);
      expect(useUIStore.getState().isSourceBoardOpen).toBe(true);
      expect(useSourceBoardStore.getState().repositoryFocus).toMatchObject({ projectId: 'p1', failureBehavior: 'manual', query: urls[2] });
      expect(useSourceBoardStore.getState().linearFocus).toMatchObject({ identifier: 'PROJ-15', url: urls[3], failureBehavior: 'manual' });
    });
  }

  test('badges and work status focus an existing PR pane without toggling it or the conversation', async () => {
    useUIStore.setState({ workspaceLayout: 'editor', contextSurfaceZones: { pr: 'bottom' }, isSourceBoardOpen: true });
    const session = useSessionUIStore.getState();
    const project = useProjectsStore.getState().activeProjectId;
    await clickLink(urls[0], '/repo', 'default', 'badge');
    const first = usePullRequestSelectionStore.getState().openRequests.get(pullRequestNavigationKey(getRuntimeKey(), '/repo'));
    await clickLink(urls[0], '/repo', 'default', 'status');
    const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
    expect(panel?.tabs.filter(tab => tab.mode === 'pr')).toHaveLength(1);
    expect(panel?.zones?.bottom?.isOpen).toBe(true);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
    expect(usePullRequestSelectionStore.getState().openRequests.get(pullRequestNavigationKey(getRuntimeKey(), '/repo'))).not.toBe(first);
    expect(useSessionUIStore.getState()).toBe(session);
    expect(useProjectsStore.getState().activeProjectId).toBe(project);
    expect(external).toEqual([]);
  });

  test('another project supplies the PR authority while the current workspace hosts its window', async () => {
    useProjectsStore.setState({ projects: [{ id: 'p1', path: '/repo', addedAt: 1 }, { id: 'p2', path: '/other', addedAt: 2 }] });
    await clickLink(urls[0], '/other', 'default', 'badge');
    expect(usePullRequestSelectionStore.getState().openRequests.get(pullRequestNavigationKey(getRuntimeKey(), '/repo'))).toMatchObject({ workspaceDirectory: '/repo', sourceDirectory: '/other' });
    expect(useUIStore.getState().contextPanelByDirectory['/other']).toBeUndefined();
    expect(useDirectoryStore.getState().currentDirectory).toBe('/repo');
    expect(useProjectsStore.getState().activeProjectId).toBe('p1');
  });

  test('a work-status row without a URL still names the PR by its authoritative repository and number', async () => {
    await clickLink(urls[0], '/repo', 'default', 'status-without-url');
    expect(usePullRequestSelectionStore.getState().openRequests.get(pullRequestNavigationKey(getRuntimeKey(), '/repo'))).toMatchObject({ url: urls[0], sourceDirectory: '/repo' });
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
  });

  test('modifier clicks on badges stay external and hosted mobile keeps the board', async () => {
    await clickLink(urls[0], '/repo', 'default', 'badge', { ctrlKey: true });
    expect(external).toEqual([urls[0]]);
    expect(usePullRequestSelectionStore.getState().openRequests.size).toBe(0);
    useUIStore.setState({ isMobile: true });
    await clickLink(urls[0]);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
    expect(usePullRequestSelectionStore.getState().openRequests.size).toBe(0);
  });

  test('an unavailable project reports the problem without automatically opening a browser', async () => {
    useUIStore.setState({ openLinksInBrowserPanel: true });
    await clickLink(urls[0], '/not-an-open-project');
    expect(external).toEqual([]);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
  });

  test('mini chat uses the external browser even with both internal preferences enabled', async () => {
    useUIStore.setState({ openLinksInBrowserPanel: true });
    await clickLink(urls[0], '/repo', 'mini-chat');
    expect(external).toEqual([urls[0]]);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
  });

  test('VS Code keeps PR links external', async () => {
    Object.defineProperty(dom, '__VSCODE_CONFIG__', { configurable: true, value: { workspaceFolder: '/repo' } });
    await clickLink(urls[0]);
    await clickLink(urls[0], '/repo', 'default', 'badge');
    expect(external).toEqual([urls[0], urls[0]]);
    expect(usePullRequestSelectionStore.getState().openRequests.size).toBe(0);
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
  });

  test('ordinary links retain the desktop browser preference', async () => {
    const url = 'https://example.com/help';
    useUIStore.setState({ openLinksInBrowserPanel: true });
    await clickLink(url);
    expect(external).toEqual([]);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs[0]?.targetPath).toBe(url);
    useUIStore.setState({ openLinksInBrowserPanel: false });
    await clickLink(url);
    expect(external).toEqual([url]);
  });
});
