import {
  DESKTOP_GUEST_ID,
  DESKTOP_PANEL_MODE,
  getZoneView,
  resolveZoneActiveTab,
  zoneOfMode,
  type ContextZonePlacement,
  type DefaultContextZone,
  type ZonedPanel,
} from './zones';

export { DESKTOP_GUEST_ID, DESKTOP_PANEL_MODE };

/** The Changes document has a lifecycle independent of its navigation panel. */
export type EditorDiffTabState = 'closed' | 'background' | 'active';
/** Remote Desktop lives as a resident editor tab in editor layout. */
export type EditorDesktopTabState = 'closed' | 'background' | 'active';

export const getEditorDiffTabState = (
  panel: (ZonedPanel & { editorDiffTab?: EditorDiffTabState }) | undefined,
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone,
): EditorDiffTabState => {
  if (!panel?.tabs.some((tab) => tab.mode === 'diff')) return 'closed';
  if (panel.editorDiffTab !== undefined) return panel.editorDiffTab;
  // Old snapshots have no document state. Restore a currently shown Changes
  // panel as a selected document; a hidden panel must not open a document.
  const zone = zoneOfMode(placement, 'diff', defaultZone);
  return getZoneView(panel, zone).isOpen && resolveZoneActiveTab(panel, placement, zone, defaultZone)?.mode === 'diff'
    ? 'active'
    : 'closed';
};

export const getEditorDesktopTabState = (
  panel: (ZonedPanel & { editorDesktopTab?: EditorDesktopTabState }) | undefined,
  placement: ContextZonePlacement,
  defaultZone: DefaultContextZone,
): EditorDesktopTabState => {
  if (!panel?.tabs.some((tab) => tab.mode === DESKTOP_PANEL_MODE)) return 'closed';
  if (panel.editorDesktopTab !== undefined) return panel.editorDesktopTab;
  const zone = zoneOfMode(placement, DESKTOP_PANEL_MODE, defaultZone);
  return getZoneView(panel, zone).isOpen && resolveZoneActiveTab(panel, placement, zone, defaultZone)?.mode === DESKTOP_PANEL_MODE
    ? 'active'
    : 'closed';
};
