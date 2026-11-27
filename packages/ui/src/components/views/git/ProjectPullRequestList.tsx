import { useProjectReferenceBack, useProjectReferenceSelection } from '@/hooks/useProjectReferenceSelection';
import { useWorkspaceViewOwner } from '@/hooks/useWorkspaceViewOwner';
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { referencePickerItemKey, type ReferencePickerItem } from '@/components/references/referencePickerItems';
import { invalidateRepositoryPullStatuses, useRepositoryReadContext } from '@/components/references/referenceSources';
import { useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { SourceBoardPullLinks } from '@/components/sourceBoard/SourceBoardActions';
import { useOpenSourceBoardPull } from '@/components/sourceBoard/useOpenSourceBoardPull';
import { useBoardRevalidation } from '@/components/sourceBoard/useBoardRevalidation';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { hasSameSourceControlReadContext } from '@/lib/source-control/identity';
import { useChangeRequestDiffServing } from '@/lib/source-control/providers/registry';
import { formatChangeRequestLabel } from '@/lib/source-control/providers/terminology';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { PullRequestDetail } from './PullRequestDetail';
import { ProjectReferenceBackButton, ProjectReferenceList } from './ProjectReferenceList';
import { workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { SourceBoardLinkFeedback } from '@/components/sourceBoard/SourceBoardLinkFeedback';
import { Textarea } from '@/components/ui/textarea';
import { useDiffFileFilter } from '../useDiffFileFilter';
import { ProjectPullFileStats } from './ProjectPullFileStats';
import { invalidateProjectPullFileStats } from './useProjectPullFileStats';

const NO_FILES: Array<{ path: string }> = [];

/** Single-repository PR list, retained across the panel's branch and detail views. */
export const ProjectPullRequestList: React.FC<{ directory: string; workspaceDirectory: string; active: boolean }> = ({ directory, workspaceDirectory, active }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const context = useRepositoryReadContext(directory);
  const diffServing = useChangeRequestDiffServing(context && context !== 'missing' ? context.provider : undefined);
  const openPull = useOpenSourceBoardPull();
  const diffContext = context && context !== 'missing' && diffServing !== 'not-served' ? context : null;
  const owner = useWorkspaceViewOwner(workspaceDirectory);
  const stateOwner = context && context !== 'missing' ? workspaceViewKey(owner.runtime, workspaceDirectory, workspaceRepositoryIdentity(context)) : null;
  const browser = useReferenceBrowser({ source: 'repository', directory, isMobile, mode: 'project-pulls', active, projectState: { owner: stateOwner, preferences: owner.project } });
  const { restoreUrl, restored, orphan } = useProjectReferenceSelection(browser, {
    directory, context: context === 'missing' ? null : context, stateOwner, runtime: owner.runtime, active,
  });
  const [refreshingFromHost, setRefreshingFromHost] = React.useState(false);
  const fileFilter = useDiffFileFilter(getRuntimeKey(), directory, NO_FILES);
  const refreshPending = React.useRef(false);
  const refreshFromHost = async () => {
    if (!context || context === 'missing' || refreshPending.current) return;
    const runtime = getRuntimeKey();
    const isCurrent = captureRuntimeInstance();
    refreshPending.current = true;
    setRefreshingFromHost(true);
    try {
      await sourceControl.refreshProviderReads(context);
      if (isCurrent()) {
        invalidateRepositoryPullStatuses(context, runtime);
        invalidateProjectPullFileStats(context);
        await browser.list.retry();
      }
    } catch (error) {
      if (isCurrent()) toast.error(t('references.projectPulls.refreshFailed'), error instanceof Error ? { description: error.message } : undefined);
    } finally {
      refreshPending.current = false;
      setRefreshingFromHost(false);
    }
  };
  const returning = usePullRequestSelectionStore(state => state.returnRequests.get(pullRequestNavigationKey(getRuntimeKey(), workspaceDirectory)));
  const { closeMobilePreview, openItem } = browser;
  React.useEffect(() => {
    if (!active || returning?.tab !== 'project' || !context || context === 'missing') return;
    if (hasSameSourceControlReadContext(returning.context, context)) {
      if (returning.showList) closeMobilePreview();
      else openItem({ source: 'repository', reference: returning.reference });
    }
    usePullRequestSelectionStore.getState().settleReturnRequest(returning);
  }, [active, closeMobilePreview, context, openItem, returning]);
  const preview = browser.previewItem;
  const selectedPull = !restoreUrl && preview?.source === 'repository' && preview.reference.kind === 'pull' ? preview.reference : null;
  const showingDetail = selectedPull !== null;
  const showingList = active && !showingDetail && !restoreUrl;
  useBoardRevalidation(active);
  const openRow = (item: ReferencePickerItem) => {
    if (diffContext && item.source === 'repository' && item.reference.kind === 'pull') {
      openPull('diff', {
        pull: item.reference, context: diffContext, repository: directory,
        project: { id: '', path: workspaceDirectory },
        projectOwnsDirectory: path => path === workspaceDirectory,
        currentDirectory: workspaceDirectory,
        returnTo: { workspaceDirectory, tab: 'project', showList: true },
      });
    } else {
      browser.showItem(referencePickerItemKey(item));
    }
  };
  const goBack = useProjectReferenceBack(browser, showingList);

  return (
    <div hidden={!active} className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {restoreUrl ? <>
        <ProjectReferenceBackButton onBack={goBack} />
        <SourceBoardLinkFeedback url={restoreUrl} state={restored.error ? 'error' : restored.unavailable === 'disconnected' ? 'disconnected'
          : restored.unavailable === 'no-repo' ? 'noRepository' : restored.status === 'ready' && !restored.refreshing ? 'notFound' : 'loading'}
          error={restored.error} onRetry={() => void restored.retry()} />
        {orphan && restored.status === 'ready' ? <div className="shrink-0 px-4 pb-4"><Textarea value={orphan.value} readOnly rows={4} aria-label={t('sourceBoard.reply.label')} /></div> : null}
      </> : null}
      {showingDetail ? (
        <>
          <ProjectReferenceBackButton onBack={goBack} />
          {active && selectedPull && context && context !== 'missing' ? (
            <PullRequestDetail
              key={`${selectedPull.sourceRepo.owner}/${selectedPull.sourceRepo.repo}#${selectedPull.number}`}
              reference={selectedPull}
              context={context}
              githubDetail={browser.repositoryDetail}
              now={browser.now}
              onChanged={browser.list.retry}
              onSubmitted={goBack}
              refreshDetail={browser.refreshRepositoryDetail}
              pullLinks={<SourceBoardPullLinks pull={selectedPull} repository={directory} project={{ id: '', path: workspaceDirectory }} context={context} projectOwnsDirectory={(directory) => directory === workspaceDirectory} currentDirectory={workspaceDirectory}
                returnTo={{ workspaceDirectory, tab: 'project' }} />}
            />
          ) : null}
        </>
      ) : null}
      <ProjectReferenceList
        browser={browser}
        stateOwner={stateOwner}
        showingList={showingList}
        label={t('gitView.pullRequest.tab.project')}
        refreshLabel={t('gitView.pr.actions.refresh')}
        refreshEnabled={Boolean(context && context !== 'missing')}
        refreshing={refreshingFromHost}
        onRefresh={() => void refreshFromHost()}
        onOpenItem={openRow}
        renderPullFileStats={context && context !== 'missing' ? pull => (
          <ProjectPullFileStats context={context} pull={pull} excludedTypes={fileFilter.excludedTypes} />
        ) : undefined}
        renderPullAction={diffContext ? (pull, rememberScroll) => {
          const label = t('references.projectPulls.viewDetails', { reference: formatChangeRequestLabel(browser.descriptor, pull.number) });
          return (
            <Button type="button" size="icon" variant="ghost" className={isMobile ? 'size-9' : 'size-6'}
              title={label} aria-label={label} onClick={(event) => {
                event.stopPropagation();
                rememberScroll();
                openItem({ source: 'repository', reference: pull });
              }}>
              <Icon name="file-text" className="size-3.5" />
            </Button>
          );
        } : undefined}
      />
    </div>
  );
};
