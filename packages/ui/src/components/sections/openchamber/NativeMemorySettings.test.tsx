import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/home/test' });
  if (url.pathname === '/api/config/settings') return Response.json({ homeDirectory: '/home/test' });
  throw new Error(`Unexpected request: ${url.pathname}`);
});
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createTestNativeAgentsAPI, createTestRuntimeAPIs } = await import('@/lib/native-agents/test-utils/runtime');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { NativeMemorySettings } = await import('./NativeMemorySettings');
import type { NativeMemoryStatus } from '@/lib/native-agents/memory-schemas';

const mounted: Array<() => void> = [];
afterEach(async () => {
  await act(async () => { for (const dispose of mounted.splice(0)) dispose(); });
  document.body.replaceChildren();
  fetchSpy.mockRestore();
});
const status = (summary: string): NativeMemoryStatus => ({
  enabled: true, canManage: true, sources: [],
  backends: [{ status: 'ok', backend: 'claude', installed: false, ready: false, reviewRequired: false, lastSeen: null }],
  progress: [{ backend: 'codex', sessionId: 'thread', projectId: 'b', summary, status: 'completed', observedAt: 1000, revision: 1 }],
});

test('does not let a stale project read replace the selected project handoff', async () => {
  useProjectsStore.setState({ projects: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], activeProjectId: 'a' });
  useUIStore.setState({ settingsProjectPath: null });
  let resolveFirst: (result: NativeMemoryStatus) => void = () => { throw new Error('First request not started'); };
  const native = createTestNativeAgentsAPI({ memoryStatus: async (directory) => directory === '/a'
    ? new Promise<NativeMemoryStatus>((resolve) => { resolveFirst = resolve; }) : status('Current project B') });
  const api = createTestRuntimeAPIs(native);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => root.unmount());
  await act(async () => root.render(<RuntimeAPIContext.Provider value={api}><I18nProvider><NativeMemorySettings refreshRevision={0} /></I18nProvider></RuntimeAPIContext.Provider>));
  await act(async () => { useProjectsStore.setState({ activeProjectId: 'b' }); });
  await act(async () => { resolveFirst(status('Stale project A')); });
  expect(container.textContent).toContain('Current project B');
  expect(container.textContent).not.toContain('Stale project A');
});
