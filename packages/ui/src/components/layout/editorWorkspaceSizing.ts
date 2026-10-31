import { create } from 'zustand';
import { EDITOR_WORKSPACE_MIN_WIDTH } from '@/lib/workspace/editorSplit';
import { getSidebarWidth } from '@/lib/workspace/sidebarGeometry';
import { getZoneView, isZoneShown, resolveZoneActiveTab, withZoneView } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

type Panel = 'left' | 'right' | 'sessions';
type UIState = ReturnType<typeof useUIStore.getState>;
export const useWorkspaceOverlay = create<{ panel: Panel | null }>(() => ({ panel: null }));

export const followEditorWorkspaceFit = (row: HTMLElement, directory: string): (() => void) => {
  const rail = row.querySelector<HTMLElement>('[data-workspace-rail]');
  const hidden = new Map<Panel, string | null>();
  let adjusting = false;
  const panelOpen = (state: UIState, key: Panel) => key === 'sessions' ? state.isSidebarOpen
    : isZoneShown(state.contextPanelByDirectory[directory], state.contextSurfaceZones, key, 'left');
  const panelWidth = (state: UIState, key: Panel) => {
    if (key === 'sessions') return getSidebarWidth(state.sidebarWidth);
    const panel = state.contextPanelByDirectory[directory];
    const tab = panel && resolveZoneActiveTab(panel, state.contextSurfaceZones, key, 'left');
    if (!tab) return 0;
    return state.editorToolPanelWidth;
  };
  const setOpen = (key: Panel, open: boolean) => {
    if (key === 'sessions') { useUIStore.getState().setSidebarOpen(open); return; }
    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory[directory];
    if (panel) useUIStore.setState({ contextPanelByDirectory: {
      ...state.contextPanelByDirectory,
      [directory]: withZoneView(panel, key, { isOpen: open, expanded: false }),
    } });
  };
  const fold = (key: Panel) => {
    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory[directory];
    hidden.set(key, key === 'sessions' || !panel ? null : getZoneView(panel, key).activeTabId);
    setOpen(key, false);
  };
  const panels: Panel[] = ['sessions', 'right', 'left'];
  const fit = (opened: Panel | null = null) => {
    if (adjusting || row.clientWidth === 0) return;
    adjusting = true;
    try {
      let floating = useWorkspaceOverlay.getState().panel;
      if (floating && !panelOpen(useUIStore.getState(), floating)) floating = null;
      if (opened) hidden.delete(opened);
      if (floating && opened && floating !== opened) {
        setOpen(floating, false);
        floating = null;
      }
      const budget = Math.max(0, row.clientWidth - (rail?.clientWidth ?? 0) - EDITOR_WORKSPACE_MIN_WIDTH);
      const occupied = () => {
        const state = useUIStore.getState();
        return panels.reduce((sum, key) => sum + (key !== floating && panelOpen(state, key) ? panelWidth(state, key) : 0), 0);
      };
      if (occupied() > budget && opened !== 'sessions' && floating !== 'sessions' && useUIStore.getState().isSidebarOpen) fold('sessions');
      if (opened && occupied() > budget) floating = opened;
      for (const key of panels) {
        if (occupied() <= budget) break;
        if (key !== floating && panelOpen(useUIStore.getState(), key)) fold(key);
      }
      if (floating && occupied() + panelWidth(useUIStore.getState(), floating) <= budget) floating = null;
      // Restore tools first, then navigation. A changed/moved tab invalidates
      // the saved restoration; it belongs to the user's newer placement.
      for (const key of ['left', 'right', 'sessions'] as const) {
        if (!hidden.has(key) || floating) continue;
        const state = useUIStore.getState();
        const panel = state.contextPanelByDirectory[directory];
        if (key !== 'sessions' && (!panel || getZoneView(panel, key).activeTabId !== hidden.get(key))) {
          hidden.delete(key);
          continue;
        }
        if (occupied() + panelWidth(state, key) <= budget) {
          hidden.delete(key);
          setOpen(key, true);
        }
      }
      if (useWorkspaceOverlay.getState().panel !== floating) useWorkspaceOverlay.setState({ panel: floating });
    } finally { adjusting = false; }
  };
  fit();
  const unsubscribe = useUIStore.subscribe((state, previous) => {
    if (adjusting || state.workspaceLayout !== 'editor') return;
    let opened: Panel | null = null;
    for (const key of panels) {
      const now = panelOpen(state, key);
      const before = panelOpen(previous, key);
      if (now && !before) opened = key;
      if (!now && before) hidden.delete(key);
      if (now && key !== 'sessions') {
        const next = state.contextPanelByDirectory[directory];
        const prev = previous.contextPanelByDirectory[directory];
        if (next && prev && getZoneView(next, key).activeTabId !== getZoneView(prev, key).activeTabId) opened = key;
      }
    }
    fit(opened);
  });
  const observer = new ResizeObserver(() => fit());
  observer.observe(row);
  if (rail) observer.observe(rail);
  return () => {
    observer.disconnect();
    unsubscribe();
    // Layout switches restore only what this controller folded.
    for (const key of hidden.keys()) setOpen(key, true);
    useWorkspaceOverlay.setState({ panel: null });
  };
};

