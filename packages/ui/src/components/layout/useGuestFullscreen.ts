import React from 'react';

import { DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';
import { useUIStore } from '@/stores/useUIStore';

/** Manages window-fullscreen state and auto-cleanup for an active guest pane or page. */
export const useGuestFullscreen = (
  guestId: string,
  surface: 'panel' | 'page',
  active = true,
) => {
  const canFullscreen = guestId === DESKTOP_GUEST_ID;
  const guestFullscreen = useUIStore((state) => state.guestFullscreen);
  const isFullscreen = canFullscreen && active && guestFullscreen?.id === guestId && guestFullscreen.surface === surface;

  React.useEffect(() => {
    if (!canFullscreen || active) return;
    const current = useUIStore.getState().guestFullscreen;
    if (current?.id === guestId && current.surface === surface) {
      useUIStore.getState().setGuestFullscreen(null);
    }
  }, [active, canFullscreen, guestId, surface]);

  React.useEffect(() => () => {
    if (!canFullscreen) return;
    const current = useUIStore.getState().guestFullscreen;
    if (current?.id === guestId && current.surface === surface) {
      useUIStore.getState().setGuestFullscreen(null);
    }
  }, [canFullscreen, guestId, surface]);

  const toggleFullscreen = React.useMemo(() => {
    if (!canFullscreen) return undefined;
    return () => {
      const ui = useUIStore.getState();
      const current = ui.guestFullscreen;
      if (current?.id === guestId && current.surface === surface) {
        ui.setGuestFullscreen(null);
      } else {
        ui.setGuestFullscreen({ id: guestId, surface });
      }
    };
  }, [canFullscreen, guestId, surface]);

  return { isFullscreen, toggleFullscreen };
};
