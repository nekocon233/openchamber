import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeAgentsAPI, NativeCapabilities } from '@/lib/api/types';
import type { NativeExecutionTask, NativeTaskSnapshot } from '@/lib/native-agents/task-schemas';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { NativeTaskDetailState } from './session-background-tasks';

const dom = installHookTestDom();
const {
  applySessionBackgroundTasksEvent, applySessionNativeTaskDetailsEvent, clearSessionNativeTaskDetails,
  loadSessionNativeTaskDetails, refreshSessionNativeTaskDetails, useSessionBackgroundTasksStore, useSessionNativeTaskDetails,
} = await import('./session-background-tasks');
const SESSION = 'ncl_tasks';
const OTHER = 'ncl_other';
const DIRECTORY = '/repo';
const capabilities: NativeCapabilities = {
  supported: true,
  backends: { claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } }, codex: { cli: true } },
  registry: { reset: false },
};
const task = (id: string, overrides: Partial<NativeExecutionTask> = {}): NativeExecutionTask => ({
  id, type: 'local_bash', description: id, active: true, ambient: false, status: 'running', canStop: true, outputAvailable: false, ...overrides,
});
const snapshot = (revision: number, tasks = [task('1')], generation = 'query-a'): NativeTaskSnapshot => ({
  state: 'active', generation, revision, tasks, omitted: 0,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
let root: ReturnType<typeof createRoot>;
let api: NativeAgentsAPI;
const states = new Map<string, NativeTaskDetailState>();
const publications = new Map<string, number>();
function Probe({ session = SESSION, directory = DIRECTORY, visible = false, enabled = true }: {
  session?: string; directory?: string; visible?: boolean; enabled?: boolean;
}) {
  const state = useSessionNativeTaskDetails(session, directory, { visible, enabled });
  states.set(`${directory}:${session}`, state);
  publications.set(session, (publications.get(session) ?? 0) + 1);
  return null;
}
const render = async (children: React.ReactNode) => {
  const apis = createTestRuntimeAPIs(api);
  registerRuntimeAPIs(apis);
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}>{children}</RuntimeAPIContext.Provider>));
};
const held = (session = SESSION, directory = DIRECTORY) => {
  const state = states.get(`${directory}:${session}`);
  if (!state) throw new Error('Probe not mounted');
  return state;
};
const heldSnapshot = (session = SESSION, directory = DIRECTORY) => {
  const state = held(session, directory);
  if (!('snapshot' in state) || !state.snapshot) throw new Error('No snapshot');
  return state.snapshot;
};
const event = (value: NativeTaskSnapshot, session = SESSION, directory = DIRECTORY) => act(() => {
  applySessionNativeTaskDetailsEvent(session, directory, value, getRuntimeKey());
});

beforeEach(() => {
  root = createRoot(dom.container);
  states.clear();
  publications.clear();
  api = createTestNativeAgentsAPI({ capabilities: async () => capabilities, sessionTasks: async () => snapshot(1) });
});
afterEach(async () => {
  await act(() => root.unmount());
  switchRuntimeEndpoint({ apiBaseUrl: 'http://native-task.test', runtimeKey: 'tasks' });
  await pause();
});
afterAll(() => dom.restore());

