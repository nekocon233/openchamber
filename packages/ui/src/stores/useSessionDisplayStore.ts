import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type SessionDisplayMode = 'default' | 'minimal';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

type SessionDisplayStore = {
  displayMode: SessionDisplayMode;
  showPinnedSection: boolean;
  showRecentSection: boolean;
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  setDisplayMode: (mode: SessionDisplayMode) => void;
  setShowPinnedSection: (show: boolean) => void;
  setShowRecentSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  togglePinnedSection: () => void;
  toggleRecentSection: () => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
};

export const migrateSessionDisplayStore = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore>;
  let next = state;
  if (version < 1) {
    next = { ...next, displayMode: 'minimal', projectSortOrder: 'recent' };
  }
  if (version < 2) {
    next = { ...next, projectSortOrder: 'recent' };
  }
  if (version < 3) {
    next = { ...next, showPinnedSection: true };
  }
  return next;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      displayMode: 'minimal',
      showPinnedSection: true,
      showRecentSection: true,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates. Users who opted into
      // showing archived have `true` persisted, which is preserved on rehydrate.
      showArchivedSessions: false,
      projectSortOrder: 'recent',
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setShowPinnedSection: (show) => set({ showPinnedSection: show }),
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      togglePinnedSection: () => set((state) => ({ showPinnedSection: !state.showPinnedSection })),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 3,
      // v0 shipped 'default' as the only/initial mode, so most existing users
      // have it persisted by accident rather than choice. Nudge everyone onto
      // minimal once so the mode can be evaluated before removing it entirely.
      // v1→v2 adds projectSortOrder defaulting to 'recent'.
      // v2→v3 adds the independently visible pinned section.
      migrate: migrateSessionDisplayStore,
    },
  ),
);

export type { ProjectSortOrder };
