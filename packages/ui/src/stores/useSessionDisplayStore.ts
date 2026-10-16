import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';
// Worktree groups inside a project. 'recent' floats worktrees with the latest
// session activity to the top, so the list moves as sessions run; 'manual'
// and 'a-z' keep positions stable.
type WorktreeSortOrder = 'recent' | 'manual' | 'a-z';

// 'projects' is the grouped sidebar: project zones with worktree sub-headers,
// optional Recent. 'timeline' is one recency-ordered list of root sessions
// across every project, with three-line rows carrying project and branch.
export type SidebarViewMode = 'projects' | 'timeline';
type ProjectDisplayMode = 'all' | 'single';

type SessionDisplayStore = {
  projectDisplayMode: ProjectDisplayMode;
  singleProjectId: string | null;
  setProjectDisplayMode: (mode: ProjectDisplayMode) => void;
  setSingleProjectId: (projectId: string) => void;
  sidebarViewMode: SidebarViewMode;
  setSidebarViewMode: (mode: SidebarViewMode) => void;
  /** Local display preference; motion remains opt-in. */
  animatedActivityIndicators: boolean;
  setAnimatedActivityIndicators: (enabled: boolean) => void;
  /** The managed Chats block in the sidebar (web and desktop). */
  showChatsSection: boolean;
  /** The In work block; hidden, its sessions stay in their projects. */
  showWorkSection: boolean;
  /** The Pinned block above In work; off by default. Hidden, pinned sessions stay in their projects. */
  showPinnedSection: boolean;
  /** Pinned and In work rows in the Tree view: one line by default, two with branch, PR and model when set. */
  detailedZoneRows: boolean;
  // VS Code only: the compact webview keeps archived buckets inline because it
  // has no room for the full Archive page. Web/desktop ignore this flag and
  // always route archived sessions to the Archive page instead.
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  worktreeSortOrder: WorktreeSortOrder;
  setShowChatsSection: (show: boolean) => void;
  setShowWorkSection: (show: boolean) => void;
  setShowPinnedSection: (show: boolean) => void;
  setDetailedZoneRows: (detailed: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
  setWorktreeSortOrder: (order: WorktreeSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
    sessionGroupingMode?: string;
    stickyZoneHeaders?: boolean;
    showRecentSection?: boolean;
  };
  const next = { ...state };
  // The two lineages that feed this store number their persisted versions
  // differently, so a stored number only says how far behind the writer was.
  // Every rule below uses the older of the two thresholds, which covers a
  // payload from either lineage, and the presence checks stay trustworthy where
  // a number cannot be.
  //
  // This distribution's layout always animated running rows. Preserve that
  // established choice while adopting the per-device appearance control the
  // payload predates; the shared schema numbers the two sections differently,
  // so the presence of the later field is the only trustworthy marker.
  if (state.showPinnedSection !== undefined && state.animatedActivityIndicators === undefined) {
    next.animatedActivityIndicators = true;
  }
  if (version < 2) {
    next.projectSortOrder = 'manual';
  }
  if (version < 4 && next.projectSortOrder === 'recent') {
    next.projectSortOrder = 'manual';
  }
  if (version < 3 && next.showPinnedSection === undefined) {
    // v3 adds the pinned section, visible by default, so a payload predating it
    // keeps a Pinned block instead of hiding one its writer never turned off.
    next.showPinnedSection = true;
  }
  if (next.showChatsSection === undefined) {
    // The Chats block is always on for payloads that never stored the choice;
    // only an explicit false from a writer that had the field hides it.
    next.showChatsSection = true;
  }
  if (version < 4) {
    // v4 removes the default/minimal display mode: the sidebar now has a
    // single row layout. Drop the stale key from persisted state.
    delete next.displayMode;
  }
  if (version < 7) {
    // v7 removes the by-worktree/flat grouping choice: the projects view always
    // groups by worktree, and the flat recency list became the timeline view.
    delete next.sessionGroupingMode;
  }
  if (version < 7) {
    // v7 removes the sticky-headers toggle: zone headers are always pinned.
    delete next.stickyZoneHeaders;
  }
  if (version < 9 && !next.worktreeSortOrder) {
    // v9 adds the worktree sort. Everyone starts on a stable manual order:
    // an activity-sorted list moved rows under the pointer, next to
    // destructive actions like deleting a worktree.
    next.worktreeSortOrder = 'manual';
  }
  if (version < 10) {
    // v10 removes Recent: In work holds the sessions being worked on, and the
    // timeline view answers "what was I doing" across projects.
    delete next.showRecentSection;
  }
  return next;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      animatedActivityIndicators: false,
      setAnimatedActivityIndicators: (enabled) => set({ animatedActivityIndicators: enabled }),
      projectDisplayMode: 'all',
      singleProjectId: null,
      setProjectDisplayMode: (mode) => set({ projectDisplayMode: mode }),
      setSingleProjectId: (projectId) => set({ singleProjectId: projectId }),
      // New installs start on the timeline. Stored state keeps an earlier
      // choice, and VS Code always renders the grouped view.
      sidebarViewMode: 'timeline',
      setSidebarViewMode: (mode) => set({ sidebarViewMode: mode }),
      showChatsSection: true,
      showWorkSection: true,
      showPinnedSection: false,
      detailedZoneRows: false,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates.
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      worktreeSortOrder: 'manual',
      setShowChatsSection: (show) => set({ showChatsSection: show }),
      setShowWorkSection: (show) => set({ showWorkSection: show }),
      setShowPinnedSection: (show) => set({ showPinnedSection: show }),
      setDetailedZoneRows: (detailed) => set({ detailedZoneRows: detailed }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
      setWorktreeSortOrder: (order) => set({ worktreeSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 10,
      // v2 adds projectSortOrder (manual), v3 renames the recent default to
      // manual and adds the pinned section, v4 removes displayMode, v7 drops
      // sessionGroupingMode and stickyZoneHeaders, v9 adds worktreeSortOrder,
      // v10 drops showRecentSection (Recent is gone). Both lineages wrote
      // version 9 last but shifted the middle numbers, so `migrate` uses the
      // older threshold of each pair and fills fields by presence where a
      // number cannot tell the lineages apart.
      migrate: migrateSessionDisplayState,
    },
  ),
);

export type {
  ProjectSortOrder,
  WorktreeSortOrder
};
