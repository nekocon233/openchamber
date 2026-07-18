import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Expand/collapse state for the mobile sessions sheet tree.
 *
 * Stores only explicit user overrides, keyed by project id (projects) and
 * `${projectId}::${bucketKey}` (worktree groups). A missing key means "use the
 * default": projects start expanded, worktree groups start collapsed. The
 * pinned/recent activity groups use explicit booleans and start expanded. The
 * user's choices are remembered across app restarts and are intentionally
 * decoupled from the active directory/session — selecting a session no longer
 * forces a project open or closed.
 */
type MobileSessionTreeStore = {
  projectExpanded: Record<string, boolean>;
  worktreeExpanded: Record<string, boolean>;
  pinnedSectionExpanded: boolean;
  recentSectionExpanded: boolean;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  setWorktreeExpanded: (key: string, expanded: boolean) => void;
  setPinnedSectionExpanded: (expanded: boolean) => void;
  setRecentSectionExpanded: (expanded: boolean) => void;
};

export const useMobileSessionTreeStore = create<MobileSessionTreeStore>()(
  persist(
    (set) => ({
      projectExpanded: {},
      worktreeExpanded: {},
      pinnedSectionExpanded: true,
      recentSectionExpanded: true,
      setProjectExpanded: (projectId, expanded) =>
        set((state) => ({ projectExpanded: { ...state.projectExpanded, [projectId]: expanded } })),
      setWorktreeExpanded: (key, expanded) =>
        set((state) => ({ worktreeExpanded: { ...state.worktreeExpanded, [key]: expanded } })),
      setPinnedSectionExpanded: (expanded) => set({ pinnedSectionExpanded: expanded }),
      setRecentSectionExpanded: (expanded) => set({ recentSectionExpanded: expanded }),
    }),
    {
      name: 'mobile-session-tree',
    },
  ),
);
