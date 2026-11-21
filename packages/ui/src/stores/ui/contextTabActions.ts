import { getEditorDiffTabState, getEditorDesktopTabState, DESKTOP_PANEL_MODE, DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';
import { isExternalHttpUrl } from '@/lib/url';
import { GUEST_ATTACH_URL_MAX, GUEST_ATTACH_TITLE_MAX } from '@openchamber/sdk';
import { useGuestItemStore } from '@/lib/guests/item-store';
import { workspaceViewKey, useWorkspaceViewStateStore } from '../useWorkspaceViewStateStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { directoryMayHaveActiveProjectAction, useTerminalStore } from '@/stores/useTerminalStore';
import { useFilesViewTabsStore } from '../useFilesViewTabsStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { noteBrowserTabOpenedWithAddress, requestBrowserTabLoad } from '@/lib/browser/devServerWait';
import { getZoneView, resolveZoneActiveTabId, withZoneView, zoneOfMode, getDefaultContextZone } from '@/lib/workspace/zones';
import type { ContextPanelTab, ContextPanelDirectoryState, UIStore, UIStoreSlice } from './types';
import {
  normalizeDirectoryPath,
  normalizeContextTargetPath,
  normalizeContextTargetDirectory,
  contextPanelModeKeepsTargetDirectory,
  isTrackerBranchTab,
  normalizePendingDiffScope,
  buildContextPanelTabID,
  normalizeContextPanelDirectoryKey,
  nextTabTouchAt,
} from './contextTabs';
import {
  touchContextPanelState,
  upsertContextPanelTab,
  closeContextPanelTabs,
  reorderContextPanelTabs,
  setContextPanelTabTargetPath,
  moveContextPanelFileTabs,
  clampContextPanelRoots,
  nextResidentTabOnClose,
  usesResidentEditor,
} from './contextPanelState';

let remoteDesktopRequestCounter = 0;

let browserTabSequence = 0;

const noteBrowserTabAddressRequested = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  directory: string,
  dedupeKey: string,
  url: string,
): void => {
  const tabID = buildContextPanelTabID('browser', dedupeKey);
  if (byDirectory[directory]?.tabs.some((tab) => tab.id === tabID)) {
    requestBrowserTabLoad(directory, tabID, url);
    return;
  }
  noteBrowserTabOpenedWithAddress(directory, tabID);
};

const openFileTab = (state: UIStore, directory: string, filePath: string, preview: boolean) => {
  const tabs = state.contextPanelByDirectory[directory]?.tabs ?? [];
  const replacedPreviewPath = preview
    ? tabs.find((tab) => tab.preview && tab.targetPath !== filePath)?.targetPath ?? null
    : null;
  const alreadyOpen = tabs.some((tab) => tab.mode === 'file' && tab.targetPath === filePath);
  state.openContextPanelTab(directory, { mode: 'file', targetPath: filePath, preview });
  if (replacedPreviewPath && !alreadyOpen) {
    useFilesViewTabsStore.getState().removeOpenPath(directory, replacedPreviewPath);
  }
};

export const createContextTabActions: UIStoreSlice<
  | 'setEditorDiffTabState'
  | 'setEditorDesktopTabState'
  | 'openRemoteDesktopUrl'
  | 'openContextSurface'
  | 'openContextPanelTab'
  | 'openTrackerItem'
  | 'openContextDiff'
  | 'openContextFile'
  | 'openContextFileAtLine'
  | 'openContextOverview'
  | 'openContextPreview'
  | 'openAgentBrowserTab'
  | 'openNewContextBrowserTab'
  | 'openContextBrowser'
  | 'setContextPanelTabTargetPath'
  | 'moveContextFilePaths'
  | 'setActiveContextPanelTab'
  | 'reorderContextPanelTabs'
  | 'pinContextPanelTab'
  | 'closeContextPanelTab'
  | 'closeContextFile'
  | 'closeContextPanelTabs'
