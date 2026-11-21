import { commitShaOfUrl } from '@/lib/source-control/repositoryLinks';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { openGuestCommit, readCurrentBranch } from '@/lib/guests/open-commit';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
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
import { isRemoteDesktopHttpUrl, openExternalUrl } from '@/lib/url';
import { DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSurfaceMode } from './useChatSurfaceMode';

export function useOpenChatLink(directory: string) {
  const showOnBoard = useShowOnBoard();
  const mobile = useMobileAppActions();
  const { t } = useI18n();
  const descriptors = useSourceControlProviderRegistry((state) => state.ordered);
  const inWorkspace = useChatSurfaceMode() !== 'mini-chat';

  const openElsewhere = React.useCallback((url: string) => {
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
      && isRemoteDesktopHttpUrl(url)
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

  return React.useCallback((url: string) => {
    const git = getRegisteredRuntimeAPIs()?.git ?? null;
    const local = inWorkspace && directory && git && !mobile && isDesktopShell() && !isVSCodeRuntime() && !isMobileSurfaceRuntime();
    const sha = local ? commitShaOfUrl(url, descriptors) : null;
    if (!sha || !git) {
      openElsewhere(url);
      return;
    }
    void openGuestCommit({
      sha,
      directory,
      git,
      currentBranch: (folder) => readCurrentBranch(git, folder),
      supported: true,
    }).then((result) => {
      if (!result.ok) openElsewhere(url);
    });
  }, [descriptors, directory, inWorkspace, mobile, openElsewhere]);
}
