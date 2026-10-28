// The plan a Codex thread wrote, for the Tasks panel. A plan arrives as a
// whole document from its own route rather than as events: a thread writes one
// per planning turn, where a checklist item flips state many times a turn.
// The panel refreshes it when it opens, when the session goes idle and when
// the reader asks, which needs no event channel and no polling timer.

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { NativeAgentsAPI } from '@/lib/api/types';
import { NativeAgentsUnsupportedError } from '@/lib/native-agents/errors';
import { nativeSessionBackend } from './native-session-source';
import type { NativePlanSnapshot } from '@/lib/native-agents/task-schemas';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

/** A read that produced a plan, or authoritatively found none. */
type Plan = Extract<NativePlanSnapshot, { state: 'ready' }> | Extract<NativePlanSnapshot, { state: 'empty' }>;
export type NativePlanState =
  | { status: 'idle' }
  | { status: 'loading'; plan: Plan | null }
  | { status: 'ready' | 'empty'; plan: Plan }
  | { status: 'stale'; plan: Plan; error: Error | null }
  | { status: 'error'; error: Error }
  | { status: 'unsupported' };

const IDLE: NativePlanState = { status: 'idle' };
const UNSUPPORTED: NativePlanState = { status: 'unsupported' };

type Entry = {
  key: string;
  runtimeKey: string;
  generation: number;
  sessionId: string;
  directory: string;
  state: NativePlanState;
  mutation: number;
  deleted: boolean;
  listeners: Set<() => void>;
  consumers: number;
  visible: number;
  api: NativeAgentsAPI | null;
  pending: Promise<NativePlanState> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
};

type Read = { api: NativeAgentsAPI; controller: AbortController; promise: Promise<NativePlanSnapshot> };
const entries = new Map<string, Entry>();
const reads = new Map<string, Read>();

const keyOf = (runtimeKey: string, directory: string, sessionId: string) => JSON.stringify([runtimeKey, directory, sessionId]);
const planOf = (state: NativePlanState): Plan | null => ('plan' in state ? state.plan : null);

