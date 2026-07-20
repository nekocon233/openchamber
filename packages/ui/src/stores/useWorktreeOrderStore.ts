import { create } from 'zustand';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { normalizeSidebarPath } from '@/lib/sidebarState';
import type { WorktreeMetadata } from '@/types/worktree';
import { useSidebarStateStore } from './useSidebarStateStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

const WORKTREE_ORDER_STORAGE_KEY = 'mobile-worktree-order';

/**
 * Persisted display order for worktrees within a project, mirroring how
 * projects persist their order (the array position IS the order). Keyed by
 * project id, the value is an ordered list of normalized worktree paths.
 *
 * Worktrees come from git and are otherwise listed alphabetically; this store
 * lets the user reorder them (e.g. in the mobile project editor) and have that
 * order stick across restarts.
 */
type WorktreeOrderStore = {
  orderByProject: Record<string, string[]>;
  moveWorktree: (projectId: string, path: string, toIndex: number, orderedPaths: string[]) => void;
};

const safeStorage = getDeferredSafeStorage();

const parseOrderMap = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [projectId, paths] of Object.entries(value)) {
    if (!Array.isArray(paths)) continue;
    const validPaths = paths.filter((path): path is string => typeof path === 'string');
    if (validPaths.length > 0) result[projectId] = validPaths;
  }
  return result;
};

const readPersistedOrder = (): Record<string, string[]> => {
  try {
    const raw = safeStorage.getItem(WORKTREE_ORDER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const state = record.state;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      return parseOrderMap((state as Record<string, unknown>).orderByProject);
    }
    return parseOrderMap(record);
  } catch {
    return {};
  }
};

const persistOrder = (orderByProject: Record<string, string[]>): void => {
  try {
    safeStorage.setItem(WORKTREE_ORDER_STORAGE_KEY, JSON.stringify({
      state: { orderByProject },
      version: 0,
    }));
  } catch {
    // ignored
  }
};

const usesAuthoritativeSidebarState = (): boolean => (
  getRegisteredRuntimeAPIs()?.sidebarState?.supported === true
);

export const useWorktreeOrderStore = create<WorktreeOrderStore>((set, get) => ({
  orderByProject: readPersistedOrder(),
  moveWorktree: (projectId, path, toIndex, orderedPaths) => {
    let normalizedPath: string;
    let normalizedOrder: string[];
    try {
      normalizedPath = normalizeSidebarPath(path);
      normalizedOrder = [...new Set(orderedPaths.map(normalizeSidebarPath))];
    } catch {
      return;
    }
    const fromIndex = normalizedOrder.indexOf(normalizedPath);
    if (fromIndex < 0 || toIndex < 0 || toIndex >= normalizedOrder.length || fromIndex === toIndex) return;

    const nextOrder = [...normalizedOrder];
    const [movedPath] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, movedPath);
    const nextMap = { ...get().orderByProject, [projectId]: nextOrder };
    set({ orderByProject: nextMap });

    if (usesAuthoritativeSidebarState()) {
      void useSidebarStateStore.getState().mutate({
        type: 'worktree.move',
        projectId,
        path: normalizedPath,
        toIndex,
        orderedPaths: normalizedOrder,
      }).catch(() => {});
      return;
    }
    persistOrder(nextMap);
  },
}));

const normalizeWorktreePath = (value: string): string => {
  try {
    return normalizeSidebarPath(value);
  } catch {
    return value.replace(/\\/g, '/').replace(/\/+$/, '');
  }
};

/**
 * Stable-sort worktrees by a stored order of paths. Worktrees not present in
 * the stored order keep their incoming (alphabetical) order, appended after
 * the known ones.
 */
export const orderWorktrees = (
  orderedPaths: string[] | undefined,
  worktrees: WorktreeMetadata[],
): WorktreeMetadata[] => {
  if (!orderedPaths || orderedPaths.length === 0) return worktrees;
  const rank = new Map(orderedPaths.map((path, index) => [normalizeWorktreePath(path), index] as const));
  const rankOf = (worktree: WorktreeMetadata): number =>
    rank.get(normalizeWorktreePath(worktree.path)) ?? Number.MAX_SAFE_INTEGER;
  return worktrees
    .map((worktree, index) => ({ worktree, index }))
    .sort((a, b) => {
      const byRank = rankOf(a.worktree) - rankOf(b.worktree);
      // Preserve incoming order for ties (unknown worktrees / equal ranks).
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map((entry) => entry.worktree);
};

const synchronizeWorktreeOrderFromSidebarState = (): void => {
  const snapshot = useSidebarStateStore.getState().snapshot;
  if (!snapshot) return;
  const current = useWorktreeOrderStore.getState().orderByProject;
  const next = snapshot.worktreeOrderByProject;
  const currentProjectIds = Object.keys(current);
  const nextProjectIds = Object.keys(next);
  const equal = currentProjectIds.length === nextProjectIds.length
    && currentProjectIds.every((projectId) => {
      const currentPaths = current[projectId];
      const nextPaths = next[projectId];
      return Boolean(nextPaths)
        && currentPaths.length === nextPaths.length
        && currentPaths.every((path, index) => path === nextPaths[index]);
    });
  if (!equal) useWorktreeOrderStore.setState({ orderByProject: next });
};

useSidebarStateStore.subscribe((state, previousState) => {
  if (state.snapshot) {
    synchronizeWorktreeOrderFromSidebarState();
    return;
  }
  if (state.runtimeKey !== previousState.runtimeKey && previousState.snapshot) {
    useWorktreeOrderStore.setState({ orderByProject: {} });
  }
});
