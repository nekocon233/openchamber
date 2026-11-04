import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ReferenceBrowserList, ReferenceBrowserSearch } from '@/components/references/ReferenceBrowser';
import { referencePickerItemKey } from '@/components/references/referencePickerItems';
import { useGitHubReadContext } from '@/components/references/referenceSources';
import { useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { SourceBoardPullLinks } from '@/components/sourceBoard/SourceBoardActions';
import { useBoardRevalidation } from '@/components/sourceBoard/useBoardRevalidation';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { hasSameSourceControlReadContext } from '@/lib/source-control/identity';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { PullRequestDetail } from './PullRequestDetail';

/** Single-repository PR list, retained across the panel's branch and detail views. */
export const ProjectPullRequestList: React.FC<{ directory: string; workspaceDirectory: string; active: boolean }> = ({ directory, workspaceDirectory, active }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const openSettings = useOpenSourceControlSettings();
  const context = useGitHubReadContext(directory);
  const browser = useReferenceBrowser({ source: 'github', directory, isMobile, mode: 'project-pulls', active });
  const [refreshingFromHost, setRefreshingFromHost] = React.useState(false);
  const refreshPending = React.useRef(false);
  const refreshFromHost = async () => {
    if (!context || context === 'missing' || refreshPending.current) return;
    const runtime = getRuntimeKey();
    refreshPending.current = true;
    setRefreshingFromHost(true);
    try {
      await sourceControl.refreshProviderReads(context);
      if (getRuntimeKey() === runtime) await browser.list.retry();
    } catch (error) {
      if (getRuntimeKey() === runtime) toast.error(t('references.projectPulls.refreshFailed'), error instanceof Error ? { description: error.message } : undefined);
    } finally {
      refreshPending.current = false;
      setRefreshingFromHost(false);
    }
  };
  const returning = usePullRequestSelectionStore(state => state.returnRequests.get(pullRequestNavigationKey(getRuntimeKey(), workspaceDirectory)));
  const { openItem } = browser;
  React.useEffect(() => {
    if (!active || returning?.tab !== 'project' || !context || context === 'missing') return;
    if (hasSameSourceControlReadContext(returning.context, context)) openItem({ source: 'github', reference: returning.reference });
    usePullRequestSelectionStore.getState().settleReturnRequest(returning);
  }, [active, context, openItem, returning]);
  const scrollRef = React.useRef<HTMLElement>(null);
  const scrollTop = React.useRef(0);
  const listVisibleRef = React.useRef(false);
  const preview = browser.previewItem;
  const selectedPull = preview?.source === 'github' && preview.reference.kind === 'pull' ? preview.reference : null;
  const showingDetail = selectedPull !== null;
  const showingList = active && !showingDetail;
  const searching = Boolean(browser.debouncedQuery.trim()) || browser.githubFilter.people !== 'any';
  useBoardRevalidation(active);

  React.useLayoutEffect(() => {
    if (showingList && scrollRef.current) scrollRef.current.scrollTop = scrollTop.current;
    listVisibleRef.current = showingList;
    // Hidden Activity boundaries disconnect effects before the list can report a hidden scroll offset.
    return () => { listVisibleRef.current = false; };
  }, [showingList]);

  const rememberScroll = () => { scrollTop.current = scrollRef.current?.scrollTop ?? 0; };
  const goBack = () => {
    browser.closeMobilePreview();
    requestAnimationFrame(() => browser.searchRef.current?.focus());
  };

  return (
    <div hidden={!active} className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
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
              githubDetail={browser.githubDetail}
              pullStatus={browser.pullStatusOf(selectedPull)}
              now={browser.now}
              onChanged={browser.list.retry}
              refreshDetail={browser.refreshGithubDetail}
              pullLinks={<SourceBoardPullLinks pull={selectedPull} project={{ id: '', path: workspaceDirectory }} context={context} projectOwnsDirectory={(directory) => directory === workspaceDirectory} currentDirectory={workspaceDirectory}
                returnTo={{ workspaceDirectory, tab: 'project' }} />}
            />
          ) : null}
        </>
      ) : null}
      <div hidden={!showingList} className={showingList ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <div className="shrink-0 border-b border-border/60 px-4 py-2">
          <SortableTabsStrip
            items={[
              { id: 'reviewRequested', label: t('references.projectPulls.group.reviewRequested') },
              { id: 'created', label: t('references.projectPulls.group.created') },
              { id: 'any', label: t('references.projectPulls.group.all') },
            ]}
            activeId={browser.githubFilter.people}
            onSelect={id => {
              if ((id !== 'reviewRequested' && id !== 'created' && id !== 'any') || id === browser.githubFilter.people) return;
              browser.selectGitHubFilter({ people: id });
              scrollTop.current = 0;
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
            }}
            variant="active-pill"
            layoutMode="fit"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
          <ReferenceBrowserSearch browser={browser} onKeyDown={(event) => {
            if (isIMECompositionEvent(event) || browser.handleNavigationKey(event)) return;
            if (event.key === 'Enter' && browser.highlightedItem) {
              event.preventDefault();
              rememberScroll();
              browser.showItem(referencePickerItemKey(browser.highlightedItem));
            }
          }} />
          <Button size="sm" variant="ghost" disabled={refreshingFromHost || !context || context === 'missing'} onClick={() => void refreshFromHost()} aria-label={t('gitView.pr.actions.refresh')} title={t('gitView.pr.actions.refresh')}>
            <Icon name="refresh" className={`size-4${refreshingFromHost || browser.list.refreshing ? ' animate-spin' : ''}`} />
          </Button>
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
          {showingList ? <ReferenceBrowserList browser={browser} label={t('gitView.pullRequest.tab.project')} multiselectable={false} onOpenSettings={openSettings} onShow={rememberScroll} /> : null}
        </ScrollableOverlay>
      </div>
    </div>
  );
};
