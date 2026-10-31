import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeAgentsAPI, NativeCapabilities } from '@/lib/api/types';
import type { NativeChecklistItem, NativeChecklistSnapshot } from '@/lib/native-agents/task-schemas';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { NativeChecklistState } from './session-native-checklist';

// Install the event target before the owner's runtime-lifecycle subscription.
const dom = installHookTestDom();
const {
  applySessionNativeChecklistEvent, clearSessionNativeChecklist, loadSessionNativeChecklist,
  refreshSessionNativeChecklists, useSessionNativeChecklist,
} = await import('./session-native-checklist');
const SESSION = 'ncl_checklist';
const OTHER = 'ncl_other';
const DIRECTORY = '/repo';
const capabilities: NativeCapabilities = {
  supported: true,
  backends: { claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } }, codex: { cli: true } },
  registry: { reset: false },
};
const item = (id: string, subject = id): NativeChecklistItem => ({ id, subject, status: 'pending', blocks: [], blockedBy: [] });
const snapshot = (revision: number, items = [item('1')], complete = true, identity = 'list-a'): NativeChecklistSnapshot => ({
  state: 'ready', identity, source: 'files', revision, observedAt: revision, complete, unreadable: complete ? 0 : 1, items,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
let root: ReturnType<typeof createRoot>;
let api: NativeAgentsAPI;
const states = new Map<string, NativeChecklistState>();
const publications = new Map<string, number>();
function Probe({ session = SESSION, directory = DIRECTORY, visible = false, enabled = true }: {
  session?: string; directory?: string; visible?: boolean; enabled?: boolean;
}) {
  const state = useSessionNativeChecklist(session, directory, { visible, enabled });
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
const event = (value: NativeChecklistSnapshot, session = SESSION, directory = DIRECTORY) => act(() => {
  applySessionNativeChecklistEvent(session, directory, value, getRuntimeKey());
});

beforeEach(() => {
  root = createRoot(dom.container);
  states.clear();
  publications.clear();
  api = createTestNativeAgentsAPI({ capabilities: async () => capabilities, checklist: async () => snapshot(1) });
});

for (const supported of [true, false]) test(`DeepSeek checklist capability controls reads: ${supported}`, async () => {
  const session = `ndh_${'b'.repeat(64)}`;
  const deepseek: NonNullable<NativeCapabilities['backends']['deepseek']> = { cli: true, blockedByEnterprise: false, actions: { revert: true, delete: true, fork: true } };
  if (supported) deepseek.tasks = { checklist: true };
  let calls = 0;
  api = createTestNativeAgentsAPI({
    capabilities: async () => ({ ...capabilities, backends: { ...capabilities.backends, deepseek } }),
    checklist: async () => { calls += 1; return { ...snapshot(1), source: 'history' }; },
  });
  await render(<Probe session={session} />);
  await pause();
  if (supported) expect(heldSnapshot(session).source).toBe('history');
  else expect(held(session).status).toBe('unsupported');
  expect(calls).toBe(supported ? 1 : 0);
});
afterEach(async () => {
  await act(() => root.unmount());
  switchRuntimeEndpoint({ apiBaseUrl: 'http://checklist.test', runtimeKey: 'checklist' });
  await pause();
});
afterAll(() => dom.restore());

describe('native checklist owner', () => {
  test('first load, partial merge, complete empty, failure and unavailable remain distinct', async () => {
    const first = deferred<NativeChecklistSnapshot>();
    api.checklist = () => first.promise;
    await render(<Probe />);
    expect(held()).toEqual({ status: 'loading', snapshot: null });
    await act(async () => first.resolve(snapshot(1, [item('1'), item('2')])));
    expect(held().status).toBe('ready');
    const unchanged = heldSnapshot().items[1];
    await event(snapshot(2, [item('1', 'Updated')], false));
    expect(held().status).toBe('partial');
    expect(heldSnapshot().items).toHaveLength(2);
    expect(heldSnapshot().items[1]).toBe(unchanged);

    api.checklist = async () => { throw new Error('Filesystem unavailable'); };
    await act(() => loadSessionNativeChecklist(SESSION, DIRECTORY));
    expect(held().status).toBe('stale');
    expect(heldSnapshot().items).toHaveLength(2);
    api.checklist = async () => snapshot(3, []);
    await act(() => loadSessionNativeChecklist(SESSION, DIRECTORY));
    expect(held()).toMatchObject({ status: 'ready', snapshot: { items: [], complete: true } });
    api.checklist = async () => ({ state: 'unavailable', reason: 'source_unknown' });
    await act(() => loadSessionNativeChecklist(SESSION, DIRECTORY));
    expect(held()).toEqual({ status: 'unavailable', reason: 'source_unknown' });
  });

  test('failure without a baseline is an error, not a ready empty list', async () => {
    api.checklist = async () => { throw new Error('Denied'); };
    await render(<Probe />);
    expect(held()).toMatchObject({ status: 'error', error: new Error('Denied') });
  });

  test('old-server capabilities and unsupported runtimes skip checklist requests', async () => {
    let reads = 0;
    api.checklist = async () => { reads += 1; return snapshot(1, []); };
    api.capabilities = async () => ({ ...capabilities, backends: { claude: { cli: true }, codex: { cli: true } } });
    await render(<Probe />);
    expect(held().status).toBe('unsupported');
    expect(reads).toBe(0);
    api = { ...api, supported: false, capabilities: async () => { throw new Error('Must skip runtime'); } };
    await render(<Probe session={OTHER} />);
    expect(held(OTHER).status).toBe('unsupported');
    expect(reads).toBe(0);
  });

  test('a newer event, including a repeated event, defeats an in-flight snapshot', async () => {
    await render(<Probe />);
    const answer = deferred<NativeChecklistSnapshot>();
    api.checklist = () => answer.promise;
    let read!: Promise<NativeChecklistState>;
    await act(() => { read = loadSessionNativeChecklist(SESSION, DIRECTORY); });
    await event(snapshot(2, [item('new')]));
    await act(async () => { answer.resolve(snapshot(1)); await read; });
    expect(heldSnapshot().items[0].id).toBe('new');
    const before = held();
    const renders = publications.get(SESSION);
    await event(snapshot(2, [item('new')]));
    expect(held()).toBe(before);
    expect(publications.get(SESSION)).toBe(renders);
    await event(snapshot(1, [], true));
    expect(held()).toBe(before);
  });

  test('partial snapshots never merge items from a previous list identity', async () => {
    await render(<Probe />);
    await event(snapshot(2, [item('other-list')], false, 'list-b'));
    expect(heldSnapshot().items.map((value) => value.id)).toEqual(['other-list']);
    await event(snapshot(1, [item('old')], true, 'list-a'));
    expect(heldSnapshot().identity).toBe('list-b');
  });

  test('known shared lists share refresh reads and receive each other’s events', async () => {
    await render(<><Probe /><Probe session={OTHER} /></>);
    let reads = 0;
    const answer = deferred<NativeChecklistSnapshot>();
    api.checklist = () => { reads += 1; return answer.promise; };
    let first!: Promise<NativeChecklistState>;
    let second!: Promise<NativeChecklistState>;
    await act(() => {
      first = loadSessionNativeChecklist(SESSION, DIRECTORY);
      second = loadSessionNativeChecklist(OTHER, DIRECTORY);
    });
    expect(reads).toBe(1);
    await act(async () => { answer.resolve(snapshot(2, [item('shared')])); await Promise.all([first, second]); });
    expect(heldSnapshot(OTHER).items[0].id).toBe('shared');
    // The publisher may address a third session without a mounted consumer.
    await event(snapshot(3, [item('from-child')]), 'ncl_unopened');
    expect(heldSnapshot().items[0].id).toBe('from-child');
    expect(heldSnapshot(OTHER).items[0].id).toBe('from-child');
  });

  test('deletion clears only the directory/session tuple and rejects late snapshots', async () => {
    await render(<><Probe /><Probe directory="/other" /></>);
    const answer = deferred<NativeChecklistSnapshot>();
    api.checklist = () => answer.promise;
    let read!: Promise<NativeChecklistState>;
    await act(() => { read = loadSessionNativeChecklist(SESSION, DIRECTORY); });
    await act(() => clearSessionNativeChecklist(SESSION, DIRECTORY, getRuntimeKey()));
    await act(async () => { answer.resolve(snapshot(20)); await read; });
    await event(snapshot(21));
    expect(held().status).toBe('idle');
    expect(held(SESSION, '/other').status).toBe('ready');
  });

  test('runtime switch away and back rejects the former runtime response', async () => {
    const requests: Array<ReturnType<typeof deferred<NativeChecklistSnapshot>>> = [];
    api.checklist = () => { const next = deferred<NativeChecklistSnapshot>(); requests.push(next); return next.promise; };
    await render(<Probe />);
    await act(() => switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: 'other' }));
    await act(() => switchRuntimeEndpoint({ apiBaseUrl: 'http://checklist.test', runtimeKey: 'checklist' }));
    expect(requests).toHaveLength(3);
    await act(async () => requests[2].resolve(snapshot(1, [item('current')])));
    await act(async () => { requests[0].resolve(snapshot(99, [item('old')])); requests[1].resolve(snapshot(99)); });
    expect(heldSnapshot().items[0].id).toBe('current');
  });

  test('reconnect accepts a restarted revision sequence and rejects the old in-flight read', async () => {
    api.checklist = async () => snapshot(50);
    await render(<Probe />);
    const old = deferred<NativeChecklistSnapshot>();
    api.checklist = () => old.promise;
    let pending!: Promise<NativeChecklistState>;
    await act(() => { pending = loadSessionNativeChecklist(SESSION, DIRECTORY); });
    api.checklist = async () => snapshot(1, [item('restarted')]);
    await act(() => refreshSessionNativeChecklists());
    expect(heldSnapshot().revision).toBe(1);
    await act(async () => { old.resolve(snapshot(100)); await pending; });
    expect(heldSnapshot().items[0].id).toBe('restarted');
  });

  test('disabled hooks read nothing; opening and reopening refresh immediately without multiplying consumers', async () => {
    let reads = 0;
    api.checklist = async () => { reads += 1; return snapshot(reads); };
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

  test('the last consumer releases its pending read and revisiting loads a fresh owner', async () => {
    const answer = deferred<NativeChecklistSnapshot>();
    let signal: AbortSignal | undefined;
    api.checklist = (_session, _directory, options) => { signal = options?.signal; return answer.promise; };
    await render(<Probe />);
    await render(null);
    await pause();
    expect(signal?.aborted).toBe(true);
    api.checklist = async () => snapshot(1, [item('revisit')]);
    await render(<Probe />);
    await act(async () => answer.resolve(snapshot(100, [item('late')])));
    expect(heldSnapshot().items[0].id).toBe('revisit');
  });

  for (const size of [100, 1_000]) test(`${size} checklist items preserve references on duplicates and unrelated list updates`, async () => {
    api.checklist = async (session) => snapshot(1, Array.from({ length: size }, (_, index) => item(String(index))), true, session);
    await render(<><Probe /><Probe session={OTHER} /></>);
    const before = held();
    const other = held(OTHER);
    await event(snapshot(1, Array.from({ length: size }, (_, index) => item(String(index))), true, SESSION));
    expect(held()).toBe(before);
    await event(snapshot(2, [item('added')], false, SESSION));
    expect(heldSnapshot().items).toHaveLength(size + 1);
    expect(held(OTHER)).toBe(other);
  });
});
