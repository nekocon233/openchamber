import { selectMobileWorkStatusHiddenSections } from './preferences';
import { isContextPanelMode } from '@/lib/surfaces/modes';
import { validEditorSplitRatio } from '@/lib/workspace/editorSplit';
import { shownMobileWorkspaceTabs, storedMobileWorkspaceTabOrder } from '@/lib/mobileWorkspaceTabs';
import { carrySurfaceToZone, getZoneView, withZoneView, zoneOfMode, CONTEXT_ZONES, getDefaultContextZone } from '@/lib/workspace/zones';
import type { ContextZonePlacement } from '@/lib/workspace/zones';
import { sanitizeWorkStatusSectionOrder } from '@/components/chat/work-status/sections';
import { clampContextEditorTreeWidth } from './preferences';
import type { ContextPanelDirectoryState, UIStoreSlice } from './types';
import { normalizeDirectoryPath, clampContextZoneSize, clampContextPanelWidth, clampContextPanelHeight } from './contextTabs';
import { touchContextPanelState, clampContextPanelRoots, reconcileContextPanelPlacement } from './contextPanelState';

export const createWorkspaceActions: UIStoreSlice<
  | 'setContextPanelWidth'
  | 'setContextPanelHeight'
  | 'setContextSurfaceZones'
  | 'setEditorChatSplitRatio'
  | 'setEditorToolPanelWidth'
  | 'setWorkspaceLayout'
  | 'toggleSidebar'
  | 'setSidebarOpen'
  | 'setSidebarFoldedForExpandedZone'
  | 'setSidebarWidth'
  | 'setContextRailOrder'
  | 'toggleContextEditorTree'
  | 'toggleContextEditor'
  | 'setContextEditorTreeWidth'
  | 'closeContextPanel'
  | 'closeContextZone'
  | 'toggleContextPanelExpanded'
  | 'setContextZoneSize'
  | 'setContextZoneExpandedChatSize'
  | 'moveContextSurfaceToZone'
  | 'setWorkStatusSectionExpanded'
  | 'setMessageQueueExpanded'
  | 'setWorkStatusScrollTop'
  | 'setWorkStatusOverlayOpen'
  | 'setWorkStatusSectionVisible'
  | 'setWorkStatusHiddenSections'
  | 'setMobileWorkStatusSectionVisible'
  | 'setMobileWorkStatusHiddenSections'
  | 'setWorkStatusSectionOrder'
  | 'setContextRailSurfaceVisible'
  | 'setContextRailHiddenSurfaces'
  | 'setMobileWorkspaceTabOrder'
  | 'setMobileWorkspaceTabVisible'
