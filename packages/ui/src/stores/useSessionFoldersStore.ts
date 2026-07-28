import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { SidebarStateOperation } from '@/lib/api/types';
import { normalizeSidebarFolderScope } from '@/lib/sidebarState';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSidebarStateStore } from './useSidebarStateStore';
import { getDeferredSafeStorage, getSafeStorage } from './utils/safeStorage';

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  /** If set, this folder is a sub-folder of the parent folder with this id. */
  parentId?: string | null;
}

export type SessionFoldersMap = Record<string, SessionFolder[]>;

interface SessionFoldersState {
  foldersMap: SessionFoldersMap;
  collapsedFolderIds: Set<string>;
}

interface SessionFoldersActions {
  getFoldersForScope: (scopeKey: string) => SessionFolder[];
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => SessionFolder;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  removeSessionEverywhere: (runtimeKey: string, sessionId: string) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  toggleFolderCollapse: (folderId: string) => void;
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

type SessionFoldersStore = SessionFoldersState & SessionFoldersActions;

const FOLDERS_STORAGE_KEY = 'oc.sessions.folders';
const COLLAPSED_STORAGE_KEY = 'oc.sessions.folderCollapse';
const STORAGE_INDEX_KEY = 'oc.sessions.folders.v2.index';
const LOCAL_PERSIST_DEBOUNCE_MS = 300;

const safeStorage = getDeferredSafeStorage();
const immediateSafeStorage = getSafeStorage();
let activeFolderRuntimeKey = getRuntimeKey();
let persistFoldersTimer: ReturnType<typeof setTimeout> | undefined;
let persistCollapsedTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFoldersMap: SessionFoldersMap | null = null;
let pendingCollapsedIds: Set<string> | null = null;
let pendingBrowserRuntimeKey: string | null = null;

type FolderStorageIndex = {
  version: 2;
  legacyClaimed: boolean;
  runtimes: Array<{ runtimeKey: string; updatedAt: number }>;
};

const runtimeStorageKey = (base: string, runtimeKey: string): string => (
  `${base}.v2:${encodeURIComponent(runtimeKey)}`
);

const readStorageIndex = (): FolderStorageIndex => {
  try {
    const parsed = JSON.parse(safeStorage.getItem(STORAGE_INDEX_KEY) ?? '') as Partial<FolderStorageIndex>;
    return parsed.version === 2 && Array.isArray(parsed.runtimes)
      ? { version: 2, legacyClaimed: Boolean(parsed.legacyClaimed), runtimes: parsed.runtimes }
      : { version: 2, legacyClaimed: false, runtimes: [] };
  } catch {
    return { version: 2, legacyClaimed: false, runtimes: [] };
  }
};

const touchRuntimeStorage = (
  runtimeKey: string,
  updatedAt = Date.now(),
  targetStorage: Storage = safeStorage,
): void => {
  const index = readStorageIndex();
  const runtimes = [
    { runtimeKey, updatedAt },
    ...index.runtimes.filter((entry) => entry.runtimeKey !== runtimeKey),
  ];
  targetStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify({
    version: 2,
    legacyClaimed: index.legacyClaimed,
    runtimes,
  }));
};

const claimLegacyStorage = (runtimeKey: string): void => {
  const index = readStorageIndex();
  if (index.legacyClaimed) return;
  const legacyFolders = safeStorage.getItem(FOLDERS_STORAGE_KEY);
  const legacyCollapsed = safeStorage.getItem(COLLAPSED_STORAGE_KEY);
  if (legacyFolders) safeStorage.setItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey), legacyFolders);
  if (legacyCollapsed) safeStorage.setItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey), legacyCollapsed);
  const next = { ...index, legacyClaimed: true };
  const serialized = JSON.stringify(next);
  safeStorage.setItem(STORAGE_INDEX_KEY, serialized);
  if (safeStorage.getItem(STORAGE_INDEX_KEY) === serialized) {
    safeStorage.removeItem(FOLDERS_STORAGE_KEY);
    safeStorage.removeItem(COLLAPSED_STORAGE_KEY);
  }
  touchRuntimeStorage(runtimeKey, 0);
};

