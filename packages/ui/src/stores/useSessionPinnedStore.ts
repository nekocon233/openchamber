import { create } from 'zustand';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSidebarStateStore } from './useSidebarStateStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

const STORAGE_KEY = 'oc.sessions.pinned.v2';
const LEGACY_STORAGE_KEY = 'oc.sessions.pinned';

export type SessionPinnedTarget = { directory: string; sessionId: string };

type PersistedPins = { version: 2; sessions: Record<string, number> };

const setsEqual = (left: Set<string>, right: Set<string>): boolean => (
  left.size === right.size && [...left].every((id) => right.has(id))
);

const usesAuthoritativeSidebarState = (): boolean => (
  getRegisteredRuntimeAPIs()?.sidebarState?.supported === true
);

type PinnedSessionState = {
  ids: Set<string>;
  touchedAt: Record<string, number>;
};

type SessionPinnedStore = PinnedSessionState & {
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (target: SessionPinnedTarget | string) => void;
  clearPinnedSession: (runtimeKey: string, directory: string, sessionId: string) => void;
};

const storage = getDeferredSafeStorage();

export const getPinnedSessionKey = (runtimeKey: string, directory: string, sessionId: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionId]);
};

const parsePinnedSessionKey = (key: string): [string, string, string] | null => {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [runtimeKey, directory, sessionId] = parsed;
    if (typeof runtimeKey !== 'string' || typeof directory !== 'string' || typeof sessionId !== 'string') return null;
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || normalizedDirectory !== directory || !sessionId) return null;
    return [runtimeKey, normalizedDirectory, sessionId];
  } catch {
    return null;
  }
};

export const isSessionPinned = (ids: Set<string>, directory: string | null | undefined, sessionId: string): boolean => {
  if (ids.has(sessionId)) return true;
  if (!directory) return false;
  const key = getPinnedSessionKey(getRuntimeKey(), directory, sessionId);
  return key ? ids.has(key) : false;
};

const readPinned = (): PinnedSessionState => {
  storage.removeItem(LEGACY_STORAGE_KEY);
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return { ids: new Set(), touchedAt: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPins>;
    if (parsed.version !== 2 || !parsed.sessions || typeof parsed.sessions !== 'object') return { ids: new Set(), touchedAt: {} };
    const entries = Object.entries(parsed.sessions)
      .filter(([key, touchedAt]) => parsePinnedSessionKey(key) && typeof touchedAt === 'number' && Number.isFinite(touchedAt))
      .sort((left, right) => right[1] - left[1]);
    return { ids: new Set(entries.map(([key]) => key)), touchedAt: Object.fromEntries(entries) };
  } catch {
    storage.removeItem(STORAGE_KEY);
    return { ids: new Set(), touchedAt: {} };
  }
};

const boundPinnedState = (ids: Set<string>, touchedAt: Record<string, number>): PinnedSessionState => {
  const entries = [...ids]
    .filter((key) => parsePinnedSessionKey(key) !== null)
    .map((key) => [key, touchedAt[key] ?? Date.now()] as const)
    .sort((left, right) => right[1] - left[1]);
  return {
    ids: new Set(entries.map(([key]) => key)),
    touchedAt: Object.fromEntries(entries),
  };
};

const persistPinned = ({ ids, touchedAt }: PinnedSessionState): void => {
  const sessions = Object.fromEntries([...ids].map((key) => [key, touchedAt[key] ?? Date.now()]));
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, sessions }));
};

const getSharedSessionIds = (ids: Set<string>): Set<string> => {
  const result = new Set<string>();
  const runtimeKey = getRuntimeKey();
  for (const id of ids) {
    const parsed = parsePinnedSessionKey(id);
    if (!parsed) result.add(id);
    else if (parsed[0] === runtimeKey) result.add(parsed[2]);
  }
  return result;
};

const submitSharedPinChanges = (current: Set<string>, next: Set<string>): void => {
  for (const sessionId of current) {
    if (!next.has(sessionId)) {
      void useSidebarStateStore.getState().mutate({ type: 'session.unpin', sessionId }).catch(() => {});
    }
  }
  for (const sessionId of next) {
    if (!current.has(sessionId)) {
      void useSidebarStateStore.getState().mutate({ type: 'session.pin', sessionId }).catch(() => {});
    }
  }
};

const initial = readPinned();

export const useSessionPinnedStore = create<SessionPinnedStore>((set, get) => ({
  ids: initial.ids,
  touchedAt: initial.touchedAt,
  setIds: (next) => {
    const current = get().ids;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (usesAuthoritativeSidebarState()) {
      const currentShared = getSharedSessionIds(current);
      const nextShared = getSharedSessionIds(resolved);
      if (setsEqual(currentShared, nextShared)) return;
      set({ ids: nextShared, touchedAt: {} });
      submitSharedPinChanges(currentShared, nextShared);
      return;
    }

    if (resolved === current || setsEqual(resolved, current)) return;
    const pinnedState = boundPinnedState(resolved, get().touchedAt);
    set(pinnedState);
    persistPinned(pinnedState);
  },
  toggle: (target) => {
    const authoritative = usesAuthoritativeSidebarState();
    const sessionId = typeof target === 'string' ? target : target.sessionId;
    if (authoritative) {
      const ids = getSharedSessionIds(get().ids);
      if (ids.has(sessionId)) ids.delete(sessionId);
      else ids.add(sessionId);
      get().setIds(ids);
      return;
    }
    const key = typeof target === 'string'
      ? null
      : getPinnedSessionKey(getRuntimeKey(), target.directory, sessionId);
    if (!key) return;
    const ids = new Set(get().ids);
    const touchedAt = { ...get().touchedAt };
    if (ids.has(key)) {
      ids.delete(key);
      delete touchedAt[key];
    } else {
      ids.add(key);
      touchedAt[key] = Date.now();
    }
    const pinnedState = boundPinnedState(ids, touchedAt);
    set(pinnedState);
    persistPinned(pinnedState);
  },
  clearPinnedSession: (runtimeKey, directory, sessionId) => {
    if (usesAuthoritativeSidebarState()) {
      const ids = getSharedSessionIds(get().ids);
      if (runtimeKey !== getRuntimeKey() || !ids.has(sessionId)) return;
      ids.delete(sessionId);
      get().setIds(ids);
      return;
    }
    const key = getPinnedSessionKey(runtimeKey, directory, sessionId);
    if (!key || !get().ids.has(key)) return;
    const ids = new Set(get().ids);
    ids.delete(key);
    get().setIds(ids);
  },
}));

const synchronizePinnedSessionsFromSidebarState = (): void => {
  const snapshot = useSidebarStateStore.getState().snapshot;
  if (!snapshot) return;
  const current = useSessionPinnedStore.getState().ids;
  const next = new Set(snapshot.pinnedSessionIds);
  if (!setsEqual(current, next)) {
    useSessionPinnedStore.setState({ ids: next, touchedAt: {} });
  }
};

useSidebarStateStore.subscribe((state, previousState) => {
  if (state.snapshot) {
    synchronizePinnedSessionsFromSidebarState();
    return;
  }
  if (state.runtimeKey !== previousState.runtimeKey && previousState.snapshot) {
    useSessionPinnedStore.setState(
      usesAuthoritativeSidebarState()
        ? { ids: new Set(), touchedAt: {} }
        : readPinned(),
    );
  }
});
