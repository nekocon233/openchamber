import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { NativeAgentsAPI } from '@/lib/api/types';
import { NativeAgentsUnsupportedError } from '@/lib/native-agents/errors';
import { nativeSessionBackend } from './native-session-source';
import type { NativeExecutionTask, NativeTaskSnapshot } from '@/lib/native-agents/task-schemas';
import type { SessionBackgroundTask } from '@/lib/opencode/events';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

// Background tasks a native CLI keeps running after its turn ended. The
// session's status is idle, yet work is in flight: when a task finishes, the
// CLI starts a turn by itself. `global-session-status.ts` reads this store to
// keep such a session's turn open for display, as it does for subagents, and
// the composer offers Stop, which ends those tasks.
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

let seeding: { generation: number; read: Promise<void> } | null = null;
let warnedRuntimeKey: string | null = null;

/**
 * Reads the server's snapshot and applies it. Overlapping calls share one
 * read. A failed read keeps the held sets: failure is not an empty snapshot.
 */
export const seedSessionBackgroundTasksFromHost = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const generation = getRuntimeEndpointGeneration();
  if (seeding?.generation === generation) return seeding.read;
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents;
  if (!nativeAgents?.supported) return Promise.resolve();
  const baselineRevision = useSessionBackgroundTasksStore.getState().revision;
  const read = (async () => {
    try {
      const snapshot = await nativeAgents.backgroundTasks();
      if (getRuntimeKey() === runtimeKey && getRuntimeEndpointGeneration() === generation) {
        applySessionBackgroundTasksSnapshot(snapshot, baselineRevision);
      }
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
  seeding = { generation, read };
  return read;
};

// Detail records include ambient and terminal tasks. They never write the active
// map above: only the CLI's full-set channel determines whether a turn stays busy.
export type NativeTaskDetailState =
  | { status: 'idle' }
  | { status: 'loading'; snapshot: NativeTaskSnapshot | null }
  | { status: 'ready'; snapshot: NativeTaskSnapshot }
  | { status: 'stale'; snapshot: NativeTaskSnapshot; error: Error | null }
  | { status: 'error'; error: Error }
  | { status: 'unsupported' };

const IDLE: NativeTaskDetailState = { status: 'idle' };
const UNSUPPORTED: NativeTaskDetailState = { status: 'unsupported' };
const DETAIL_REFRESH_MS = 45_000;

type DetailEntry = {
  key: string;
  runtimeKey: string;
  generation: number;
  sessionId: string;
  directory: string;
  state: NativeTaskDetailState;
  mutation: number;
  serverRevision: number | null;
  deleted: boolean;
  listeners: Set<() => void>;
  consumers: number;
  visible: number;
  api: NativeAgentsAPI | null;
  pending: Promise<NativeTaskDetailState> | null;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  lastReadAt: number;
};

const details = new Map<string, DetailEntry>();
const detailSnapshot = (state: NativeTaskDetailState) => 'snapshot' in state ? state.snapshot : null;
const detailEntry = (sessionId: string, directory: string, runtimeKey = getRuntimeKey(), generation = getRuntimeEndpointGeneration()): DetailEntry => {
  const normalized = normalizePath(directory) ?? directory;
  const key = JSON.stringify([runtimeKey, normalized, sessionId]);
  let entry = details.get(key);
  if (!entry || entry.generation !== generation) {
    entry = {
      key, runtimeKey, generation, sessionId, directory: normalized, state: IDLE, mutation: 0,
      serverRevision: null, deleted: false, listeners: new Set(), consumers: 0,
      visible: 0, api: null, pending: null, controller: null, timer: null, releaseTimer: null, lastReadAt: 0,
    };
    details.set(key, entry);
  }
  if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
  entry.releaseTimer = null;
  return entry;
};
const releaseDetail = (entry: DetailEntry): void => {
  if (entry.releaseTimer || entry.consumers > 0 || entry.listeners.size > 0) return;
  entry.releaseTimer = setTimeout(() => {
    entry.releaseTimer = null;
    if (entry.consumers > 0 || entry.listeners.size > 0 || details.get(entry.key) !== entry) return;
    entry.deleted = true;
    entry.mutation += 1;
    entry.pending = null;
    entry.controller?.abort();
    stopDetailTimer(entry);
    details.delete(entry.key);
  }, 0);
};
const publishDetail = (entry: DetailEntry, state: NativeTaskDetailState): void => {
  if (entry.state === state) return;
  entry.state = state;
  if (state.status === 'unsupported') stopDetailTimer(entry);
  for (const listener of entry.listeners) listener();
};

const sameTaskDetail = (left: NativeExecutionTask, right: NativeExecutionTask): boolean => (
  left.id === right.id && left.type === right.type && left.description === right.description
  && left.active === right.active && left.ambient === right.ambient && left.status === right.status
  && left.canStop === right.canStop && left.outputAvailable === right.outputAvailable
  && left.toolUseId === right.toolUseId && left.childSessionId === right.childSessionId
  && left.summary === right.summary && left.error === right.error && left.startedAt === right.startedAt
  && left.endedAt === right.endedAt && left.lastToolName === right.lastToolName
  && left.usage?.totalTokens === right.usage?.totalTokens && left.usage?.toolUses === right.usage?.toolUses
  && left.usage?.durationMs === right.usage?.durationMs
);

const commitDetail = (entry: DetailEntry, snapshot: NativeTaskSnapshot): void => {
  if (entry.deleted || (entry.serverRevision !== null && snapshot.revision < entry.serverRevision)) return;
  entry.mutation += 1;
  entry.serverRevision = snapshot.revision;
  if (snapshot.state === 'unsupported') {
    publishDetail(entry, UNSUPPORTED);
    return;
  }
  const held = detailSnapshot(entry.state);
  const previous = held?.generation === snapshot.generation ? held : null;
  const byId = new Map(previous?.tasks.map((task) => [task.id, task]));
  const tasks = snapshot.tasks.map((task) => {
    const old = byId.get(task.id);
    return old && sameTaskDetail(old, task) ? old : task;
  });
  const stableTasks = previous && tasks.length === previous.tasks.length
    && tasks.every((task, index) => task === previous.tasks[index]) ? previous.tasks : tasks;
  const reconciled = previous && stableTasks === previous.tasks && previous.state === snapshot.state
    && previous.revision === snapshot.revision && previous.omitted === snapshot.omitted
    ? previous : { ...snapshot, tasks: stableTasks };
  if (entry.state.status === 'ready' && entry.state.snapshot === reconciled) return;
  publishDetail(entry, { status: 'ready', snapshot: reconciled });
};

export const applySessionNativeTaskDetailsEvent = (
  sessionId: string, directory: string, snapshot: NativeTaskSnapshot, runtimeKey: string,
): void => {
  if (runtimeKey !== getRuntimeKey() || !normalizePath(directory) || directory === 'global') return;
  const entry = details.get(JSON.stringify([runtimeKey, normalizePath(directory) ?? directory, sessionId]));
  if (entry) commitDetail(entry, snapshot);
};

const loadDetails = (entry: DetailEntry, api: NativeAgentsAPI | undefined): Promise<NativeTaskDetailState> => {
  if (entry.deleted || entry.runtimeKey !== getRuntimeKey()) return Promise.resolve(IDLE);
  if (entry.pending) return entry.pending;
  const backend = nativeSessionBackend(entry.sessionId, entry.directory);
  if (!api?.supported || (backend !== 'claude' && backend !== 'antigravity')) {
    publishDetail(entry, UNSUPPORTED);
    releaseDetail(entry);
    return Promise.resolve(entry.state);
  }
  const baseline = entry.mutation;
  const runtimeGeneration = getRuntimeEndpointGeneration();
  const current = () => !entry.deleted && details.get(entry.key) === entry
    && entry.runtimeKey === getRuntimeKey() && entry.mutation === baseline && runtimeGeneration === getRuntimeEndpointGeneration();
  const controller = new AbortController();
  entry.controller = controller;
  entry.lastReadAt = Date.now();
  publishDetail(entry, { status: 'loading', snapshot: detailSnapshot(entry.state) });
  const pending = (async () => {
    try {
      const capabilities = await api.capabilities();
      if (!current() || controller.signal.aborted) return entry.state;
      if (!capabilities.backends[backend]?.tasks?.background) {
        publishDetail(entry, UNSUPPORTED);
        return entry.state;
      }
      const snapshot = await api.sessionTasks(entry.sessionId, entry.directory, { signal: controller.signal });
      if (!current()) return entry.state;
      commitDetail(entry, snapshot);
      if (entry.state.status === 'loading' && entry.state.snapshot) {
        publishDetail(entry, { status: 'ready', snapshot: entry.state.snapshot });
      }
    } catch (cause) {
      if (!current()) return entry.state;
      if (cause instanceof NativeAgentsUnsupportedError) publishDetail(entry, UNSUPPORTED);
      else {
        const error = cause instanceof Error ? cause : new Error('Native task read failed');
        const snapshot = detailSnapshot(entry.state);
        publishDetail(entry, snapshot ? { status: 'stale', snapshot, error } : { status: 'error', error });
      }
    }
    return entry.state;
  })().finally(() => {
    if (entry.pending === pending) {
      entry.pending = null;
      entry.controller = null;
      releaseDetail(entry);
    }
  });
  entry.pending = pending;
  return pending;
};

export const loadSessionNativeTaskDetails = (sessionId: string, directory: string): Promise<NativeTaskDetailState> => (
  loadDetails(detailEntry(sessionId, directory), getRegisteredRuntimeAPIs()?.nativeAgents)
);

const stopDetailTimer = (entry: DetailEntry): void => {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
};
const scheduleDetails = (entry: DetailEntry): void => {
  // Saved Antigravity tasks refresh on turn completion, reconnect or request;
  // they do not claim a live task-control channel and must not poll at idle.
  if (nativeSessionBackend(entry.sessionId, entry.directory) === 'antigravity') return;
  if (entry.timer || entry.deleted || entry.visible === 0 || entry.state.status === 'unsupported' || globalThis.document?.visibilityState === 'hidden') return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const read = Date.now() - entry.lastReadAt >= DETAIL_REFRESH_MS ? loadDetails(entry, entry.api ?? undefined) : Promise.resolve(entry.state);
    void read.finally(() => scheduleDetails(entry));
  }, Math.max(1, DETAIL_REFRESH_MS - (Date.now() - entry.lastReadAt)));
};

