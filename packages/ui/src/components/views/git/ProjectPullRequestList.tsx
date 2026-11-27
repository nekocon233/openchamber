import { useWorkspaceViewOwner } from '@/hooks/useWorkspaceViewOwner';
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ReferenceBrowserList, ReferenceBrowserSearch } from '@/components/references/ReferenceBrowser';
import { DEFAULT_REPOSITORY_FILTER, referencePickerItemKey, type ReferencePickerItem } from '@/components/references/referencePickerItems';
import { invalidateRepositoryPullStatuses, useRepositoryReadContext, useRepositoryReferenceList } from '@/components/references/referenceSources';
import { useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { SourceBoardPullLinks } from '@/components/sourceBoard/SourceBoardActions';
import { useOpenSourceBoardPull } from '@/components/sourceBoard/useOpenSourceBoardPull';
import { useBoardRevalidation } from '@/components/sourceBoard/useBoardRevalidation';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { hasSameSourceControlReadContext } from '@/lib/source-control/identity';
import { useChangeRequestDiffServing } from '@/lib/source-control/providers/registry';
import { formatChangeRequestLabel } from '@/lib/source-control/providers/terminology';
import { cn } from '@/lib/utils';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { PullRequestDetail } from './PullRequestDetail';
import { useWorkspaceScroll } from '@/hooks/useWorkspaceViewState';
import { WORKSPACE_VIEW_DEFAULTS, readWorkspaceViewState, useWorkspaceViewStateStore, workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { SourceBoardLinkFeedback } from '@/components/sourceBoard/SourceBoardLinkFeedback';
import { isSameRepositoryItemLink } from '@/components/sourceBoard/boardLinkTarget';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import { useWorkspaceDraftStore, workspaceReplyDraftKey } from '@/stores/useWorkspaceDraftStore';
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
  const openSettings = useOpenSourceControlSettings();
  const context = useRepositoryReadContext(directory);
  const diffServing = useChangeRequestDiffServing(context && context !== 'missing' ? context.provider : undefined);
  const openPull = useOpenSourceBoardPull();
  const diffContext = context && context !== 'missing' && diffServing !== 'not-served' ? context : null;
  const owner = useWorkspaceViewOwner(workspaceDirectory);
  const stateOwner = context && context !== 'missing' ? workspaceViewKey(owner.runtime, workspaceDirectory, workspaceRepositoryIdentity(context)) : null;
  const browser = useReferenceBrowser({ source: 'repository', directory, isMobile, mode: 'project-pulls', active, projectPullsState: { owner: stateOwner, preferences: owner.project } });
  const restoreUrl = browser.selectionUrl;
  const previewUrl = browser.previewItem?.source === 'repository' ? browser.previewItem.reference.url : null;
  const restoring = Boolean(restoreUrl && restoreUrl !== previewUrl);
  const restoreTarget = restoreUrl ? parseChangeRequestReference(restoreUrl) : null;
  const orphanKey = restoreTarget?.project && context && context !== 'missing' ? workspaceReplyDraftKey(owner.runtime, context, {
    kind: 'pull', number: restoreTarget.number, sourceRepo: { owner: restoreTarget.project.owner, repo: restoreTarget.project.name },
  }) : null;
  const orphan = useWorkspaceDraftStore(state => orphanKey ? state.drafts[orphanKey] : undefined);
  const restored = useRepositoryReferenceList({ directory, kind: 'pull', filter: DEFAULT_REPOSITORY_FILTER,
    query: restoreUrl ?? '', scope: 'repository', enabled: restoring && active, active });
  React.useEffect(() => {
    if (!restoring || !active || !restoreUrl) return;
    if (stateOwner && readWorkspaceViewState(useWorkspaceViewStateStore.getState(), 'pullRequest', stateOwner).selectedUrl !== restoreUrl) return;
    const reference = restored.items.find(item => item.kind === 'pull' && isSameRepositoryItemLink(item.url, restoreUrl));
    if (reference) browser.openItem({ source: 'repository', reference });
  }, [active, browser, restoreUrl, restored.error, restored.items, restored.refreshing, restored.status, restoring, stateOwner]);
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
  const scrollRef = React.useRef<HTMLElement>(null);
  const stateTriggerRef = React.useRef<HTMLButtonElement>(null);
  useWidthMorph(stateTriggerRef);
  const stateValueId = React.useId();
  const scrollTop = React.useRef(0);
  const listVisibleRef = React.useRef(false);
  const preview = browser.previewItem;
  const selectedPull = !restoring && preview?.source === 'repository' && preview.reference.kind === 'pull' ? preview.reference : null;
  const showingDetail = selectedPull !== null;
  const showingList = active && !showingDetail && !restoring;
  const { people, state } = browser.repositoryFilter;
  const depthIdentity = JSON.stringify([stateOwner, people, state, browser.query]);
  const savedDepth = React.useRef({ identity: depthIdentity, count: browser.loadedCount });
  if (savedDepth.current.identity !== depthIdentity) savedDepth.current = { identity: depthIdentity, count: browser.loadedCount };
  React.useEffect(() => {
    if (!showingList || browser.list.status !== 'ready') return;
    if (browser.list.items.length < savedDepth.current.count && browser.list.hasMore && !browser.list.error) browser.list.loadMore();
    if (browser.list.items.length > browser.loadedCount) browser.setLoadedCount(browser.list.items.length);
  }, [browser, showingList]);
  const searching = Boolean(browser.debouncedQuery.trim()) || people !== 'any';
  useBoardRevalidation(active);

  React.useLayoutEffect(() => {
    if (showingList && scrollRef.current) scrollRef.current.scrollTop = scrollTop.current;
    listVisibleRef.current = showingList;
    // Hidden Activity boundaries disconnect effects before the list can report a hidden scroll offset.
    return () => { listVisibleRef.current = false; };
  }, [showingList]);
  const scrollOwnerFor = (people: typeof browser.repositoryFilter.people, state: typeof browser.repositoryFilter.state) => {
    if (!stateOwner) return null;
    const scope = [stateOwner, 'list', people, browser.query];
    if (state === 'closed') scope.push(state);
    return JSON.stringify(scope);
  };
  useWorkspaceScroll(scrollRef, scrollOwnerFor(people, state),
    showingList && browser.list.status === 'ready' && (browser.list.items.length >= savedDepth.current.count || !browser.list.hasMore), showingList);

  const selectListFilter = (nextPeople: 'mine' | 'any', nextState: typeof browser.projectAllState) => {
    if (nextPeople === people && nextState === state) return;
    const scrollOwner = scrollOwnerFor(nextPeople, nextState);
    if (scrollOwner) useWorkspaceViewStateStore.getState().update('scroll', scrollOwner, () => WORKSPACE_VIEW_DEFAULTS.scroll);
    browser.selectRepositoryFilter({ people: nextPeople, state: nextState });
    scrollTop.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const rememberScroll = () => { scrollTop.current = scrollRef.current?.scrollTop ?? 0; };
  const openRow = (item: ReferencePickerItem) => {
    rememberScroll();
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
  const goBack = () => {
    browser.closeMobilePreview();
    requestAnimationFrame(() => browser.searchRef.current?.focus());
  };

  return (
    <div hidden={!active} className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {restoring ? <>
        <div className="shrink-0 border-b border-border/60 px-4 py-2">
          <Button size="sm" variant="ghost" onClick={goBack}><Icon name="arrow-left" className="size-4" />{t('gitView.pullRequest.backToList')}</Button>
        </div>
        <SourceBoardLinkFeedback url={restoreUrl!} state={restored.error ? 'error' : restored.unavailable === 'disconnected' ? 'disconnected'
          : restored.unavailable === 'no-repo' ? 'noRepository' : restored.status === 'ready' && !restored.refreshing ? 'notFound' : 'loading'}
          error={restored.error} onRetry={() => void restored.retry()} />
        {orphan && restored.status === 'ready' ? <div className="shrink-0 px-4 pb-4"><Textarea value={orphan.value} readOnly rows={4} aria-label={t('sourceBoard.reply.label')} /></div> : null}
      </> : null}
      {showingDetail ? (
        <>
          <div className="shrink-0 border-b border-border/60 px-4 py-2">
            <Button size="sm" variant="ghost" onClick={goBack}>
              <Icon name="arrow-left" className="size-4" />
              {t('gitView.pullRequest.backToList')}
            </Button>
          </div>
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
      <div hidden={!showingList} className={showingList ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <div className="shrink-0 border-b border-border/60 px-4 py-2">
          <SortableTabsStrip
            items={[
              { id: 'mine', label: t('references.projectPulls.group.mine') },
              { id: 'any', label: t('references.projectPulls.group.all') },
            ]}
            activeId={people}
            onSelect={id => {
              if (id === 'mine' || id === 'any') selectListFilter(id, id === 'mine' ? 'open' : browser.projectAllState);
            }}
            variant="active-pill"
            layoutMode="fit"
            intrinsicWidth
          />
        </div>
        <div className="shrink-0 border-b border-border/60 px-4 py-2">
          <ReferenceBrowserSearch
            browser={browser}
            onKeyDown={(event) => {
              if (isIMECompositionEvent(event) || browser.handleNavigationKey(event)) return;
              if (event.key === 'Enter' && browser.highlightedItem) {
                event.preventDefault();
                openRow(browser.highlightedItem);
              }
            }}
            trailing={<>
              {people === 'any' ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    ref={stateTriggerRef}
                    className={cn(dropdownTriggerVariants({ size: isMobile ? 'touch' : 'default' }), 'max-w-36 shrink-0')}
                    aria-label={t('references.picker.filter.group.status')}
                    aria-describedby={stateValueId}
                  >
                    <span id={stateValueId} className="truncate">
                      {t(browser.projectAllState === 'closed' ? 'references.picker.state.closed' : 'references.picker.state.open')}
                    </span>
                    <Icon name="arrow-down-s" className="size-4 opacity-50" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup value={browser.projectAllState} onValueChange={value => {
                      if (value === 'open' || value === 'closed') selectListFilter('any', value);
                    }}>
                      <DropdownMenuRadioItem value="open" closeOnClick>{t('references.picker.state.open')}</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="closed" closeOnClick>{t('references.picker.state.closed')}</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button size="sm" variant="ghost" disabled={refreshingFromHost || !context || context === 'missing'} onClick={() => void refreshFromHost()} aria-label={t('gitView.pr.actions.refresh')} title={t('gitView.pr.actions.refresh')}>
                <Icon name="refresh" className={`size-4${refreshingFromHost || browser.list.refreshing ? ' animate-spin' : ''}`} />
              </Button>
            </>}
          />
        </div>
        {searching && (browser.list.total ?? 0) > 1_000 ? (
          <p className="px-4 py-2 typography-meta text-muted-foreground">{t('gitView.pullRequest.searchLimit', { count: 1_000 })}</p>
        ) : null}
        <ScrollableOverlay
          ref={scrollRef}
          outerClassName="min-h-0 flex-1"
          disableHorizontal
          useScrollShadow
          onScroll={(event) => {
            if (listVisibleRef.current) scrollTop.current = event.currentTarget.scrollTop;
          }}
        >
          {showingList ? <ReferenceBrowserList browser={browser} label={t('gitView.pullRequest.tab.project')} multiselectable={false} onOpenSettings={openSettings} onSelectItem={openRow}
            renderPullFileStats={context && context !== 'missing' ? pull => (
              <ProjectPullFileStats context={context} pull={pull} excludedTypes={fileFilter.excludedTypes} />
            ) : undefined}
            renderPullAction={diffContext ? pull => {
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
            } : undefined} /> : null}
        </ScrollableOverlay>
      </div>
    </div>
  );
};
