import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { REFERENCE_META_TEXT, relativeTimeOf } from '@/components/references/referencePickerItems';
import { useGitHubReadContext, useGitHubSourceStatus } from '@/components/references/referenceSources';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { getDropdownNavigationKey, shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkspaceViewOwner } from '@/hooks/useWorkspaceViewOwner';
import { useWorkspaceScroll, useWorkspaceViewState } from '@/hooks/useWorkspaceViewState';
import type { CiRunStatusFilter, CiWorkflowRun } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { useGitStatus } from '@/stores/useGitStore';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import {
  WORKSPACE_VIEW_DEFAULTS,
  useWorkspaceViewStateStore,
  workspaceRepositoryIdentity,
  workspaceViewKey,
} from '@/stores/useWorkspaceViewStateStore';

import { CiRunDetail, CiRunStatusGlyph } from './CiRunDetail';
import { formatElapsedDuration } from './checkRunState';
import {
  IDLE_CI_LIST_ENTRY,
  getCiRunsListKey,
  isActiveCiRunStatus,
  pinCiCacheKey,
  useCiRunsStore,
  type CiListFilterInput,
} from './ciRunsStore';

const LIST_ACTIVE_REFRESH_MS = 20_000;
const QUERY_DEBOUNCE_MS = 250;

const normalizeCompare = (value: string): string => value.replace(/\/+$/, '');

type CiTabFilter = 'all' | 'active' | 'failure' | 'branch';

