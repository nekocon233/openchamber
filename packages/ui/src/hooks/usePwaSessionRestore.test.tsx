import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRouter } from './useRouter';

const session = (id: string): Session => ({
  id,
  projectID: 'project',
  directory: '/project',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
});

let dom: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Harness = ({ pwaSessionRestoreReady }: { pwaSessionRestoreReady?: boolean }) => {
  useRouter(pwaSessionRestoreReady === undefined ? undefined : { pwaSessionRestoreReady });
  return null;
};

beforeEach(() => {
  dom = new Window({ url: 'http://localhost/' });
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }] });
  useSessionUIStore.getState().setCurrentSession(null, '/project');
  useUIStore.setState({ isSettingsDialogOpen: false });
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test('installed PWA session handoff waits for pwaSessionRestoreReady and restores the shared session once ready', async () => {
  const shared = session('shared-pwa');
  useGlobalSessionsStore.setState({
    activeSessions: [session('previous'), shared],
    archivedSessions: [],
    entityById: new Map([[shared.id, shared]]),
    hasLoaded: true,
    status: 'ready',
  });

  const matchMediaSpy = spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query === '(display-mode: standalone)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  const originalFetch = globalThis.fetch;
  let selectionReads = 0;
  let selectionFetched!: () => void;
  const selectionReadDone = new Promise<void>((resolve) => { selectionFetched = resolve; });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/pwa/session-selection')) {
        selectionReads += 1;
        selectionFetched();
        return new Response(JSON.stringify({ sessionId: shared.id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
  });

  try {
    await act(async () => root.render(<Harness pwaSessionRestoreReady={false} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(selectionReads).toBe(0);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();

    await act(async () => root.render(<Harness pwaSessionRestoreReady={true} />));
    await act(async () => {
      await selectionReadDone;
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
    expect(selectionReads).toBe(1);
    expect(useSessionUIStore.getState().currentSessionId).toBe(shared.id);
    expect(window.location.search).toBe(`?session=${shared.id}&directory=%2Fproject`);
  } finally {
    matchMediaSpy.mockRestore();
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
  }
});