export const useSessionNativeTaskDetails = (
  sessionId: string | null | undefined,
  directory: string | null | undefined,
  { enabled = true, visible = false }: { enabled?: boolean; visible?: boolean } = {},
): NativeTaskDetailState => {
  const { nativeAgents } = useRuntimeAPIs();
  const generation = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const runtimeKey = getRuntimeKey();
  const entry = useMemo(() => enabled && sessionId && directory ? detailEntry(sessionId, directory, runtimeKey, generation) : null, [enabled, sessionId, directory, runtimeKey, generation]);
  const subscribe = useMemo(() => (listener: () => void) => {
    if (entry?.releaseTimer) clearTimeout(entry.releaseTimer);
    if (entry) entry.releaseTimer = null;
    entry?.listeners.add(listener);
    return () => {
      entry?.listeners.delete(listener);
      if (entry) releaseDetail(entry);
    };
  }, [entry]);
  const state = useSyncExternalStore(subscribe, () => entry?.state ?? IDLE, () => IDLE);
  useEffect(() => {
    if (!entry || !enabled || entry.deleted) return;
    entry.api = nativeAgents;
    entry.consumers += 1;
    const opened = visible && entry.visible === 0;
    if (visible) entry.visible += 1;
    if (opened || entry.state.status === 'idle' || entry.state.status === 'stale' || entry.state.status === 'error') void loadDetails(entry, nativeAgents);
    const visibility = () => {
      if (document.visibilityState === 'hidden') stopDetailTimer(entry);
      else scheduleDetails(entry);
    };
    if (visible) document.addEventListener('visibilitychange', visibility);
    scheduleDetails(entry);
    return () => {
      entry.consumers -= 1;
      if (visible) {
        entry.visible -= 1;
        document.removeEventListener('visibilitychange', visibility);
      }
      if (entry.visible === 0) stopDetailTimer(entry);
      releaseDetail(entry);
    };
  }, [entry, nativeAgents, enabled, visible]);
  const backend = entry ? nativeSessionBackend(entry.sessionId, entry.directory) : null;
  if (entry && (!nativeAgents.supported || (backend !== 'claude' && backend !== 'antigravity'))) return UNSUPPORTED;
  return state;
};