const CiWorkflowRunRow = React.memo(function CiWorkflowRunRow({
  run,
  highlighted,
  now,
  onHighlight,
  onOpen,
}: {
  run: CiWorkflowRun;
  highlighted: boolean;
  now: number;
  onHighlight: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const rowRef = React.useRef<HTMLDivElement>(null);
  const wasHighlighted = React.useRef(false);

  React.useEffect(() => {
    if (highlighted && !wasHighlighted.current) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
    wasHighlighted.current = highlighted;
  }, [highlighted]);

  const active = isActiveCiRunStatus(run.status);
  const durationLabel = active
    ? formatElapsedDuration(run.startedAt, undefined, now)
    : formatElapsedDuration(run.startedAt, run.completedAt);
  const updated = relativeTimeOf(run.startedAt ?? run.createdAt ?? null, now);
  const summary = run.jobSummary;
  const completedJobs = summary ? summary.success + summary.failure : 0;

  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={highlighted}
      className={cn(
        'group flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors',
        highlighted ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
      )}
      onClick={() => {
        onHighlight();
        onOpen();
      }}
    >
      <CiRunStatusGlyph status={run.status} conclusion={run.conclusion} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div dir="auto" className={cn('oc-ui-start-align typography-ui-header font-semibold line-clamp-2 break-words', !highlighted && 'text-foreground')}>
          {run.title}
        </div>
        <div className={cn('mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 typography-micro', REFERENCE_META_TEXT)}>
          <span dir="auto" className="oc-ui-start-align truncate font-medium">
            {run.workflowName} <span dir="ltr" className="font-mono">#{run.runNumber}</span>
          </span>
          {run.headBranch ? (
            <span dir="ltr" className="inline-flex max-w-[11rem] items-center gap-0.5 truncate font-mono">
              <Icon name="git-branch" className="size-3 shrink-0" />
              <span className="truncate">{run.headBranch}</span>
            </span>
          ) : null}
          {run.pullRequests[0] ? (
            <span dir="ltr" className="inline-flex items-center gap-0.5 font-mono">
              <Icon name="git-pull-request" className="size-3 shrink-0" />
              #{run.pullRequests[0].number}
            </span>
          ) : null}
          <span dir="ltr" className="font-mono">{run.event}</span>
          {run.actor ? <span dir="ltr" className="truncate">@{run.actor.username}</span> : null}
          {updated ? (
            <span>
              {updated.key === 'common.relative.justNow'
                ? t(updated.key)
                : t(updated.key, { count: updated.count })}
            </span>
          ) : null}
          {durationLabel ? <span dir="ltr" className="tabular-nums">{durationLabel}</span> : null}
        </div>
        {summary && summary.total > 0 ? (
          <div
            className={cn(
              'mt-1 flex min-w-0 items-center gap-1 typography-micro tabular-nums',
              summary.state === 'failure'
                ? 'text-[var(--status-error)]'
                : summary.state === 'pending'
                  ? 'text-[var(--status-warning)]'
                  : 'text-[var(--status-success)]',
            )}
          >
            <span>{t('ciRuns.row.jobsProgress', { completed: completedJobs, total: summary.total })}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** Single-repository GitHub Actions workflow runs list and detail viewer. */
export const ProjectCiList: React.FC<{
  directory: string;
  workspaceDirectory: string;
  active: boolean;
}> = ({ directory, workspaceDirectory, active }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const openSettings = useOpenSourceControlSettings();
  const sourceStatus = useGitHubSourceStatus(directory);
  const rawContext = useGitHubReadContext(directory);
  const context = rawContext && rawContext !== 'missing' && rawContext.provider === 'github' ? rawContext : null;
  const contextLoading = sourceStatus === 'ready' && Boolean(directory) && rawContext === null;
  const gitStatus = useGitStatus(directory);
  const currentBranch = gitStatus?.current?.trim() || null;

  const owner = useWorkspaceViewOwner(workspaceDirectory);
  const stateOwner = context
    ? workspaceViewKey(owner.runtime, workspaceDirectory, workspaceRepositoryIdentity(context))
    : null;

  const [filterTab, setFilterTab] = useWorkspaceViewState('ci', stateOwner, 'filter');
  const [query, setQuery] = useWorkspaceViewState('ci', stateOwner, 'query');
  const [selectedRunId, setSelectedRunId] = useWorkspaceViewState('ci', stateOwner, 'selectedRunId');
  const [loadedCount, setLoadedCount] = useWorkspaceViewState('ci', stateOwner, 'loadedCount');

  const [debouncedQuery, setDebouncedQuery] = React.useState(query);
  React.useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setDebouncedQuery('');
      return undefined;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Wait until binding authority resolves so `selectedRunId` persists into `stateOwner`
  // rather than vanishing when `PullRequestTabs` remounts under the resolved binding key.
  const ciPending = usePullRequestSelectionStore((state) => (
    state.ciOpenRequests.get(pullRequestNavigationKey(getRuntimeKey(), workspaceDirectory))
  ));
  React.useEffect(() => {
    if (!active || !ciPending) return;
    if (ciPending.sourceDirectory && normalizeCompare(ciPending.sourceDirectory) !== normalizeCompare(directory)) {
      return;
    }
    if (context && stateOwner) {
      setSelectedRunId(ciPending.runId);
      usePullRequestSelectionStore.getState().settleCiRunRequest(ciPending);
      return;
    }
    if (!contextLoading) {
      usePullRequestSelectionStore.getState().settleCiRunRequest(ciPending);
    }
  }, [active, ciPending, context, contextLoading, directory, setSelectedRunId, stateOwner]);

  const statusFilter: CiRunStatusFilter = filterTab === 'active'
    ? 'active'
    : filterTab === 'failure'
      ? 'failure'
      : 'all';
  const branchFilter = filterTab === 'branch' ? (currentBranch ?? '') : '';
  const missingBranchForFilter = filterTab === 'branch' && !currentBranch;

  const listFilter = React.useMemo<CiListFilterInput>(() => ({
    status: statusFilter,
    branch: branchFilter || undefined,
    query: debouncedQuery || undefined,
  }), [branchFilter, debouncedQuery, statusFilter]);

  const listKey = context && !missingBranchForFilter ? getCiRunsListKey(context, listFilter) : null;
  const entry = useCiRunsStore((state) => (listKey ? state.lists[listKey] : undefined)) ?? IDLE_CI_LIST_ENTRY;

  React.useEffect(() => {
    if (!listKey) return undefined;
    return pinCiCacheKey(listKey);
  }, [listKey]);

  const showingDetail = selectedRunId !== null;
  const showingList = active && !showingDetail;
  const hasActiveRuns = entry.items.some((run) => isActiveCiRunStatus(run.status));
  const now = useDurationTickerNow(showingList && hasActiveRuns);

  React.useEffect(() => {
    if (!showingList || !context || missingBranchForFilter) return undefined;
    void useCiRunsStore.getState().ensureList(sourceControl, context, listFilter, false);
    const revalidateIfStale = () => {
      if (document.visibilityState === 'visible') {
        void useCiRunsStore.getState().ensureList(sourceControl, context, listFilter, false);
      }
    };
    window.addEventListener('focus', revalidateIfStale);
    document.addEventListener('visibilitychange', revalidateIfStale);
    const timer = hasActiveRuns
      ? window.setInterval(() => {
        void useCiRunsStore.getState().ensureList(sourceControl, context, listFilter, true);
      }, LIST_ACTIVE_REFRESH_MS)
      : null;
    return () => {
      window.removeEventListener('focus', revalidateIfStale);
      document.removeEventListener('visibilitychange', revalidateIfStale);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [context, hasActiveRuns, listFilter, missingBranchForFilter, showingList, sourceControl]);

  // Restore multi-page depth once per filter/query scope, then clear `savedDepth`
  // so subsequent active refreshes never trigger an endless pagination loop.
  const depthIdentity = JSON.stringify([stateOwner, filterTab, debouncedQuery]);
  const savedDepth = React.useRef({ identity: depthIdentity, count: loadedCount });
  if (savedDepth.current.identity !== depthIdentity) {
    savedDepth.current = { identity: depthIdentity, count: loadedCount };
  }
  React.useEffect(() => {
    if (!showingList || !context || entry.status !== 'ready') return;
    if (savedDepth.current.count > 0) {
      if (entry.items.length < savedDepth.current.count && entry.hasMore && !entry.error && !entry.loadingMore) {
        void useCiRunsStore.getState().loadMoreList(sourceControl, context, listFilter);
        return;
      }
      savedDepth.current.count = 0;
    }
    if (entry.items.length > loadedCount) {
      setLoadedCount(entry.items.length);
    }
  }, [context, entry.error, entry.hasMore, entry.items.length, entry.loadingMore, entry.status, listFilter, loadedCount, setLoadedCount, showingList, sourceControl]);

  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [filterTab, debouncedQuery]);

  const clampedIndex = entry.items.length > 0 ? Math.min(highlightedIndex, entry.items.length - 1) : -1;

  const searchRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLElement>(null);
  const scrollTop = React.useRef(0);
  const listVisibleRef = React.useRef(false);

  React.useLayoutEffect(() => {
    if (showingList && scrollRef.current) scrollRef.current.scrollTop = scrollTop.current;
    listVisibleRef.current = showingList;
    return () => {
      listVisibleRef.current = false;
    };
  }, [showingList]);

  useWorkspaceScroll(
    scrollRef,
    stateOwner ? JSON.stringify([stateOwner, 'ci-list', filterTab, debouncedQuery]) : null,
    showingList && entry.status === 'ready' && (entry.items.length >= savedDepth.current.count || !entry.hasMore),
    showingList,
  );

  const [refreshingFromHost, setRefreshingFromHost] = React.useState(false);
  const refreshPending = React.useRef(false);
  const refreshFromHost = async () => {
    if (!context || refreshPending.current || missingBranchForFilter) return;
    const runtime = getRuntimeKey();
    refreshPending.current = true;
    setRefreshingFromHost(true);
    try {
      await sourceControl.refreshProviderReads(context);
      if (getRuntimeKey() === runtime) {
        await useCiRunsStore.getState().ensureList(sourceControl, context, listFilter, true);
      }
    } catch (error) {
      if (getRuntimeKey() === runtime) {
        toast.error(t('ciRuns.refreshFailed'), error instanceof Error ? { description: error.message } : undefined);
      }
    } finally {
      refreshPending.current = false;
      setRefreshingFromHost(false);
    }
  };

  const rememberScroll = () => {
    scrollTop.current = scrollRef.current?.scrollTop ?? 0;
  };

  const openRun = (runId: string) => {
    rememberScroll();
    setSelectedRunId(runId);
  };

  const goBack = () => {
    setSelectedRunId(null);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const selectedRunFromList = React.useMemo(
    () => (selectedRunId ? entry.items.find((item) => item.id === selectedRunId) ?? null : null),
    [entry.items, selectedRunId],
  );

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isIMECompositionEvent(event)) return;
    if (shouldDismissDropdown(event) && query.length > 0) {
      event.preventDefault();
      setQuery('');
      return;
    }
    const navKey = event.key === 'ArrowDown' || event.key === 'ArrowUp'
      ? event.key
      : getDropdownNavigationKey(event);
    if (navKey && entry.items.length > 0) {
      event.preventDefault();
      setHighlightedIndex((prev) => (
        navKey === 'ArrowDown'
          ? Math.min(entry.items.length - 1, prev + 1)
          : Math.max(0, prev - 1)
      ));
      return;
    }
    if (event.key === 'Enter' && clampedIndex >= 0 && entry.items[clampedIndex]) {
      event.preventDefault();
      openRun(entry.items[clampedIndex].id);
    }
  };

  const selectFilterTab = (id: string) => {
    if (id !== 'all' && id !== 'active' && id !== 'failure' && id !== 'branch') return;
    const nextTab: CiTabFilter = id;
    if (nextTab === filterTab) return;
    if (stateOwner) {
      useWorkspaceViewStateStore.getState().update(
        'scroll',
        JSON.stringify([stateOwner, 'ci-list', nextTab, debouncedQuery]),
        () => WORKSPACE_VIEW_DEFAULTS.scroll,
      );
    }
    setFilterTab(nextTab);
    setLoadedCount(0);
    scrollTop.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const renderUnavailableContext = () => {
    if (sourceStatus === 'unsupported') {
      return (
        <div className="px-6 py-12 text-center typography-meta text-muted-foreground">
          {t('references.picker.empty.unsupported')}
        </div>
      );
    }
    if (contextLoading) {
      return (
        <div role="status" className="flex justify-center py-12">
          <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (sourceStatus === 'disconnected') {
      return (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <p className="typography-meta text-muted-foreground">{t('ciRuns.notConnected')}</p>
          <Button size="sm" variant="outline" onClick={openSettings}>
            {t('references.picker.actions.openSettings')}
          </Button>
        </div>
      );
    }
    return (
      <div className="px-6 py-12 text-center typography-meta text-muted-foreground">
        {t(directory ? 'references.picker.empty.noRepo' : 'references.picker.empty.noProject')}
      </div>
    );
  };

  return (
    <div hidden={!active} className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {showingDetail && selectedRunId ? (
        <>
          <div className="shrink-0 border-b border-border/60 px-4 py-2">
            <Button size="sm" variant="ghost" onClick={goBack}>
              <Icon name="arrow-left" className="size-4" />
              {t('gitView.pullRequest.backToList')}
            </Button>
          </div>
          {context ? (
            <CiRunDetail
              key={`${context.repositoryId}:${selectedRunId}`}
              runId={selectedRunId}
              initialRun={selectedRunFromList}
              context={context}
              workspaceDirectory={workspaceDirectory}
              active={active && showingDetail}
            />
          ) : renderUnavailableContext()}
        </>
      ) : null}

      <div hidden={!showingList} className={showingList ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <div className="shrink-0 border-b border-border/60 px-4 py-2">
          <SortableTabsStrip
            items={[
              { id: 'all', label: t('ciRuns.filter.all') },
              { id: 'active', label: t('ciRuns.filter.active') },
              { id: 'failure', label: t('ciRuns.filter.failure') },
              { id: 'branch', label: t('ciRuns.filter.branch') },
            ]}
            activeId={filterTab}
            onSelect={selectFilterTab}
            variant="active-pill"
            layoutMode="fit"
          />
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Icon name="search" className="pointer-events-none absolute inset-s-2.5 size-3.5 text-muted-foreground" />
            <Input
              ref={searchRef}
              inputSize="compact"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLoadedCount(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('ciRuns.search.placeholder')}
              aria-label={t('ciRuns.search.placeholder')}
              className="ps-8 pe-7"
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setLoadedCount(0);
                  searchRef.current?.focus();
                }}
                aria-label={t('ciRuns.search.clearAria')}
                className="absolute inset-e-1.5 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <Icon name="close" className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={refreshingFromHost || !context || missingBranchForFilter}
            onClick={() => void refreshFromHost()}
            aria-label={t('gitView.pr.actions.refresh')}
            title={t('gitView.pr.actions.refresh')}
          >
            <Icon name="refresh" className={cn('size-4', (refreshingFromHost || entry.refreshing) && 'animate-spin')} />
          </Button>
        </div>

        <ScrollableOverlay
          ref={scrollRef}
          outerClassName="min-h-0 flex-1"
          disableHorizontal
          useScrollShadow
          onScroll={(event) => {
            if (listVisibleRef.current) scrollTop.current = event.currentTarget.scrollTop;
          }}
        >
          {!context ? renderUnavailableContext() : missingBranchForFilter ? (
            <div className="px-6 py-12 text-center typography-meta text-muted-foreground">
              {t('ciRuns.empty.noBranch')}
            </div>
          ) : entry.status === 'error' && entry.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <p role="alert" className="typography-meta text-[var(--status-error-text)]">
                {t('ciRuns.loadFailed', { error: entry.error ?? '' })}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void useCiRunsStore.getState().ensureList(sourceControl, context, listFilter, true)}
              >
                {t('settings.sourceControl.transport.retry')}
              </Button>
            </div>
          ) : (entry.status === 'loading' || entry.status === 'idle') && entry.items.length === 0 ? (
            <div role="status" className="flex justify-center py-12">
              <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : entry.items.length === 0 ? (
            <div className="px-6 py-12 text-center typography-meta text-muted-foreground">
              {t(filterTab === 'all' && !debouncedQuery ? 'ciRuns.empty.all' : 'ciRuns.empty.filtered')}
            </div>
          ) : (
            <div role="listbox" aria-label={t('gitView.pullRequest.tab.ci')} className="flex flex-col gap-0.5 p-2">
              {entry.error ? (
                <div role="alert" className="mb-1 flex items-center justify-between gap-2 rounded-md bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error-text)]">
                  <span className="min-w-0 truncate">{t('ciRuns.loadFailed', { error: entry.error })}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void useCiRunsStore.getState().ensureList(sourceControl, context, listFilter, true)}
                  >
                    {t('settings.sourceControl.transport.retry')}
                  </Button>
                </div>
              ) : null}
              {entry.items.map((run, idx) => (
                <CiWorkflowRunRow
                  key={run.id}
                  run={run}
                  highlighted={idx === clampedIndex}
                  now={now}
                  onHighlight={() => setHighlightedIndex(idx)}
                  onOpen={() => openRun(run.id)}
                />
              ))}
              {entry.hasMore ? (
                <div className="flex justify-center py-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={entry.loadingMore}
                    onClick={() => void useCiRunsStore.getState().loadMoreList(sourceControl, context, listFilter)}
                  >
                    {entry.loadingMore ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
                    {t('ciRuns.loadMore')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );
};
