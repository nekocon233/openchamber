import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSurfaceMode } from './chatSurfaceContextValue';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
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
  useUIStore.setState({ openTrackerLinksOnBoard: true, openLinksInBrowserPanel: false, isSourceBoardOpen: false, contextPanelByDirectory: {} });
  useProjectsStore.setState({ projects: [{ id: 'p1', path: '/repo', addedAt: 1 }] });
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

async function clickLink(url: string, directory = '/repo', surface: ChatSurfaceMode = 'default') {
  function Probe() {
    const open = useOpenChatLink(directory);
    return <button onClick={() => open(url)}>Open</button>;
  }
  await act(async () => root.render(
    <I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <ChatSurfaceContext.Provider value={surface}><Probe /></ChatSurfaceContext.Provider>
    </RuntimeAPIContext.Provider></I18nProvider>,
  ));
  await act(async () => host.querySelector('button')?.click());
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
      for (const url of urls) await clickLink(url);
      expect(external).toEqual([]);
      expect(useUIStore.getState().isSourceBoardOpen).toBe(true);
      expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
      expect(useSourceBoardStore.getState().repositoryFocus).toMatchObject({ projectId: 'p1', failureBehavior: 'manual', query: urls[2] });
      expect(useSourceBoardStore.getState().linearFocus).toMatchObject({ identifier: 'PROJ-15', url: urls[3], failureBehavior: 'manual' });
    });
  }

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
