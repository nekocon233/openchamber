import React from 'react';
import { GUEST_ATTACH_URL_MAX } from '@openchamber/sdk';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { boardTargetOfUrl } from '@/components/sourceBoard/boardLinkTarget';
import { useShowOnBoard } from '@/components/sourceBoard/openOnBoard';
import { toast } from 'sonner';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n } from '@/lib/i18n';
import { isExternalHttpUrl, openExternalUrl } from '@/lib/url';
import { DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSurfaceMode } from './useChatSurfaceMode';

/**
 * Where a plain click on a web link in chat content goes. With the settings
 * on, a GitHub PR opens in the desktop PR pane; other tracker links open on
 * the issues and PRs board. Ordinary http(s) links open through the built-in
 * Remote Desktop extension when active, falling back to the built-in browser
 * panel on desktop or the system browser. Tracker links explicitly set to
 * external always use the system browser. A tracker that cannot open internally
 * reports the failure with a manual external action. Modified clicks never come
 * here: they keep the browser's own meaning, which is the local browser.
 */
export function useOpenChatLink(directory: string) {
  const showOnBoard = useShowOnBoard();
  const mobile = useMobileAppActions();
  const { t } = useI18n();
  // The mini chat window has neither the board nor the panel.
  const inWorkspace = useChatSurfaceMode() !== 'mini-chat';

  return React.useCallback((url: string) => {
    const {
      openTrackerLinksOnBoard,
      openLinksInBrowserPanel,
      openContextPreview,
      openRemoteDesktopUrl,
      isMobile,
    } = useUIStore.getState();
    if (inWorkspace && boardTargetOfUrl(url)) {
      if (!openTrackerLinksOnBoard || isVSCodeRuntime()) {
        void openExternalUrl(url);
      } else if (!showOnBoard(url, directory, 'manual')) {
        toast.error(t('sourceBoard.link.unavailable'), {
          action: { label: t('sourceBoard.link.openExternal'), onClick: () => { void openExternalUrl(url); } },
        });
      }
      return;
    }
    const { guests, hostPlatform, desktopUrlReady } = useGuestsStore.getState();
    const desktopGuest = guests.find((guest) => guest.id === DESKTOP_GUEST_ID) ?? null;
    const desktopHostEligible = (hostPlatform === null || hostPlatform === 'linux') && desktopUrlReady !== false;
    if (
      inWorkspace
      && !mobile
      && !isMobile
      && !isVSCodeRuntime()
      && directory
      && isExternalHttpUrl(url)
      && url.trim().length <= GUEST_ATTACH_URL_MAX
      && desktopHostEligible
      && desktopGuest !== null
      && isGuestActive(desktopGuest)
    ) {
      openRemoteDesktopUrl(directory, url.trim());
      return;
    }
    if (inWorkspace && openLinksInBrowserPanel && !mobile && isDesktopShell() && directory) {
      openContextPreview(directory, url);
      return;
    }
    void openExternalUrl(url);
  }, [directory, inWorkspace, mobile, showOnBoard, t]);
}
