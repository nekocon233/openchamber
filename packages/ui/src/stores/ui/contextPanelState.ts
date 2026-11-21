import type { WorkspaceLayout } from '@/lib/workspace/sidebarGeometry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getEditorDiffTabState, getEditorDesktopTabState, DESKTOP_PANEL_MODE, type EditorDiffTabState, type EditorDesktopTabState } from '@/lib/workspace/editorTabs';
import { type ContextPanelMode, isContextPanelMode } from '@/lib/surfaces/modes';
import { z } from 'zod';
import { rebaseMovedPath } from '@/lib/filePathMoves';
import {
  getZoneView,
  resolveZoneActiveTabId,
  keepZoneViewsOnTabs,
  zoneViewsSchema,
  settleZones,
  withZoneView,
  zoneOfMode,
  CLOSED_ZONE_VIEW,
  CONTEXT_ZONES,
  type DefaultContextZone,
  reconcileZonePlacement,
} from '@/lib/workspace/zones';
import type { ContextZone, ContextZonePlacement, ContextZoneView } from '@/lib/workspace/zones';
import type { ContextPanelTab, ContextPanelTabDescriptor, ContextPanelDirectoryState, LegacyZoneSizes } from './types';
import {
  CONTEXT_PANEL_MAX_TABS,
  normalizeDirectoryPath,
  clampContextZoneSize,
  buildContextPanelTabID,
  createContextPanelTab,
  clampContextPanelTabs,
  sanitizeContextPanelTabs,
  resolveActiveContextPanelTabID,
  nextTabTouchAt,
  clampContextPanelWidth,
  clampContextPanelHeight,
} from './contextTabs';

const persistedPanelWidthsSchema = z.object({
  widthByMode: z.record(z.string(), z.number().finite().optional().catch(undefined)).catch({}),
});

const persistedPanelHeightsSchema = z.object({
  heightByMode: z.record(z.string(), z.number().finite().optional().catch(undefined)).catch({}),
});

const persistedEditorTabSchema = z.object({
  editorDiffTab: z.enum(['closed', 'background', 'active']).catch('closed').optional(),
  editorDesktopTab: z.enum(['closed', 'background', 'active']).catch('closed').optional(),
});

export const usesResidentEditor = (state: { workspaceLayout: WorkspaceLayout; isMobile: boolean }): boolean => (
  state.workspaceLayout === 'editor' && !state.isMobile && !isVSCodeRuntime()
);

export const nextResidentTabOnClose = (
  panel: ContextPanelDirectoryState,
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone,
  closing: 'file' | 'diff' | 'desktop',
) => {
  const diffState = closing === 'diff' ? 'closed' : getEditorDiffTabState(panel, placement, defaultZone);
  const desktopState = closing === 'desktop' ? 'closed' : getEditorDesktopTabState(panel, placement, defaultZone);
  const files = panel.tabs.filter((tab) => tab.mode === 'file' && tab.targetPath);
  const bestFile = files.reduce<ContextPanelTab | null>((best, tab) => (!best || tab.touchedAt >= best.touchedAt ? tab : best), null);
  const diffTab = diffState === 'background' ? panel.tabs.find((tab) => tab.mode === 'diff') : undefined;
  const desktopTab = desktopState === 'background' ? panel.tabs.find((tab) => tab.mode === DESKTOP_PANEL_MODE) : undefined;
  const bestFileTouchedAt = bestFile?.touchedAt ?? -1;
  const activateDiff = Boolean(diffTab && diffTab.touchedAt > bestFileTouchedAt && (!desktopTab || diffTab.touchedAt >= desktopTab.touchedAt));
  const activateDesktop = Boolean(!activateDiff && desktopTab && desktopTab.touchedAt > bestFileTouchedAt);
  return {
    editorDiffTab: activateDiff ? 'active' : diffState,
    editorDesktopTab: activateDesktop ? 'active' : desktopState,
  };
};