const usesAuthoritativeSidebarState = (): boolean => (
  getRegisteredRuntimeAPIs()?.sidebarState?.supported === true
);

const normalizeScopeKey = (scopeKey: string): string | null => {
  try {
    return normalizeSidebarFolderScope(scopeKey);
  } catch {
    return null;
  }
};

const readPersistedFolders = (runtimeKey = activeFolderRuntimeKey): SessionFoldersMap => {
  try {
    claimLegacyStorage(runtimeKey);
    const raw = safeStorage.getItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: SessionFoldersMap = {};
    for (const [rawScopeKey, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const scopeKey = normalizeScopeKey(rawScopeKey);
      if (!scopeKey) continue;
      const folders: SessionFolder[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const candidate = entry as Record<string, unknown>;
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
          ? candidate.createdAt
          : 0;
        if (!id || !name) continue;
        const sessionIds = Array.isArray(candidate.sessionIds)
          ? candidate.sessionIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        const parentId = typeof candidate.parentId === 'string' ? candidate.parentId : null;
        folders.push({ id, name, sessionIds, createdAt, parentId });
      }
      if (folders.length > 0) result[scopeKey] = folders;
    }
    return result;
  } catch {
    return {};
  }
};

const readPersistedCollapsed = (runtimeKey = activeFolderRuntimeKey): Set<string> => {
  try {
    claimLegacyStorage(runtimeKey);
    const raw = safeStorage.getItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
};

const persistFolders = (foldersMap: SessionFoldersMap): void => {
  pendingFoldersMap = foldersMap;
  pendingBrowserRuntimeKey = activeFolderRuntimeKey;
  clearTimeout(persistFoldersTimer);
  persistFoldersTimer = setTimeout(() => {
    const runtimeKey = pendingBrowserRuntimeKey ?? activeFolderRuntimeKey;
    try {
      safeStorage.setItem(
        runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey),
        JSON.stringify(pendingFoldersMap ?? {}),
      );
      touchRuntimeStorage(runtimeKey);
    } catch {
      // ignored
    }
    pendingFoldersMap = null;
    if (pendingCollapsedIds === null) pendingBrowserRuntimeKey = null;
  }, LOCAL_PERSIST_DEBOUNCE_MS);
};

const persistCollapsed = (collapsedFolderIds: Set<string>): void => {
  pendingCollapsedIds = collapsedFolderIds;
  pendingBrowserRuntimeKey = activeFolderRuntimeKey;
  clearTimeout(persistCollapsedTimer);
  persistCollapsedTimer = setTimeout(() => {
    const runtimeKey = pendingBrowserRuntimeKey ?? activeFolderRuntimeKey;
    try {
      safeStorage.setItem(
        runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey),
        JSON.stringify(Array.from(pendingCollapsedIds ?? [])),
      );
      touchRuntimeStorage(runtimeKey);
    } catch {
      // ignored
    }
    pendingCollapsedIds = null;
    if (pendingFoldersMap === null) pendingBrowserRuntimeKey = null;
  }, LOCAL_PERSIST_DEBOUNCE_MS);
};

const persistLocalState = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): void => {
  if (!usesAuthoritativeSidebarState()) persistFolders(foldersMap);
  persistCollapsed(collapsedFolderIds);
};

const flushPendingBrowserPersistence = (): void => {
  if (persistFoldersTimer) clearTimeout(persistFoldersTimer);
  if (persistCollapsedTimer) clearTimeout(persistCollapsedTimer);
  persistFoldersTimer = undefined;
  persistCollapsedTimer = undefined;

  const runtimeKey = pendingBrowserRuntimeKey ?? activeFolderRuntimeKey;
  let wrote = false;
  if (pendingFoldersMap !== null) {
    const key = runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey);
    const value = JSON.stringify(pendingFoldersMap);
    safeStorage.setItem(key, value);
    immediateSafeStorage.setItem(key, value);
    pendingFoldersMap = null;
    wrote = true;
  }
  if (pendingCollapsedIds !== null) {
    const key = runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey);
    const value = JSON.stringify(Array.from(pendingCollapsedIds));
    safeStorage.setItem(key, value);
    immediateSafeStorage.setItem(key, value);
    pendingCollapsedIds = null;
    wrote = true;
  }
  if (wrote) {
    const updatedAt = Date.now();
    touchRuntimeStorage(runtimeKey, updatedAt);
    touchRuntimeStorage(runtimeKey, updatedAt, immediateSafeStorage);
  }
  pendingBrowserRuntimeKey = null;
};

