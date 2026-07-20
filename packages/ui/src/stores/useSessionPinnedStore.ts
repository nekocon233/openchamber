import { create } from 'zustand';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useSidebarStateStore } from './useSidebarStateStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

const readPinned = (storage: Storage): Set<string> => {
  try {
    const raw = storage.getItem(SESSION_PINNED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
};

const persistPinned = (storage: Storage, ids: Set<string>): void => {
  try {
    storage.setItem(SESSION_PINNED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
};

const setsEqual = (left: Set<string>, right: Set<string>): boolean => (
  left.size === right.size && [...left].every((id) => right.has(id))
);

const usesAuthoritativeSidebarState = (): boolean => (
  getRegisteredRuntimeAPIs()?.sidebarState?.supported === true
);

type SessionPinnedStore = {
  ids: Set<string>;
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (sessionId: string) => void;
};

const safeStorage = getDeferredSafeStorage();

export const useSessionPinnedStore = create<SessionPinnedStore>((set, get) => ({
  ids: readPinned(safeStorage),
  setIds: (next) => {
    const current = get().ids;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (resolved === current || setsEqual(resolved, current)) return;
    set({ ids: resolved });

    if (usesAuthoritativeSidebarState()) {
      for (const sessionId of current) {
        if (!resolved.has(sessionId)) {
          void useSidebarStateStore.getState().mutate({ type: 'session.unpin', sessionId }).catch(() => {});
        }
      }
      for (const sessionId of resolved) {
        if (!current.has(sessionId)) {
          void useSidebarStateStore.getState().mutate({ type: 'session.pin', sessionId }).catch(() => {});
        }
      }
      return;
    }

    persistPinned(safeStorage, resolved);
  },
  toggle: (sessionId) => {
    const current = get().ids;
    const next = new Set(current);
    if (next.has(sessionId)) {
      next.delete(sessionId);
    } else {
      next.add(sessionId);
    }
    get().setIds(next);
  },
}));

const synchronizePinnedSessionsFromSidebarState = (): void => {
  const snapshot = useSidebarStateStore.getState().snapshot;
  if (!snapshot) return;
  const current = useSessionPinnedStore.getState().ids;
  const next = new Set(snapshot.pinnedSessionIds);
  if (!setsEqual(current, next)) {
    useSessionPinnedStore.setState({ ids: next });
  }
};

useSidebarStateStore.subscribe((state, previousState) => {
  if (state.snapshot) {
    synchronizePinnedSessionsFromSidebarState();
    return;
  }
  if (state.runtimeKey !== previousState.runtimeKey && previousState.snapshot) {
    useSessionPinnedStore.setState({ ids: new Set() });
  }
});