export const reconcileContextPanelPlacement = (
  panels: Record<string, ContextPanelDirectoryState>,
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone,
): Record<string, ContextPanelDirectoryState> => {
  let next = panels;
  for (const [directory, panel] of Object.entries(panels)) {
    const wasDesktopOpenInZone = CONTEXT_ZONES.some((zone) => {
      const view = getZoneView(panel, zone);
      return view.isOpen && panel.tabs.some((tab) => tab.id === view.activeTabId && tab.mode === DESKTOP_PANEL_MODE);
    });
    const placed = reconcileZonePlacement(panel, placement, defaultZone);
    let reconciled = placed;
    if (defaultZone === 'left') {
      const editorDiffTab = placed.editorDiffTab === undefined ? getEditorDiffTabState(placed, placement, defaultZone) : placed.editorDiffTab;
      const editorDesktopTab = wasDesktopOpenInZone
        ? 'active'
        : placed.editorDesktopTab ?? getEditorDesktopTabState(placed, placement, defaultZone);
      let resolvedDiffTab = editorDiffTab;
      let resolvedDesktopTab = editorDesktopTab;
      if (resolvedDiffTab === 'active' && resolvedDesktopTab === 'active') {
        const diffTouchedAt = placed.tabs.find((tab) => tab.mode === 'diff')?.touchedAt ?? 0;
        const desktopTouchedAt = placed.tabs.find((tab) => tab.mode === DESKTOP_PANEL_MODE)?.touchedAt ?? 0;
        if (desktopTouchedAt > diffTouchedAt) resolvedDiffTab = 'background';
        else resolvedDesktopTab = 'background';
      }
      if (resolvedDiffTab !== placed.editorDiffTab || resolvedDesktopTab !== placed.editorDesktopTab) {
        reconciled = { ...placed, editorDiffTab: resolvedDiffTab, editorDesktopTab: resolvedDesktopTab };
      }
    } else if (placed.editorDesktopTab === 'active') {
      const desktopTab = placed.tabs.find((tab) => tab.mode === DESKTOP_PANEL_MODE);
      if (desktopTab) {
        const zone = zoneOfMode(placement, DESKTOP_PANEL_MODE, defaultZone);
        reconciled = settleZones(withZoneView({ ...placed, editorDesktopTab: undefined }, zone, {
          isOpen: true,
          activeTabId: desktopTab.id,
        }), placement, defaultZone);
      } else {
        reconciled = { ...placed, editorDesktopTab: 'closed' };
      }
    }
    if (reconciled === panel) continue;
    if (next === panels) next = { ...panels };
    next[directory] = reconciled;
  }
  return next;
};

const persistedPixelsSchema = z.number().finite().optional().catch(undefined);

const persistedZoneSizesSchema = z.object({
  sizeByZone: z.object({
    left: persistedPixelsSchema,
    right: persistedPixelsSchema,
    bottom: persistedPixelsSchema,
  }).optional().catch(undefined),
  widthByMode: z.record(z.string(), persistedPixelsSchema).catch({}),
  heightByMode: z.record(z.string(), persistedPixelsSchema).catch({}),
});

export const touchContextPanelState = (
  prev: ContextPanelDirectoryState | undefined,
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone,
): ContextPanelDirectoryState => {
  if (prev) {
    const tabs = sanitizeContextPanelTabs(prev.tabs);
    return settleZones({
      ...prev,
      tabs,
      zones: keepZoneViewsOnTabs(zoneViewsSchema.parse(prev.zones), new Set(tabs.map((tab) => tab.id))),
      touchedAt: Date.now(),
    }, placement, defaultZone);
  }

  return {
    isOpen: false,
    expanded: false,
    tabs: [],
    activeTabId: null,
    zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
    widthByMode: {},
    heightByMode: {},
    touchedAt: Date.now(),
  };
};

