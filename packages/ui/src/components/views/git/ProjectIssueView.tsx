import * as React from 'react';

import type { CachedValue } from '@/components/references/referenceCache';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import { useRepositoryHost, useRepositoryReadContext } from '@/components/references/referenceSources';
import { IDLE_PULL_STATUS, useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { SourceBoardActions, SourceBoardStateMenuItems } from '@/components/sourceBoard/SourceBoardActions';
import { SourceBoardLinkFeedback } from '@/components/sourceBoard/SourceBoardLinkFeedback';
import { SourceBoardLabels } from '@/components/sourceBoard/SourceBoardMetaEditors';
import { SourceBoardReply } from '@/components/sourceBoard/SourceBoardReply';
import { updateRepositoryItemText } from '@/components/sourceBoard/updateItemText';
import { deleteRepositoryComment, updateRepositoryComment } from '@/components/sourceBoard/updateItemComment';
import { useBoardRevalidation } from '@/components/sourceBoard/useBoardRevalidation';
import { toast } from '@/components/ui';
import { Textarea } from '@/components/ui/textarea';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useProjectReferenceBack, useProjectReferenceSelection } from '@/hooks/useProjectReferenceSelection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkspaceViewOwner } from '@/hooks/useWorkspaceViewOwner';
import { WorkspaceViewScope } from '@/hooks/useWorkspaceViewState';
import type { GitHubReferenceDetail, RepositoryReference, SourceControlReadContext } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { GitRepositoryUnreadableState } from './GitRepositoryUnreadableState';
import { NestedRepoPicker } from './NestedRepoPicker';
import { NestedRepoResolutionStates } from './NestedRepoResolutionStates';
import { ProjectReferenceBackButton, ProjectReferenceList } from './ProjectReferenceList';

type IssueReference = Extract<RepositoryReference, { kind: 'issue' }>;

export const ProjectIssueView: React.FC<{ directory: string; visible: boolean }> = ({ directory, visible }) => {
  const { t } = useI18n();
  const { rootIsGitRepo, gitDirectory, nestedRepos, unreadable } = useNestedGitDirectory(directory, { enabled: visible });
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  const ensureNestedRepos = useGitStore(state => state.ensureNestedRepos);
  const selectNestedRepo = useGitStore(state => state.selectNestedRepo);
  const sourceDirectory = gitDirectory ?? directory;
  const host = useRepositoryHost(sourceDirectory || null);
  const binding = useRepositoryReadContext(sourceDirectory || null);
  const context = binding && binding !== 'missing' && binding.provider === 'github' ? binding : null;
  const owner = useWorkspaceViewOwner(directory);
  const stateOwner = context ? workspaceViewKey(owner.runtime, directory, workspaceRepositoryIdentity(context)) : null;

  return (
    <React.Activity mode={visible ? 'visible' : 'hidden'}>
      {unreadable ? <GitRepositoryUnreadableState directory={unreadable.directory} message={unreadable.message} />
        : rootIsGitRepo === false && isGitRepo !== true ? (
          <NestedRepoResolutionStates
            root={directory}
            rootIsGitRepo={rootIsGitRepo}
            resolvedIsGitRepo={isGitRepo}
            nestedRepos={nestedRepos}
            onRetryDiscovery={() => void ensureNestedRepos(directory, { force: true })}
          />
        ) : host && host.provider !== 'github' ? (
          <div className="grid h-full place-items-center p-6 text-center typography-meta text-muted-foreground">
            {t('references.picker.empty.unsupported')}
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {rootIsGitRepo === false && Array.isArray(nestedRepos) && nestedRepos.length > 0 ? (
              <div className="shrink-0 border-b border-border/60 px-4 py-2">
                <NestedRepoPicker repositories={nestedRepos} selectedRepository={gitDirectory ?? null}
                  onSelectRepository={repository => selectNestedRepo(directory, repository)} repositoryRoot={directory} />
              </div>
            ) : null}
            <ProjectIssueList key={JSON.stringify([owner.runtime, sourceDirectory, stateOwner])}
              directory={sourceDirectory || null} active={visible} context={context}
              stateOwner={stateOwner} preferences={owner.project} />
          </div>
        )}
    </React.Activity>
  );
};

