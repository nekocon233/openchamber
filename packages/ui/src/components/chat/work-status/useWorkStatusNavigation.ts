import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useShowOnBoard } from '@/components/sourceBoard/openOnBoard';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useUIStore } from '@/stores/useUIStore';

/**
 * The work-status rows navigate to whatever hosts the detail on this surface:
 * the desktop context panel, or the mobile workspace drawer and change-request
 * viewer. Keeping the mapping here means every row behaves the same and the
 * sections do not each grow a platform branch.
 */
export const useWorkStatusNavigation = (directory: string | null) => {
  const mobileActions = useMobileAppActions();
  const showTrackerLink = useShowOnBoard();
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);

  const openContext = React.useCallback(() => {
    if (!directory) return;
    if (mobileActions) {
      mobileActions.openWorkspaceTab('notes');
      return;
    }
    openContextOverview(directory);
  }, [directory, mobileActions, openContextOverview]);

  const openGit = React.useCallback(() => {
    if (!directory) return;
    if (mobileActions) {
      mobileActions.openChanges();
      return;
    }
    openContextSurface(directory, 'git');
  }, [directory, mobileActions, openContextSurface]);

  const openChanges = React.useCallback(() => {
    if (!directory) return;
    if (mobileActions) {
      mobileActions.openChanges();
      return;
    }
    openContextPanelTab(directory, { mode: 'diff', diffScope: 'working' });
  }, [directory, mobileActions, openContextPanelTab]);

  const openChangeRequest = React.useCallback((summary: Pick<PrVisualSummary, 'number' | 'repo' | 'url' | 'provider'>) => {
    if (!directory) return;
    if (mobileActions) {
      if (summary.repo) {
        mobileActions.openChangeRequest({
          number: summary.number,
          owner: summary.repo.owner,
          repo: summary.repo.repo,
        });
      } else {
        mobileActions.openWorkspaceTab('changes');
      }
      return;
    }
    const url = summary.url ?? (summary.provider === 'github' && summary.repo
      ? `https://github.com/${summary.repo.owner}/${summary.repo.repo}/pull/${summary.number}` : null);
    if (summary.provider === 'github' || (url && parseChangeRequestReference(url)?.identity?.provider === 'github')) {
      if (!url || !showTrackerLink(url, directory)) {
        openContextPanelTab(directory, { mode: 'pr' });
      }
      return;
    }
    openContextSurface(directory, 'pr');
  }, [directory, mobileActions, openContextPanelTab, openContextSurface, showTrackerLink]);

  const openCiRun = React.useCallback((runId: string, sourceDirectory?: string) => {
    if (!directory) return;
    usePullRequestSelectionStore.getState().requestCiRun(directory, sourceDirectory ?? directory, runId);
    if (mobileActions) {
      mobileActions.openWorkspaceTab('pr');
      return;
    }
    openContextPanelTab(directory, { mode: 'pr' });
  }, [directory, mobileActions, openContextPanelTab]);

  return {
    isMobileHost: mobileActions !== null,
    openContext,
    openGit,
    openChanges,
    openChangeRequest,
    openCiRun,
  };
};
