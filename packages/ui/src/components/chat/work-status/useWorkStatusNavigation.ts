import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useUIStore } from '@/stores/useUIStore';
import { selectNativeTasksTab, type NativeTasksTab } from '../native-tasks/task-ui-store';

/**
 * The work-status rows navigate to whatever hosts the detail on this surface:
 * the desktop context panel, or the mobile workspace drawer and change-request
 * viewer. Keeping the mapping here means every row behaves the same and the
 * sections do not each grow a platform branch.
 */
export const useWorkStatusNavigation = (directory: string | null) => {
  const mobileActions = useMobileAppActions();
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

  const openChangeRequest = React.useCallback((summary: Pick<PrVisualSummary, 'number' | 'repo'>) => {
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
    openContextSurface(directory, 'pr');
  }, [directory, mobileActions, openContextSurface]);

  const openTasks = React.useCallback((tab: NativeTasksTab) => {
    selectNativeTasksTab(tab);
    if (!directory) return;
    if (mobileActions) {
      mobileActions.openWorkspaceTab('tasks');
      return;
    }
    openContextSurface(directory, 'tasks');
  }, [directory, mobileActions, openContextSurface]);

  return {
    isMobileHost: mobileActions !== null,
    openContext,
    openGit,
    openChanges,
    openChangeRequest,
    openTasks,
  };
};
