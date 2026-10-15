// The steps a Codex turn reported through `update_plan`, as the connected
// server's process observed them. Codex keeps the notification out of its
// store, so this is an observation and not a stored list: nothing can read the
// steps back once the process that saw them is gone. The owner therefore never
// turns a missing observation into an empty list — `unknown` is a state of its
// own — and a thread whose process ended keeps its last steps under `inactive`.

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { NativeAgentsAPI } from '@/lib/api/types';
import { NativeAgentsUnsupportedError } from '@/lib/native-agents/errors';
import { nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import type { NativeTodosSnapshot } from '@/lib/native-agents/task-schemas';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

type Todos = Extract<NativeTodosSnapshot, { state: 'unknown' | 'active' | 'inactive' }>;
export type NativeTodosState =
  | { status: 'idle' }
  | { status: 'loading'; snapshot: Todos | null }
  | { status: 'ready'; snapshot: Todos }
  | { status: 'stale'; snapshot: Todos; error: Error | null }
  | { status: 'error'; error: Error }
  | { status: 'unsupported' };

const IDLE: NativeTodosState = { status: 'idle' };
const UNSUPPORTED: NativeTodosState = { status: 'unsupported' };
const UNSUPPORTED_SNAPSHOT: NativeTodosSnapshot = { state: 'unsupported', generation: null, revision: 0, todos: [] };

type Entry = {
  key: string;
  runtimeKey: string;
  generation: number;
  sessionId: string;
  directory: string;
  state: NativeTodosState;
  mutation: number;
  serverRevision: number | null;
  deleted: boolean;
  listeners: Set<() => void>;
  consumers: number;
  visible: number;
  api: NativeAgentsAPI | null;
  pending: Promise<NativeTodosState> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
};

type Read = { api: NativeAgentsAPI; controller: AbortController; promise: Promise<NativeTodosSnapshot> };
const entries = new Map<string, Entry>();
const reads = new Map<string, Read>();

const keyOf = (runtimeKey: string, directory: string, sessionId: string) => JSON.stringify([runtimeKey, directory, sessionId]);
const snapshotOf = (state: NativeTodosState): Todos | null => ('snapshot' in state ? state.snapshot : null);
const isTodos = (snapshot: NativeTodosSnapshot): snapshot is Todos => snapshot.state !== 'unsupported';

const entryFor = (sessionId: string, directory: string, runtimeKey = getRuntimeKey(), generation = getRuntimeEndpointGeneration()): Entry => {
  const normalized = normalizePath(directory) ?? directory;
  const key = keyOf(runtimeKey, normalized, sessionId);
  let entry = entries.get(key);
  if (!entry || entry.generation !== generation) {
    entry = {
      key, runtimeKey, generation, sessionId, directory: normalized, state: IDLE, mutation: 0,
      serverRevision: null, deleted: false, listeners: new Set(), consumers: 0, visible: 0,
      api: null, pending: null, releaseTimer: null,
    };
    entries.set(key, entry);
  }
  if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
  entry.releaseTimer = null;
  return entry;
};

// Release only after the render/commit task. Acquisition never evicts a mounting
// consumer, and Strict Mode can reacquire before this cleanup observes it.
const release = (entry: Entry): void => {
  if (entry.releaseTimer || entry.consumers > 0 || entry.listeners.size > 0) return;
  entry.releaseTimer = setTimeout(() => {
    entry.releaseTimer = null;
    if (entry.consumers > 0 || entry.listeners.size > 0 || entries.get(entry.key) !== entry) return;
    entry.deleted = true;
    entry.mutation += 1;
    entry.pending = null;
    entries.delete(entry.key);
    reads.get(entry.key)?.controller.abort();
    reads.delete(entry.key);
  }, 0);
};

const publish = (entry: Entry, state: NativeTodosState): void => {
  if (entry.state === state) return;
  entry.state = state;
  for (const listener of entry.listeners) listener();
};

const commit = (entry: Entry, snapshot: NativeTodosSnapshot): void => {
  if (entry.deleted) return;
  if (!isTodos(snapshot)) {
    entry.mutation += 1;
    if (entry.state.status !== 'unsupported') publish(entry, UNSUPPORTED);
    return;
  }
  const held = snapshotOf(entry.state);
  // Revisions order one process's observations. A new generation is a new
  // observer, so its numbering starts over and is not compared with the old.
  if (held && held.generation === snapshot.generation) {
    if (entry.serverRevision !== null && snapshot.revision < entry.serverRevision) return;
    if (held === snapshot) return;
  }
  entry.mutation += 1;
  entry.serverRevision = snapshot.revision;
  publish(entry, { status: 'ready', snapshot });
};

const readSnapshot = (entry: Entry, api: NativeAgentsAPI): Promise<NativeTodosSnapshot> => {
  const held = reads.get(entry.key);
  if (held?.api === api) return held.promise;
  const controller = new AbortController();
  const promise = (async () => {
    const capabilities = await api.capabilities();
    if (controller.signal.aborted) throw new DOMException('Read cancelled', 'AbortError');
    // An older server has no Codex todo view; do not ask for one.
    if (!capabilities.backends.codex.tasks?.todos) return UNSUPPORTED_SNAPSHOT;
    return api.codexTodos(entry.sessionId, entry.directory, { signal: controller.signal });
  })().finally(() => { if (reads.get(entry.key)?.promise === promise) reads.delete(entry.key); });
  reads.set(entry.key, { api, controller, promise });
  return promise;
};

const load = (entry: Entry, api: NativeAgentsAPI | undefined): Promise<NativeTodosState> => {
  if (entry.deleted || entry.runtimeKey !== getRuntimeKey()) return Promise.resolve(IDLE);
  if (entry.pending) return entry.pending;
  if (!api?.supported || nativeBackendOfSessionId(entry.sessionId) !== 'codex') {
    commit(entry, UNSUPPORTED_SNAPSHOT);
    release(entry);
    return Promise.resolve(entry.state);
  }
  const baseline = entry.mutation;
  const runtimeGeneration = getRuntimeEndpointGeneration();
  const current = () => !entry.deleted && entries.get(entry.key) === entry
    && entry.runtimeKey === getRuntimeKey() && entry.mutation === baseline && runtimeGeneration === getRuntimeEndpointGeneration();
  publish(entry, { status: 'loading', snapshot: snapshotOf(entry.state) });
  const pending = readSnapshot(entry, api).then((snapshot) => {
    if (!current()) return entry.state;
    commit(entry, snapshot);
    // An older server snapshot cannot leave a refresh stuck in loading.
    if (entry.state.status === 'loading' && entry.state.snapshot) publish(entry, { status: 'ready', snapshot: entry.state.snapshot });
    return entry.state;
  }, (cause) => {
    if (!current()) return entry.state;
    if (cause instanceof NativeAgentsUnsupportedError) commit(entry, UNSUPPORTED_SNAPSHOT);
    else {
      const error = cause instanceof Error ? cause : new Error('Native todo read failed');
      const snapshot = snapshotOf(entry.state);
      publish(entry, snapshot ? { status: 'stale', snapshot, error } : { status: 'error', error });
    }
    return entry.state;
  }).finally(() => {
    if (entry.pending === pending) {
      entry.pending = null;
      release(entry);
    }
  });
  entry.pending = pending;
  return pending;
};

/** The panel's refresh button: reads even before the hook has mounted. */
export const loadSessionNativeTodos = (sessionId: string, directory: string): Promise<NativeTodosState> => (
  load(entryFor(sessionId, directory), getRegisteredRuntimeAPIs()?.nativeAgents)
);

/**
 * A turn reported steps. A session nobody has opened allocates nothing: the
 * observation lives on the server, and opening the panel reads it there.
 */
export const applySessionNativeTodosEvent = (sessionId: string, directory: string, snapshot: NativeTodosSnapshot, runtimeKey: string): void => {
  if (runtimeKey !== getRuntimeKey() || !normalizePath(directory) || directory === 'global') return;
  const entry = entries.get(keyOf(runtimeKey, normalizePath(directory) ?? directory, sessionId));
  if (entry) commit(entry, snapshot);
};

export const useSessionNativeTodos = (
  sessionId: string | null | undefined,
  directory: string | null | undefined,
  { enabled = true, visible = false }: { enabled?: boolean; visible?: boolean } = {},
): NativeTodosState => {
  const { nativeAgents } = useRuntimeAPIs();
  const generation = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const runtimeKey = getRuntimeKey();
  const entry = useMemo(() => enabled && sessionId && directory ? entryFor(sessionId, directory, runtimeKey, generation) : null, [enabled, sessionId, directory, runtimeKey, generation]);
  const subscribe = useMemo(() => (listener: () => void) => {
    if (entry?.releaseTimer) clearTimeout(entry.releaseTimer);
    if (entry) entry.releaseTimer = null;
    entry?.listeners.add(listener);
    return () => {
      entry?.listeners.delete(listener);
      if (entry) release(entry);
    };
  }, [entry]);
  const state = useSyncExternalStore(subscribe, () => entry?.state ?? IDLE, () => IDLE);
  useEffect(() => {
    if (!entry || !enabled || entry.deleted) return;
    entry.api = nativeAgents;
    entry.consumers += 1;
    const opened = visible && entry.visible === 0;
    if (visible) entry.visible += 1;
    // Opening reads once, because the events that carried the steps are gone
    // as soon as the process that published them is.
    if (opened || entry.state.status === 'idle' || entry.state.status === 'stale' || entry.state.status === 'error') void load(entry, nativeAgents);
    return () => {
      entry.consumers -= 1;
      if (visible) entry.visible -= 1;
      release(entry);
    };
  }, [entry, nativeAgents, enabled, visible]);
  if (entry && (!nativeAgents.supported || nativeBackendOfSessionId(entry.sessionId) !== 'codex')) return UNSUPPORTED;
  return state;
};

export const clearSessionNativeTodos = (sessionId: string, directory: string, runtimeKey: string): void => {
  if (runtimeKey !== getRuntimeKey()) return;
  const entry = entries.get(keyOf(runtimeKey, normalizePath(directory) ?? directory, sessionId));
  if (!entry) return;
  entry.deleted = true;
  entry.mutation += 1;
  entry.pending = null;
  reads.get(entry.key)?.controller.abort();
  reads.delete(entry.key);
  publish(entry, IDLE);
  release(entry);
};

/** Connection loss is stale data, not a thread that reported no steps. */
export const markSessionNativeTodosStale = (): void => {
  for (const read of reads.values()) read.controller.abort();
  reads.clear();
  for (const entry of entries.values()) {
    entry.mutation += 1;
    entry.pending = null;
    entry.serverRevision = null;
    const snapshot = snapshotOf(entry.state);
    if (snapshot) publish(entry, { status: 'stale', snapshot, error: null });
    else if (entry.state.status === 'loading') publish(entry, IDLE);
  }
};

/** A new server process may restart its revision sequence. */
export const refreshSessionNativeTodos = (): void => {
  markSessionNativeTodosStale();
  for (const entry of entries.values()) if (entry.consumers > 0) void load(entry, entry.api ?? undefined);
};

subscribeRuntimeEndpointWillChange(() => {
  for (const read of reads.values()) read.controller.abort();
  reads.clear();
  for (const entry of entries.values()) {
    entry.deleted = true;
    entry.mutation += 1;
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    publish(entry, IDLE);
  }
  entries.clear();
});
