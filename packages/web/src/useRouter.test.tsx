// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@openchamber/ui/lib/opencode/model';

const memoryStorage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true });
Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true, writable: true });
vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));

const { useRouter } = await import('@openchamber/ui/hooks/useRouter');
const { navigateFromNotification } = await import('@openchamber/ui/lib/router/notificationNavigation');
const { useDirectoryStore } = await import('@openchamber/ui/stores/useDirectoryStore');
const { useGlobalSessionsStore } = await import('@openchamber/ui/stores/useGlobalSessionsStore');
const { useUIStore } = await import('@openchamber/ui/stores/useUIStore');
const { useSessionUIStore } = await import('@openchamber/ui/sync/session-ui-store');

type SessionsSnapshot = { activeSessions: Session[]; archivedSessions: Session[] };
const loadSessions = vi.fn<() => Promise<SessionsSnapshot>>();

let root: Root;
let host: HTMLDivElement;

function Router() {
  useRouter();
  return <div>Mounted app</div>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  window.history.replaceState({}, '', '/?session=ses_A');
  useDirectoryStore.setState({ currentDirectory: '/project' });
  useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'home' });
  useSessionUIStore.setState({
    currentSessionId: 'ses_A',
    currentSessionDirectory: '/project',
    getDirectoryForSession: () => '/project',
    setCurrentSession: (id: string | null, directory?: string | null) => {
      useSessionUIStore.setState({
        currentSessionId: id,
        currentSessionDirectory: directory ?? useSessionUIStore.getState().currentSessionDirectory,
      });
    },
  });
  loadSessions.mockReset().mockResolvedValue({ activeSessions: [], archivedSessions: [] });
  useGlobalSessionsStore.setState({
    hasLoaded: false,
    status: 'idle',
    activeSessions: [],
    archivedSessions: [],
    entityById: new Map(),
    loadSessions,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('notification navigation opens B through the session-link owner and keeps the document mounted', async () => {
  await act(async () => root.render(<Router />));
  const mounted = host.firstChild;
  const documentBefore = window.document;
  const assign = vi.spyOn(window.location, 'assign');
  const pushState = vi.spyOn(window.history, 'pushState');
  let finishLoad!: (snapshot: SessionsSnapshot) => void;
  loadSessions.mockImplementationOnce(() => {
    expect(window.location.search).toBe('?session=ses_B');
    return new Promise((resolve) => { finishLoad = resolve; });
  });

  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_B');
  expect(pushState).toHaveBeenCalledOnce();
  expect(navigateFromNotification('/?session=ses_C')).toBe(false);
  expect(window.location.search).toBe('?session=ses_B');

  await act(async () => finishLoad({
    activeSessions: [{
      id: 'ses_B',
      title: 'B',
      directory: '/other-project',
      projectID: 'proj',
      time: { created: 1, updated: 1 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }],
    archivedSessions: [],
  }));
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/other-project');
  expect(window.document).toBe(documentBefore);
  expect(host.firstChild).toBe(mounted);
  expect(assign).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  expect(navigateFromNotification('/?session=ses_C')).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_B');
  expect(pushState).toHaveBeenCalledOnce();
});

test('startup declines notification navigation until the initial route finishes', async () => {
  let finishLoad!: (snapshot: SessionsSnapshot) => void;
  loadSessions.mockImplementationOnce(() => new Promise<SessionsSnapshot>((resolve) => { finishLoad = resolve; }));
  await act(async () => root.render(<Router />));
  expect(navigateFromNotification('/?session=ses_B')).toBe(false);
  expect(window.location.search).toBe('?session=ses_A');
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_A');
  await act(async () => finishLoad({ activeSessions: [], archivedSessions: [] }));
  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  await act(async () => {});
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_B');
});

test('an accepted route failure releases the busy guard for the next click', async () => {
  await act(async () => root.render(<Router />));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const select = vi.spyOn(useSessionUIStore.getState(), 'setCurrentSession')
    .mockImplementationOnce(() => { throw new Error('selection failed'); });
  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  await act(async () => {});
  expect(log).toHaveBeenCalledWith('[PWA] notification navigation failed:', expect.any(Error));
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_A');
  select.mockRestore();
  expect(navigateFromNotification('/?session=ses_C')).toBe(true);
  await act(async () => {});
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_C');
});
