import * as React from 'react';

import type { CachedValue } from '@/components/references/referenceCache';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import { SourceBoardActions } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardChecksDialog } from '@/components/sourceBoard/SourceBoardChecksDialog';
import { SourceBoardLabels, SourceBoardReviewers } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { useThreadActions } from '@/components/sourceBoard/threadActions';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullReference, GitHubPullStatus, GitHubReferenceDetail, SourceControlReadContext } from '@/lib/api/types';
import { WorkspaceViewScope, useWorkspaceViewState } from '@/hooks/useWorkspaceViewState';
import { workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

/** PR actions always use the context that supplied the displayed reference. */
export const PullRequestDetail: React.FC<{
  reference: GitHubPullReference;
  context: SourceControlReadContext;
  githubDetail: CachedValue<GitHubReferenceDetail>;
  pullStatus: CachedValue<GitHubPullStatus | null>;
  now: number;
  onChanged: () => Promise<void>;
  refreshDetail: () => Promise<void>;
  pullLinks: React.ReactNode;
}> = ({ reference, context, githubDetail, pullStatus, now, onChanged, refreshDetail, pullLinks }) => {
  const { sourceControl } = useRuntimeAPIs();
  const owner = workspaceViewKey(getRuntimeKey(), context.directory, 'pull-detail', workspaceRepositoryIdentity(context), reference.sourceRepo.owner, reference.sourceRepo.repo, reference.number);
  const [checksOpen, setChecksOpen] = useWorkspaceViewState('pullRequest', owner, 'checksOpen');
  const attachments = usePullAttachments(reference);
  const refresh = React.useCallback(async () => {
    await Promise.all([onChanged(), refreshDetail()]);
  }, [onChanged, refreshDetail]);
  const refreshFromHost = async () => {
    await sourceControl.refreshProviderReads(context);
    await refresh();
  };
  const threadActions = useThreadActions(reference, context, refresh);
  const item = { source: 'github' as const, reference };

  return (
    <WorkspaceViewScope.Provider value={owner}>
      <ReferencePreview
        item={item}
        directory={context.directory}
        pullStatus={pullStatus}
        linearDetail={{ status: 'idle' }}
        githubDetail={githubDetail}
        purpose="attach"
        pinned
        includeDiff={false}
        onIncludeDiffChange={() => undefined}
        now={now}
        onRefresh={refreshFromHost}
        footer={<SourceBoardActions item={item} project={null} context={context} onStartWorktree={() => undefined} onChanged={refresh} />}
        onOpenChecks={() => setChecksOpen(true)}
        commentAttachments={{ onAttach: attachments.attachComment, onAttachAll: attachments.attachComments }}
        threadActions={threadActions}
        labelsControl={<SourceBoardLabels reference={reference} context={context} onChanged={refresh} />}
        reviewersControl={<SourceBoardReviewers pull={reference} detail={githubDetail} context={context} onChanged={refresh} />}
        reply={<SourceBoardReply key={reference.number} reference={reference} context={context} onRefresh={refresh} />}
        pullLinks={pullLinks}
      />
      <SourceBoardChecksDialog pull={reference} context={context} open={checksOpen} onOpenChange={setChecksOpen} onAttachFailed={attachments.attachFailedChecks} />
    </WorkspaceViewScope.Provider>
  );
};
