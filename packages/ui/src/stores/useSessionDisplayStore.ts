import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

// 'by-worktree' keeps per-worktree sub-headers inside each project zone
// (parallel-work overview); 'flat' merges everything into one recency list.
type SessionGroupingMode = 'by-worktree' | 'flat';
type ProjectDisplayMode = 'all' | 'single';

type SessionDisplayStore = {
  projectDisplayMode: ProjectDisplayMode;
  singleProjectId: string | null;
  setProjectDisplayMode: (mode: ProjectDisplayMode) => void;
  setSingleProjectId: (projectId: string) => void;
  sessionGroupingMode: SessionGroupingMode;
  setSessionGroupingMode: (mode: SessionGroupingMode) => void;
  /** Project/recent zone headers stick to the top while their zone scrolls. */
  stickyZoneHeaders: boolean;
  toggleStickyZoneHeaders: () => void;
  showPinnedSection: boolean;
  showChatsSection: boolean;
  showRecentSection: boolean;
  // VS Code only: the compact webview keeps archived buckets inline because it
  // has no room for the full Archive page. Web/desktop ignore this flag and
  // always route archived sessions to the Archive page instead.
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  setShowPinnedSection: (show: boolean) => void;
  setShowChatsSection: (show: boolean) => void;
  setShowRecentSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  togglePinnedSection: () => void;
  toggleChatsSection: () => void;
  toggleRecentSection: () => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
  };
  const next = { ...state };
  if (version < 2) {
    next.projectSortOrder = 'manual';
  }
  if (version < 4 && next.projectSortOrder === 'recent') {
    next.projectSortOrder = 'manual';
  }
  if (version < 3) {
    next.showPinnedSection = true;
  }
  if (version < 4) {
    // v4 removes the default/minimal display mode: the sidebar now has a
    // single row layout. Drop the stale key from persisted state.
    delete next.displayMode;
  }
  if (version < 6) {
    next.showChatsSection = true;
  }
  return next;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      projectDisplayMode: 'all',
      singleProjectId: null,
      setProjectDisplayMode: (mode) => set({ projectDisplayMode: mode }),
      setSingleProjectId: (projectId) => set({ singleProjectId: projectId }),
      sessionGroupingMode: 'by-worktree',
      setSessionGroupingMode: (mode) => set({ sessionGroupingMode: mode }),
      stickyZoneHeaders: true,
      toggleStickyZoneHeaders: () => set((state) => ({ stickyZoneHeaders: !state.stickyZoneHeaders })),
      showPinnedSection: true,
      showChatsSection: true,
      showRecentSection: true,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates.
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      setShowPinnedSection: (show) => set({ showPinnedSection: show }),
      setShowChatsSection: (show) => set({ showChatsSection: show }),
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      togglePinnedSection: () => set((state) => ({ showPinnedSection: !state.showPinnedSection })),
      toggleChatsSection: () => set((state) => ({ showChatsSection: !state.showChatsSection })),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 6,
      // v1→v2 adds projectSortOrder using the canonical manual ordering.
      // v2→v3 adds the independently visible pinned section.
      // v3→v4 replaces the previously shipped recent default with manual.
      // v3→v4 removes displayMode (single sidebar row layout).
      // v4→v5 adds the independent all-projects/single-project view mode.
      // v5→v6 adds the independently visible managed Chats section.
      migrate: migrateSessionDisplayState,
    },
  ),
);

export type { ProjectDisplayMode, ProjectSortOrder };
