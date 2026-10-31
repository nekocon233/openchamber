import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { NativeAgentsAPI } from '@/lib/api/types';
import { NativeAgentsUnsupportedError } from '@/lib/native-agents/errors';
import { nativeSessionBackend } from './native-session-source';
import type { NativeChecklistItem, NativeChecklistSnapshot } from '@/lib/native-agents/task-schemas';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

type Checklist = Extract<NativeChecklistSnapshot, { state: 'ready' }>;
export type NativeChecklistState =
  | { status: 'idle' }
  | { status: 'loading'; snapshot: Checklist | null }
  | { status: 'ready' | 'partial'; snapshot: Checklist }
  | { status: 'stale'; snapshot: Checklist; error: Error | null }
  | { status: 'error'; error: Error }
  | { status: 'unsupported' }
  | { status: 'unavailable'; reason: 'source_unknown' };

const IDLE: NativeChecklistState = { status: 'idle' };
const UNSUPPORTED: NativeChecklistState = { status: 'unsupported' };
const REFRESH_MS = 45_000;
const supportsChecklist = (backend: ReturnType<typeof nativeSessionBackend>) => backend === 'claude' || backend === 'deepseek';

type Entry = {
  key: string;
  runtimeKey: string;
  generation: number;
  sessionId: string;
  directory: string;
  state: NativeChecklistState;
  mutation: number;
  serverRevision: number | null;
  identity: string | null;
  deleted: boolean;
  listeners: Set<() => void>;
  consumers: number;
  visible: number;
  api: NativeAgentsAPI | null;
  pending: Promise<NativeChecklistState> | null;
  timer: ReturnType<typeof setTimeout> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  lastReadAt: number;
};

type Read = { api: NativeAgentsAPI; controller: AbortController; promise: Promise<NativeChecklistSnapshot> };
const entries = new Map<string, Entry>();
// Only server-confirmed list identities may share reads and updates.
const lists = new Map<string, Set<Entry>>();
const reads = new Map<string, Read>();

const keyOf = (runtimeKey: string, directory: string, sessionId: string) => JSON.stringify([runtimeKey, directory, sessionId]);
const listKey = (entry: Entry, identity: string) => JSON.stringify([entry.runtimeKey, identity]);
const snapshotOf = (state: NativeChecklistState): Checklist | null => 'snapshot' in state ? state.snapshot : null;

const entryFor = (sessionId: string, directory: string, runtimeKey = getRuntimeKey(), generation = getRuntimeEndpointGeneration()): Entry => {
  const normalized = normalizePath(directory) ?? directory;
  const key = keyOf(runtimeKey, normalized, sessionId);
  let entry = entries.get(key);
  if (!entry || entry.generation !== generation) {
    entry = {
      key, runtimeKey, generation, sessionId, directory: normalized, state: IDLE, mutation: 0,
      serverRevision: null, identity: null, deleted: false, listeners: new Set(),
      consumers: 0, visible: 0, api: null, pending: null, timer: null, releaseTimer: null, lastReadAt: 0,
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
    const readKey = entry.identity ? listKey(entry, entry.identity) : entry.key;
    entry.deleted = true;
    entry.mutation += 1;
    entry.pending = null;
    stopTimer(entry);
    setIdentity(entry, null);
    entries.delete(entry.key);
    if (![...lists.get(readKey) ?? []].some((member) => member.pending)) {
      reads.get(readKey)?.controller.abort();
      reads.delete(readKey);
    }
  }, 0);
};

const publish = (entry: Entry, state: NativeChecklistState): void => {
  if (entry.state === state) return;
  entry.state = state;
  if (state.status === 'unsupported') stopTimer(entry);
  for (const listener of entry.listeners) listener();
};

const setIdentity = (entry: Entry, identity: string | null): void => {
  if (entry.identity === identity) return;
  if (entry.identity) {
    const key = listKey(entry, entry.identity);
    const members = lists.get(key);
    members?.delete(entry);
    if (members?.size === 0) lists.delete(key);
  }
  entry.identity = identity;
  entry.serverRevision = null;
  if (identity) {
    const key = listKey(entry, identity);
    let members = lists.get(key);
    if (!members) lists.set(key, members = new Set());
    members.add(entry);
  }
};

const sameStrings = (left: readonly string[], right: readonly string[]) => left.length === right.length
  && left.every((value, index) => value === right[index]);
const sameItem = (left: NativeChecklistItem, right: NativeChecklistItem) => left.id === right.id
  && left.subject === right.subject && left.status === right.status && left.description === right.description
  && left.activeForm === right.activeForm && left.owner === right.owner
  && sameStrings(left.blocks, right.blocks) && sameStrings(left.blockedBy, right.blockedBy);