/** Explicit deletion records a mutation even when no records have arrived yet. */
export const clearSessionNativeTaskDetails = (sessionId: string, directory: string, runtimeKey: string): void => {
  if (runtimeKey !== getRuntimeKey()) return;
  applySessionBackgroundTasksEvent(sessionId, [], runtimeKey);
  const entry = details.get(JSON.stringify([runtimeKey, normalizePath(directory) ?? directory, sessionId]));
  if (!entry) return;
  entry.deleted = true;
  entry.mutation += 1;
  entry.pending = null;
  entry.controller?.abort();
  stopDetailTimer(entry);
  publishDetail(entry, IDLE);
  releaseDetail(entry);
};

export const resetSessionNativeTaskSource = (sessionId: string, directory: string, runtimeKey: string): void => {
  const entry = details.get(JSON.stringify([runtimeKey, normalizePath(directory) ?? directory, sessionId]));
  if (!entry || entry.deleted || runtimeKey !== getRuntimeKey()) return;
  entry.mutation += 1;
  entry.pending = null;
  entry.controller?.abort();
  entry.controller = null;
  stopDetailTimer(entry);
  publishDetail(entry, IDLE);
  entry.serverRevision = null;
  entry.lastReadAt = 0;
  if (entry.consumers > 0) void loadDetails(entry, entry.api ?? undefined);
};

export const markSessionNativeTaskDetailsStale = (): void => {
  for (const entry of details.values()) {
    entry.mutation += 1;
    entry.serverRevision = null;
    entry.pending = null;
    entry.controller?.abort();
    entry.controller = null;
    const snapshot = detailSnapshot(entry.state);
    if (snapshot) publishDetail(entry, { status: 'stale', snapshot, error: null });
    else if (entry.state.status === 'loading') publishDetail(entry, IDLE);
  }
};

export const refreshSessionNativeTaskDetails = (): void => {
  markSessionNativeTaskDetailsStale();
  for (const entry of details.values()) if (entry.consumers > 0) void loadDetails(entry, entry.api ?? undefined);
};

subscribeRuntimeEndpointWillChange(() => {
  for (const entry of details.values()) {
    entry.deleted = true;
    entry.mutation += 1;
    entry.controller?.abort();
    stopDetailTimer(entry);
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    publishDetail(entry, IDLE);
  }
  details.clear();
});

/** Whether the session's CLI still runs background tasks after its turn. */
export const useSessionHasBackgroundTasks = (sessionId: string | null | undefined): boolean => (
  useSessionBackgroundTasksStore((state) => Boolean(sessionId && state.tasksBySession.has(sessionId)))
);