export const upsertContextPanelTab = (
  current: ContextPanelDirectoryState,
  descriptor: ContextPanelTabDescriptor,
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone = 'right',
  options?: { reveal?: boolean },
): ContextPanelDirectoryState => {
  const reveal = options?.reveal !== false;
  const nextTab = createContextPanelTab(descriptor);
  // A real file tab replaces the empty editor placeholder ('file' with no
  // target) that the rail can open before any file is picked.
  const baseTabs = nextTab.mode === 'file' && nextTab.targetPath
    ? current.tabs.filter((tab) => !(tab.mode === 'file' && !tab.targetPath))
    : current.tabs;
  const existingIndex = baseTabs.findIndex((tab) => tab.id === nextTab.id);
  // A new preview takes the slot of the current preview tab, if any.
  const replacedPreviewIndex = existingIndex === -1 && nextTab.preview
    ? baseTabs.findIndex((tab) => tab.preview)
    : -1;
  const tabs = replacedPreviewIndex !== -1
    ? baseTabs.map((tab, index) => (index === replacedPreviewIndex ? nextTab : tab))
    : existingIndex === -1
    ? [...baseTabs, nextTab]
    : baseTabs.map((tab, index) => (index === existingIndex
      ? {
          ...tab,
          mode: nextTab.mode,
          targetPath: nextTab.targetPath || tab.targetPath,
          targetDirectory: nextTab.targetDirectory,
          dedupeKey: nextTab.dedupeKey,
          label: nextTab.label,
          sessionTitleFallback: nextTab.sessionTitleFallback || tab.sessionTitleFallback,
          stagedDiff: nextTab.stagedDiff,
          diffScope: nextTab.diffScope,
          readOnly: nextTab.readOnly,
          // Reopening a preview as a preview keeps it one; any other open pins it.
          preview: tab.preview && nextTab.preview,
          touchedAt: nextTabTouchAt(),
        }
      : tab));

  // A background upsert (an agent working a page) keeps the panel exactly as
  // the user left it: closed stays closed, and whatever tab they were on
  // stays active. The tab still exists — panes are kept mounted regardless of
  // visibility — so agent control and a later manual open both find it.
  // The tab opens in the zone its surface is placed in.
  const zone = zoneOfMode(placement, nextTab.mode, defaultZone);
  const view = getZoneView(current, zone);
  const activeTabId = reveal
    ? nextTab.id
    : (current.tabs.find((tab) => tab.id === view.activeTabId)?.mode === 'file'
        && !tabs.some((tab) => tab.id === view.activeTabId)
        ? nextTab.id
        : resolveZoneActiveTabId(current.tabs, placement, zone, view.activeTabId, defaultZone) ?? nextTab.id);
  const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, activeTabId);

  return settleZones(withZoneView({
    ...current,
    tabs: clampedTabs,
    touchedAt: Date.now(),
  }, zone, {
    isOpen: reveal ? true : view.isOpen,
    activeTabId,
  }), placement, defaultZone);
};

export const closeContextPanelTabs = (
  current: ContextPanelDirectoryState,
  tabIds: readonly string[],
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone,
): ContextPanelDirectoryState => {
  const closed = new Set(tabIds);
  const closedTabs = current.tabs.filter((tab) => closed.has(tab.id));
  let nextTabs = current.tabs.filter((tab) => !closed.has(tab.id));
  if (nextTabs.length === current.tabs.length) {
    return current;
  }

  // Each zone settles on its own: closing a tab never changes what another
  // zone shows.
  const views: Partial<Record<ContextZone, Partial<ContextZoneView>>> = {};
  for (const zone of CONTEXT_ZONES) {
    const view = getZoneView(current, zone);
    const activeClosed = view.activeTabId ? closed.has(view.activeTabId) : false;
    if (!activeClosed) continue;

    // Closing the active tab stays inside its surface: activate the most
    // recent remaining tab of the same mode, and when none remain just close
    // the zone instead of jumping to another surface.
    const activeMode = closedTabs.find((tab) => tab.id === view.activeTabId)?.mode ?? null;
    const sameModeTabs = activeMode ? nextTabs.filter((tab) => tab.mode === activeMode) : [];
    const nextSameModeTab = sameModeTabs.length > 0
      ? sameModeTabs.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
      : null;

    // The file surface outlives its files: closing the last real file tab leaves
    // the same empty editor placeholder the rail opens, so the surface falls
    // back to its file tree instead of taking the whole zone down with it.
    // Closing the placeholder itself still closes the surface.
    if (activeMode === 'file' && !nextSameModeTab && closedTabs.some((tab) => tab.mode === 'file' && tab.targetPath)) {
      const placeholder = createContextPanelTab({ mode: 'file' });
      nextTabs = [...nextTabs, placeholder];
      views[zone] = { activeTabId: placeholder.id };
      continue;
    }

    views[zone] = nextSameModeTab
      ? { activeTabId: nextSameModeTab.id }
      : { activeTabId: null, isOpen: false, expanded: false };
  }

  const droppedActiveDiff = current.editorDiffTab === 'active' && !nextTabs.some((tab) => tab.mode === 'diff');
  const droppedActiveDesktop = current.editorDesktopTab === 'active' && !nextTabs.some((tab) => tab.mode === DESKTOP_PANEL_MODE);
  let editorDiffTab: EditorDiffTabState | undefined = nextTabs.some((tab) => tab.mode === 'diff') ? current.editorDiffTab : 'closed';
  let editorDesktopTab: EditorDesktopTabState | undefined = nextTabs.some((tab) => tab.mode === DESKTOP_PANEL_MODE) ? current.editorDesktopTab : 'closed';
  if (droppedActiveDesktop || droppedActiveDiff) {
    const promoted = nextResidentTabOnClose(
      { ...current, tabs: nextTabs, editorDiffTab, editorDesktopTab },
      placement,
      defaultZone,
      droppedActiveDesktop ? 'desktop' : 'diff',
    );
    editorDiffTab = promoted.editorDiffTab;
    editorDesktopTab = promoted.editorDesktopTab;
  }

  let next: ContextPanelDirectoryState = {
    ...current, tabs: nextTabs, touchedAt: Date.now(),
    editorDiffTab,
    editorDesktopTab,
  };
  for (const zone of CONTEXT_ZONES) {
    const patch = views[zone];
    if (patch) next = withZoneView(next, zone, patch);
  }
  return settleZones(next, placement, defaultZone);
};