const entryFor = (sessionId: string, directory: string, runtimeKey = getRuntimeKey(), generation = getRuntimeEndpointGeneration()): Entry => {
  const normalized = normalizePath(directory) ?? directory;
  const key = keyOf(runtimeKey, normalized, sessionId);
  let entry = entries.get(key);
  if (!entry || entry.generation !== generation) {
    entry = {
      key, runtimeKey, generation, sessionId, directory: normalized, state: IDLE, mutation: 0,
      deleted: false, listeners: new Set(), consumers: 0, visible: 0, api: null, pending: null, releaseTimer: null,
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

const publish = (entry: Entry, state: NativePlanState): void => {
  if (entry.state === state) return;
  entry.state = state;
  for (const listener of entry.listeners) listener();
};

/** Status a successful read maps to; the snapshot keeps its own state. */
const statusOf = (plan: Plan): 'ready' | 'empty' => (plan.state === 'ready' ? 'ready' : 'empty');

const readSnapshot = (entry: Entry, api: NativeAgentsAPI): Promise<NativePlanSnapshot> => {
  const held = reads.get(entry.key);
  if (held?.api === api) return held.promise;
  const controller = new AbortController();
  const promise = (async () => {
    const capabilities = await api.capabilities();
    if (controller.signal.aborted) throw new DOMException('Read cancelled', 'AbortError');
    // An older server has no Codex plan view; do not ask for one.
    if (!capabilities.backends.codex.tasks?.plan) return { state: 'unavailable' as const, reason: 'unsupported' as const };
    return api.plan(entry.sessionId, entry.directory, { signal: controller.signal });
  })().finally(() => { if (reads.get(entry.key)?.promise === promise) reads.delete(entry.key); });
  reads.set(entry.key, { api, controller, promise });
  return promise;
};

const commit = (entry: Entry, snapshot: NativePlanSnapshot): void => {
  if (entry.deleted) return;
  if (snapshot.state === 'unavailable') {
    entry.mutation += 1;
    if (entry.state.status !== 'unsupported') publish(entry, UNSUPPORTED);
    return;
  }
  entry.mutation += 1;
  const status = statusOf(snapshot);
  if (entry.state.status === status && planOf(entry.state) === snapshot) return;
  publish(entry, { status, plan: snapshot });
};

const load = (entry: Entry, api: NativeAgentsAPI | undefined): Promise<NativePlanState> => {
  if (entry.deleted || entry.runtimeKey !== getRuntimeKey()) return Promise.resolve(IDLE);
  if (entry.pending) return entry.pending;
  if (!api?.supported || nativeSessionBackend(entry.sessionId, entry.directory) !== 'codex') {
    commit(entry, { state: 'unavailable', reason: 'unsupported' });
    release(entry);
    return Promise.resolve(entry.state);
  }
  const baseline = entry.mutation;
  const runtimeGeneration = getRuntimeEndpointGeneration();
  const current = () => !entry.deleted && entries.get(entry.key) === entry
    && entry.runtimeKey === getRuntimeKey() && entry.mutation === baseline && runtimeGeneration === getRuntimeEndpointGeneration();
  publish(entry, { status: 'loading', plan: planOf(entry.state) });
  const pending = readSnapshot(entry, api).then((snapshot) => {
    if (!current()) return entry.state;
    commit(entry, snapshot);
    // An older server snapshot cannot leave a refresh stuck in loading.
    if (entry.state.status === 'loading' && entry.state.plan) {
      publish(entry, { status: statusOf(entry.state.plan), plan: entry.state.plan });
    }
    return entry.state;
  }, (cause) => {
    if (!current()) return entry.state;
    if (cause instanceof NativeAgentsUnsupportedError) commit(entry, { state: 'unavailable', reason: 'unsupported' });
    else {
      const error = cause instanceof Error ? cause : new Error('Native plan read failed');
      const plan = planOf(entry.state);
      publish(entry, plan ? { status: 'stale', plan, error } : { status: 'error', error });
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
export const loadSessionNativePlan = (sessionId: string, directory: string): Promise<NativePlanState> => (
  load(entryFor(sessionId, directory), getRegisteredRuntimeAPIs()?.nativeAgents)
);

/**
 * A turn ended, so a planning turn may have written a plan. Only a session the
 * panel has already opened is read; a session nobody is looking at allocates
 * nothing.
 */
export const refreshSessionNativePlan = (sessionId: string, directory: string): void => {
  const entry = entries.get(keyOf(getRuntimeKey(), normalizePath(directory) ?? directory, sessionId));
  if (!entry || entry.deleted) return;
  void load(entry, entry.api ?? undefined);
};

export const useSessionNativePlan = (
  sessionId: string | null | undefined,
  directory: string | null | undefined,
  { enabled = true, visible = false }: { enabled?: boolean; visible?: boolean } = {},
): NativePlanState => {
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
    if (opened || entry.state.status === 'idle' || entry.state.status === 'stale' || entry.state.status === 'error') void load(entry, nativeAgents);
    return () => {
      entry.consumers -= 1;
      if (visible) entry.visible -= 1;
      release(entry);
    };
  }, [entry, nativeAgents, enabled, visible]);
  if (entry && (!nativeAgents.supported || nativeSessionBackend(entry.sessionId, entry.directory) !== 'codex')) return UNSUPPORTED;
  return state;
};

export const clearSessionNativePlan = (sessionId: string, directory: string, runtimeKey: string): void => {
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

export const resetSessionNativePlanSource = (sessionId: string, directory: string, runtimeKey: string): void => {
  const entry = entries.get(keyOf(runtimeKey, normalizePath(directory) ?? directory, sessionId));
  if (!entry || entry.deleted || runtimeKey !== getRuntimeKey()) return;
  clearSessionNativePlan(sessionId, directory, runtimeKey);
  entry.deleted = false;
  if (entry.consumers > 0) void load(entry, entry.api ?? undefined);
};

/** Connection loss is stale data, not a thread without a plan. */
export const markSessionNativePlansStale = (): void => {
  for (const read of reads.values()) read.controller.abort();
  reads.clear();
  for (const entry of entries.values()) {
    entry.mutation += 1;
    entry.pending = null;
    const plan = planOf(entry.state);
    if (plan) publish(entry, { status: 'stale', plan, error: null });
    else if (entry.state.status === 'loading') publish(entry, IDLE);
  }
};

export const refreshSessionNativePlans = (): void => {
  markSessionNativePlansStale();
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