const reconcile = (held: Checklist | null, incoming: Checklist): Checklist => {
  const previous = held?.identity === incoming.identity ? held : null;
  const byId = new Map(previous?.items.map((item) => [item.id, item]));
  const items = incoming.items.map((item) => {
    const old = byId.get(item.id);
    byId.delete(item.id);
    return old && sameItem(old, item) ? old : item;
  });
  // Missing files in a partial read are unknown, not deletions.
  if (!incoming.complete) items.push(...byId.values());
  const stableItems = previous && items.length === previous.items.length
    && items.every((item, index) => item === previous.items[index]) ? previous.items : items;
  if (previous && stableItems === previous.items && previous.revision === incoming.revision
    && previous.source === incoming.source && previous.observedAt === incoming.observedAt
    && previous.complete === incoming.complete && previous.unreadable === incoming.unreadable) return previous;
  return { ...incoming, items: stableItems };
};

const commit = (entry: Entry, snapshot: NativeChecklistSnapshot): void => {
  if (entry.deleted) return;
  if (snapshot.state === 'unavailable') {
    entry.mutation += 1;
    setIdentity(entry, null);
    const next: NativeChecklistState = snapshot.reason === 'unsupported'
      ? UNSUPPORTED : { status: 'unavailable', reason: snapshot.reason };
    if (entry.state.status !== next.status) publish(entry, next);
    return;
  }
  if (entry.serverRevision !== null && snapshot.revision < entry.serverRevision) return;
  entry.mutation += 1;
  setIdentity(entry, snapshot.identity);
  entry.serverRevision = snapshot.revision;
  const reconciled = reconcile(snapshotOf(entry.state), snapshot);
  const status = reconciled.complete ? 'ready' : 'partial';
  if (entry.state.status === status && snapshotOf(entry.state) === reconciled) return;
  publish(entry, { status, snapshot: reconciled });
};

/** A list update reaches only sessions already confirmed to share its identity. */
export const applySessionNativeChecklistEvent = (
  sessionId: string, directory: string, snapshot: NativeChecklistSnapshot, runtimeKey: string,
): void => {
  if (runtimeKey !== getRuntimeKey() || !normalizePath(directory) || directory === 'global') return;
  const entry = entries.get(keyOf(runtimeKey, normalizePath(directory) ?? directory, sessionId));
  const members = snapshot.state === 'ready' ? lists.get(JSON.stringify([runtimeKey, snapshot.identity])) : undefined;
  // An unopened session has no task consumer. Known shared-list members still
  // receive its event without caching every session on the global stream.
  for (const member of new Set([...(entry ? [entry] : []), ...members ?? []])) commit(member, snapshot);
};

const readSnapshot = (entry: Entry, api: NativeAgentsAPI): Promise<NativeChecklistSnapshot> => {
  const key = entry.identity ? listKey(entry, entry.identity) : entry.key;
  const held = reads.get(key);
  if (held?.api === api) return held.promise;
  const controller = new AbortController();
  const promise = (async (): Promise<NativeChecklistSnapshot> => {
    const capabilities = await api.capabilities();
    if (controller.signal.aborted) throw new DOMException('Read cancelled', 'AbortError');
    const backend = nativeSessionBackend(entry.sessionId, entry.directory);
    const supported = backend === 'deepseek' ? capabilities.backends.deepseek?.tasks?.checklist : capabilities.backends.claude.tasks?.checklist;
    if (!supported) return { state: 'unavailable', reason: 'unsupported' };
    return api.checklist(entry.sessionId, entry.directory, { signal: controller.signal });
  })().finally(() => {
    if (reads.get(key)?.promise === promise) reads.delete(key);
  });
  reads.set(key, { api, controller, promise });
  return promise;
};