> = (set, get) => ({
  setEditorDiffTabState: (directory, value) => {
    const key = normalizeContextPanelDirectoryKey(directory);
    set((state) => {
      const panel = state.contextPanelByDirectory[key];
      if (!panel || !panel.tabs.some((tab) => tab.mode === 'diff') || panel.editorDiffTab === value) return state;
      const defaultZone = getDefaultContextZone(state.workspaceLayout);
      const currentDiffState = getEditorDiffTabState(panel, state.contextSurfaceZones, defaultZone);
      const currentDesktopState = getEditorDesktopTabState(panel, state.contextSurfaceZones, defaultZone);
      const editorDesktopTab = value === 'active'
        ? (currentDesktopState === 'active' ? 'background' : panel.editorDesktopTab)
        : value === 'closed' && currentDiffState === 'active'
          ? nextResidentTabOnClose(panel, state.contextSurfaceZones, defaultZone, 'diff').editorDesktopTab
          : panel.editorDesktopTab;
      return { contextPanelByDirectory: {
        ...state.contextPanelByDirectory,
        [key]: { ...panel, editorDiffTab: value, editorDesktopTab, touchedAt: Date.now(),
          tabs: value === 'active' ? panel.tabs.map((tab) => tab.mode === 'diff' ? { ...tab, touchedAt: nextTabTouchAt() } : tab) : panel.tabs },
      } };
    });
  },
  setEditorDesktopTabState: (directory, value) => {
    const key = normalizeContextPanelDirectoryKey(directory);
    if (!key) return;
    set((state) => {
      const defaultZone = getDefaultContextZone(state.workspaceLayout);
      const prev = state.contextPanelByDirectory[key];
      const hasDesktopTab = Boolean(prev?.tabs.some((tab) => tab.mode === DESKTOP_PANEL_MODE));
      if (value !== 'active' && !hasDesktopTab) return state;
      if (prev && hasDesktopTab && prev.editorDesktopTab === value) return state;
      const current = touchContextPanelState(prev, state.contextSurfaceZones, defaultZone);
      const currentDiffState = getEditorDiffTabState(current, state.contextSurfaceZones, defaultZone);
      const currentDesktopState = getEditorDesktopTabState(current, state.contextSurfaceZones, defaultZone);
      const editorDiffTab = value === 'active'
        ? (currentDiffState === 'active' ? 'background' : current.editorDiffTab)
        : value === 'closed' && currentDesktopState === 'active'
          ? nextResidentTabOnClose(current, state.contextSurfaceZones, defaultZone, 'desktop').editorDiffTab
          : current.editorDiffTab;
      const nextPanel = hasDesktopTab
        ? {
            ...current,
            editorDiffTab,
            editorDesktopTab: value,
            touchedAt: Date.now(),
            tabs: value === 'active'
              ? current.tabs.map((tab) => (tab.mode === DESKTOP_PANEL_MODE ? { ...tab, touchedAt: nextTabTouchAt() } : tab))
              : current.tabs,
          }
        : upsertContextPanelTab(
            { ...current, editorDiffTab, editorDesktopTab: value },
            { mode: DESKTOP_PANEL_MODE },
            state.contextSurfaceZones,
            defaultZone,
            { reveal: false },
          );
      return {
        contextPanelByDirectory: clampContextPanelRoots({
          ...state.contextPanelByDirectory,
          [key]: nextPanel,
        }, 20),
      };
    });
  },
  openRemoteDesktopUrl: (directory, url) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) return;
    const trimmedUrl = url?.trim() ?? '';
    if (trimmedUrl) {
      if (!isExternalHttpUrl(trimmedUrl) || trimmedUrl.length > GUEST_ATTACH_URL_MAX) {
        return;
      }
      const id = `remote-url-${++remoteDesktopRequestCounter}-${Date.now()}`;
      useGuestItemStore.getState().setPendingItem(DESKTOP_GUEST_ID, {
        providerId: DESKTOP_GUEST_ID,
        id,
        title: trimmedUrl.slice(0, GUEST_ATTACH_TITLE_MAX),
        url: trimmedUrl,
      });
    }
    if (usesResidentEditor(get())) {
      get().setEditorDesktopTabState(normalizedDirectory, 'active');
      return;
    }
    get().openContextPanelTab(normalizedDirectory, { mode: DESKTOP_PANEL_MODE }, { reveal: true });
  },
  openContextSurface: (directory, mode) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    const state = get();
    const placement = state.contextSurfaceZones;
    const panelState = state.contextPanelByDirectory[normalizedDirectory];
    if (mode === DESKTOP_PANEL_MODE && usesResidentEditor(state)) {
      const desktopState = getEditorDesktopTabState(panelState, placement, getDefaultContextZone(state.workspaceLayout));
      state.setEditorDesktopTabState(normalizedDirectory, desktopState === 'active' ? 'closed' : 'active');
      return;
    }
    const tabs = panelState?.tabs ?? [];
    const zone = zoneOfMode(placement, mode, getDefaultContextZone(state.workspaceLayout));
    const zoneView = panelState ? getZoneView(panelState, zone) : null;
    const activeTabId = resolveZoneActiveTabId(tabs, placement, zone, zoneView?.activeTabId ?? null, getDefaultContextZone(state.workspaceLayout));
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    const clearTerminalTarget = () => {
      if (mode === 'terminal') {
        const terminalTab = tabs.find((tab) => tab.mode === 'terminal') ?? null;
        const targetDirectory = terminalTab?.targetDirectory ?? null;
        if (targetDirectory) {
          const targetState = useTerminalStore.getState().getDirectoryState(targetDirectory);
          if (directoryMayHaveActiveProjectAction(targetState)) {
            return;
          }
        }
        state.openContextPanelTab(normalizedDirectory, { mode: 'terminal', targetDirectory: null }, { reveal: false });
      }
    };

    if (zoneView?.isOpen && activeTab?.mode === mode) {
      clearTerminalTarget();
      state.closeContextZone(normalizedDirectory, zone);
      return;
    }

    // A hidden tree stays hidden while a file is open, so the editor
    // shows alone. With no file open the tree is all the surface has,
    // and it comes back.
    if (mode === 'file' && !state.contextEditorTreeVisible
      && !tabs.some((tab) => tab.mode === 'file' && tab.targetPath)) {
      set({ contextEditorTreeVisible: true });
    }

    const tabsOfMode = tabs.filter((tab) => tab.mode === mode);
    if (tabsOfMode.length > 0) {
      clearTerminalTarget();
      // `>=` so equal timestamps (same-millisecond opens) resolve to the
      // later tab in insertion order.
      const mostRecent = tabsOfMode.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best));
      // In editor layout file tabs belong to the resident editor. The
      // rail opens the directory panel without changing its document.
      if (panelState && mode === 'file' && state.workspaceLayout === 'editor' && !state.isMobile && !isVSCodeRuntime()) {
        set({ contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: withZoneView(panelState, zone, { isOpen: true, activeTabId: mostRecent.id }),
        } });
        return;
      }
      state.setActiveContextPanelTab(normalizedDirectory, mostRecent.id);
      return;
    }

    // Content-driven modes need a payload (a session to split); the rail
    // renders them disabled until content exists. 'file' opens an empty
    // editor whose embedded tree picks the first file.
    if (mode === 'chat') {
      return;
    }

    state.openContextPanelTab(normalizedDirectory, { mode });
  },

  openContextPanelTab: (directory, tab, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    // Working in the panel's own directory is the default, stored as no target.
    const nextTab = tab.mode !== 'chat' && contextPanelModeKeepsTargetDirectory(tab.mode)
      ? {
          ...tab,
          targetDirectory: normalizeContextTargetDirectory(tab.targetDirectory) === normalizedDirectory
            ? null
            : normalizeContextTargetDirectory(tab.targetDirectory),
        }
      : tab;

    // Revealing a real file shows it, even if the editor was hidden.
    const showsFile = nextTab.mode === 'file' && Boolean(nextTab.targetPath) && options?.reveal !== false;
    const isEditorMode = usesResidentEditor(get());
    const residentFile = nextTab.mode === 'file' && Boolean(nextTab.targetPath) && isEditorMode;
    const residentDiff = nextTab.mode === 'diff' && isEditorMode;
    const residentDesktop = nextTab.mode === DESKTOP_PANEL_MODE && isEditorMode;

    const diffOwner = workspaceViewKey(getRuntimeKey(), normalizedDirectory);
    if (diffOwner && nextTab.mode === 'diff' && nextTab.targetPath?.trim() && options?.reveal !== false) {
      useWorkspaceViewStateStore.getState().requestDiffNavigation(diffOwner, nextTab.targetPath.trim(),
        normalizePendingDiffScope(nextTab.diffScope) ?? (nextTab.stagedDiff ? 'staged' : 'working'));
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const defaultZone = getDefaultContextZone(state.workspaceLayout);
      const current = touchContextPanelState(prev, state.contextSurfaceZones, defaultZone);
      const revealsResidentDiff = residentDiff && options?.reveal !== false;
      const revealsResidentDesktop = residentDesktop && options?.reveal !== false;
      const currentDiffState = getEditorDiffTabState(current, state.contextSurfaceZones, defaultZone);
      const currentDesktopState = getEditorDesktopTabState(current, state.contextSurfaceZones, defaultZone);
      const editorDiffTab = revealsResidentDiff
        ? 'active'
        : ((residentFile && showsFile) || revealsResidentDesktop) && currentDiffState !== 'closed'
          ? 'background'
          : current.editorDiffTab;
      const editorDesktopTab = revealsResidentDesktop
        ? 'active'
        : ((residentFile && showsFile) || revealsResidentDiff) && currentDesktopState !== 'closed'
          ? 'background'
          : current.editorDesktopTab;
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: upsertContextPanelTab(
          { ...current, editorDiffTab, editorDesktopTab },
          nextTab,
          state.contextSurfaceZones,
          defaultZone,
          residentFile || residentDesktop ? { reveal: false } : options,
        ),
      };

      return {
        contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
        contextEditorVisible: showsFile || state.contextEditorVisible,
      };
    });
    if (residentFile && showsFile && nextTab.targetPath) {
      useFilesViewTabsStore.getState().setSelectedPath(normalizedDirectory, nextTab.targetPath, { allowOutsideRoot: true });
    }
  },

  openTrackerItem: (directory, item) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const url = item.url.trim();
    if (!normalizedDirectory || !url) {
      return null;
    }

    const dedupeKey = `tracker:${item.key}`;
    const targetDirectory = normalizeContextTargetDirectory(item.targetDirectory);
    set((state) => {
      const placement = state.contextSurfaceZones;
      const defaultZone = getDefaultContextZone(state.workspaceLayout);
      const current = touchContextPanelState(state.contextPanelByDirectory[normalizedDirectory], placement, defaultZone);
      // An item never shows without the branch's own tab beside it.
      const withBranch = current.tabs.some(isTrackerBranchTab)
        ? current
        : upsertContextPanelTab(current, { mode: 'pr' }, placement, defaultZone, { reveal: false });
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: upsertContextPanelTab(withBranch, {
          mode: 'pr',
          targetPath: url,
          dedupeKey,
          label: item.label,
          targetDirectory: targetDirectory === normalizedDirectory ? null : targetDirectory,
        }, placement, defaultZone),
      };
      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
    return buildContextPanelTabID('pr', dedupeKey);
  },

  openContextDiff: (directory, filePath, staged = false, scope = null) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = (filePath || '').trim();
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    const diffScope = normalizePendingDiffScope(scope) ?? (staged ? 'staged' : 'working');

    get().openContextPanelTab(normalizedDirectory, {
      mode: 'diff',
      targetPath: normalizedFilePath,
      stagedDiff: diffScope === 'staged',
      diffScope,
    });
  },

  openContextFile: (directory, filePath, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
    get().setPendingFileFocusPath(normalizedFilePath);
    get().setPendingFileNavigation(null);
    if (options?.expanded) {
      const zone = zoneOfMode(get().contextSurfaceZones, 'file');
      const panel = get().contextPanelByDirectory[normalizedDirectory];
      if (panel && !getZoneView(panel, zone).expanded) {
        get().toggleContextPanelExpanded(normalizedDirectory, zone);
      }
    }
  },

  openContextFileAtLine: (directory, filePath, line, column, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
    const normalizedColumn = Number.isFinite(column) ? Math.max(1, Math.trunc(column as number)) : 1;
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
    get().setPendingFileFocusPath(null);
    get().setPendingFileNavigation({
      path: normalizedFilePath,
      line: normalizedLine,
      column: normalizedColumn,
    });
  },

  openContextOverview: (directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    get().openContextPanelTab(normalizedDirectory, { mode: 'context' });
  },

  openContextPreview: (directory, url) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedUrl = (url || '').trim();
    if (!normalizedDirectory || !normalizedUrl || isVSCodeRuntime()) {
      return;
    }

    noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, normalizedUrl, normalizedUrl);
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: normalizedUrl,
      dedupeKey: normalizedUrl,
      label: null,
    });
  },

  openAgentBrowserTab: (directory, url, ownerSessionId) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return null;
    browserTabSequence += 1;
    const dedupeKey = `browser:agent:${Date.now()}-${browserTabSequence}`;
    if (url.trim()) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, dedupeKey, url.trim());
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: url.trim(),
      dedupeKey,
      label: null,
      ownerSessionId,
    }, { reveal: false });
    return buildContextPanelTabID('browser', dedupeKey);
  },

  openNewContextBrowserTab: (directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return;
    browserTabSequence += 1;
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: '',
      dedupeKey: `browser:new:${Date.now()}-${browserTabSequence}`,
      label: null,
    });
  },

  openContextBrowser: (directory, url = '', options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return;
    const targetUrl = typeof url === 'string' && url.trim().length > 0 ? url.trim() : '';
    if (targetUrl) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, targetUrl, targetUrl);
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: targetUrl,
      dedupeKey: targetUrl || 'browser',
      label: null,
    }, options);
  },

  setContextPanelTabTargetPath: (directory, tabID, targetPath) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedTabID = (tabID || '').trim();
    if (!normalizedDirectory || !normalizedTabID) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: setContextPanelTabTargetPath(current, normalizedTabID, targetPath),
        },
      };
    });
  },

  moveContextFilePaths: (directory, fromPath, toPath, filesRoot = directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFrom = normalizeContextTargetPath(fromPath);
    const normalizedTo = normalizeContextTargetPath(toPath);
    if (!normalizedDirectory || !normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current) return state;
      const next = moveContextPanelFileTabs(current, normalizedFrom, normalizedTo);
      if (next === current) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: next,
        },
      };
    });
    useFilesViewTabsStore.getState().movePaths(normalizeDirectoryPath(filesRoot.trim()), normalizedFrom, normalizedTo);
  },

  setActiveContextPanelTab: (directory, tabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedTabID = (tabID || '').trim();
    if (!normalizedDirectory || !normalizedTabID) {
      return;
    }

    const selectedTab = get().contextPanelByDirectory[normalizedDirectory]?.tabs.find((tab) => tab.id === normalizedTabID);
    const isEditorMode = usesResidentEditor(get());
    const residentFile = selectedTab?.mode === 'file' && selectedTab.targetPath && isEditorMode;
    const residentDiff = selectedTab?.mode === 'diff' && isEditorMode;
    const residentDesktop = selectedTab?.mode === DESKTOP_PANEL_MODE && isEditorMode;

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const defaultZone = getDefaultContextZone(state.workspaceLayout);
      const current = touchContextPanelState(prev, state.contextSurfaceZones, defaultZone);
      const targetTab = current.tabs.find((tab) => tab.id === normalizedTabID);
      if (!targetTab) {
        return state;
      }

      // Picking a file tab shows its editor, even if the editor was hidden.
      const showsFile = targetTab.mode === 'file' && Boolean(targetTab.targetPath);
      const zone = zoneOfMode(state.contextSurfaceZones, targetTab.mode, defaultZone);
      const view = getZoneView(current, zone);

      if (!residentFile && !residentDiff && !residentDesktop && view.activeTabId === normalizedTabID && view.isOpen) {
        return showsFile ? { contextEditorVisible: true } : state;
      }

      const currentDiffState = getEditorDiffTabState(current, state.contextSurfaceZones, defaultZone);
      const currentDesktopState = getEditorDesktopTabState(current, state.contextSurfaceZones, defaultZone);
      const editorDiffTab = residentDiff
        ? 'active'
        : (residentFile || residentDesktop) && currentDiffState !== 'closed'
          ? 'background'
          : current.editorDiffTab;
      const editorDesktopTab = residentDesktop
        ? 'active'
        : (residentFile || residentDiff) && currentDesktopState !== 'closed'
          ? 'background'
          : current.editorDesktopTab;

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: withZoneView({
          ...current,
          editorDiffTab,
          editorDesktopTab,
          touchedAt: Date.now(),
          tabs: current.tabs.map((tab) => (tab.id === normalizedTabID
            ? { ...tab, touchedAt: nextTabTouchAt() }
            : tab)),
        }, zone, residentFile || residentDesktop ? {} : { isOpen: true, activeTabId: normalizedTabID }),
      };

      return {
        contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
        contextEditorVisible: showsFile || state.contextEditorVisible,
      };
    });
    if (residentFile && selectedTab?.targetPath) {
      useFilesViewTabsStore.getState().setSelectedPath(normalizedDirectory, selectedTab.targetPath, { allowOutsideRoot: true });
    }
  },

  reorderContextPanelTabs: (directory, activeTabID, overTabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedActiveTabID = (activeTabID || '').trim();
    const normalizedOverTabID = (overTabID || '').trim();
    if (!normalizedDirectory || !normalizedActiveTabID || !normalizedOverTabID) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones, getDefaultContextZone(state.workspaceLayout));
      if (!current.tabs.some((tab) => tab.id === normalizedActiveTabID) || !current.tabs.some((tab) => tab.id === normalizedOverTabID)) {
        return state;
      }

      const next = reorderContextPanelTabs(current, normalizedActiveTabID, normalizedOverTabID);
      if (next.tabs === current.tabs) {
        return state;
      }

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },

  pinContextPanelTab: (directory, tabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current?.tabs.some((tab) => tab.id === tabID && tab.preview)) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: {
            ...current,
            tabs: current.tabs.map((tab) => (tab.id === tabID ? { ...tab, preview: false } : tab)),
          },
        },
      };
    });
  },

  closeContextPanelTab: (directory, tabID) => {
    get().closeContextPanelTabs(directory, [tabID]);
  },

  closeContextFile: (directory, filePath) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }
    const tab = get().contextPanelByDirectory[normalizedDirectory]?.tabs
      .find((candidate) => candidate.mode === 'file' && candidate.targetPath === normalizedFilePath);
    if (tab) {
      get().closeContextPanelTabs(normalizedDirectory, [tab.id]);
      return;
    }
    useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, normalizedFilePath);
  },

  closeContextPanelTabs: (directory, tabIds) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    // The Tracker's branch tab stays: closing every item leaves it.
    const branchTabIds = new Set((get().contextPanelByDirectory[normalizedDirectory]?.tabs ?? [])
      .filter(isTrackerBranchTab)
      .map((tab) => tab.id));
    const normalizedTabIds = (tabIds ?? [])
      .map((id) => (id || '').trim())
      .filter((id) => id.length > 0 && !branchTabIds.has(id));
    if (!normalizedDirectory || normalizedTabIds.length === 0) {
      return;
    }

    const closedTabs = normalizedTabIds
      .map((id) => get().contextPanelByDirectory[normalizedDirectory]?.tabs.find((tab) => tab.id === id))
      .filter((tab): tab is ContextPanelTab => Boolean(tab));
    const selectedPath = useFilesViewTabsStore.getState().byRoot[normalizedDirectory]?.selectedPath;
    const selectedFileClosed = closedTabs.some((tab) => tab.mode === 'file' && tab.targetPath === selectedPath);

    set((state) => {
      const placement = state.contextSurfaceZones;
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, placement, getDefaultContextZone(state.workspaceLayout));
      if (!current.tabs.some((tab) => normalizedTabIds.includes(tab.id))) {
        return state;
      }

      const next = closeContextPanelTabs(current, normalizedTabIds, placement, getDefaultContextZone(state.workspaceLayout));
      const fileView = getZoneView(next, zoneOfMode(placement, 'file', getDefaultContextZone(state.workspaceLayout)));
      const activeTab = next.tabs.find((tab) => tab.id === fileView.activeTabId);
      const returnedToTree = fileView.isOpen && activeTab?.mode === 'file' && !activeTab.targetPath;
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      return {
        contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
        contextEditorTreeVisible: returnedToTree || state.contextEditorTreeVisible,
      };
    });

    // Keep the editor's own open-file state in sync so closed files do not
    // resurrect when the editor surface reopens.
    for (const tab of closedTabs) {
      if (tab.mode === 'file' && tab.targetPath) {
        useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, tab.targetPath);
      }
    }
    if (selectedFileClosed && usesResidentEditor(get())) {
      const state = get();
      const panel = state.contextPanelByDirectory[normalizedDirectory];
      const files = panel?.tabs.filter((tab) => tab.mode === 'file' && tab.targetPath) ?? [];
      const next = files.reduce<ContextPanelTab | null>((best, tab) => !best || tab.touchedAt >= best.touchedAt ? tab : best, null);
      useFilesViewTabsStore.getState().setSelectedPath(normalizedDirectory, next?.targetPath ?? null, { allowOutsideRoot: true });
      const defaultZone = getDefaultContextZone(state.workspaceLayout);
      if (
        panel
        && getEditorDiffTabState(panel, state.contextSurfaceZones, defaultZone) !== 'active'
        && getEditorDesktopTabState(panel, state.contextSurfaceZones, defaultZone) !== 'active'
      ) {
        const fallback = nextResidentTabOnClose(panel, state.contextSurfaceZones, defaultZone, 'file');
        if (fallback.editorDiffTab === 'active') get().setEditorDiffTabState(normalizedDirectory, 'active');
        else if (fallback.editorDesktopTab === 'active') get().setEditorDesktopTabState(normalizedDirectory, 'active');
      }
    }
  },
});