> = (set, get) => ({
  setContextPanelWidth: (directory, mode, width) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones, getDefaultContextZone(state.workspaceLayout));
      const clampedWidth = clampContextPanelWidth(width);
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: {
          ...current,
          widthByMode: {
            ...current.widthByMode,
            [mode]: clampedWidth,
          },
        },
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },
  setContextPanelHeight: (directory, mode, height) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones, getDefaultContextZone(state.workspaceLayout));
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: {
          ...current,
          heightByMode: {
            ...current.heightByMode,
            [mode]: clampContextPanelHeight(height),
          },
        },
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },
  setContextSurfaceZones: (placement) => {
    set((state) => {
      const current = state.contextSurfaceZones;
      if (Object.keys(current).length === Object.keys(placement).length
        && Object.entries(placement).every(([mode, zone]) => isContextPanelMode(mode) && current[mode] === zone)) return state;
      return {
        contextSurfaceZones: placement,
        contextPanelByDirectory: reconcileContextPanelPlacement(state.contextPanelByDirectory, placement, getDefaultContextZone(state.workspaceLayout)),
      };
    });
  },
  setEditorChatSplitRatio: (ratio) => {
    if (validEditorSplitRatio(ratio)) set({ editorChatSplitRatio: ratio });
  },
  setEditorToolPanelWidth: (width) => {
    if (Number.isFinite(width)) set({ editorToolPanelWidth: clampContextPanelWidth(width) });
  },
  setWorkspaceLayout: (layout) => {
    set((state) => state.workspaceLayout === layout ? state : {
      workspaceLayout: layout,
      contextPanelByDirectory: reconcileContextPanelPlacement(state.contextPanelByDirectory, state.contextSurfaceZones, getDefaultContextZone(layout)),
    });
  },
  toggleSidebar: () => {
    set((state) => ({ isSidebarOpen: !state.isSidebarOpen }));
  },

  setSidebarOpen: (open) => {
    set((state) => state.isSidebarOpen === open ? state : { isSidebarOpen: open });
  },

  setSidebarFoldedForExpandedZone: (folded) => {
    set((state) => state.sidebarFoldedForExpandedZone === folded ? state : { sidebarFoldedForExpandedZone: folded });
  },

  setSidebarWidth: (width) => {
    set({ sidebarWidth: width });
  },

  setContextRailOrder: (order) => {
    const sanitized = Array.isArray(order)
      ? order.filter((id, index) => typeof id === 'string' && id.trim() !== '' && order.indexOf(id) === index)
      : [];
    set({ contextRailOrder: sanitized });
  },

  toggleContextEditorTree: () => {
    set((state) => (state.contextEditorTreeVisible && !state.contextEditorVisible
      ? { contextEditorTreeVisible: false, contextEditorVisible: true }
      : { contextEditorTreeVisible: !state.contextEditorTreeVisible }));
  },

  toggleContextEditor: () => {
    set((state) => (state.contextEditorVisible && !state.contextEditorTreeVisible
      ? { contextEditorVisible: false, contextEditorTreeVisible: true }
      : { contextEditorVisible: !state.contextEditorVisible }));
  },

  setContextEditorTreeWidth: (width) => {
    if (!Number.isFinite(width)) {
      return;
    }
    set({ contextEditorTreeWidth: clampContextEditorTreeWidth(width) });
  },

  closeContextPanel: (directory) => {
    get().closeContextZone(directory, 'right');
  },

  closeContextZone: (directory, zone) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      if (!prev || !getZoneView(prev, zone).isOpen) {
        return state;
      }

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: withZoneView(touchContextPanelState(prev, state.contextSurfaceZones, getDefaultContextZone(state.workspaceLayout)), zone, { isOpen: false }),
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },

  toggleContextPanelExpanded: (directory, zone = 'right') => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones, getDefaultContextZone(state.workspaceLayout));
      const expanded = !getZoneView(current, zone).expanded;
      let next = current;
      for (const other of CONTEXT_ZONES) {
        next = withZoneView(next, other, { expanded: other === zone ? expanded : false });
      }
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },

  setContextZoneSize: (zone, size) => {
    set((state) => ({ contextZoneSizes: { ...state.contextZoneSizes, [zone]: clampContextZoneSize(zone, size) } }));
  },

  setContextZoneExpandedChatSize: (zone, size) => {
    if (!Number.isFinite(size)) return;
    set((state) => ({ contextZoneExpandedChatSizes: { ...state.contextZoneExpandedChatSizes, [zone]: Math.max(0, Math.round(size)) } }));
  },

  moveContextSurfaceToZone: (mode, zone) => {
    set((state) => {
      const from = zoneOfMode(state.contextSurfaceZones, mode, getDefaultContextZone(state.workspaceLayout));
      if (state.contextSurfaceZones[mode] === zone) {
        return state;
      }

      const placement: ContextZonePlacement = { ...state.contextSurfaceZones, [mode]: zone };

      // Every project's panel follows, so the surface is where the user
      // put it whichever project they switch to.
      const byDirectory: Record<string, ContextPanelDirectoryState> = {};
      for (const [directory, panel] of Object.entries(state.contextPanelByDirectory)) {
        byDirectory[directory] = carrySurfaceToZone(panel, mode, from, zone, placement, getDefaultContextZone(state.workspaceLayout));
      }

      return { contextSurfaceZones: placement, contextPanelByDirectory: byDirectory };
    });
  },

  setWorkStatusSectionExpanded: (sectionId, expanded) => {
    set((state) => (
      state.workStatusExpandedSections[sectionId] === expanded
        ? state
        : {
          workStatusExpandedSections: {
            ...state.workStatusExpandedSections,
            [sectionId]: expanded,
          },
        }
    ));
  },

  setMessageQueueExpanded: (expanded) => {
    set((state) => (state.messageQueueExpanded === expanded ? state : { messageQueueExpanded: expanded }));
  },

  setWorkStatusScrollTop: (scrollTop) => {
    set({ workStatusScrollTop: Math.max(0, scrollTop) });
  },




  setWorkStatusOverlayOpen: (open) => {
    set((state) => (state.workStatusOverlayOpen === open ? state : { workStatusOverlayOpen: open }));
  },

  setWorkStatusSectionVisible: (sectionId, visible) => {
    set((state) => {
      const hidden = state.workStatusHiddenSections;
      const isHidden = hidden.includes(sectionId);
      if (visible === !isHidden) return state;
      return {
        workStatusHiddenSectionsExplicit: true,
        workStatusHiddenSections: visible
          ? hidden.filter((entry) => entry !== sectionId)
          : [...hidden, sectionId],
      };
    });
  },

  setWorkStatusHiddenSections: (sectionIds) => {
    set({ workStatusHiddenSections: [...new Set(sectionIds)], workStatusHiddenSectionsExplicit: true });
  },

  setMobileWorkStatusSectionVisible: (sectionId, visible) => {
    set((state) => {
      const hidden = selectMobileWorkStatusHiddenSections(state);
      if (visible === !hidden.includes(sectionId)) return state;
      return {
        mobileWorkStatusHiddenSections: visible
          ? hidden.filter((entry) => entry !== sectionId)
          : [...hidden, sectionId],
      };
    });
  },

  setMobileWorkStatusHiddenSections: (sectionIds) => {
    set({ mobileWorkStatusHiddenSections: [...new Set(sectionIds)] });
  },

  setWorkStatusSectionOrder: (sectionIds) => {
    set({ workStatusSectionOrder: sanitizeWorkStatusSectionOrder(sectionIds), workStatusSectionOrderExplicit: true });
  },

  setContextRailSurfaceVisible: (surfaceId, visible) => {
    set((state) => {
      const hidden = state.contextRailHiddenSurfaces;
      const isHidden = hidden.includes(surfaceId);
      if (visible === !isHidden) return state;
      return {
        contextRailHiddenSurfaces: visible
          ? hidden.filter((entry) => entry !== surfaceId)
          : [...hidden, surfaceId],
      };
    });
  },

  setContextRailHiddenSurfaces: (surfaceIds) => {
    set({ contextRailHiddenSurfaces: [...new Set(surfaceIds)] });
  },

  setMobileWorkspaceTabOrder: (order) => {
    set((state) => ({ mobileWorkspaceTabOrder: storedMobileWorkspaceTabOrder(order, state.mobileWorkspaceTabOrder) }));
  },

  setMobileWorkspaceTabVisible: (tab, visible, extensions) => {
    set((state) => {
      const hidden = state.mobileWorkspaceHiddenTabs;
      const shown = new Set<string>(shownMobileWorkspaceTabs(state.mobileWorkspaceTabOrder, hidden, extensions));
      if (visible === shown.has(tab)) return state;
      if (visible) {
        return hidden.includes(tab) ? { mobileWorkspaceHiddenTabs: hidden.filter((entry) => entry !== tab) } : state;
      }
      if (shown.size <= 1) return state;
      // The all-hidden fallback can show tabs that are still in the saved hidden list.
      return { mobileWorkspaceHiddenTabs: [...hidden.filter((id) => !shown.has(id)), tab] };
    });
  },
});