const ProjectIssueList: React.FC<{
  directory: string | null;
  active: boolean;
  context: SourceControlReadContext | null;
  stateOwner: string | null;
  preferences: string | null;
}> = ({ directory, active, context, stateOwner, preferences }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const runtimeKey = useGitStore(state => state.runtimeKey);
  const browser = useReferenceBrowser({
    source: 'repository', directory, isMobile, mode: 'project-issues', active, onScreen: active,
    projectState: { owner: stateOwner, preferences },
  });
  useBoardRevalidation(active);
  const { openItem, previewItem } = browser;
  const issue = previewItem?.source === 'repository' && previewItem.reference.kind === 'issue' ? previewItem.reference : null;
  const { restoreUrl, restored, orphan } = useProjectReferenceSelection(browser, { directory, context, stateOwner, runtime: runtimeKey, active });

  const [refreshing, setRefreshing] = React.useState(false);
  const refreshPending = React.useRef(false);
  const refreshList = async () => {
    if (!context || refreshPending.current) return;
    const isCurrent = captureRuntimeInstance();
    refreshPending.current = true;
    setRefreshing(true);
    try {
      await sourceControl.refreshProviderReads(context);
      if (isCurrent()) await browser.list.retry();
    } catch (error) {
      if (isCurrent()) toast.error(t('references.picker.error.refresh', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      refreshPending.current = false;
      setRefreshing(false);
    }
  };
  const showingDetail = Boolean(restoreUrl || issue);
  const goBack = useProjectReferenceBack(browser, active && !showingDetail);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showingDetail ? <ProjectReferenceBackButton onBack={goBack} /> : null}
      {restoreUrl ? <>
        <SourceBoardLinkFeedback url={restoreUrl} state={restored.error ? 'error'
          : restored.unavailable === 'disconnected' || !context ? 'disconnected'
          : restored.unavailable === 'no-repo' ? 'noRepository'
          : restored.status === 'ready' && !restored.refreshing ? 'notFound' : 'loading'}
          error={restored.error} onRetry={() => void restored.retry()} />
        {orphan && restored.status === 'ready' ? (
          <div className="shrink-0 px-4 pb-4">
            <Textarea value={orphan.value} readOnly rows={4} aria-label={t('sourceBoard.reply.label')} />
          </div>
        ) : null}
      </> : issue && context && active ? (
        <ProjectIssueDetail key={issue.url} reference={issue} context={context} stateOwner={stateOwner}
          detail={browser.repositoryDetail} now={browser.now} refreshDetail={browser.refreshRepositoryDetail}
          refreshList={browser.list.retry} onStateChanged={goBack} />
      ) : null}
      <ProjectReferenceList browser={browser} stateOwner={stateOwner} showingList={active && !showingDetail}
        label={t('references.picker.tab.issues')} refreshLabel={t('sourceBoard.list.refresh')}
        refreshEnabled={context !== null} refreshing={refreshing} onRefresh={() => void refreshList()}
        onOpenItem={openItem} />
    </div>
  );
};

const ProjectIssueDetail: React.FC<{
  reference: IssueReference;
  context: SourceControlReadContext;
  stateOwner: string | null;
  detail: CachedValue<GitHubReferenceDetail>;
  now: number;
  refreshDetail: () => Promise<void>;
  refreshList: () => Promise<void>;
  onStateChanged: () => void;
}> = ({ reference, context, stateOwner, detail, now, refreshDetail, refreshList, onStateChanged }) => {
  const { sourceControl } = useRuntimeAPIs();
  const body = detail.status === 'ready' ? detail.value.body : undefined;
  const item = { source: 'repository' as const, reference: body === undefined ? reference : { ...reference, body, bodyTruncated: false } };
  const scope = stateOwner ? JSON.stringify([stateOwner, 'issue', reference.url]) : null;
  const detailHost = React.useRef<HTMLDivElement>(null);
  const refresh = async () => { await Promise.all([refreshDetail(), refreshList()]); };
  const refreshFromHost = async () => {
    const isCurrent = captureRuntimeInstance();
    const { sourceRepo, number } = reference;
    await sourceControl.refreshProviderReads(context, { item: { owner: sourceRepo.owner, repo: sourceRepo.repo, number } });
    if (isCurrent()) await refresh();
  };

  return (
    <WorkspaceViewScope.Provider value={scope}>
      <div ref={detailHost} className="flex min-h-0 flex-1 flex-col">
        <ReferencePreview item={item} directory={context.directory}
          pullStatus={IDLE_PULL_STATUS} trackerDetail={{ status: 'idle' }} repositoryDetail={detail}
          purpose="attach" pinned includeDiff={false} onIncludeDiffChange={() => undefined} now={now}
          onRefresh={refreshFromHost}
          footer={<SourceBoardActions item={item} project={null} context={context}
            onStartWorktree={() => undefined} onChanged={refresh} worktreeAvailable={false} />}
          onSaveText={async input => {
            await updateRepositoryItemText(sourceControl, context, reference, input);
            await refresh();
          }}
          stateMenu={<SourceBoardStateMenuItems item={item} context={context} onChanged={() => void refresh()}
            onStateChanged={() => { if (detailHost.current) onStateChanged(); }} />}
          commentActions={{
            update: async (comment, body) => {
              if (!comment.id) return;
              await updateRepositoryComment(sourceControl, context, reference, { id: comment.id }, body);
              await refresh();
            },
            remove: async comment => {
              if (!comment.id) return;
              await deleteRepositoryComment(sourceControl, context, reference, { id: comment.id });
              await refresh();
            },
          }}
          labelsControl={<SourceBoardLabels reference={reference} context={context} onChanged={refresh} />}
          reply={<SourceBoardReply reference={reference} context={context} onRefresh={refresh} />}
        />
      </div>
    </WorkspaceViewScope.Provider>
  );
};
