import React from 'react';
import { isGuestAttachItem } from '@openchamber/sdk';

import { useGuestItemStore } from '@/lib/guests/item-store';
import { DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';
import { useUIStore } from '@/stores/useUIStore';

/** Keeps window fullscreen in sync with the active guest surface and pending panel links. */
export const useGuestFullscreen = (
  guestId: string,
  surface: 'panel' | 'page',
  active = true,
) => {
  const canFullscreen = guestId === DESKTOP_GUEST_ID;
  const guestFullscreen = useUIStore((state) => state.guestFullscreen);
  const isFullscreen = canFullscreen && active && guestFullscreen?.id === guestId && guestFullscreen.surface === surface;
  const pendingItem = useGuestItemStore((state) => (
    canFullscreen && active && surface === 'panel' ? state.pendingItemByGuest[guestId] ?? null : null
  ));

  // Open before the pane's passive effect consumes the pending link.
  React.useLayoutEffect(() => {
    if (isGuestAttachItem(pendingItem) && pendingItem.url) {
      useUIStore.getState().setGuestFullscreen({ id: guestId, surface });
    }
  }, [guestId, pendingItem, surface]);

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
