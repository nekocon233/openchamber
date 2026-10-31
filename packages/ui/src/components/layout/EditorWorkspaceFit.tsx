import { followEditorWorkspaceFit, useWorkspaceOverlay } from './editorWorkspaceSizing';
import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { isEditorEventTarget } from '@/lib/editorFocus';
import { isTerminalEventTarget } from '@/lib/terminalFocus';

/** Auto-folded panels return when there is room. Opening one manually consumes that restoration. */
export const EditorWorkspaceFit: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory();
  const directory = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';
  const overlay = useWorkspaceOverlay((state) => state.panel);
  const closeOverlay = React.useCallback(() => {
    const panel = useWorkspaceOverlay.getState().panel;
    if (panel === 'sessions') useUIStore.getState().setSidebarOpen(false);
    else if (panel && directory) useUIStore.getState().closeContextZone(directory, panel);
    useWorkspaceOverlay.setState({ panel: null });
  }, [directory]);

  React.useLayoutEffect(() => {
    const row = document.querySelector<HTMLElement>('[data-workspace-frame]');
    return row ? followEditorWorkspaceFit(row, directory) : undefined;
  }, [directory]);

  React.useEffect(() => {
    if (!overlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isIMECompositionEvent(event)
        || isEditorEventTarget(event.target) || isTerminalEventTarget(event.target)) return;
      if (document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeOverlay, overlay]);

  return overlay ? <button type="button" tabIndex={-1} data-workspace-overlay-dismiss="" aria-label={t('contextPanel.actions.closePanel')}
    className="absolute inset-0 z-30 cursor-default bg-background/20" onPointerDown={closeOverlay} /> : null;
};