const load = (entry: Entry, api: NativeAgentsAPI | undefined): Promise<NativeChecklistState> => {
  if (entry.deleted || entry.runtimeKey !== getRuntimeKey()) return Promise.resolve(IDLE);
  if (entry.pending) return entry.pending;
  if (!api?.supported || !supportsChecklist(nativeSessionBackend(entry.sessionId, entry.directory))) {
    commit(entry, { state: 'unavailable', reason: 'unsupported' });
    release(entry);
    return Promise.resolve(entry.state);
  }
  const baseline = entry.mutation;
  const runtimeGeneration = getRuntimeEndpointGeneration();
  const peers = new Map([...lists.get(listKey(entry, entry.identity ?? '')) ?? []].map((peer) => [peer, peer.mutation]));
  peers.set(entry, baseline);
  const current = () => !entry.deleted && entries.get(entry.key) === entry
    && entry.runtimeKey === getRuntimeKey() && entry.mutation === baseline && runtimeGeneration === getRuntimeEndpointGeneration();
  publish(entry, { status: 'loading', snapshot: snapshotOf(entry.state) });
  entry.lastReadAt = Date.now();
  const pending = readSnapshot(entry, api).then((snapshot) => {
    if (!current()) return entry.state;
    for (const [peer, revision] of peers) {
      if (peer.deleted || peer.mutation !== revision) continue;
      // A source change belongs only to the session which resolved it.
      if (peer !== entry && (snapshot.state !== 'ready' || snapshot.identity !== peer.identity)) continue;
      peer.lastReadAt = entry.lastReadAt;
      commit(peer, snapshot);
      release(peer);
    }
    // An older server snapshot cannot leave a refresh stuck in loading.
    if (entry.state.status === 'loading' && entry.state.snapshot) {
      publish(entry, { status: entry.state.snapshot.complete ? 'ready' : 'partial', snapshot: entry.state.snapshot });
    }
    return entry.state;
  }, (cause) => {
    if (!current()) return entry.state;
    if (cause instanceof NativeAgentsUnsupportedError) commit(entry, { state: 'unavailable', reason: 'unsupported' });
    else {
      const error = cause instanceof Error ? cause : new Error('Native checklist read failed');
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

/** Manual refresh; failures remain explicit and preserve the last valid records. */
export const loadSessionNativeChecklist = (sessionId: string, directory: string): Promise<NativeChecklistState> => (
  load(entryFor(sessionId, directory), getRegisteredRuntimeAPIs()?.nativeAgents)
);

const stopTimer = (entry: Entry): void => {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
};
const schedule = (entry: Entry): void => {
  if (entry.timer || entry.deleted || entry.visible === 0 || entry.state.status === 'unsupported' || globalThis.document?.visibilityState === 'hidden') return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const read = Date.now() - entry.lastReadAt >= REFRESH_MS ? load(entry, entry.api ?? undefined) : Promise.resolve(entry.state);
    void read.finally(() => schedule(entry));
  }, Math.max(1, REFRESH_MS - (Date.now() - entry.lastReadAt)));
};

export const useSessionNativeChecklist = (
  sessionId: string | null | undefined,
  directory: string | null | undefined,
  { enabled = true, visible = false }: { enabled?: boolean; visible?: boolean } = {},
): NativeChecklistState => {
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
    const visibility = () => {
      if (document.visibilityState === 'hidden') stopTimer(entry);
      else schedule(entry);
    };
    if (visible) document.addEventListener('visibilitychange', visibility);
    schedule(entry);
    return () => {
      entry.consumers -= 1;
      if (visible) {
        entry.visible -= 1;
        document.removeEventListener('visibilitychange', visibility);
      }
      if (entry.visible === 0) stopTimer(entry);
      release(entry);
    };
  }, [entry, nativeAgents, enabled, visible]);
  if (entry && (!nativeAgents.supported || !supportsChecklist(nativeSessionBackend(entry.sessionId, entry.directory)))) return UNSUPPORTED;
  return state;
};

export const clearSessionNativeChecklist = (sessionId: string, directory: string, runtimeKey: string): void => {
  if (runtimeKey !== getRuntimeKey()) return;
  const entry = entries.get(keyOf(runtimeKey, normalizePath(directory) ?? directory, sessionId));
  if (!entry) return;
  const readKey = entry.identity ? listKey(entry, entry.identity) : entry.key;
  entry.deleted = true;
  entry.mutation += 1;
  entry.pending = null;
  setIdentity(entry, null);
  if (![...lists.get(readKey) ?? []].some((member) => member.pending)) {
    reads.get(readKey)?.controller.abort();
    reads.delete(readKey);
  }
  stopTimer(entry);
  publish(entry, IDLE);
  release(entry);
};

export const resetSessionNativeChecklistSource = (sessionId: string, directory: string, runtimeKey: string): void => {
  const entry = entries.get(keyOf(runtimeKey, normalizePath(directory) ?? directory, sessionId));
  if (!entry || entry.deleted || runtimeKey !== getRuntimeKey()) return;
  clearSessionNativeChecklist(sessionId, directory, runtimeKey);
  entry.deleted = false;
  entry.lastReadAt = 0;
  if (entry.consumers > 0) void load(entry, entry.api ?? undefined);
};

/** Connection loss is stale data, not a successful empty list. */
export const markSessionNativeChecklistsStale = (): void => {
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
export const refreshSessionNativeChecklists = (): void => {
  markSessionNativeChecklistsStale();
  for (const entry of entries.values()) if (entry.consumers > 0) void load(entry, entry.api ?? undefined);
};

subscribeRuntimeEndpointWillChange(() => {
  for (const read of reads.values()) read.controller.abort();
  reads.clear();
  for (const entry of entries.values()) {
    entry.deleted = true;
    entry.mutation += 1;
    stopTimer(entry);
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    publish(entry, IDLE);
  }
  entries.clear();
  lists.clear();
});
