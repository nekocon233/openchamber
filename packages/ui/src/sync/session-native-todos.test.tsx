import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeAgentsAPI, NativeCapabilities } from '@/lib/api/types';
import type { NativeTodosSnapshot } from '@/lib/native-agents/task-schemas';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { NativeTodosState } from './session-native-todos';

// Install the event target before the owner's runtime-lifecycle subscription.
const dom = installHookTestDom();
const {
  applySessionNativeTodosEvent, clearSessionNativeTodos, useSessionNativeTodos,
} = await import('./session-native-todos');

const SESSION = 'ncx_todos';
const OTHER = 'ncx_other';
const CLAUDE = 'ncl_claude';
const DIRECTORY = '/repo';
const capabilities: NativeCapabilities = {
  supported: true,
  backends: { claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } }, codex: { cli: true, tasks: { plan: true, todos: true } } },
  registry: { reset: false },
};
type Todos = Extract<NativeTodosSnapshot, { state: 'unknown' | 'active' | 'inactive' }>;
const steps = (state: Todos['state'], revision: number, generation = 'query-1', todos: Todos['todos'] = [{ id: '1', content: 'Read notes', status: 'in_progress' }]): Todos => ({ state, generation, revision, todos });
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
let root: ReturnType<typeof createRoot>;
let api: NativeAgentsAPI;
const states = new Map<string, NativeTodosState>();

function Probe({ session = SESSION, directory = DIRECTORY, visible = false }: { session?: string; directory?: string; visible?: boolean }) {
  const state = useSessionNativeTodos(session, directory, { visible });
  states.set(`${directory}:${session}`, state);
  return null;
}
const render = async (children: React.ReactNode) => {
  const apis = createTestRuntimeAPIs(api);
  registerRuntimeAPIs(apis);
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}>{children}</RuntimeAPIContext.Provider>));
};
const held = (session = SESSION): NativeTodosState => {
  const state = states.get(`${DIRECTORY}:${session}`);
  if (!state) throw new Error('Probe not mounted');
  return state;
};
const heldSnapshot = (session = SESSION): Todos => {
  const state = held(session);
  if (!('snapshot' in state) || !state.snapshot) throw new Error('No snapshot held');
  return state.snapshot;
};
const event = (snapshot: Todos, session = SESSION) => act(() => {
  applySessionNativeTodosEvent(session, DIRECTORY, snapshot, getRuntimeKey());
});

beforeEach(() => {
  root = createRoot(dom.container);
  states.clear();
  api = createTestNativeAgentsAPI({ capabilities: async () => capabilities, codexTodos: async () => steps('unknown', 0, 'query-1', []) });
});
afterEach(async () => {
  await act(() => root.unmount());
  switchRuntimeEndpoint({ apiBaseUrl: 'http://todos.test', runtimeKey: 'todos' });
  await pause();
});
afterAll(() => dom.restore());

describe('native Codex todos owner', () => {
  test('a thread the process never reported steps for reads as unknown', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    expect(heldSnapshot().state).toBe('unknown');
  });

  test('a reported list arrives as an event and replaces the held one', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    await event(steps('active', 1));
    expect(heldSnapshot()).toMatchObject({ state: 'active', todos: [{ content: 'Read notes', status: 'in_progress' }] });

    await event(steps('active', 2, 'query-1', [{ id: '1', content: 'Read notes', status: 'completed' }]));
    expect(heldSnapshot()).toMatchObject({ revision: 2, todos: [{ status: 'completed' }] });
  });

  test('an older revision never overwrites a newer one', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    await event(steps('active', 4));
    await event(steps('active', 3, 'query-1', [{ id: '1', content: 'Stale', status: 'pending' }]));
    expect(heldSnapshot()).toMatchObject({ revision: 4, todos: [{ content: 'Read notes' }] });
  });

  test('a new observation owner replaces the old one even at a lower revision', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    await event(steps('active', 9, 'query-1'));
    await event(steps('active', 1, 'query-2', [{ id: '1', content: 'After restart', status: 'pending' }]));
    expect(heldSnapshot()).toMatchObject({ generation: 'query-2', todos: [{ content: 'After restart' }] });
  });

  test('an ended observation keeps the steps it last saw', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    await event(steps('active', 1));
    await event(steps('inactive', 2));
    expect(heldSnapshot()).toMatchObject({ state: 'inactive', todos: [{ content: 'Read notes' }] });
  });

  test('an event for a session nobody opened allocates nothing', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    await event(steps('active', 1), OTHER);
    expect(states.has(`${DIRECTORY}:${OTHER}`)).toBe(false);
  });

  test('a Claude session reports unsupported without a request', async () => {
    let reads = 0;
    api = createTestNativeAgentsAPI({ capabilities: async () => capabilities, codexTodos: async () => { reads += 1; return steps('active', 1); } });
    await render(<Probe session={CLAUDE} visible />);
    await act(() => pause());
    expect(held(CLAUDE).status).toBe('unsupported');
    expect(reads).toBe(0);
  });

  test('clearing one session leaves another alone', async () => {
    await render(<><Probe visible /><Probe session={OTHER} visible /></>);
    await act(() => pause());
    await event(steps('active', 1), OTHER);
    await act(() => { clearSessionNativeTodos(SESSION, DIRECTORY, getRuntimeKey()); });
    await act(() => pause());
    expect(held(SESSION).status).toBe('idle');
    expect(heldSnapshot(OTHER)).toMatchObject({ state: 'active' });
  });
});
