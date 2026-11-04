import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getSettingsSurface } from '@/lib/settings/surface';
import { getRuntimeKey, isTransientRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { SettingsSurface } from '@/lib/settings/registry';
import {
  DEFAULT_SIDEBAR_SECTIONS,
  hiddenSidebarSectionsSchema,
  sidebarPinListsSchema,
  sidebarSectionsSchema,
  type SidebarPinList,
  type SidebarSectionEntry,
} from '@/lib/sidebarSections';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';
// Worktree groups inside a project. 'recent' floats worktrees with the latest
// session activity to the top, so the list moves as sessions run; 'manual'
// and 'a-z' keep positions stable.
type WorktreeSortOrder = 'recent' | 'manual' | 'a-z';

// The Tree/List pair the one view replaced, read only until a grouping is
// chosen (`resolveSidebarGrouping`). 'projects' was Tree; 'timeline' was
// List, laid out by `listSessionGrouping`.
export type SidebarViewMode = 'projects' | 'timeline';
// `sidebarGrouping`, and the old List's: 'project' puts each project's sessions under its header;
// 'time' lists every project's sessions together, newest activity first.
export type ListSessionGrouping = 'project' | 'time';
type ProjectDisplayMode = 'all' | 'single';

type SessionDisplayStore = {
  projectDisplayMode: ProjectDisplayMode;
  singleProjectId: string | null;
  setProjectDisplayMode: (mode: ProjectDisplayMode) => void;
  setSingleProjectId: (projectId: string) => void;
  sidebarViewMode: SidebarViewMode;
  setSidebarViewMode: (mode: SidebarViewMode) => void;
  listSessionGrouping: ListSessionGrouping;
  setListSessionGrouping: (grouping: ListSessionGrouping) => void;
  /**
   * The sidebar's one view, on the desktop, the web and the phone: under each
   * project, or one list by time. Null until chosen, when it follows the
   * List/Tree pair it replaced (`resolveSidebarGrouping`).
   */
  sidebarGrouping: ListSessionGrouping | null;
  setSidebarGrouping: (grouping: ListSessionGrouping) => void;
  /** A work in the In work block also stays in its project or folder; off by default. */
  keepWorkInPlace: boolean;
  setKeepWorkInPlace: (keep: boolean) => void;
  /** Local display preference; motion remains opt-in. */
  animatedActivityIndicators: boolean;
  setAnimatedActivityIndicators: (enabled: boolean) => void;
  /** The managed Chats block in the sidebar (web and desktop). */
  showChatsSection: boolean;
  /** The In work block; hidden, its sessions stay in their projects. */
  showWorkSection: boolean;
  /** The Pinned block above In work; off by default. Hidden, pinned sessions stay in their projects. */
  showPinnedSection: boolean;
  /**
   * Works in two lines (branch, reference, project where projects mix) rather
   * than one. Off by default on a computer, on by default on a phone, whose
   * full-width rows have the room.
   */
  detailedZoneRows: boolean;
  /**
   * Worktrees named by their branch (a space by its own name) rather than by
   * their task; the other name goes under it. Off by default.
   */
  worktreeNameByBranch: boolean;
  /**
   * The sidebar's sections in order, the built-in ones included
   * (`lib/sidebarSections.ts`). Shared by every surface.
   */
  sections: SidebarSectionEntry[];
  /** The named pin lists Pin to files works into. Shared by every surface. */
  pinLists: SidebarPinList[];
  /** The user's sections this surface hides; built-in ones keep their own show toggles. */
  hiddenSections: string[];
  /**
   * The instance the sections, pin lists and hidden sections came from. They
   * belong to that instance: switching to another drops them until its own
   * settings arrive, so one server's sections never show on another.
   */
  sectionsOwner: string | null;
  setSections: (sections: SidebarSectionEntry[]) => void;
  setPinLists: (lists: SidebarPinList[]) => void;
  setHiddenSections: (ids: string[]) => void;
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
  setWorktreeNameByBranch: (byBranch: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
  setWorktreeSortOrder: (order: WorktreeSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
  surface: SettingsSurface = getSettingsSurface(),
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
    sessionGroupingMode?: string;
    stickyZoneHeaders?: boolean;
    showRecentSection?: boolean;
  };
  const next = { ...state };
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
    next.showPinnedSection = true;
  }
  if (next.showChatsSection === undefined) {
    next.showChatsSection = true;
  }
  if (version < 4) {
    delete next.displayMode;
  }
  if (version < 7) {
    delete next.sessionGroupingMode;
  }
  if (version < 7) {
    delete next.stickyZoneHeaders;
  }
  if (version < 9 && !next.worktreeSortOrder) {
    next.worktreeSortOrder = 'manual';
  }
  if (version < 10) {
    delete next.showRecentSection;
  }
  if (version < 12 && surface === 'mobile' && next.sidebarViewMode !== 'projects') {
    next.detailedZoneRows = true;
  }
  return next;
};

/**
 * How the desktop and web sidebar groups works. Before the choice is made in
 * the one view, a List sorted by time keeps its list by time; Tree and List by
 * project both group under projects.
 */
export const resolveSidebarGrouping = (
  state: Pick<SessionDisplayStore, 'sidebarGrouping' | 'sidebarViewMode' | 'listSessionGrouping'>,
): ListSessionGrouping => state.sidebarGrouping
  ?? (state.sidebarViewMode === 'timeline' && state.listSessionGrouping === 'time' ? 'time' : 'project');

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      animatedActivityIndicators: true,
      setAnimatedActivityIndicators: (enabled) => set({ animatedActivityIndicators: enabled }),
      projectDisplayMode: 'all',
      singleProjectId: null,
      setProjectDisplayMode: (mode) => set({ projectDisplayMode: mode }),
      setSingleProjectId: (projectId) => set({ singleProjectId: projectId }),
      sidebarViewMode: 'timeline',
      setSidebarViewMode: (mode) => set({ sidebarViewMode: mode }),
      listSessionGrouping: 'project',
      setListSessionGrouping: (grouping) => set({ listSessionGrouping: grouping }),
      sidebarGrouping: null,
      setSidebarGrouping: (grouping) => set({ sidebarGrouping: grouping }),
      keepWorkInPlace: false,
      setKeepWorkInPlace: (keep) => set({ keepWorkInPlace: keep }),
      showChatsSection: true,
      showWorkSection: true,
      showPinnedSection: true,
      detailedZoneRows: getSettingsSurface() === 'mobile',
      worktreeNameByBranch: false,
      sections: [...DEFAULT_SIDEBAR_SECTIONS],
      pinLists: [],
      hiddenSections: [],
      sectionsOwner: null,
      setSections: (sections) => set({ sections: sidebarSectionsSchema.parse(sections), sectionsOwner: getRuntimeKey() }),
      setPinLists: (lists) => set({ pinLists: sidebarPinListsSchema.parse(lists), sectionsOwner: getRuntimeKey() }),
      setHiddenSections: (ids) => set({ hiddenSections: hiddenSidebarSectionsSchema.parse(ids), sectionsOwner: getRuntimeKey() }),
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      worktreeSortOrder: 'manual',
      setShowChatsSection: (show) => set({ showChatsSection: show }),
      setShowWorkSection: (show) => set({ showWorkSection: show }),
      setShowPinnedSection: (show) => set({ showPinnedSection: show }),
      setDetailedZoneRows: (detailed) => set({ detailedZoneRows: detailed }),
      setWorktreeNameByBranch: (byBranch) => set({ worktreeNameByBranch: byBranch }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
      setWorktreeSortOrder: (order) => set({ worktreeSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 12,
      migrate: migrateSessionDisplayState,
      merge: (persisted, current) => {
        const state = (persisted ?? {}) as Partial<SessionDisplayStore>;
        const sections = sidebarSectionsSchema.safeParse(state.sections ?? current.sections);
        return { ...current, ...state, sections: sections.success ? sections.data : [...DEFAULT_SIDEBAR_SECTIONS] };
      },
    },
  ),
);

export type {
  ProjectSortOrder,
  WorktreeSortOrder,
};

export const dropSectionsOfOtherInstance = (runtimeKey: string): void => {
  const state = useSessionDisplayStore.getState();
  if (state.sectionsOwner === null || state.sectionsOwner === runtimeKey || isTransientRuntimeKey(runtimeKey)) return;
  useSessionDisplayStore.setState({ sections: [...DEFAULT_SIDEBAR_SECTIONS], pinLists: [], hiddenSections: [], sectionsOwner: null });
};
subscribeRuntimeEndpointWillChange(({ runtimeKey }) => dropSectionsOfOtherInstance(runtimeKey));
queueMicrotask(() => dropSectionsOfOtherInstance(getRuntimeKey()));
