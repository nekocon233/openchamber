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

/** Returns to the PR panel that handed this exact comparison to Changes. */
export const PullRequestBackButton: React.FC<{
  directory: string | null;
  source: PullRequestSource | null;
  context: SourceControlReadContext | null;
}> = ({ directory, source, context }) => {
  const { t } = useI18n();
  const runtimeKey = useGitStore(state => state.runtimeKey);
  const target = usePullRequestSelectionStore(state => directory
    ? state.diffReturnTargets.get(pullRequestNavigationKey(runtimeKey, directory)) : null);
  if (!target || !source || !context || !hasSameSourceControlReadContext(target.context, context)
    || target.source.number !== source.number
    || target.source.sourceRepo?.owner.toLowerCase() !== source.sourceRepo?.owner.toLowerCase()
    || target.source.sourceRepo?.repo.toLowerCase() !== source.sourceRepo?.repo.toLowerCase()) return null;
  const label = t(context.provider === 'gitlab' ? 'references.projectPulls.backToMerge' : 'references.projectPulls.backToPull', { number: source.number });
  return <Button variant="ghost" size="sm" className="shrink-0" title={label} aria-label={label} onClick={() => {
    if (usePullRequestSelectionStore.getState().requestReturn(target)) {
      useUIStore.getState().openContextPanelTab(target.workspaceDirectory, { mode: 'pr' });
    }
  }}>
    <Icon name="arrow-left" className="size-4" />
    <span>{label}</span>
  </Button>;
};
