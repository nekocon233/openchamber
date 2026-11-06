import { useWorkspaceViewOwner } from '@/hooks/useWorkspaceViewOwner';
import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { hasSameSourceControlReadContext } from '@/lib/source-control/identity';
import { useGitStore } from '@/stores/useGitStore';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { useWorkspaceViewState } from '@/hooks/useWorkspaceViewState';
import { useWorkspaceViewStateStore, workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Returns to the PR panel that handed this exact comparison to Changes. */
export const PullRequestBackButton: React.FC<{
  directory: string | null;
  source: PullRequestSource | null;
  context: SourceControlReadContext | null;
  compact?: boolean;
}> = ({ directory, source, context, compact = false }) => {
  const { t } = useI18n();
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
  const label = t(context.provider === 'gitlab' ? 'references.projectPulls.backToMerge' : 'references.projectPulls.backToPull', { number: source.number });
  return <Button variant="ghost" size="sm" className={cn('min-w-0', compact ? 'shrink-0' : 'me-auto shrink')} title={label} aria-label={label} onClick={() => {
    if (live && usePullRequestSelectionStore.getState().requestReturn(live)) {
      live.restoreWorkspace?.();
      useUIStore.getState().openContextPanelTab(live.workspaceDirectory, { mode: 'pr' });
    } else if (restored) {
      if (restored.navigation) useSessionUIStore.getState().restoreNavigationReturn(restored.navigation);
      if (restored.tab === 'linked') usePullRequestSelectionStore.getState().requestOpen({
        workspaceDirectory: restored.workspaceDirectory, sourceDirectory: restored.sourceDirectory,
        url: restored.url, failureBehavior: 'manual',
      });
      else {
        if (owner.project) useWorkspaceViewStateStore.getState().update('pullRequest', owner.project, previous => ({ ...previous, tab: restored.tab === 'branch' ? 'branch' : 'project' }));
        const workspace = workspaceViewKey(runtimeKey, restored.workspaceDirectory);
        if (workspace) useWorkspaceViewStateStore.getState().update('pullRequest', workspace, previous => ({ ...previous, link: null }));
        const list = workspaceViewKey(runtimeKey, restored.workspaceDirectory, workspaceRepositoryIdentity(context));
        if (list && restored.tab === 'project') useWorkspaceViewStateStore.getState().update('pullRequest', list, previous => ({ ...previous, selectedUrl: restored.url }));
      }
      setSaved(null);
      useUIStore.getState().openContextPanelTab(restored.workspaceDirectory, { mode: 'pr' });
    }
  }}>
    <Icon name="arrow-left" className="size-4" />
    {!compact && <span className="truncate">{label}</span>}
  </Button>;
};
