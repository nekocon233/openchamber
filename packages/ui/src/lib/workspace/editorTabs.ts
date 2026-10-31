import { getZoneView, resolveZoneActiveTab, zoneOfMode, type ContextZonePlacement, type DefaultContextZone, type ZonedPanel } from './zones';

/** The Changes document has a lifecycle independent of its navigation panel. */
export type EditorDiffTabState = 'closed' | 'background' | 'active';

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
