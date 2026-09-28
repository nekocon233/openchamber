import { create } from 'zustand';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { SessionBackgroundTask } from '@/lib/opencode/events';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

// Background tasks a native CLI keeps running after its turn ended. The
// session's status is idle, yet work is in flight: when a task finishes, the
// CLI starts a turn by itself. Rows and the chat read this store to say so.
//
// Live only, never persisted. An event replaces one session's set. The
// server's snapshot names every session with tasks, because no task outlives
// its CLI query, so it replaces the whole map, except the sessions an event
// changed while the read was in flight.

type BackgroundTasksState = {
  tasksBySession: ReadonlyMap<string, readonly SessionBackgroundTask[]>;
  /** Revision of each session's latest event, removals included. */
  eventRevisionBySession: ReadonlyMap<string, number>;
  revision: number;
};

const EMPTY_TASKS: readonly SessionBackgroundTask[] = Object.freeze([]);

export const useSessionBackgroundTasksStore = create<BackgroundTasksState>(() => ({
  tasksBySession: new Map(),
  eventRevisionBySession: new Map(),
  revision: 0,
}));

const sameTasks = (left: readonly SessionBackgroundTask[], right: readonly SessionBackgroundTask[]): boolean => (
  left.length === right.length
  && left.every((task, index) => task.id === right[index].id
    && task.type === right[index].type
    && task.description === right[index].description)
);

subscribeRuntimeEndpointWillChange(() => {
  useSessionBackgroundTasksStore.setState((state) => ({
    tasksBySession: new Map(),
    eventRevisionBySession: new Map(),
    revision: state.revision + 1,
  }));
});

/** Applies a session's set from a live event of the runtime it arrived on. */
export const applySessionBackgroundTasksEvent = (
  sessionId: string,
  tasks: readonly SessionBackgroundTask[],
  runtimeKey: string,
): void => {
  if (runtimeKey !== getRuntimeKey()) return;
  useSessionBackgroundTasksStore.setState((state) => {
    const revision = state.revision + 1;
    const held = state.tasksBySession.get(sessionId);
    const unchanged = tasks.length === 0 ? held === undefined : held !== undefined && sameTasks(held, tasks);
    let tasksBySession = state.tasksBySession;
    if (!unchanged) {
      const next = new Map(state.tasksBySession);
      if (tasks.length > 0) next.set(sessionId, tasks);
      else next.delete(sessionId);
      tasksBySession = next;
    }
    return {
      tasksBySession,
      eventRevisionBySession: new Map(state.eventRevisionBySession).set(sessionId, revision),
      revision,
    };
  });
};

/**
 * Replaces the held sets with the server's snapshot. A session an event
 * changed after `baselineRevision` keeps the event's set: the snapshot was
 * read before that event.
 */
export const applySessionBackgroundTasksSnapshot = (
  snapshot: Readonly<Record<string, { tasks: readonly SessionBackgroundTask[] }>>,
  baselineRevision: number,
): void => {
  useSessionBackgroundTasksStore.setState((state) => {
    const eventIsNewer = (sessionId: string) => (state.eventRevisionBySession.get(sessionId) ?? 0) > baselineRevision;
    const next = new Map<string, readonly SessionBackgroundTask[]>();
    for (const [sessionId, tasks] of state.tasksBySession) {
      if (eventIsNewer(sessionId)) next.set(sessionId, tasks);
    }
    for (const [sessionId, { tasks }] of Object.entries(snapshot)) {
      if (eventIsNewer(sessionId) || tasks.length === 0) continue;
      const held = state.tasksBySession.get(sessionId);
      next.set(sessionId, held && sameTasks(held, tasks) ? held : tasks);
    }
    const unchanged = next.size === state.tasksBySession.size
      && [...next].every(([sessionId, tasks]) => state.tasksBySession.get(sessionId) === tasks);
    return unchanged ? state : { tasksBySession: next };
  });
};

let seeding: { runtimeKey: string; read: Promise<void> } | null = null;
let warnedRuntimeKey: string | null = null;

/**
 * Reads the server's snapshot and applies it. Overlapping calls share one
 * read. A failed read keeps the held sets: failure is not an empty snapshot.
 */
export const seedSessionBackgroundTasksFromHost = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  if (seeding?.runtimeKey === runtimeKey) return seeding.read;
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents;
  if (!nativeAgents?.supported) return Promise.resolve();
  const baselineRevision = useSessionBackgroundTasksStore.getState().revision;
  const read = (async () => {
    try {
      const snapshot = await nativeAgents.backgroundTasks();
      if (getRuntimeKey() === runtimeKey) applySessionBackgroundTasksSnapshot(snapshot, baselineRevision);
    } catch (error) {
      // The read repeats with every global session load; one warning per runtime is enough.
      if (warnedRuntimeKey !== runtimeKey) {
        warnedRuntimeKey = runtimeKey;
        console.warn('[native-sessions] failed to read native background tasks', error);
      }
    }
  })().finally(() => {
    if (seeding?.read === read) seeding = null;
  });
  seeding = { runtimeKey, read };
  return read;
};

/** The session's running background tasks; one shared empty list when none. */
export const useSessionBackgroundTasks = (sessionId: string | null | undefined): readonly SessionBackgroundTask[] => (
  useSessionBackgroundTasksStore((state) => (sessionId ? state.tasksBySession.get(sessionId) : undefined) ?? EMPTY_TASKS)
);
