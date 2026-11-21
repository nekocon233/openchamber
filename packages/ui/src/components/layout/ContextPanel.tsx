import { getContextSurfaceDefaultWidth } from '@/lib/surfaces/registry';
import React from 'react';
import { ReceivedPagesTab } from '@/components/chat/sharePages/received/ReceivedPagesTab';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useWorkspaceOverlay } from './editorWorkspaceSizing';
import { EDITOR_MIN_WIDTH } from '@/lib/workspace/editorSplit';
import { useDefaultContextZone, useIsEditorWorkspaceLayout } from './workspaceLayout';

import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { TrackerItemView } from '@/components/views/TrackerItemView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { isBrowserClientRuntime, isDesktopShell } from '@/lib/desktop';
import { getDisambiguatingFolders } from '@/lib/path-utils';
import { getRelativePathLabel } from './contextPanelPaths';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { toast } from '@/components/ui';

const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
import { areTitleMapsEqual, buildSessionTitleMap, EMPTY_SESSION_TITLE_MAP, getSessionIDFromDedupeKey } from './contextPanelSessionTitles';
import { ProjectContextPanel } from './RightSidebarTabs';
import { WorkflowsPanel } from '@/components/chat/workflows/WorkflowsPanel';
import { SubagentsPanel } from '@/components/chat/subagents/SubagentsPanel';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { clampContextEditorTreeWidth, isTrackerBranchTab, useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { useGitStatus } from '@/stores/useGitStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { Icon } from "@/components/icon/Icon";
import { beginLayoutAnimation, cancelWhenLayoutSettled, holdLayoutAnimation, LAYOUT_ANIMATION_EASING, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { useChatCoverageStore } from './chatCoverage';
import { sidebarPendingWidth } from './sidebarPendingWidth';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import { ContextPanelHeaderSlotProvider } from './contextPanelHeaderSlot';
import { getDefaultContextZone, CLOSED_ZONE_VIEW, CONTEXT_ZONE_DEFAULT_WIDTH, getZoneView, isZoneShown, resolveZoneActiveTab, type ContextZone } from '@/lib/workspace/zones';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import { useClosingZoneTab } from './useClosingZoneTab';
import { closeZoneOnEscape } from './zoneEscape';
import { ZoneMoveMenuItems } from './ZoneMoveMenuItems';
import { beginZoneDrag, cancelZoneDrag, finishZoneDrag, startZoneDragGesture, updateZoneDrag } from './zoneDrag';
import { setZoneBody, setZoneHeaderSlot } from './zoneHosts';
import { useOpenUntilSettled, useOpenWhenSettled } from './useOpenUntilSettled';
import { isZoneExposed } from './zoneInteractiveContext';
import { DockedPanelSurfaceContext } from '@/hooks/usePageColors';
import type { TranslateFn } from './contextPanelTabs';
import { getModeLabel, getTabLabel, getTabIcon } from './contextPanelTabs';

const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_CHAT_MIN_WIDTH = 320;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;

const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const clampWidth = (width: number, maxWidth: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_ZONE_DEFAULT_WIDTH;
  }

  return Math.min(maxWidth, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const maxPanelWidth = (availableWidth: number | null): number => {
  if (availableWidth === null) return Number.POSITIVE_INFINITY;
  return Math.max(CONTEXT_PANEL_MIN_WIDTH, availableWidth - CONTEXT_CHAT_MIN_WIDTH);
};

const useSessionTitleMap = (sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  const childStores = useChildStoreManager();
  const snapshotRef = React.useRef<ReadonlyMap<string, string>>(EMPTY_SESSION_TITLE_MAP);
  const sessionIDsRef = React.useRef<readonly string[]>(sessionIDs);

  sessionIDsRef.current = sessionIDs;
  const wanted = sessionIDs.length > 0;

  return React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => (wanted ? childStores.subscribeAllSelected((state) => state.session, notify) : () => undefined),
      [childStores, wanted],
    ),
    React.useCallback(() => {
      const liveStates = Array.from(childStores.children.values(), (store) => store.getState());
      const next = buildSessionTitleMap(liveStates, sessionIDsRef.current);
      if (areTitleMapsEqual(snapshotRef.current, next)) {
        return snapshotRef.current;
      }
      snapshotRef.current = next;
      return next;
    }, [childStores]),
    () => EMPTY_SESSION_TITLE_MAP,
  );
};

const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

const HEADER_DRAG_DISTANCE_PX = 8;
const HEADER_DRAG_EXCLUDED = 'button, a, input, textarea, select, label, [role="button"], [role="tab"], [role="combobox"], [role="switch"], [role="slider"], [data-sortable-tab-id], [contenteditable="true"]';

const isRemountedSurface = (mode: ContextPanelMode): boolean => (
  mode === 'context' || mode === 'git' || mode === 'pr' || mode === 'notes' || mode === 'workflows'
);

const CONTEXT_PANEL_DEFAULT_HEIGHT = 320;
const CONTEXT_PANEL_MIN_HEIGHT = 160;
const CONTEXT_CHAT_MIN_HEIGHT = 200;

const ZONE_GEOMETRY = {
  right: {
    axis: 'x',
    gutter: 'mb-2 ms-2 me-1.5',
    gutterSize: '0.875rem',
    editor: {
      gutter: 'mb-1 ms-0.5 me-1',
      gutterSize: '0.375rem',
      handle: 'absolute bottom-1 inset-s-0 top-0 z-50 w-1.5 cursor-col-resize',
    },
    expanded: 'absolute inset-y-0 inset-e-0 z-20 min-w-0',
    handle: 'absolute bottom-2 inset-s-1 top-0 z-50 w-2 cursor-col-resize',
    sizeVariable: '--oc-context-panel-width',
  },
  left: {
    axis: 'x',
    gutter: 'mb-2 ms-1.5 me-2',
    gutterSize: '0.875rem',
    editor: {
      gutter: 'mb-1 ms-1 me-0.5',
      gutterSize: '0.375rem',
      handle: 'absolute bottom-1 inset-e-0 top-0 z-50 w-1.5 cursor-col-resize',
    },
    expanded: 'absolute inset-y-0 inset-s-0 z-20 min-w-0',
    handle: 'absolute bottom-2 inset-e-1 top-0 z-50 w-2 cursor-col-resize',
    sizeVariable: '--oc-context-panel-width',
  },
  bottom: {
    axis: 'y',
    gutter: 'mb-2 mt-2',
    gutterSize: '1rem',
    editor: {
      gutter: 'mb-1',
      gutterSize: '0.25rem',
      handle: 'absolute inset-x-0 top-0 z-50 h-1.5 cursor-row-resize',
    },
    expanded: 'absolute inset-x-0 bottom-0 z-20 min-h-0',
    handle: 'absolute inset-x-0 top-1 z-50 h-2 cursor-row-resize',
    sizeVariable: '--oc-context-panel-height',
  },
} as const;

const clampHeight = (height: number, maxHeight: number): number => {
  if (!Number.isFinite(height)) {
    return CONTEXT_PANEL_DEFAULT_HEIGHT;
  }

  return Math.min(maxHeight, Math.max(CONTEXT_PANEL_MIN_HEIGHT, Math.round(height)));
};

const maxPanelHeight = (availableHeight: number | null): number => {
  if (availableHeight === null) return Number.POSITIVE_INFINITY;
  return Math.max(CONTEXT_PANEL_MIN_HEIGHT, availableHeight - CONTEXT_CHAT_MIN_HEIGHT);
};

export const ContextPanel: React.FC<{ zone?: ContextZone }> = ({ zone = 'right' }) => {
  const geometry = ZONE_GEOMETRY[zone];
  const layoutAnimationMs = useLayoutAnimationMs();
  const isVertical = geometry.axis === 'y';
  const { t, direction } = useI18n();
  const { files, runtime } = useRuntimeAPIs();
  const isRtl = direction === 'rtl';
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const changeRequestTerm = useChangeRequestTerm(useRepositoryReferenceProvider(effectiveDirectory || null));
  const tabT = React.useCallback<TranslateFn>(
    (key, params) => t(changeRequestCopy(key, changeRequestTerm), params),
    [changeRequestTerm, t],
  );
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const placement = useUIStore((state) => state.contextSurfaceZones);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const defaultZone = useDefaultContextZone();
  const closeContextZone = useUIStore((state) => state.closeContextZone);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const pinContextPanelTab = useUIStore((state) => state.pinContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextZoneSize = useUIStore((state) => state.setContextZoneSize);
  const setContextZoneExpandedChatSize = useUIStore((state) => state.setContextZoneExpandedChatSize);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const contextEditorTreeWidth = useUIStore((state) => state.contextEditorTreeWidth);
  const setContextEditorTreeWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);
  const editorLayout = useIsEditorWorkspaceLayout();
  const spacing = editorLayout ? geometry.editor : geometry;
  const sharedToolWidth = useUIStore((state) => state.editorToolPanelWidth);
  const setSharedToolWidth = useUIStore((state) => state.setEditorToolPanelWidth);
  const usesSharedWidth = editorLayout && !isVertical;
  const overlayPanel = useWorkspaceOverlay((state) => state.panel);
  const floating = editorLayout && overlayPanel === zone;
  const contextEditorVisible = useUIStore((state) => state.contextEditorVisible);
  const toggleContextEditor = useUIStore((state) => state.toggleContextEditor);
  const fileTreeSide = useUIStore((state) => state.fileTreeSide);
  const openNewContextBrowserTab = useUIStore((state) => state.openNewContextBrowserTab);
  const faviconByOrigin = useBrowserFaviconStore((state) => state.byOrigin);
  const [headerSlotEl, setHeaderSlotEl] = React.useState<HTMLDivElement | null>(null);
  const registerHeaderSlot = React.useCallback((element: HTMLDivElement | null) => {
    setHeaderSlotEl(element);
    setZoneHeaderSlot(zone, element);
  }, [zone]);
  const registerBody = React.useCallback((element: HTMLDivElement | null) => {
    setZoneBody(zone, element);
  }, [zone]);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  // This zone's tab: one of its own surfaces, never one placed elsewhere.
  const storedActiveTab = panelState ? resolveZoneActiveTab(panelState, placement, zone, defaultZone) : null;
  const zoneView = panelState ? getZoneView(panelState, zone) : CLOSED_ZONE_VIEW;
  const chatCovered = useChatCoverageStore((state) => state.covered);
  // The bottom zone belongs to the chat column: a page covering the chat
  // covers it too.
  const coveredByPage = zone === 'bottom' && chatCovered;
  const isOpen = Boolean(zoneView.isOpen && storedActiveTab) && !coveredByPage;
  const activeTab = useClosingZoneTab(storedActiveTab, isOpen);
  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );
  // The editor column is shown for an open file unless the user hid it; the
  // tree never hides alongside it, so a hidden tree forces the editor back.
  const showsEditor = !editorLayout && hasOpenEditorFile && (contextEditorVisible || !contextEditorTreeVisible);
  const activeModeForWidth = activeTab?.mode ?? null;
  // A side zone without an editor shrinks to the tree; the bottom zone keeps
  // its full width either way.
  const isTreeOnly = !isVertical && activeModeForWidth === 'file' && !showsEditor;
  const isExpanded = Boolean(isOpen && zoneView.expanded && !isTreeOnly && !floating);
  // Editor layout shares one tool-column width across modes and projects.
  // Classic retains each surface's width; bottom zones retain their heights.
  // Window constraints clamp the visible size without rewriting the preference.
  const manualSize = activeModeForWidth
    ? (isVertical ? panelState?.heightByMode?.[activeModeForWidth] : panelState?.widthByMode?.[activeModeForWidth])
    : undefined;
  const desiredSize = usesSharedWidth ? sharedToolWidth : isTreeOnly
    ? contextEditorTreeWidth
    : isVertical
      ? clampHeight(manualSize ?? CONTEXT_PANEL_DEFAULT_HEIGHT, Number.POSITIVE_INFINITY)
      : clampWidth(manualSize ?? CONTEXT_ZONE_DEFAULT_WIDTH, Number.POSITIVE_INFINITY);
  const clampSize = React.useCallback((next: number, available: number | null) => (
    isVertical ? clampHeight(next, maxPanelHeight(available)) : clampWidth(next, maxPanelWidth(available))
  ), [isVertical]);
  const chatMinimum = isVertical ? CONTEXT_CHAT_MIN_HEIGHT : CONTEXT_CHAT_MIN_WIDTH;

  const otherSide = zone === 'right' ? 'left' : zone === 'left' ? 'right' : null;
  const otherSideWidth = useUIStore((state) => {
    if (!otherSide || !directoryKey) return 0;
    const panel = state.contextPanelByDirectory[directoryKey];
    const tab = panel && isZoneShown(panel, state.contextSurfaceZones, otherSide, getDefaultContextZone(state.workspaceLayout))
      ? resolveZoneActiveTab(panel, state.contextSurfaceZones, otherSide, getDefaultContextZone(state.workspaceLayout))
      : null;
    if (!panel || !tab) return 0;
    if (state.workspaceLayout === 'editor') return state.editorToolPanelWidth;
    const editorShown = panel.tabs.some((entry) => entry.mode === 'file' && entry.targetPath)
      && (state.contextEditorVisible || !state.contextEditorTreeVisible);
    if (tab.mode === 'file' && !editorShown) return state.contextEditorTreeWidth;
    return panel.widthByMode[tab.mode] ?? getContextSurfaceDefaultWidth(tab.mode);
  });
  const otherSideReserved = editorLayout && overlayPanel === otherSide ? 0 : otherSideWidth;
  const editorReserved = editorLayout && !isVertical && !floating ? EDITOR_MIN_WIDTH : 0;
  const editorReservedRef = React.useRef(editorReserved);
  editorReservedRef.current = editorReserved;
  const [measuredArea, setMeasuredArea] = React.useState<number | null>(null);
  const measuredAreaSizeRef = React.useRef<number | null>(null);
  const otherSideRef = React.useRef(otherSideReserved);
  otherSideRef.current = otherSideReserved;
  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const areaDecidesRef = React.useRef<(measured: number) => boolean>(() => false);
  areaDecidesRef.current = (measured) => isExpanded || ((usesSharedWidth || !isTreeOnly) && measured - otherSideRef.current - editorReservedRef.current - chatMinimum < desiredSize);
  const applyAreaSize = React.useCallback(() => {
    let measured = measuredAreaSizeRef.current;
    if (measured !== null && !isVertical && isOpenRef.current) measured += sidebarPendingWidth();
    setMeasuredArea(measured !== null && areaDecidesRef.current(measured) ? measured : null);
  }, [isVertical]);
  // Side zones share the row with the editor and chat; navigation sits outside it.
  const areaSize = measuredArea !== null ? measuredArea - otherSideReserved - editorReserved : null;
  // Expanded, the left zone covers the whole row; the right one covers the
  // chat area beside the left zone, as before zones.
  const expandedArea = zone === 'left' ? measuredArea : areaSize;
  const size = floating || (isTreeOnly && !usesSharedWidth) ? desiredSize : clampSize(desiredSize, areaSize);
  // Titles are for this zone's chat tab strip only; a zone that is closed or
  // shows another surface subscribes to none.
  const showsChatTabs = isOpen && activeTab?.mode === 'chat';
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    if (!showsChatTabs) return ids;
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [showsChatTabs, tabs]);
  const sessionTitleById = useSessionTitleMap(chatSessionIDs);

  const [isResizing, setIsResizing] = React.useState(false);
  const startPointerRef = React.useRef(0);
  const startSizeRef = React.useRef(size);
  const resizingSizeRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const focusSinkRef = React.useRef<HTMLDivElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useLayoutEffect(() => {
    const parent = isVertical
      ? panelRef.current?.parentElement
      : panelRef.current?.closest<HTMLElement>('[data-workspace-row]');
    if (!parent || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      const measured = isVertical ? rect?.height : rect?.width;
      measuredAreaSizeRef.current = measured ? Math.round(measured) : null;
      runWhenLayoutSettled(applyAreaSize);
    });
    observer.observe(parent);
    measuredAreaSizeRef.current = (isVertical ? parent.clientHeight : parent.clientWidth) || null;
    applyAreaSize();

    return () => {
      observer.disconnect();
      cancelWhenLayoutSettled(applyAreaSize);
    };
  }, [applyAreaSize, defaultZone, isVertical]);

  const sidebarMovesZone = !isVertical && isOpen && (isExpanded || measuredArea !== null);
  const sidebarOpen = useUIStore((state) => sidebarMovesZone && state.isSidebarOpen);
  React.useLayoutEffect(() => {
    applyAreaSize();
  }, [applyAreaSize, desiredSize, isExpanded, isOpen, sidebarOpen, otherSideReserved, editorReserved]);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusSinkRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const resizeAvailableSizeRef = React.useRef<number | null>(null);
  const resizeFrameRef = React.useRef<number | null>(null);
  const releaseResizeHoldRef = React.useRef<(() => void) | null>(null);
  const dragShieldRef = React.useRef<HTMLDivElement | null>(null);
  const sizeFromDragRef = React.useRef(false);

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const writeDragSize = React.useCallback((next: number) => {
    const panel = panelRef.current;
    const card = cardRef.current;
    if (!panel || !card) return;
    const property = isVertical ? 'height' : 'width';
    panel.style[property] = `min(${next}px, 100%)`;
    card.style[property] = `calc(${next}px - ${geometry.gutterSize})`;
  }, [geometry.gutterSize, isVertical]);

  const applyResizeSize = React.useCallback(() => {
    resizeFrameRef.current = null;
    const next = resizingSizeRef.current;
    if (next !== null) writeDragSize(next);
  }, [writeDragSize]);

  React.useEffect(() => () => {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }
    releaseResizeHoldRef.current?.();
    releaseResizeHoldRef.current = null;
    dragShieldRef.current?.remove();
    dragShieldRef.current = null;
  }, []);

  const clampSizeForDrag = React.useCallback((nextSize: number) => {
    const available = resizeAvailableSizeRef.current;
    const clamped = isTreeOnly && !usesSharedWidth ? clampContextEditorTreeWidth(nextSize) : clampSize(nextSize, available);
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, [clampSize, isTreeOnly, usesSharedWidth]);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || !directoryKey) {
      return;
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startPointerRef.current = isVertical ? event.clientY : event.clientX;
    startSizeRef.current = size;
    resizingSizeRef.current = size;
    // Measure once per drag; no layout reads happen during pointermove.
    // The same area the ceiling uses: the row less the other side and sessions.
    const available = isVertical
      ? panelRef.current?.parentElement?.clientHeight
      : (panelRef.current?.closest<HTMLElement>('[data-workspace-row]')?.clientWidth ?? 0) - otherSideRef.current - editorReservedRef.current;
    resizeAvailableSizeRef.current = available && available > 0 ? available : null;
    dragShieldRef.current?.remove();
    const shield = document.createElement('div');
    shield.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${isVertical ? 'row-resize' : 'col-resize'}`;
    document.body.appendChild(shield);
    dragShieldRef.current = shield;
    releaseResizeHoldRef.current?.();
    releaseResizeHoldRef.current = holdLayoutAnimation(isVertical ? 'height' : 'width');
    event.preventDefault();
  }, [directoryKey, isOpen, isVertical, size]);

  const finishResize = React.useCallback(() => {
    const finalSize = clampSizeForDrag(resizingSizeRef.current ?? size);
    const available = resizeAvailableSizeRef.current;
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    const panel = panelRef.current;
    const card = cardRef.current;
    if (panel && card) {
      const property = isVertical ? 'height' : 'width';
      panel.style.setProperty(geometry.sizeVariable, `${finalSize}px`);
      panel.style[property] = slotSizeRef.current;
      card.style[property] = cardSizeRef.current;
    }
    resizingSizeRef.current = null;
    resizeAvailableSizeRef.current = null;
    sizeFromDragRef.current = true;
    dragShieldRef.current?.remove();
    dragShieldRef.current = null;
    if (usesSharedWidth) {
      setSharedToolWidth(finalSize);
    } else if (isTreeOnly) {
      setContextEditorTreeWidth(finalSize);
    } else if (isExpanded) {
      if (available !== null) setContextZoneExpandedChatSize(zone, available - finalSize);
    } else {
      setContextZoneSize(zone, finalSize);
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
    releaseResizeHoldRef.current?.();
    releaseResizeHoldRef.current = null;
  }, [clampSizeForDrag, geometry.sizeVariable, isExpanded, isTreeOnly, isVertical, setContextEditorTreeWidth, setContextZoneExpandedChatSize, setContextZoneSize, setSharedToolWidth, size, usesSharedWidth, zone]);

  React.useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      const pointer = isVertical ? event.clientY : event.clientX;
      const towardChat = zone === 'left' ? pointer - startPointerRef.current : startPointerRef.current - pointer;
      const delta = !isVertical && isRtl ? -towardChat : towardChat;
      const nextSize = clampSizeForDrag(startSizeRef.current + delta);
      if (resizingSizeRef.current === nextSize) {
        return;
      }
      resizingSizeRef.current = nextSize;
      if (resizeFrameRef.current === null) {
        resizeFrameRef.current = requestAnimationFrame(applyResizeSize);
      }
    };

    const handleUp = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      finishResize();
    };

    const handleWindowBlur = () => {
      finishResize();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [applyResizeSize, clampSizeForDrag, finishResize, isResizing, isRtl, isVertical, zone]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingSizeRef.current = null;
      dragShieldRef.current?.remove();
      dragShieldRef.current = null;
    }
  }, [isResizing]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    closeContextZone(directoryKey, zone);
  }, [closeContextZone, directoryKey, zone]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey, zone);
  }, [directoryKey, toggleContextPanelExpanded, zone]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    closeZoneOnEscape(event, isOpen, handleClose);
  }, [handleClose, isOpen]);

  const isMultiInstanceMode = (!editorLayout && activeTab?.mode === 'file') || activeTab?.mode === 'chat' || activeTab?.mode === 'browser' || activeTab?.mode === 'pr' || activeTab?.mode === 'pages';
  const activeModeTabs = React.useMemo(() => {
    if (!activeTab) return [];
    const modeTabs = tabs.filter((tab) => tab.mode === activeTab.mode);
    return activeTab.mode === 'pr'
      ? [...modeTabs.filter(isTrackerBranchTab), ...modeTabs.filter((tab) => !isTrackerBranchTab(tab))]
      : modeTabs;
  }, [activeTab, tabs]);
  const trackerBranch = useGitStatus(activeTab?.mode === 'pr' && directoryKey ? directoryKey : null)?.current ?? null;

  const activeTabId = activeTab?.id;
  const tabItems = React.useMemo(() => {
    const fileFolders = getDisambiguatingFolders(activeModeTabs
      .filter((tab) => tab.mode === 'file')
      .map((tab) => getRelativePathLabel(tab.targetPath, effectiveDirectory)));
    return activeModeTabs.map((tab) => {
      const branchTab = isTrackerBranchTab(tab);
      const rawLabel = branchTab ? trackerBranch || t('contextPanel.tracker.branchTab') : getTabLabel(tab, sessionTitleById, tabT);
      const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
      const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
      return {
        id: tab.id,
        label,
        labelFolder: tab.mode === 'file' ? fileFolders.get(tabPathLabel) : undefined,
        icon: getTabIcon(tab, faviconByOrigin, tab.id === activeTabId, isOpen),
        title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
        closeLabel: t('contextPanel.tab.closeTabAria', { label }),
        closeShortcut: tab.id === activeTabId && isDesktopShell() ? formatShortcutForDisplay('mod+w', '') : undefined,
        closable: !branchTab,
        preview: tab.preview,
      };
    });
  }, [activeModeTabs, activeTabId, effectiveDirectory, faviconByOrigin, isOpen, sessionTitleById, t, tabT, trackerBranch]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ContextPanelContent /></ContextPanelHeaderSlotProvider>
        : activeTab?.mode === 'git'
            ? <React.Suspense fallback={null}><ContextPanelHeaderSlotProvider value={headerSlotEl}><GitView isActive={isOpen} /></ContextPanelHeaderSlotProvider></React.Suspense>
            : activeTab?.mode === 'pr'
                ? (activeTab.targetPath
                    ? (
                      <TrackerItemView
                        key={activeTab.id}
                        url={activeTab.targetPath}
                        directory={activeTab.targetDirectory ?? effectiveDirectory}
                        panelDirectory={effectiveDirectory}
                        tabId={activeTab.id}
                        foreign={Boolean(activeTab.targetDirectory)}
                        visible={isOpen}
                      />
                    )
                    : null)
            : activeTab?.mode === 'notes'
                ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><ProjectContextPanel visible={isOpen} /></ContextPanelHeaderSlotProvider>
            : activeTab?.mode === 'workflows'
                ? <ContextPanelHeaderSlotProvider value={headerSlotEl}><WorkflowsPanel directory={effectiveDirectory || null} /></ContextPanelHeaderSlotProvider>
            : activeTab?.mode === 'pages' && !activeTab.targetPath
                ? <ReceivedPagesTab />
        : null;

  const isFileTabActive = activeTab?.mode === 'file';

  const editorClosesTab = isFileTabActive && Boolean(activeTab?.targetPath) && showsEditor;
  const shortcutClosableTabId = isOpen && activeTab && isMultiInstanceMode && !editorClosesTab && !isTrackerBranchTab(activeTab)
    ? activeTab.id
    : null;
  React.useEffect(() => {
    if (!directoryKey || !shortcutClosableTabId) return;
    return registerCloseTabTarget(() => closeContextPanelTab(directoryKey, shortcutClosableTabId), panelRef);
  }, [closeContextPanelTab, directoryKey, shortcutClosableTabId]);

  const closeContextPanelTabs = useUIStore((state) => state.closeContextPanelTabs);
  const renderTabContextMenu = React.useCallback(
    (args: { id: string; index: number; allIds: string[]; close: () => void }): React.ReactNode => {
      if (!directoryKey) {
        return null;
      }
      const { id, index, allIds, close } = args;
      const filePath = tabs.find((tab) => tab.id === id && tab.mode === 'file')?.targetPath;
      const copyPath = (value: string, relative: boolean) => {
        void copyTextToClipboard(value).then((result) => {
          if (result.ok) {
            toast.success(t(relative ? 'filesView.toast.relativePathCopied' : 'sidebarFilesTree.toast.pathCopied'));
          } else {
            toast.error(t('sidebarFilesTree.toast.copyFailed'));
          }
        });
      };
      const closeOthers = () => closeContextPanelTabs(directoryKey, allIds.filter((tabId) => tabId !== id));
      const before = allIds.slice(0, index);
      const after = allIds.slice(index + 1);
      const closeToLeft = () => closeContextPanelTabs(directoryKey, isRtl ? after : before);
      const closeToRight = () => closeContextPanelTabs(directoryKey, isRtl ? before : after);
      const closeAll = () => closeContextPanelTabs(directoryKey, allIds);
      const hasOthers = allIds.length > 1;
      const nothingToLeft = isRtl ? index === allIds.length - 1 : index === 0;
      const nothingToRight = isRtl ? index === 0 : index === allIds.length - 1;
      return (
        <>
          {filePath && (
            <>
              <ContextMenuItem onClick={() => copyPath(filePath, false)}>
                <Icon name="link" className="me-2 size-4" /> {t('sidebarFilesTree.menu.copyPath')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => copyPath(getRelativePathLabel(filePath, effectiveDirectory), true)}>
                <Icon name="file-copy-2" className="me-2 size-4" /> {t('filesView.tree.menu.copyRelativePath')}
              </ContextMenuItem>
              {files.revealPath && !isBrowserClientRuntime(runtime.platform) && (
                <ContextMenuItem onClick={() => {
                  void files.revealPath?.(filePath).catch(() => toast.error(t('sidebarFilesTree.toast.revealFailed')));
                }}>
                  <Icon name="folder-received" className="me-2 size-4" /> {t(getRevealLabelKey())}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={close}>
            <Icon name="close" className="me-2 size-4" />
            {t('contextPanel.tab.menu.close')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeOthers} disabled={!hasOthers}>
            <Icon name="expand-horizontal" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeOthers')}
          </ContextMenuItem>
          <ContextMenuItem onClick={closeToLeft} disabled={nothingToLeft}>
            <Icon name="expand-left" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeToLeft')}
          </ContextMenuItem>
          <ContextMenuItem onClick={closeToRight} disabled={nothingToRight}>
            <Icon name="expand-right" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeToRight')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={closeAll} disabled={!hasOthers}>
            <Icon name="close-circle" className="me-2 size-4" />
            {t('contextPanel.tab.menu.closeAll')}
          </ContextMenuItem>
          {activeTab ? (
            <>
              <ContextMenuSeparator />
              <ZoneMoveMenuItems mode={activeTab.mode} />
            </>
          ) : null}
        </>
      );
    },
    [activeTab, closeContextPanelTabs, directoryKey, effectiveDirectory, files, isRtl, runtime.platform, t, tabs],
  );

  const handleTabDragOut = React.useCallback((tabId: string, isOutside: (point: { x: number; y: number }) => boolean) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) return null;
    const gesture = startZoneDragGesture({ mode: tab.mode, label: getModeLabel(tab.mode, tabT), from: zone }, isOutside);
    return { finish: () => gesture.finish(directoryKey), cancel: gesture.cancel };
  }, [directoryKey, tabT, tabs, zone]);

  const [headerEl, setHeaderEl] = React.useState<HTMLElement | null>(null);
  const handleHeaderPointerDown = React.useCallback((event: PointerEvent) => {
    if (!activeTab || event.button !== 0 || event.pointerType === 'touch') return;
    if (event.target instanceof Element && event.target.closest(HEADER_DRAG_EXCLUDED)) return;
    const mode = activeTab.mode;
    const label = getModeLabel(mode, tabT);
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    const onMove = (moveEvent: PointerEvent) => {
      const point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!dragging) {
        if (Math.hypot(point.x - start.x, point.y - start.y) < HEADER_DRAG_DISTANCE_PX) return;
        dragging = beginZoneDrag({ mode, label, from: zone });
        if (!dragging) return;
      }
      updateZoneDrag(point);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
    };
    const onUp = () => {
      stop();
      if (dragging) finishZoneDrag(directoryKey);
    };
    const onCancel = () => {
      stop();
      if (dragging) cancelZoneDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  }, [activeTab, directoryKey, tabT, zone]);
  React.useEffect(() => {
    if (!headerEl) return undefined;
    headerEl.addEventListener('pointerdown', handleHeaderPointerDown);
    return () => headerEl.removeEventListener('pointerdown', handleHeaderPointerDown);
  }, [handleHeaderPointerDown, headerEl]);

  const header = (
    <header
      ref={setHeaderEl}
      className="group/panel-header flex min-h-10 select-none items-stretch border-b border-border"
    >
      {isMultiInstanceMode ? (
        <SortableTabsStrip
          items={tabItems}
          activeId={activeTab?.id ?? null}
          onSelect={(tabID) => {
            if (!directoryKey) {
              return;
            }
            setActiveContextPanelTab(directoryKey, tabID);
          }}
          onClose={(tabID) => {
            if (!directoryKey) {
              return;
            }
            closeContextPanelTab(directoryKey, tabID);
          }}
          onReorder={(activeTabID, overTabID) => {
            if (!directoryKey) {
              return;
            }
            reorderContextPanelTabs(directoryKey, activeTabID, overTabID);
          }}
          onDoubleClickTab={(tabID) => {
            if (directoryKey) pinContextPanelTab(directoryKey, tabID);
          }}
          layoutMode="scrollable"
          scrollWithWheel={isFileTabActive}
          variant="default"
          tabContextMenu={renderTabContextMenu}
          onTabDragOut={handleTabDragOut}
        />
      ) : (
        <>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3 group-has-[[data-context-panel-toolbar]]/panel-header:hidden">
          {activeTab ? getTabIcon(activeTab, faviconByOrigin) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab ? getModeLabel(activeTab.mode, tabT) : null}
          </span>
        </div>
        {/* The active surface's own toolbar lands here (contextPanelHeaderSlot). */}
        <div ref={registerHeaderSlot} className="flex min-w-0 flex-1 items-stretch ps-1.5 empty:hidden has-[[data-context-panel-actions]]:flex-none" />
        </>
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 self-start px-1.5">
        {activeTab?.mode === 'browser' ? (
          <Tooltip>
          <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!directoryKey) return;
              openNewContextBrowserTab(directoryKey);
            }}
            className="h-7 w-7 p-0"
            aria-label={t('contextPanel.browser.newTab')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('contextPanel.browser.newTab')}</TooltipContent>
          </Tooltip>
        ) : null}
        {/* Each icon toggles the column on its side: the editor and the tree
            swap sides with the file tree side setting, the icons stay put. */}
        {isFileTabActive && !editorLayout ? (['left', 'right'] as const).map((side) => {
          const isTree = side === fileTreeSide;
          if (!isTree && !hasOpenEditorFile) return null;
          const label = isTree ? t('contextRail.editorTree.toggle') : t('contextRail.editor.toggle');
          const shown = isTree ? contextEditorTreeVisible : showsEditor;
          const tooltip = isTree
            ? t(shown ? 'contextTooltips.panel.hideFileTree' : 'contextTooltips.panel.showFileTree')
            : t(shown ? 'contextTooltips.panel.hideFileEditor' : 'contextTooltips.panel.showFileEditor');
          return (
            <Tooltip key={side}>
            <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={isTree ? toggleContextEditorTree : toggleContextEditor}
              className="h-7 w-7 p-0"
              aria-label={label}
              aria-pressed={shown}
            >
              <Icon name={side === 'left' ? 'layout-left' : 'layout-right'} className="h-3.5 w-3.5" />
            </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{tooltip}</TooltipContent>
            </Tooltip>
          );
        }) : null}
        {!isTreeOnly && !floating ? (
          <Tooltip>
          <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleToggleExpanded}
            className="h-7 w-7 p-0"
            aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          >
            {isExpanded ? <Icon name="fullscreen-exit" className="h-3.5 w-3.5" /> : <Icon name="fullscreen" className="h-3.5 w-3.5" />}
          </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_context_panel_expanded', shortcutOverrides), '')} /></TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
        <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          aria-label={t('contextPanel.actions.closePanel')}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{t('contextPanel.actions.closePanel')}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );

  // Closed zones occupy no space; expanded zones retain a spacer while floating.
  const expandedSize = expandedArea !== null ? `${expandedArea}px` : '100%';
  const slotSize = !isOpen
    ? '0px'
    : isExpanded
      // px, not '100%': px↔% size changes do not interpolate, which
      // would make the expand/collapse snap instead of animating.
      ? expandedSize
      : `min(var(${geometry.sizeVariable}), 100%)`;

  // The bottom card spans the chat column. Next to a card on either side it
  // gives up its own gutter on that side, so neighbours stand one gutter apart.
  const leftZoneShown = zone === 'bottom' && isZoneShown(panelState, placement, 'left', defaultZone);
  const rightSlotFilled = zone === 'bottom' && isZoneShown(panelState, placement, 'right', defaultZone);

  // What the user changed, as opposed to the zone following the window: a
  // toggle, expanding, another surface's or a dragged
  // size. Only these animate as an announced layout animation; the chat area
  // resizing (a window drag, a clamp) is tracked without one, so the work
  // that waits for an animation's end is not held back for the whole drag.
  const animationKey = `${isOpen}|${isExpanded}|${isOpen ? desiredSize : ''}`;
  const animationKeyRef = React.useRef(animationKey);
  const coveredRef = React.useRef(chatCovered);
  const coverChanged = coveredRef.current !== chatCovered;
  React.useLayoutEffect(() => {
    coveredRef.current = chatCovered;
  }, [chatCovered]);
  React.useLayoutEffect(() => {
    if (animationKeyRef.current === animationKey) return;
    animationKeyRef.current = animationKey;
    const draggedSize = sizeFromDragRef.current;
    if (!coverChanged && !draggedSize) beginLayoutAnimation(layoutAnimationMs);
  }, [animationKey, coverChanged, layoutAnimationMs]);
  React.useLayoutEffect(() => {
    sizeFromDragRef.current = false;
  });

  const contentHidden = !isZoneExposed(isOpen, useOpenWhenSettled(isOpen), activeTab?.mode);
  const contentShown = useOpenUntilSettled(isOpen);
  // Expanded, and through the collapse animation, the zone floats over the
  // chat while a spacer holds its docked size in the layout, so the chat
  // never changes size under it. Back in the layout at once on collapse, the
  // zone started at the full area and squeezed the chat to nothing: the
  // transcript measured its rows at that width, thousands of pixels tall, and
  // stayed blank until the session was reopened.
  const overlaid = useOpenUntilSettled(isExpanded);

  const panelStyle: React.CSSProperties = {
    [geometry.sizeVariable]: `${size}px`,
    ...(isVertical
      ? { height: slotSize, maxHeight: '100%' }
      : { width: slotSize, maxWidth: '100%' }),
    transitionDuration: coverChanged || isResizing ? '0ms' : `${layoutAnimationMs}ms`,
    transitionTimingFunction: LAYOUT_ANIMATION_EASING,
  };

  // Less the gutters the aside reserves for the card. px in the expanded
  // state too: px↔% size changes cannot interpolate, so the header controls
  // would snap instead of riding the animation.
  const cardSize = floating ? `calc(100% - ${spacing.gutterSize})` : isExpanded
    ? (expandedArea !== null ? `calc(${expandedArea}px - ${spacing.gutterSize})` : '100%')
    : `calc(var(${geometry.sizeVariable}) - ${spacing.gutterSize})`;
  const slotSizeRef = React.useRef(slotSize);
  slotSizeRef.current = slotSize;
  const cardSizeRef = React.useRef(cardSize);
  cardSizeRef.current = cardSize;

  return (
    <aside
      ref={panelRef}
      onKeyDownCapture={handlePanelKeyDownCapture}
      data-context-panel="true"
      data-workspace-overlay={floating || undefined}
      data-context-zone={zone}
      data-right-slot={zone === 'right' ? '' : undefined}
      data-context-panel-open={isOpen ? 'true' : 'false'}
      data-zone-size={size}
      tabIndex={-1}
      className={cn(
        // external: https://developer.mozilla.org/en-US/docs/Web/CSS/overflow A hidden axis also makes clip on the other axis compute to hidden.
        'flex min-h-0 flex-col overflow-clip bg-background',
        'isolate',
        // Anchored to its window edge while expanded: `inset-0` would teleport
        // the far edge instantly (position does not transition), so only the
        // size animates and the zone grows toward the chat from where it docks.
        floating ? (zone === 'left' ? 'absolute inset-s-0 inset-y-0 z-40 shadow-xl' : 'absolute inset-e-0 inset-y-0 z-40 shadow-xl') : overlaid
          ? geometry.expanded
          : isVertical ? 'relative w-full flex-shrink-0' : 'relative h-full flex-shrink-0',
        isVertical ? 'transition-[height]' : 'transition-[width]',
        'motion-reduce:transition-none',
      )}
      style={panelStyle}
    >
      <div ref={focusSinkRef} tabIndex={-1} className="absolute size-0 overflow-hidden outline-none" />
      {isOpen && !isExpanded && !floating && (
        // In the gutter facing the chat, along the card's edge. Nothing paints
        // on hover or drag: the cursor says it is draggable, and the card edge
        // itself moves on release.
        <div
          className={spacing.handle}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation={isVertical ? 'horizontal' : 'vertical'}
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        ref={cardRef}
        data-zone-card=""
        className={cn(
          'relative z-10 flex min-h-0 shrink-0 flex-col motion-reduce:transition-none',
          // The gutter sets the card apart from the chat and leaves its shadow
          // room on every side the aside clips; the resize handle sits in the
          // one facing the chat.
          spacing.gutter,
          zone === 'bottom' && (editorLayout ? 'mx-0.5' : cn(leftZoneShown ? 'ms-0' : 'ms-2', rightSlotFilled ? 'me-0' : 'me-1.5')),
          !isVertical && (editorLayout ? 'h-[calc(100%-0.25rem)]' : 'h-[calc(100%-0.5rem)]'),
          // A framed card, inset from the chat: its own border and radius rather
          // than a divider running the length of the window.
          // The dropdown's hairline ring (`oc-panel-edge`), shared with the
          // work-status card.
          'oc-panel-edge overflow-hidden rounded-[10px] bg-background',
          isVertical ? 'transition-[height,opacity]' : 'transition-[width,opacity,margin-inline-start]',
          !isOpen && 'opacity-0',
          contentHidden && 'pointer-events-none select-none'
        )}
        style={{
          ...(isVertical
            ? { height: cardSize, width: `calc(100% - ${editorLayout ? 0.25 : (leftZoneShown ? 0 : 0.5) + (rightSlotFilled ? 0 : 0.375)}rem)` }
            : { width: cardSize }),
          
          transitionDuration: isResizing ? '0ms' : `${layoutAnimationMs}ms`,
          transitionTimingFunction: LAYOUT_ANIMATION_EASING,
        }}
        inert={contentHidden || undefined}
      >
      <DockedPanelSurfaceContext.Provider value>
      {header}
      <div ref={registerBody} className="relative min-h-0 flex-1 overflow-hidden">
        {activeTab?.mode === 'subagents' ? (contentShown ? <SubagentsPanel directory={effectiveDirectory || null} /> : null)
          : activeTab && (isRemountedSurface(activeTab.mode) || (activeTab.mode === 'pages' && !activeTab.targetPath)) ? activeNonChatContent : null}
      </div>
      </DockedPanelSurfaceContext.Provider>
      </div>
    </aside>
  );
};
