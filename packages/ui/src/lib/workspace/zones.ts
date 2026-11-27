import { z } from 'zod';
import { isContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';
import type { WorkspaceLayout } from './sidebarGeometry';

export const DESKTOP_GUEST_ID = 'openchamber-builtin-desktop';
export const DESKTOP_PANEL_MODE = `plugin:${DESKTOP_GUEST_ID}` as const;

/**
 * Where a context surface opens around the chat. The chat is always the
 * centre and takes the remaining space; every other surface lives in one of
 * three zones. The layout supplies the default; manual placements override it.
 */
export type ContextZone = 'left' | 'right' | 'bottom';
export type DefaultContextZone = 'left' | 'right';

export const CONTEXT_ZONES: readonly ContextZone[] = ['left', 'right', 'bottom'];

export const CONTEXT_ZONE_DEFAULT_WIDTH = 640;

/** Explicit surface placements, per device. Missing modes follow the layout. */
export type ContextZonePlacement = Partial<Record<ContextPanelMode, ContextZone>>;

export const getDefaultContextZone = (layout: WorkspaceLayout): DefaultContextZone => layout === 'editor' ? 'left' : 'right';

export type ContextZoneView = {
  isOpen: boolean;
  expanded: boolean;
  activeTabId: string | null;
};

export const CLOSED_ZONE_VIEW: ContextZoneView = { isOpen: false, expanded: false, activeTabId: null };

export type MovedZoneViews = { left: ContextZoneView; bottom: ContextZoneView };

type ZonedTab = { id: string; mode: ContextPanelMode; touchedAt: number };

export type ZonedPanel<T extends ZonedTab = ZonedTab> = ContextZoneView & {
  tabs: readonly T[];
  zones: MovedZoneViews;
};

export const zoneOfMode = (placement: ContextZonePlacement, mode: ContextPanelMode, defaultZone: DefaultContextZone = 'right'): ContextZone =>
  placement[mode] ?? defaultZone;

export const getZoneView = (panel: ZonedPanel, zone: ContextZone): ContextZoneView => (
  zone === 'right'
    ? { isOpen: panel.isOpen, expanded: panel.expanded, activeTabId: panel.activeTabId }
    : panel.zones[zone]
);

export const withZoneView = <P extends ZonedPanel>(panel: P, zone: ContextZone, patch: Partial<ContextZoneView>): P => (
  zone === 'right'
    ? { ...panel, ...patch }
    : { ...panel, zones: { ...panel.zones, [zone]: { ...panel.zones[zone], ...patch } } }
);

const tabsInZone = <T extends ZonedTab>(tabs: readonly T[], placement: ContextZonePlacement, zone: ContextZone, defaultZone: DefaultContextZone = 'right'): T[] =>
  tabs.filter((tab) => !(defaultZone === 'left' && tab.mode === DESKTOP_PANEL_MODE) && zoneOfMode(placement, tab.mode, defaultZone) === zone);

export const resolveZoneActiveTabId = (
  tabs: readonly ZonedTab[],
  placement: ContextZonePlacement,
  zone: ContextZone,
  activeTabId: string | null,
  defaultZone: DefaultContextZone = 'right',
): string | null => {
  const zoneTabs = tabsInZone(tabs, placement, zone, defaultZone);
  if (activeTabId && zoneTabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  return zoneTabs.at(-1)?.id ?? null;
};

export const resolveZoneActiveTab = <T extends ZonedTab>(
  panel: ZonedPanel<T>,
  placement: ContextZonePlacement,
  zone: ContextZone,
  defaultZone: DefaultContextZone = 'right',
): T | null => {
  const id = resolveZoneActiveTabId(panel.tabs, placement, zone, getZoneView(panel, zone).activeTabId, defaultZone);
  return id ? panel.tabs.find((tab) => tab.id === id) ?? null : null;
};

/** The zone is on screen: open, with a tab of its own to show. */
export const isZoneShown = (panel: ZonedPanel | undefined, placement: ContextZonePlacement, zone: ContextZone, defaultZone: DefaultContextZone = 'right'): boolean => (
  Boolean(panel && getZoneView(panel, zone).isOpen && resolveZoneActiveTab(panel, placement, zone, defaultZone))
);

export const canZoneExpand = (
  panel: ZonedPanel<ZonedTab & { targetPath?: string | null }> | undefined,
  view: { workspaceLayout: WorkspaceLayout; contextSurfaceZones: ContextZonePlacement; contextEditorVisible: boolean; contextEditorTreeVisible: boolean },
  zone: ContextZone,
): boolean => {
  const defaultZone = getDefaultContextZone(view.workspaceLayout);
  const tab = panel && getZoneView(panel, zone).isOpen
    ? resolveZoneActiveTab(panel, view.contextSurfaceZones, zone, defaultZone)
    : null;
  if (!panel || !tab) return false;
  if (zone === 'bottom' || tab.mode !== 'file') return true;
  return view.workspaceLayout === 'classic'
    && panel.tabs.some((entry) => entry.mode === 'file' && entry.targetPath)
    && (view.contextEditorVisible || !view.contextEditorTreeVisible);
};

type SideZoneSizing = {
  contextZoneSizes: Partial<Record<ContextZone, number>>;
  contextEditorVisible: boolean;
  contextEditorTreeVisible: boolean;
  contextEditorTreeWidth: number;
};

type SizedTab = ZonedTab & { targetPath?: string | null };

export const showsFileTreeOnly = (panel: ZonedPanel<SizedTab>, tab: SizedTab, sizing: SideZoneSizing): boolean => {
  if (tab.mode !== 'file') return false;
  const editorShown = panel.tabs.some((entry) => entry.mode === 'file' && entry.targetPath)
    && (sizing.contextEditorVisible || !sizing.contextEditorTreeVisible);
  return !editorShown;
};

export const sideZoneWidth = (
  panel: ZonedPanel<SizedTab>,
  tab: SizedTab,
  side: Exclude<ContextZone, 'bottom'>,
  sizing: SideZoneSizing,
): number => (
  showsFileTreeOnly(panel, tab, sizing)
    ? sizing.contextEditorTreeWidth
    : sizing.contextZoneSizes[side] ?? CONTEXT_ZONE_DEFAULT_WIDTH
);

/** Every surface on screen right now, one per shown zone. */
export const shownContextModes = (panel: ZonedPanel | undefined, placement: ContextZonePlacement, defaultZone: DefaultContextZone = 'right'): Set<ContextPanelMode> => {
  const modes = new Set<ContextPanelMode>();
  if (!panel) return modes;
  for (const zone of CONTEXT_ZONES) {
    if (!getZoneView(panel, zone).isOpen) continue;
    const tab = resolveZoneActiveTab(panel, placement, zone, defaultZone);
    if (tab) modes.add(tab.mode);
  }
  return modes;
};

/**
 * Re-resolves every zone against the tabs and the placement: each zone names
 * one of its own tabs, and a zone left without tabs closes.
 */
export const settleZones = <P extends ZonedPanel>(panel: P, placement: ContextZonePlacement, defaultZone: DefaultContextZone = 'right'): P => {
  let next = panel;
  for (const zone of CONTEXT_ZONES) {
    const view = getZoneView(next, zone);
    const activeTabId = resolveZoneActiveTabId(next.tabs, placement, zone, view.activeTabId, defaultZone);
    const isOpen = view.isOpen && activeTabId !== null;
    const expanded = view.expanded && isOpen;
    if (activeTabId !== view.activeTabId || isOpen !== view.isOpen || expanded !== view.expanded) {
      next = withZoneView(next, zone, { activeTabId, isOpen, expanded });
    }
  }
  return next;
};

export const carrySurfaceToZone = <P extends ZonedPanel>(
  panel: P,
  mode: ContextPanelMode,
  from: ContextZone,
  to: ContextZone,
  placementAfter: ContextZonePlacement,
  defaultZone: DefaultContextZone = 'right',
): P => {
  if (from === to) return panel;
  const source = getZoneView(panel, from);
  const sourceTab = source.activeTabId ? panel.tabs.find((tab) => tab.id === source.activeTabId) : undefined;
  const surfaceWasShown = source.isOpen && sourceTab?.mode === mode;
  let next = panel;
  if (surfaceWasShown && sourceTab) {
    next = withZoneView(next, from, { isOpen: false, expanded: false });
    next = withZoneView(next, to, { isOpen: true, expanded: false, activeTabId: sourceTab.id });
  }
  return settleZones(next, placementAfter, defaultZone);
};

/**
 * Rehomes the visible tabs after a layout change, hydration or a placement
 * snapshot. A collision keeps the most recently touched visible tab; ties
 * keep the destination's tab. Closed surfaces stay closed and tabs stay intact.
 */
export const reconcileZonePlacement = <P extends ZonedPanel>(
  panel: P,
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone,
): P => {
  const visible = new Map<ContextZone, { tab: ZonedTab; from: ContextZone; expanded: boolean }>();
  for (const from of CONTEXT_ZONES) {
    const view = getZoneView(panel, from);
    if (!view.isOpen) continue;
    const tab = panel.tabs.find((entry) => entry.id === view.activeTabId);
    if (!tab || (defaultZone === 'left' && tab.mode === DESKTOP_PANEL_MODE)) continue;
    const to = zoneOfMode(placement, tab.mode, defaultZone);
    const prior = visible.get(to);
    if (!prior || tab.touchedAt > prior.tab.touchedAt || (tab.touchedAt === prior.tab.touchedAt && from === to)) {
      visible.set(to, { tab, from, expanded: view.expanded });
    }
  }
  let next = panel;
  for (const zone of CONTEXT_ZONES) {
    const view = getZoneView(next, zone);
    const candidate = visible.get(zone);
    const isOpen = Boolean(candidate);
    const activeTabId = candidate?.tab.id ?? view.activeTabId;
    const expanded = Boolean(candidate && candidate.from === zone && candidate.expanded);
    if (isOpen !== view.isOpen || activeTabId !== view.activeTabId || expanded !== view.expanded) {
      next = withZoneView(next, zone, { isOpen, activeTabId, expanded });
    }
  }
  return settleZones(next, placement, defaultZone);
};

const explicitZoneSchema = z.enum(['left', 'right', 'bottom']);

/**
 * Stored manual placements, including right. Unknown modes and malformed
 * values are dropped; a missing mode follows the current layout's default.
 */
export const zonePlacementSchema = z.record(z.string(), z.unknown()).catch({}).transform((record) => (
  Object.fromEntries(Object.entries(record).flatMap(([mode, zone]) => {
    const parsed = explicitZoneSchema.safeParse(zone);
    return isContextPanelMode(mode) && parsed.success ? [[mode, parsed.data]] : [];
  }))
));

const zoneViewSchema = z.object({
  isOpen: z.boolean().catch(false),
  expanded: z.boolean().catch(false),
  activeTabId: z.string().nullable().catch(null),
}).catch(CLOSED_ZONE_VIEW);

export const zoneViewsSchema = z.object({
  left: zoneViewSchema.default(CLOSED_ZONE_VIEW),
  bottom: zoneViewSchema.default(CLOSED_ZONE_VIEW),
}).catch({ left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW });

export const keepZoneViewsOnTabs = (views: MovedZoneViews, tabIds: ReadonlySet<string>): MovedZoneViews => {
  const keep = (view: ContextZoneView): ContextZoneView => {
    const activeTabId = view.activeTabId && tabIds.has(view.activeTabId) ? view.activeTabId : null;
    return { isOpen: view.isOpen && activeTabId !== null, expanded: view.expanded && view.isOpen && activeTabId !== null, activeTabId };
  };
  return { left: keep(views.left), bottom: keep(views.bottom) };
};
