import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { Window } from 'happy-dom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { SettingsAPI } from '@/lib/api/types';
import type { NativeChecklistSnapshot, NativeTaskSnapshot } from '@/lib/native-agents/task-schemas';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { NativeChecklistState } from '../session-native-checklist';
import type { NativeTaskDetailState } from '../session-background-tasks';

// Runtime-switch listeners also probe host home/location. Keep those unrelated
// reads on a local transport fixture rather than attempting a network connection.
const hostFetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://routing.test').pathname;
  const body = path.endsWith('/fs/home') ? { home: '/fixture' }
    : path.endsWith('/location') ? { directory: '/repo', project: { id: 'fixture', directory: '/repo', canonical: '/repo' } }
    : { data: [], cursor: {} };
  return Response.json(body);
});
const testWindow = new Window({ url: 'http://routing.test' });
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: testWindow, document: testWindow.document, localStorage: testWindow.localStorage,
  location: testWindow.location, HTMLElement: testWindow.HTMLElement, CustomEvent: testWindow.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const container = document.createElement('div');
document.body.append(container);
const { useSessionNativeChecklist } = await import('../session-native-checklist');
const { useSessionNativeTaskDetails, applySessionBackgroundTasksEvent, useSessionBackgroundTasksStore } = await import('../session-background-tasks');
const { createEventRoutingIndex, handleEvent } = await import('../sync-context');
const { ChildStoreManager } = await import('../child-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');

const SESSION = 'ncl_routing';
const checklist = (revision: number): NativeChecklistSnapshot => ({
  state: 'ready', identity: 'list', source: 'files', revision, observedAt: revision, complete: true, unreadable: 0,
  items: [{ id: '1', subject: `Work ${revision}`, status: 'pending', blocks: [], blockedBy: [] }],
});
const tasks = (revision: number): NativeTaskSnapshot => ({ state: 'active', generation: 'query', revision, tasks: [], omitted: 0 });
let root: ReturnType<typeof createRoot>;
let checklistState: NativeChecklistState = { status: 'idle' };
let detailState: NativeTaskDetailState = { status: 'idle' };
let manager: InstanceType<typeof ChildStoreManager>;
let routing: ReturnType<typeof createEventRoutingIndex>;
function Probe() {
  checklistState = useSessionNativeChecklist(SESSION, '/far');
  detailState = useSessionNativeTaskDetails(SESSION, '/far');
  return null;
}

beforeEach(async () => {
  root = createRoot(container);
  manager = new ChildStoreManager();
  manager.ensureChild('/open', { bootstrap: false });
  routing = createEventRoutingIndex();
  useGlobalSessionsStore.getState().applySnapshot([{
    id: SESSION, directory: '/far', projectID: 'project', title: 'Native tasks', cost: 0,
    time: { created: 1, updated: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }], [], 'ready');
  const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
    capabilities: async () => ({ supported: true, registry: { reset: false }, backends: {
      claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } }, codex: { cli: true },
    } }),
    checklist: async () => checklist(1), sessionTasks: async () => tasks(1),
  }), { sidebarState: { supported: false, load: async () => null, mutate: async () => null } });
  Object.defineProperty(apis, 'settings', { value: {
    load: async () => ({ settings: {}, source: 'web' }),
    save: async () => ({}),
  } satisfies SettingsAPI });
  registerRuntimeAPIs(apis);
  await act(() => root.render(<RuntimeAPIContext.Provider value={apis}><Probe /></RuntimeAPIContext.Provider>));
});
afterEach(async () => {
  await act(() => root.unmount());
  manager.disposeAll();
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
});
afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  hostFetch.mockRestore();
  await testWindow.happyDOM.abort();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('native task event routing', () => {
  test('directory-less task events resolve the global record without bootstrapping its directory', async () => {
    await act(() => {
      handleEvent('global', { type: 'session.checklist.updated', properties: { sessionID: SESSION, snapshot: checklist(2) } }, manager, routing, getRuntimeKey());
      handleEvent('global', { type: 'session.tasks.updated', properties: { sessionID: SESSION, snapshot: tasks(2) } }, manager, routing, getRuntimeKey());
    });
    expect(checklistState).toMatchObject({ status: 'ready', snapshot: { revision: 2 } });
    expect(detailState).toMatchObject({ status: 'ready', snapshot: { revision: 2 } });
    expect(manager.getChild('/far')).toBeUndefined();
    expect(manager.getChild('/open')?.getState().session).toEqual([]);
  });

  test('idle preserves checklist/details; stale-runtime frames never replace them', async () => {
    await act(() => {
      handleEvent('/far', { type: 'session.idle', properties: { sessionID: SESSION } }, manager, routing, getRuntimeKey());
      handleEvent('/far', { type: 'session.checklist.updated', properties: { sessionID: SESSION, snapshot: checklist(30) } }, manager, routing, 'old-runtime');
      handleEvent('/far', { type: 'session.tasks.updated', properties: { sessionID: SESSION, snapshot: tasks(30) } }, manager, routing, 'old-runtime');
    });
    expect(checklistState).toMatchObject({ snapshot: { revision: 1 } });
    expect(detailState).toMatchObject({ snapshot: { revision: 1 } });
  });

  test('delete clears task owners before an unopened directory returns', async () => {
    applySessionBackgroundTasksEvent(SESSION, [{ id: 'run', type: 'local_bash', description: 'Work' }], getRuntimeKey());
    await act(() => handleEvent('global', { type: 'session.deleted', properties: { sessionID: SESSION } }, manager, routing, getRuntimeKey()));
    expect(checklistState).toEqual({ status: 'idle' });
    expect(detailState).toEqual({ status: 'idle' });
    expect(useSessionBackgroundTasksStore.getState().tasksBySession.has(SESSION)).toBe(false);
  });
});
