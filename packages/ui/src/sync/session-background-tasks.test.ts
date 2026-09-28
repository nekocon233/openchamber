import { afterEach, describe, expect, test } from 'bun:test';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeBackgroundTaskSnapshot } from '@/lib/api/types';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import type { SessionBackgroundTask } from '@/lib/opencode/events';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import {
  applySessionBackgroundTasksEvent,
  applySessionBackgroundTasksSnapshot,
  seedSessionBackgroundTasksFromHost,
  useSessionBackgroundTasksStore,
} from './session-background-tasks';

const SESSION = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const OTHER = 'ncl_210333b7-a88c-45b7-8bec-6d63ec3a1188';
const WAIT: SessionBackgroundTask = { id: 'bwait', type: 'local_bash', description: 'Wait for the training job' };
const AGENT: SessionBackgroundTask = { id: 'a6f8a95b426077fd7', type: 'local_agent', description: 'Count lines in notes.txt' };

const tasksOf = (sessionId: string) => useSessionBackgroundTasksStore.getState().tasksBySession.get(sessionId);
const revision = () => useSessionBackgroundTasksStore.getState().revision;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
};

afterEach(() => {
  useSessionBackgroundTasksStore.setState({ tasksBySession: new Map(), eventRevisionBySession: new Map(), revision: 0 });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'default' });
});

describe('session background tasks', () => {
  test('an event replaces the session set, and an empty set removes it', () => {
    applySessionBackgroundTasksEvent(SESSION, [WAIT], getRuntimeKey());
    applySessionBackgroundTasksEvent(OTHER, [AGENT], getRuntimeKey());
    expect(tasksOf(SESSION)).toEqual([WAIT]);

    applySessionBackgroundTasksEvent(SESSION, [], getRuntimeKey());
    expect(tasksOf(SESSION)).toBeUndefined();
    expect(tasksOf(OTHER)).toEqual([AGENT]);
  });

  test('a repeated set keeps the held list, so rows do not re-render', () => {
    applySessionBackgroundTasksEvent(SESSION, [WAIT], getRuntimeKey());
    const held = tasksOf(SESSION);
    applySessionBackgroundTasksEvent(SESSION, [{ ...WAIT }], getRuntimeKey());
    expect(tasksOf(SESSION)).toBe(held);
  });

  test('an event from another runtime is ignored', () => {
    applySessionBackgroundTasksEvent(SESSION, [WAIT], 'another-runtime');
    expect(tasksOf(SESSION)).toBeUndefined();
  });

  test('a snapshot replaces every held set', () => {
    applySessionBackgroundTasksEvent(SESSION, [WAIT], getRuntimeKey());
    const baseline = revision();
    applySessionBackgroundTasksSnapshot({ [OTHER]: { tasks: [AGENT] } }, baseline);
    expect(tasksOf(SESSION)).toBeUndefined();
    expect(tasksOf(OTHER)).toEqual([AGENT]);
  });

  test('a snapshot read before an event keeps what the event said, including a removal', () => {
    applySessionBackgroundTasksEvent(SESSION, [WAIT], getRuntimeKey());
    const baseline = revision();
    applySessionBackgroundTasksEvent(OTHER, [AGENT], getRuntimeKey());
    applySessionBackgroundTasksEvent(SESSION, [], getRuntimeKey());

    // Read before both events: it still lists the first session and not the other.
    applySessionBackgroundTasksSnapshot({ [SESSION]: { tasks: [WAIT] } }, baseline);
    expect(tasksOf(SESSION)).toBeUndefined();
    expect(tasksOf(OTHER)).toEqual([AGENT]);
  });

  test('an unchanged snapshot keeps the state object', () => {
    applySessionBackgroundTasksEvent(SESSION, [WAIT], getRuntimeKey());
    const state = useSessionBackgroundTasksStore.getState();
    applySessionBackgroundTasksSnapshot({ [SESSION]: { tasks: [{ ...WAIT }] } }, revision());
    expect(useSessionBackgroundTasksStore.getState()).toBe(state);
  });
});

describe('seeding background tasks from the server', () => {
  const register = (backgroundTasks: () => Promise<NativeBackgroundTaskSnapshot>) => {
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ backgroundTasks })));
  };

  test('applies the server snapshot', async () => {
    applySessionBackgroundTasksEvent(OTHER, [AGENT], getRuntimeKey());
    register(async () => ({ [SESSION]: { directory: '/repo', tasks: [WAIT] } }));
    await seedSessionBackgroundTasksFromHost();
    expect(tasksOf(SESSION)).toEqual([WAIT]);
    expect(tasksOf(OTHER)).toBeUndefined();
  });

  test('a failed read keeps the held sets instead of clearing them', async () => {
    applySessionBackgroundTasksEvent(SESSION, [WAIT], getRuntimeKey());
    register(async () => {
      throw new Error('route missing on an older server');
    });
    await seedSessionBackgroundTasksFromHost();
    expect(tasksOf(SESSION)).toEqual([WAIT]);
  });

  test('a runtime without native sessions reads nothing', async () => {
    let reads = 0;
    registerRuntimeAPIs(createTestRuntimeAPIs({
      ...createTestNativeAgentsAPI({
        backgroundTasks: async () => {
          reads += 1;
          return {};
        },
      }),
      supported: false,
    }));
    await seedSessionBackgroundTasksFromHost();
    expect(reads).toBe(0);
  });

  test('overlapping calls share one read, and a snapshot from a previous runtime is dropped', async () => {
    const answer = deferred<NativeBackgroundTaskSnapshot>();
    let reads = 0;
    register(() => {
      reads += 1;
      return answer.promise;
    });
    const first = seedSessionBackgroundTasksFromHost();
    const second = seedSessionBackgroundTasksFromHost();
    expect(reads).toBe(1);

    switchRuntimeEndpoint({ apiBaseUrl: 'http://other-runtime.test', runtimeKey: 'other-runtime' });
    answer.resolve({ [SESSION]: { directory: '/repo', tasks: [WAIT] } });
    await Promise.all([first, second]);
    expect(tasksOf(SESSION)).toBeUndefined();
  });
});