describe('native task detail owner', () => {
  test('saved Antigravity tasks refresh from events without scheduling idle polls or claiming activity', async () => {
    const session = 'nag_saved-tasks';
    const saved: NativeTaskSnapshot = {
      state: 'history', generation: 'agy-history:fixture', revision: 1, omitted: 0,
      tasks: [{ id: 'native/task-2', type: 'bash', description: 'Saved command', active: false, ambient: false, status: 'unknown', canStop: false, outputAvailable: false }],
    };
    api.capabilities = async () => ({ ...capabilities, backends: { ...capabilities.backends, antigravity: { cli: true, tasks: { background: true, output: true, stop: false } } } });
    let reads = 0;
    api.sessionTasks = async () => { reads += 1; return saved; };
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      await render(<Probe session={session} visible />);
      expect(reads).toBe(1);
      expect(heldSnapshot(session).state).toBe('history');
      expect(timers.mock.calls.filter((call) => call[1] === 45_000)).toHaveLength(0);
      await event({ ...saved, revision: 2, tasks: saved.tasks.map((task) => ({ ...task, status: 'completed' })) }, session);
      expect(heldSnapshot(session).tasks[0].status).toBe('completed');
      expect(useSessionBackgroundTasksStore.getState().tasksBySession.has(session)).toBe(false);
    } finally { timers.mockRestore(); }
  });

  test('initial loading, unknown membership, successful empty, failure and inactive remain distinct', async () => {
    const first = deferred<NativeTaskSnapshot>();
    api.sessionTasks = () => first.promise;
    await render(<Probe />);
    expect(held()).toEqual({ status: 'loading', snapshot: null });
    await act(async () => first.resolve({ state: 'unknown', generation: 'query-a', revision: 0, tasks: [], omitted: 0 }));
    expect(held()).toMatchObject({ status: 'ready', snapshot: { state: 'unknown' } });
    await event(snapshot(1, []));
    expect(held()).toMatchObject({ status: 'ready', snapshot: { state: 'active', tasks: [] } });
    await event(snapshot(2));
    api.sessionTasks = async () => { throw new Error('Offline'); };
    await act(() => loadSessionNativeTaskDetails(SESSION, DIRECTORY));
    expect(held().status).toBe('stale');
    expect(heldSnapshot().tasks).toHaveLength(1);
    await event({ state: 'inactive', generation: null, revision: 3, tasks: [], omitted: 0 });
    expect(held()).toMatchObject({ status: 'ready', snapshot: { state: 'inactive', tasks: [] } });
    await event(snapshot(2));
    expect(heldSnapshot().state).toBe('inactive');
  });

  test('detail and terminal/ambient records cannot change authoritative active membership', async () => {
    const active = [{ id: 'running', type: 'local_bash', description: 'Running' }];
    applySessionBackgroundTasksEvent(SESSION, active, getRuntimeKey());
    await render(<Probe />);
    const before = useSessionBackgroundTasksStore.getState().tasksBySession;
    await event(snapshot(2, [task('done', { active: false, status: 'completed', canStop: false }), task('watcher', { ambient: true })]));
    expect(useSessionBackgroundTasksStore.getState().tasksBySession).toBe(before);
    applySessionBackgroundTasksEvent(SESSION, [], getRuntimeKey());
    expect(useSessionBackgroundTasksStore.getState().tasksBySession.has(SESSION)).toBe(false);
    expect(heldSnapshot().tasks).toHaveLength(2);
  });

  test('old-server missing tasks capability and unsupported runtime issue no task reads', async () => {
    let reads = 0;
    api.sessionTasks = async () => { reads += 1; return snapshot(1, []); };
    api.capabilities = async () => ({ ...capabilities, backends: { claude: { cli: true }, codex: { cli: true } } });
    await render(<Probe />);
    expect(held().status).toBe('unsupported');
    expect(reads).toBe(0);
    api = { ...api, supported: false, capabilities: async () => { throw new Error('Should skip'); } };
    await render(<Probe session={OTHER} />);
    expect(held(OTHER).status).toBe('unsupported');
    expect(reads).toBe(0);
  });

  test('failed initial read is not authoritative empty; overlapping callers share one request', async () => {
    api.sessionTasks = async () => { throw new Error('Failed'); };
    await render(<Probe />);
    expect(held()).toMatchObject({ status: 'error', error: new Error('Failed') });
    const answer = deferred<NativeTaskSnapshot>();
    let reads = 0;
    api.sessionTasks = () => { reads += 1; return answer.promise; };
    let one!: Promise<NativeTaskDetailState>;
    let two!: Promise<NativeTaskDetailState>;
    await act(() => { one = loadSessionNativeTaskDetails(SESSION, DIRECTORY); two = loadSessionNativeTaskDetails(SESSION, DIRECTORY); });
    expect(reads).toBe(1);
    await act(async () => { answer.resolve(snapshot(1, [])); await Promise.all([one, two]); });
    expect(held()).toMatchObject({ status: 'ready', snapshot: { tasks: [] } });
  });

  test('new generation event defeats an in-flight old generation snapshot and later old events', async () => {
    await render(<Probe />);
    const old = deferred<NativeTaskSnapshot>();
    api.sessionTasks = () => old.promise;
    let read!: Promise<NativeTaskDetailState>;
    await act(() => { read = loadSessionNativeTaskDetails(SESSION, DIRECTORY); });
    await event(snapshot(3, [task('2')], 'query-b'));
    await act(async () => { old.resolve(snapshot(2, [task('old')])); await read; });
    expect(heldSnapshot().generation).toBe('query-b');
    expect(heldSnapshot().tasks.map((value) => value.id)).toEqual(['2']);
    await event(snapshot(2));
    expect(heldSnapshot().generation).toBe('query-b');
  });

  test('a repeated event keeps both detail state and task references stable', async () => {
    await render(<Probe />);
    const before = held();
    const renders = publications.get(SESSION);
    await event(snapshot(1));
    expect(held()).toBe(before);
    expect(publications.get(SESSION)).toBe(renders);
    const records = heldSnapshot().tasks;
    await event(snapshot(2));
    expect(heldSnapshot().tasks).toBe(records);
  });

  test('deletion clears detail and active state without erasing another directory', async () => {
    await render(<><Probe /><Probe directory="/other" /></>);
    applySessionBackgroundTasksEvent(SESSION, [{ id: 'run', type: 'local_bash', description: 'Run' }], getRuntimeKey());
    const old = deferred<NativeTaskSnapshot>();
    let signal: AbortSignal | undefined;
    api.sessionTasks = (_session, _directory, options) => { signal = options?.signal; return old.promise; };
    let read!: Promise<NativeTaskDetailState>;
    await act(() => { read = loadSessionNativeTaskDetails(SESSION, DIRECTORY); });
    await act(() => clearSessionNativeTaskDetails(SESSION, DIRECTORY, getRuntimeKey()));
    expect(signal?.aborted).toBe(true);
    await act(async () => { old.resolve(snapshot(10)); await read; });
    await event(snapshot(11));
    expect(held().status).toBe('idle');
    expect(held(SESSION, '/other').status).toBe('ready');
    expect(useSessionBackgroundTasksStore.getState().tasksBySession.has(SESSION)).toBe(false);
  });

  test('runtime switch away/back discards former runtime state and its late completions', async () => {
    const requests: Array<ReturnType<typeof deferred<NativeTaskSnapshot>>> = [];
    api.sessionTasks = () => { const answer = deferred<NativeTaskSnapshot>(); requests.push(answer); return answer.promise; };
    await render(<Probe />);
    await act(() => switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: 'other' }));
    await act(() => switchRuntimeEndpoint({ apiBaseUrl: 'http://native-task.test', runtimeKey: 'tasks' }));
    expect(requests).toHaveLength(3);
    await act(async () => requests[2].resolve(snapshot(1, [task('new')], 'new-query')));
    await act(async () => { requests[0].resolve(snapshot(100)); requests[1].resolve(snapshot(200)); });
    expect(heldSnapshot().generation).toBe('new-query');
  });

  test('server restart resets revision authority and aborts the pre-reconnect read', async () => {
    api.sessionTasks = async () => snapshot(50);
    await render(<Probe />);
    const old = deferred<NativeTaskSnapshot>();
    let signal: AbortSignal | undefined;
    api.sessionTasks = (_session, _directory, options) => { signal = options?.signal; return old.promise; };
    let read!: Promise<NativeTaskDetailState>;
    await act(() => { read = loadSessionNativeTaskDetails(SESSION, DIRECTORY); });
    api.sessionTasks = async () => snapshot(1, [task('new')], 'restarted');
    await act(() => refreshSessionNativeTaskDetails());
    expect(signal?.aborted).toBe(true);
    expect(heldSnapshot().revision).toBe(1);
    await act(async () => { old.resolve(snapshot(100)); await read; });
    expect(heldSnapshot().generation).toBe('restarted');
  });

  test('only visible consumers schedule refresh and opening a ready summary reads immediately', async () => {
    let reads = 0;
    api.sessionTasks = async () => snapshot(++reads);
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      await render(<Probe enabled={false} />);
      expect(reads).toBe(0);
      await render(<Probe />);
      expect(reads).toBe(1);
      expect(timers.mock.calls.filter((call) => call[1] === 45_000)).toHaveLength(0);
      await render(<><Probe visible /><Probe visible /></>);
      expect(reads).toBe(2);
      await render(<Probe />);
      await render(<Probe visible />);
      expect(reads).toBe(3);
    } finally { timers.mockRestore(); }
  });

  test('last consumer releases pending read; orphan events cannot repopulate its cache', async () => {
    const old = deferred<NativeTaskSnapshot>();
    let signal: AbortSignal | undefined;
    api.sessionTasks = (_session, _directory, options) => { signal = options?.signal; return old.promise; };
    await render(<Probe />);
    await render(null);
    await pause();
    expect(signal?.aborted).toBe(true);
    await event(snapshot(100));
    api.sessionTasks = async () => snapshot(1, [task('current')]);
    await render(<Probe />);
    await act(async () => old.resolve(snapshot(200)));
    expect(heldSnapshot().tasks[0].id).toBe('current');
  });

  for (const size of [20, 100]) test(`${size} task details keep unrelated subscribers stable`, async () => {
    api.sessionTasks = async () => snapshot(1, Array.from({ length: size }, (_, index) => task(String(index))));
    await render(<><Probe /><Probe session={OTHER} /></>);
    const before = held();
    const unrelated = held(OTHER);
    await event(snapshot(1, Array.from({ length: size }, (_, index) => task(String(index)))));
    expect(held()).toBe(before);
    await event(snapshot(2, [task('next')], 'next-query'));
    expect(held(OTHER)).toBe(unrelated);
    expect(heldSnapshot().tasks).toHaveLength(1);
  });
});