if (typeof window !== 'undefined') {
  const flushPending = () => {
    try {
      flushPendingBrowserPersistence();
    } catch {
      // Deferred storage retains failed writes.
    }
  };
  window.addEventListener('pagehide', flushPending, { capture: true });
  window.addEventListener('beforeunload', flushPending, { capture: true });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPending();
    });
    document.addEventListener('freeze', flushPending);
  }
}

const createFolderId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const removeCollapsedFolderIds = (
  collapsedFolderIds: Set<string>,
  removedFolderIds: Set<string>,
): Set<string> | null => {
  if (![...removedFolderIds].some((folderId) => collapsedFolderIds.has(folderId))) return null;
  const next = new Set(collapsedFolderIds);
  removedFolderIds.forEach((folderId) => next.delete(folderId));
  return next;
};

const submitSidebarOperation = (operation: SidebarStateOperation): void => {
  if (!usesAuthoritativeSidebarState()) return;
  void useSidebarStateStore.getState().mutate(operation).catch(() => {});
};

export const useSessionFoldersStore = create<SessionFoldersStore>()(
  devtools((set, get) => ({
    foldersMap: readPersistedFolders(),
    collapsedFolderIds: readPersistedCollapsed(),

    resetForRuntimeSwitch: (runtimeKey) => {
      try {
        flushPendingBrowserPersistence();
      } catch {
        // Deferred storage retains failed writes.
      }
      activeFolderRuntimeKey = runtimeKey;
      set({
        foldersMap: usesAuthoritativeSidebarState() ? {} : readPersistedFolders(runtimeKey),
        collapsedFolderIds: readPersistedCollapsed(runtimeKey),
      });
    },

    getFoldersForScope: (rawScopeKey) => {
      const scopeKey = normalizeScopeKey(rawScopeKey);
      return scopeKey ? get().foldersMap[scopeKey] ?? [] : [];
    },

    createFolder: (rawScopeKey, name, parentId) => {
      const scopeKey = normalizeScopeKey(rawScopeKey) ?? rawScopeKey;
      const folder: SessionFolder = {
        id: createFolderId(),
        name: name.trim() || 'New folder',
        sessionIds: [],
        createdAt: Date.now(),
        parentId: parentId ?? null,
      };
      const current = get().foldersMap;
      const nextMap = { ...current, [scopeKey]: [...(current[scopeKey] ?? []), folder] };
      set({ foldersMap: nextMap });
      persistLocalState(nextMap, get().collapsedFolderIds);
      submitSidebarOperation({
        type: 'folder.create',
        scopeKey,
        folder: {
          id: folder.id,
          name: folder.name,
          createdAt: folder.createdAt,
          parentId: folder.parentId ?? null,
        },
      });
      return folder;
    },

    renameFolder: (rawScopeKey, folderId, name) => {
      const scopeKey = normalizeScopeKey(rawScopeKey);
      const trimmed = name.trim();
      if (!scopeKey || !trimmed) return;
      const current = get().foldersMap;
      const folders = current[scopeKey];
      const folder = folders?.find((entry) => entry.id === folderId);
      if (!folder || folder.name === trimmed) return;
      const nextMap = {
        ...current,
        [scopeKey]: folders.map((entry) => entry.id === folderId ? { ...entry, name: trimmed } : entry),
      };
      set({ foldersMap: nextMap });
      persistLocalState(nextMap, get().collapsedFolderIds);
      submitSidebarOperation({ type: 'folder.rename', scopeKey, folderId, name: trimmed });
    },

    deleteFolder: (rawScopeKey, folderId) => {
      const scopeKey = normalizeScopeKey(rawScopeKey);
      if (!scopeKey) return;
      const current = get().foldersMap;
      const folders = current[scopeKey];
      if (!folders?.some((folder) => folder.id === folderId)) return;

      const removedFolderIds = new Set([folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of folders) {
          if (folder.parentId && removedFolderIds.has(folder.parentId) && !removedFolderIds.has(folder.id)) {
            removedFolderIds.add(folder.id);
            changed = true;
          }
        }
      }
      const remaining = folders.filter((folder) => !removedFolderIds.has(folder.id));
      const nextMap = { ...current };
      if (remaining.length > 0) nextMap[scopeKey] = remaining;
      else delete nextMap[scopeKey];
      const nextCollapsed = removeCollapsedFolderIds(get().collapsedFolderIds, removedFolderIds);
      set(nextCollapsed
        ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
        : { foldersMap: nextMap });
      persistLocalState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      submitSidebarOperation({ type: 'folder.delete', scopeKey, folderId });
    },

    addSessionToFolder: (scopeKey, folderId, sessionId) => {
      get().addSessionsToFolder(scopeKey, folderId, [sessionId]);
    },

    addSessionsToFolder: (rawScopeKey, folderId, sessionIds) => {
      const scopeKey = normalizeScopeKey(rawScopeKey);
      if (!scopeKey || !folderId) return;
      const ids = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) return;
      const current = get().foldersMap;
      const folders = current[scopeKey];
      const target = folders?.find((folder) => folder.id === folderId);
      if (!folders || !target) return;

      const assignedIds = new Set(ids);
      const alreadyAssignedOnlyToTarget = ids.every((sessionId) => (
        target.sessionIds.includes(sessionId)
        && folders.every((folder) => folder.id === folderId || !folder.sessionIds.includes(sessionId))
      ));
      if (alreadyAssignedOnlyToTarget) return;

      const nextFolders = folders.map((folder) => {
        const remaining = folder.sessionIds.filter((sessionId) => !assignedIds.has(sessionId));
        return folder.id === folderId
          ? { ...folder, sessionIds: [...remaining, ...ids] }
          : remaining.length === folder.sessionIds.length ? folder : { ...folder, sessionIds: remaining };
      });
      const nextMap = { ...current, [scopeKey]: nextFolders };
      set({ foldersMap: nextMap });
      persistLocalState(nextMap, get().collapsedFolderIds);
      submitSidebarOperation({ type: 'folder.assign', scopeKey, folderId, sessionIds: ids });
    },

    removeSessionFromFolder: (scopeKey, sessionId) => {
      get().removeSessionsFromFolders(scopeKey, [sessionId]);
    },

    removeSessionsFromFolders: (rawScopeKey, sessionIds) => {
      const scopeKey = normalizeScopeKey(rawScopeKey);
      if (!scopeKey) return;
      const ids = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) return;
      const current = get().foldersMap;
      const folders = current[scopeKey];
      if (!folders) return;

      const removedIds = new Set(ids);
      let changed = false;
      const nextFolders = folders.map((folder) => {
        const remaining = folder.sessionIds.filter((sessionId) => !removedIds.has(sessionId));
        if (remaining.length === folder.sessionIds.length) return folder;
        changed = true;
        return { ...folder, sessionIds: remaining };
      });
      if (!changed) return;
      const nextMap = { ...current, [scopeKey]: nextFolders };
      set({ foldersMap: nextMap });
      persistLocalState(nextMap, get().collapsedFolderIds);
      submitSidebarOperation({ type: 'folder.unassign', scopeKey, sessionIds: ids });
    },

    removeSessionEverywhere: (runtimeKey, sessionId) => {
      if (!runtimeKey || runtimeKey !== activeFolderRuntimeKey || runtimeKey !== getRuntimeKey() || !sessionId) return;
      const current = get().foldersMap;
      let nextMap: SessionFoldersMap | null = null;
      const changedScopes: string[] = [];

      for (const [scopeKey, folders] of Object.entries(current)) {
        let scopeChanged = false;
        const nextFolders = folders.map((folder) => {
          const sessionIds = folder.sessionIds.filter((id) => id !== sessionId);
          if (sessionIds.length === folder.sessionIds.length) return folder;
          scopeChanged = true;
          return { ...folder, sessionIds };
        });
        if (!scopeChanged) continue;
        nextMap ??= { ...current };
        nextMap[scopeKey] = nextFolders;
        changedScopes.push(scopeKey);
      }

      if (!nextMap) return;
      set({ foldersMap: nextMap });
      if (!usesAuthoritativeSidebarState()) persistFolders(nextMap);
      for (const scopeKey of changedScopes) {
        submitSidebarOperation({ type: 'folder.unassign', scopeKey, sessionIds: [sessionId] });
      }
    },

    toggleFolderCollapse: (folderId) => {
      const next = new Set(get().collapsedFolderIds);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      set({ collapsedFolderIds: next });
      persistCollapsed(next);
    },

    getSessionFolderId: (rawScopeKey, sessionId) => {
      const scopeKey = normalizeScopeKey(rawScopeKey);
      if (!scopeKey || !sessionId) return null;
      return get().foldersMap[scopeKey]?.find((folder) => folder.sessionIds.includes(sessionId))?.id ?? null;
    },
  }), { name: 'session-folders-store' }),
);

