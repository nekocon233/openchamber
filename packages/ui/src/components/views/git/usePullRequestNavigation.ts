import { useWorkspaceViewOwner } from '@/hooks/useWorkspaceViewOwner';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useI18n } from '@/lib/i18n';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { hasSameSourceControlReadContext } from '@/lib/source-control/identity';
import { useGitStore } from '@/stores/useGitStore';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWorkspaceViewState } from '@/hooks/useWorkspaceViewState';
import { useWorkspaceViewStateStore, workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function usePullRequestNavigation({ directory, source, context, onLeaveChanges }: {
  directory: string | null;
  source: PullRequestSource | null;
  context: SourceControlReadContext | null;
  onLeaveChanges?: () => void;
}) {
  const { t } = useI18n();
  const mobile = useMobileAppActions();
  const runtimeKey = useGitStore(state => state.runtimeKey);
  const target = usePullRequestSelectionStore(state => directory
    ? state.diffReturnTargets.get(pullRequestNavigationKey(runtimeKey, directory)) : null);
  const navigationOwner = workspaceViewKey(runtimeKey, directory, 'pr-navigation');
  const [saved, setSaved] = useWorkspaceViewState('changes', navigationOwner, 'returnTo');
  const owner = useWorkspaceViewOwner(saved?.workspaceDirectory);
  const sameSource = (candidate: PullRequestSource) => candidate.number === source?.number
    && candidate.sourceRepo?.owner.toLowerCase() === source?.sourceRepo?.owner.toLowerCase()
    && candidate.sourceRepo?.repo.toLowerCase() === source?.sourceRepo?.repo.toLowerCase();
  const live = target && context && hasSameSourceControlReadContext(target.context, context) && sameSource(target.source) ? target : null;
  const restored = saved && context && saved.repositoryIdentity === workspaceRepositoryIdentity(context) && sameSource(saved.source) ? saved : null;
  if ((!live && !restored) || !source || !context) return null;
  const openPullRequest = (workspaceDirectory: string) => {
    if (mobile) mobile.openWorkspaceTab('pr');
    else useUIStore.getState().openContextPanelTab(workspaceDirectory, { mode: 'pr' });
  };
  const destination = live ?? restored;
  const returnsToList = destination?.tab === 'project' && destination.showList;
  const backLabel = returnsToList
    ? t('gitView.pullRequest.backToList')
    : t(context.provider === 'gitlab' ? 'references.projectPulls.backToMerge' : 'references.projectPulls.backToPull', { number: source.number });
  const detailsLabel = returnsToList ? t('references.projectPulls.viewDetails', {
    reference: context.provider === 'gitlab' ? `MR !${source.number}` : `PR #${source.number}`,
  }) : null;
  const navigate = (to: 'origin' | 'details') => {
    if (live) {
      if (!usePullRequestSelectionStore.getState().requestReturn(live, to)) return;
      onLeaveChanges?.();
      live.restoreWorkspace?.();
      openPullRequest(live.workspaceDirectory);
    } else if (restored) {
      onLeaveChanges?.();
      if (restored.navigation) useSessionUIStore.getState().restoreNavigationReturn(restored.navigation);
      if (restored.tab === 'linked') usePullRequestSelectionStore.getState().requestOpen({
        workspaceDirectory: restored.workspaceDirectory, sourceDirectory: restored.sourceDirectory,
        url: restored.url, failureBehavior: 'manual',
      });
      else {
        if (owner.project) useWorkspaceViewStateStore.getState().update('pullRequest', owner.project, previous => ({ ...previous, tab: 'project' }));
        const workspace = workspaceViewKey(runtimeKey, restored.workspaceDirectory);
        if (workspace) useWorkspaceViewStateStore.getState().update('pullRequest', workspace, previous => ({ ...previous, link: null }));
        const list = workspaceViewKey(runtimeKey, restored.workspaceDirectory, workspaceRepositoryIdentity(context));
        if (list) useWorkspaceViewStateStore.getState().update('pullRequest', list, previous => ({
          ...previous,
          selectedUrl: restored.showList && to === 'origin' ? null : restored.url,
        }));
      }
      setSaved(null);
      openPullRequest(restored.workspaceDirectory);
    }
  };
  return { backLabel, detailsLabel, navigate, isMobile: Boolean(mobile) };
}