export const reorderContextPanelTabs = (
  current: ContextPanelDirectoryState,
  activeTabID: string,
  overTabID: string,
): ContextPanelDirectoryState => {
  if (activeTabID === overTabID) {
    return current;
  }

  const fromIndex = current.tabs.findIndex((tab) => tab.id === activeTabID);
  const toIndex = current.tabs.findIndex((tab) => tab.id === overTabID);
  if (fromIndex === -1 || toIndex === -1) {
    return current;
  }

  const tabs = [...current.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  if (!moved) {
    return current;
  }

  tabs.splice(toIndex, 0, moved);

  return {
    ...current,
    tabs,
    touchedAt: Date.now(),
  };
};

export const setContextPanelTabTargetPath = (
  current: ContextPanelDirectoryState,
  tabID: string,
  targetPath: string,
): ContextPanelDirectoryState => ({
  ...current,
  tabs: current.tabs.map((tab) =>
    tab.id === tabID ? { ...tab, targetPath } : tab,
  ),
});

export const moveContextPanelFileTabs = (
  current: ContextPanelDirectoryState,
  fromPath: string,
  toPath: string,
): ContextPanelDirectoryState => {
  const renamed = new Map<string, string>();
  const movedIds = new Set<string>();
  const tabs = current.tabs.map((tab) => {
    if (tab.mode !== 'file' || !tab.targetPath) return tab;
    const targetPath = rebaseMovedPath(tab.targetPath, fromPath, toPath);
    if (targetPath === null) return tab;
    const keyFollowsPath = tab.dedupeKey === tab.targetPath;
    const dedupeKey = keyFollowsPath ? targetPath : tab.dedupeKey;
    const id = keyFollowsPath ? buildContextPanelTabID(tab.mode, dedupeKey) : tab.id;
    renamed.set(tab.id, id);
    movedIds.add(id);
    return { ...tab, targetPath, dedupeKey, id };
  });
  if (movedIds.size === 0) return current;

  let next: ContextPanelDirectoryState = {
    ...current,
    tabs: tabs.filter((tab, index) => tab !== current.tabs[index] || !movedIds.has(tab.id)),
    touchedAt: Date.now(),
  };
  for (const zone of CONTEXT_ZONES) {
    const activeTabId = getZoneView(current, zone).activeTabId;
    const renamedId = activeTabId ? renamed.get(activeTabId) : undefined;
    if (renamedId) next = withZoneView(next, zone, { activeTabId: renamedId });
  }
  return next;
};

export const withoutForeignComparisons = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
): Record<string, ContextPanelDirectoryState> => {
  const isForeign = (tab: ContextPanelTab) => (tab.mode === 'diff' || tab.mode === 'walkthrough') && tab.targetDirectory !== null;
  if (!Object.values(byDirectory).some((panel) => panel.tabs.some(isForeign))) return byDirectory;
  return Object.fromEntries(Object.entries(byDirectory).map(([directory, panel]) => [directory, panel.tabs.some(isForeign)
    ? { ...panel, tabs: panel.tabs.map((tab) => (isForeign(tab) ? { ...tab, targetDirectory: null } : tab)) }
    : panel]));
};

