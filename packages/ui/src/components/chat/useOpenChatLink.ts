import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { boardTargetOfUrl } from '@/components/sourceBoard/boardLinkTarget';
import { useShowOnBoard } from '@/components/sourceBoard/openOnBoard';
import { toast } from 'sonner';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSurfaceMode } from './useChatSurfaceMode';

/**
 * Where a plain click on a web link in chat content goes. With the settings
 * on, an issue, PR or Linear link opens on the issues and PRs board, and any
 * other link in the built-in browser panel of `directory`. Tracker links
 * explicitly set to external always use the system browser. A tracker that
 * cannot open on the board reports the failure with a manual external action.
 * Only the desktop panel can show any site: on the web it is an iframe, which
 * most sites refuse to load in, so links there keep opening in a new tab.
 * Modified clicks never come here: they keep the browser's own meaning, which
 * on desktop is the system browser.
 */
export function useOpenChatLink(directory: string) {
  const showOnBoard = useShowOnBoard();
  const mobile = useMobileAppActions();
  const { t } = useI18n();
  // The mini chat window has neither the board nor the panel.
  const inWorkspace = useChatSurfaceMode() !== 'mini-chat';

  return React.useCallback((url: string) => {
    const { openTrackerLinksOnBoard, openLinksInBrowserPanel, openContextPreview } = useUIStore.getState();
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
    if (inWorkspace && openLinksInBrowserPanel && !mobile && isDesktopShell() && directory) {
      openContextPreview(directory, url);
      return;
    }
    void openExternalUrl(url);
  }, [directory, inWorkspace, mobile, showOnBoard, t]);
}