const foldersEqual = (left: SessionFolder[], right: SessionFolder[]): boolean => (
  left.length === right.length && left.every((folder, index) => {
    const candidate = right[index];
    return candidate
      && folder.id === candidate.id
      && folder.name === candidate.name
      && folder.createdAt === candidate.createdAt
      && (folder.parentId ?? null) === (candidate.parentId ?? null)
      && folder.sessionIds.length === candidate.sessionIds.length
      && folder.sessionIds.every((sessionId, sessionIndex) => sessionId === candidate.sessionIds[sessionIndex]);
  })
);

const folderMapsEqual = (left: SessionFoldersMap, right: SessionFoldersMap): boolean => {
  const leftScopes = Object.keys(left);
  const rightScopes = Object.keys(right);
  return leftScopes.length === rightScopes.length
    && leftScopes.every((scopeKey) => Boolean(right[scopeKey]) && foldersEqual(left[scopeKey], right[scopeKey]));
};

const synchronizeFoldersFromSidebarState = (): void => {
  const snapshot = useSidebarStateStore.getState().snapshot;
  if (!snapshot) return;
  const current = useSessionFoldersStore.getState();
  const nextMap: SessionFoldersMap = snapshot.sessionFoldersByScope;
  const validFolderIds = new Set(Object.values(nextMap).flat().map((folder) => folder.id));
  const nextCollapsed = new Set([...current.collapsedFolderIds].filter((folderId) => validFolderIds.has(folderId)));
  const mapChanged = !folderMapsEqual(current.foldersMap, nextMap);
  const collapsedChanged = nextCollapsed.size !== current.collapsedFolderIds.size;
  if (!mapChanged && !collapsedChanged) return;
  useSessionFoldersStore.setState({
    ...(mapChanged ? { foldersMap: nextMap } : {}),
    ...(collapsedChanged ? { collapsedFolderIds: nextCollapsed } : {}),
  });
  if (collapsedChanged) persistCollapsed(nextCollapsed);
};

useSidebarStateStore.subscribe((state, previousState) => {
  if (state.snapshot) {
    synchronizeFoldersFromSidebarState();
    return;
  }
  if (state.runtimeKey !== previousState.runtimeKey) {
    try {
      flushPendingBrowserPersistence();
    } catch {
      // Deferred storage retains failed writes.
    }
    activeFolderRuntimeKey = state.runtimeKey;
    useSessionFoldersStore.setState({
      foldersMap: usesAuthoritativeSidebarState() ? {} : readPersistedFolders(state.runtimeKey),
      collapsedFolderIds: readPersistedCollapsed(state.runtimeKey),
    });
  }
});