export const sanitizeContextPanelByDirectory = (
  value: unknown,
  legacySizes?: LegacyZoneSizes[],
): Record<string, ContextPanelDirectoryState> => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const source = value as Record<string, unknown>;
  const next: Record<string, ContextPanelDirectoryState> = {};

  for (const [rawDirectory, rawState] of Object.entries(source)) {
    const directory = normalizeDirectoryPath(rawDirectory);
    if (!directory || !rawState || typeof rawState !== 'object') {
      continue;
    }

    const candidate = rawState as {
      isOpen?: unknown;
      expanded?: unknown;
      zones?: unknown;
      tabs?: unknown;
      activeTabId?: unknown;
      touchedAt?: unknown;
      mode?: unknown;
      targetPath?: unknown;
      targetDirectory?: string | null;
      dedupeKey?: unknown;
      label?: unknown;
    };

    let tabs = sanitizeContextPanelTabs(candidate.tabs);
    let activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;

    if (tabs.length === 0 && (candidate.mode === 'diff' || candidate.mode === 'file' || candidate.mode === 'context' || candidate.mode === 'chat' || candidate.mode === 'terminal')) {
      tabs = [createContextPanelTab({
        mode: candidate.mode,
        targetPath: typeof candidate.targetPath === 'string' ? candidate.targetPath : null,
        targetDirectory: candidate.targetDirectory,
        dedupeKey: typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
        label: typeof candidate.label === 'string' ? candidate.label : null,
      })];
      activeTabId = tabs[0]?.id ?? null;
    }

    const resolvedActiveTabId = resolveActiveContextPanelTabID(tabs, activeTabId);
    const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, resolvedActiveTabId);

    const resolvedTabId = resolveActiveContextPanelTabID(clampedTabs, resolvedActiveTabId);
    const zones = keepZoneViewsOnTabs(zoneViewsSchema.parse(candidate.zones), new Set(clampedTabs.map((tab) => tab.id)));
    const touchedAt = typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
      ? candidate.touchedAt
      : Date.now();
    if (legacySizes) {
      const savedSizes = persistedZoneSizesSchema.parse(rawState);
      const sizes: Partial<Record<ContextZone, number>> = {};
      for (const zone of CONTEXT_ZONES) {
        let pixels = savedSizes.sizeByZone?.[zone];
        if (!savedSizes.sizeByZone) {
          const zoneTabId = zone === 'right' ? resolvedTabId : zones[zone].activeTabId;
          const mode = clampedTabs.find((tab) => tab.id === zoneTabId)?.mode;
          pixels = mode ? (zone === 'bottom' ? savedSizes.heightByMode : savedSizes.widthByMode)[mode] : undefined;
        }
        if (pixels !== undefined) sizes[zone] = clampContextZoneSize(zone, pixels);
      }
      legacySizes.push({ sizes, touchedAt });
    }

    const widthByMode: Partial<Record<ContextPanelMode, number>> = {};
    const savedWidths = persistedPanelWidthsSchema.parse(rawState);
    for (const [mode, pixels] of Object.entries(savedWidths.widthByMode)) {
      if (isContextPanelMode(mode) && pixels !== undefined) widthByMode[mode] = clampContextPanelWidth(pixels);
    }

    const heightByMode: Partial<Record<ContextPanelMode, number>> = {};
    const savedHeights = persistedPanelHeightsSchema.parse(rawState);
    for (const [mode, pixels] of Object.entries(savedHeights.heightByMode)) {
      if (isContextPanelMode(mode) && pixels !== undefined) heightByMode[mode] = clampContextPanelHeight(pixels);
    }

    const parsedEditorTabs = persistedEditorTabSchema.parse(rawState);
    next[directory] = {
      editorDiffTab: clampedTabs.some((tab) => tab.mode === 'diff') ? parsedEditorTabs.editorDiffTab : 'closed',
      editorDesktopTab: clampedTabs.some((tab) => tab.mode === DESKTOP_PANEL_MODE) ? parsedEditorTabs.editorDesktopTab : 'closed',
      widthByMode,
      heightByMode,
      isOpen: candidate.isOpen === true,
      expanded: candidate.expanded === true,
      tabs: clampedTabs,
      activeTabId: resolvedTabId,
      zones,
      touchedAt,
    };
  }

  return next;
};

export const clampContextPanelRoots = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  maxRoots: number
): Record<string, ContextPanelDirectoryState> => {
  const entries = Object.entries(byDirectory);
  if (entries.length <= maxRoots) {
    return byDirectory;
  }

  entries.sort((a, b) => (b[1]?.touchedAt ?? 0) - (a[1]?.touchedAt ?? 0));
  const next: Record<string, ContextPanelDirectoryState> = {};
  for (const [directory, state] of entries.slice(0, maxRoots)) {
    next[directory] = state;
  }
  return next;
};
