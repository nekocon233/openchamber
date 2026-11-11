import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ChecksSummaryLine, StatePill } from '@/components/references/ReferencePreview';
import { REFERENCE_META_TEXT, relativeTimeOf } from '@/components/references/referencePickerItems';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkspaceScroll } from '@/hooks/useWorkspaceViewState';
import type { CIRun, CiWorkflowRun, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useUIStore } from '@/stores/useUIStore';
import { workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { CheckRunList, type CheckRunJobLogController } from './CheckRunList';
import { formatElapsedDuration, isFailedConclusion, useCheckRunExpansion } from './checkRunState';
import {
  IDLE_CI_DETAIL_ENTRY,
  IDLE_CI_JOB_LOG_ENTRY,
  ciRunLookOf,
  getCiJobLogKey,
  getCiRunDetailKey,
  isActiveCiRunStatus,
  pinCiCacheKey,
  useCiRunsStore,
} from './ciRunsStore';

const DETAIL_ACTIVE_REFRESH_MS = 15_000;

export const CiRunStatusGlyph: React.FC<{
  status: string | undefined | null;
  conclusion: string | undefined | null;
  className?: string;
}> = ({ status, conclusion, className }) => {
  const look = ciRunLookOf(status, conclusion);
  if (look.kind === 'running') {
    return <Spinner className={cn('size-4 shrink-0 text-[var(--status-warning)]', className)} />;
  }
  return <Icon name={look.icon} className={cn('size-4 shrink-0', className)} style={{ color: look.color }} />;
};

const buildFailedCiDraftText = (run: CiWorkflowRun | null, jobRun: CIRun, logExcerpt?: string): string => {
  const annotations = (jobRun.annotations ?? []).map((annotation) => [
    [annotation.level, annotation.title].filter(Boolean).join(' '),
    annotation.path ? `${annotation.path}${annotation.startLine !== undefined ? `:${annotation.startLine}` : ''}` : null,
    annotation.message,
    annotation.rawDetails,
  ].filter(Boolean).join('\n'));
  const failedSteps = (jobRun.job?.steps ?? [])
    .filter((step) => isFailedConclusion(step.conclusion))
    .map((step) => `step ${step.number ?? '?'}: ${step.name} -> ${step.conclusion}`);
  return [
    run ? `workflow: ${run.workflowName} #${run.runNumber}` : null,
    run?.headBranch ? `branch: ${run.headBranch} (${run.headSha.slice(0, 7)})` : null,
    `job: ${jobRun.name}`,
    `status: ${jobRun.status ?? 'unknown'} / ${jobRun.conclusion ?? 'unknown'}`,
    jobRun.detailsUrl ? `url: ${jobRun.detailsUrl}` : (run?.url ? `url: ${run.url}` : null),
    failedSteps.length > 0 ? `failed steps:\n${failedSteps.join('\n')}` : null,
    annotations.length > 0 ? `annotations:\n${annotations.join('\n---\n')}` : null,
    logExcerpt ? `log tail:\n${logExcerpt.slice(-16_000)}` : null,
  ].filter(Boolean).join('\n\n');
};

export const CiRunDetail: React.FC<{
  runId: string;
  initialRun: CiWorkflowRun | null;
  context: SourceControlReadContext;
  workspaceDirectory: string;
  active: boolean;
}> = ({ runId, initialRun, context, workspaceDirectory, active }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const expansion = useCheckRunExpansion();
  const [openLogs, setOpenLogs] = React.useState<Set<string>>(() => new Set());
  const [manualRefreshing, setManualRefreshing] = React.useState(false);
  const autoExpandedRef = React.useRef(false);

  const detailKey = getCiRunDetailKey(context, runId);
  const entry = useCiRunsStore((state) => state.details[detailKey]) ?? IDLE_CI_DETAIL_ENTRY;
  const logsByKey = useCiRunsStore((state) => state.logs);

  const run = entry.detail?.run ?? initialRun;
  const ci = entry.detail?.ci ?? null;
  const jobs = React.useMemo(() => ci?.runs ?? [], [ci?.runs]);
  const isRunning = isActiveCiRunStatus(run?.status) || jobs.some((job) => isActiveCiRunStatus(job.status));
  const now = useDurationTickerNow(active && isRunning);

  const scrollRef = React.useRef<HTMLElement>(null);
  const scrollKey = workspaceViewKey(
    getRuntimeKey(),
    context.directory,
    'ci-detail-scroll',
    workspaceRepositoryIdentity(context),
    runId,
  );
  useWorkspaceScroll(scrollRef, scrollKey, active && (entry.status === 'ready' || Boolean(run)), active);

  React.useEffect(() => pinCiCacheKey(detailKey), [detailKey]);

  React.useEffect(() => {
    if (!active) return undefined;
    void useCiRunsStore.getState().ensureDetail(sourceControl, context, runId, false);
    if (!isRunning) return undefined;
    const interval = window.setInterval(() => {
      void useCiRunsStore.getState().ensureDetail(sourceControl, context, runId, true);
    }, DETAIL_ACTIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [active, context, isRunning, runId, sourceControl]);

  // Expand failed jobs automatically on initial arrival so failure details show immediately.
  React.useEffect(() => {
    if (autoExpandedRef.current || jobs.length === 0) return;
    autoExpandedRef.current = true;
    jobs.forEach((job, idx) => {
      if (isFailedConclusion(job.conclusion)) {
        const runKey = `${job.id ?? 'run'}:${job.name}:${idx}`;
        if (!expansion.runs.has(runKey)) expansion.toggleRun(runKey);
      }
    });
  }, [expansion, jobs]);

  const refreshFromHost = async () => {
    if (manualRefreshing) return;
    const runtime = getRuntimeKey();
    setManualRefreshing(true);
    try {
      await sourceControl.refreshProviderReads(context).catch(() => undefined);
      if (getRuntimeKey() === runtime) {
        await useCiRunsStore.getState().ensureDetail(sourceControl, context, runId, true);
      }
    } finally {
      setManualRefreshing(false);
    }
  };

  const formatTimestamp = React.useCallback((value?: string) => {
    if (!value) return '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return formatDateTimeForPreference(timestamp, timeFormatPreference, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }, [timeFormatPreference]);

  const jobLogController = React.useMemo<CheckRunJobLogController>(() => ({
    getLog: (jobId: string) => logsByKey[getCiJobLogKey(context, jobId)] ?? IDLE_CI_JOB_LOG_ENTRY,
    loadLog: (jobId: string, force = false) => {
      void useCiRunsStore.getState().loadJobLog(sourceControl, context, jobId, force);
    },
    openLogs,
    toggleLog: (jobId: string) => {
      setOpenLogs((prev) => {
        const next = new Set(prev);
        if (next.has(jobId)) next.delete(jobId);
        else next.add(jobId);
        return next;
      });
    },
  }), [context, logsByKey, openLogs, sourceControl]);

  const attachFailedJobs = () => {
    const failed = jobs.filter((job) => isFailedConclusion(job.conclusion));
    if (failed.length === 0) {
      toast.message(t('gitView.pr.toast.noFailedChecks'));
      return;
    }
    const session = useSessionUIStore.getState();
    const sessionKey = session.currentSessionId ?? (session.newSessionDraft?.open ? 'draft' : null);
    const sessionDirectory = session.currentSessionId
      ? (session.getDirectoryForSession(session.currentSessionId) ?? session.currentSessionDirectory)
      : (session.newSessionDraft?.directoryOverride ?? null);
    const targetDirectory = sessionDirectory || useDirectoryStore.getState().currentDirectory || workspaceDirectory;
    if (!targetDirectory || !sessionKey) {
      toast.error(t('gitView.pr.toast.noActiveSession'), { description: t('gitView.pr.toast.noActiveSessionDescription') });
      return;
    }
    const runLabel = run ? `CI #${run.runNumber}` : `CI ${runId}`;
    for (const failedJob of failed) {
      const jobId = failedJob.job?.jobId ?? failedJob.id;
      const loadedLog = logsByKey[getCiJobLogKey(context, jobId)]?.result;
      const logExcerpt = loadedLog?.available && loadedLog.content.trim().length > 0 ? loadedLog.content : undefined;
      useInlineCommentDraftStore.getState().addDraft({ directory: targetDirectory, sessionKey }, {
        source: 'pr-check',
        provider: context.provider,
        fileLabel: `${runLabel} · ${failedJob.name}`,
        startLine: 0,
        endLine: 0,
        code: buildFailedCiDraftText(run ?? null, failedJob, logExcerpt),
        language: 'text',
        text: '',
      });
    }
  };

  if (!run && (entry.status === 'loading' || entry.status === 'idle')) {
    return (
      <div role="status" className="flex flex-1 items-center justify-center py-12">
        <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!run && entry.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p role="alert" className="typography-meta text-[var(--status-error-text)]">
          {t('ciRuns.loadFailed', { error: entry.error ?? '' })}
        </p>
        <Button size="sm" variant="outline" onClick={() => void useCiRunsStore.getState().ensureDetail(sourceControl, context, runId, true)}>
          {t('settings.sourceControl.transport.retry')}
        </Button>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="typography-meta text-muted-foreground">{t('ciRuns.detail.notFound')}</p>
      </div>
    );
  }

  const look = ciRunLookOf(run.status, run.conclusion);
  const summary = ci?.summary ?? run.jobSummary ?? null;
  const completedJobs = summary ? summary.success + summary.failure : 0;
  const durationLabel = isActiveCiRunStatus(run.status)
    ? formatElapsedDuration(run.startedAt, undefined, now)
    : formatElapsedDuration(run.startedAt, run.completedAt);
  const relativeStarted = relativeTimeOf(run.startedAt ?? run.createdAt ?? null, now);
  const commitUrl = `https://${context.instance}/${run.project.owner}/${run.project.name}/commit/${run.headSha}`;
  const hasFailedJobs = jobs.some((job) => isFailedConclusion(job.conclusion));

  return (
    <ScrollableOverlay
      ref={scrollRef}
      outerClassName="min-h-0 flex-1"
      className="px-4 py-4"
      disableHorizontal
      useScrollShadow
    >
      <article className="flex flex-col gap-4">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatePill icon={look.icon} color={look.color} label={t(look.labelKey)} />
            <span dir="auto" className="oc-ui-start-align typography-meta font-medium text-muted-foreground">
              {run.workflowName} · <span dir="ltr">#{run.runNumber}</span>
            </span>
            {run.runAttempt > 1 ? (
              <span className={cn('typography-micro', REFERENCE_META_TEXT)}>
                {t('ciRuns.row.attempt', { attempt: run.runAttempt })}
              </span>
            ) : null}
            <div className="ms-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={manualRefreshing || entry.refreshing}
                onClick={() => void refreshFromHost()}
                aria-label={t('gitView.pr.actions.refresh')}
                title={t('gitView.pr.actions.refresh')}
              >
                <Icon name="refresh" className={cn('size-4', (manualRefreshing || entry.refreshing) && 'animate-spin')} />
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <a href={run.url} target="_blank" rel="noopener noreferrer" aria-label={t('gitView.pr.checks.openRun')} title={t('gitView.pr.checks.openRun')}>
                  <Icon name="external-link" className="size-4" />
                </a>
              </Button>
            </div>
          </div>

          <h3 dir="auto" className="oc-ui-start-align typography-ui-header font-semibold break-words text-foreground">
            {run.title}
          </h3>
          {run.commitMessage && run.commitMessage !== run.title ? (
            <p dir="auto" className="oc-ui-start-align typography-meta break-words text-muted-foreground">
              {run.commitMessage}
            </p>
          ) : null}
        </header>

        {entry.error ? (
          <p role="alert" className="rounded-md bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error-text)]">
            {t('ciRuns.loadFailed', { error: entry.error })}
          </p>
        ) : null}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
          {run.headBranch ? (
            <>
              <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{t('ciRuns.detail.branch')}</dt>
              <dd className="min-w-0 typography-meta text-muted-foreground">
                <span className="inline-flex max-w-full items-center gap-1">
                  <Icon name="git-branch" className="size-3.5 shrink-0" />
                  <span dir="ltr" className="truncate font-mono text-foreground">{run.headBranch}</span>
                </span>
              </dd>
            </>
          ) : null}

          <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{t('ciRuns.detail.commit')}</dt>
          <dd className="min-w-0 typography-meta text-muted-foreground">
            <a
              href={commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              dir="ltr"
              className="inline-flex items-center gap-1 font-mono text-foreground hover:underline"
            >
              <Icon name="git-commit" className="size-3.5 shrink-0 text-muted-foreground" />
              {run.headSha.slice(0, 7)}
            </a>
          </dd>

          <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{t('ciRuns.detail.trigger')}</dt>
          <dd className="min-w-0 typography-meta text-muted-foreground">
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span dir="ltr" className="font-mono">{run.event}</span>
              {run.actor ? <span>· <span dir="ltr">@{run.actor.username}</span></span> : null}
              {relativeStarted ? (
                <span>
                  · {relativeStarted.key === 'common.relative.justNow'
                    ? t(relativeStarted.key)
                    : t(relativeStarted.key, { count: relativeStarted.count })}
                </span>
              ) : null}
            </span>
          </dd>

          {run.pullRequests.length > 0 ? (
            <>
              <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{t('ciRuns.detail.pullRequest')}</dt>
              <dd className="min-w-0 typography-meta text-muted-foreground">
                <span className="flex flex-wrap items-center gap-1.5">
                  {run.pullRequests.map((pr) => (
                    <Button
                      key={pr.number}
                      variant="ghost"
                      size="xs"
                      className="-ms-1.5 px-1.5 font-mono text-foreground"
                      onClick={() => {
                        usePullRequestSelectionStore.getState().requestOpen({
                          workspaceDirectory,
                          sourceDirectory: context.directory,
                          url: pr.url,
                          failureBehavior: 'manual',
                        });
                      }}
                    >
                      <Icon name="git-pull-request" className="size-3.5 text-muted-foreground" />
                      #{pr.number}
                    </Button>
                  ))}
                </span>
              </dd>
            </>
          ) : null}

          {durationLabel ? (
            <>
              <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{t('ciRuns.detail.duration')}</dt>
              <dd className="min-w-0 typography-meta tabular-nums text-muted-foreground">
                <span dir="ltr">{durationLabel}</span>
              </dd>
            </>
          ) : null}

          {summary && summary.total > 0 ? (
            <>
              <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{t('references.picker.preview.checks')}</dt>
              <dd className="min-w-0 typography-meta text-muted-foreground">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <ChecksSummaryLine checks={summary} />
                  </span>
                  <span className="tabular-nums">
                    · {t('ciRuns.row.jobsProgress', { completed: completedJobs, total: summary.total })}
                  </span>
                </span>
              </dd>
            </>
          ) : null}
        </dl>

        <section className="flex flex-col gap-2.5 border-t border-border/60 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="typography-ui-label font-semibold text-foreground">
              {t('ciRuns.detail.jobs')}
              {jobs.length > 0 ? (
                <span className={cn('ms-1.5 typography-meta font-normal tabular-nums', REFERENCE_META_TEXT)}>
                  {jobs.length}
                </span>
              ) : null}
            </h4>
            {hasFailedJobs ? (
              <Button variant="outline" size="xs" className="ms-auto" onClick={attachFailedJobs}>
                <Icon name="attachment-2" className="size-3.5" />
                {t('gitView.pr.actions.resolveFailedChecks')}
              </Button>
            ) : null}
          </div>

          {jobs.length > 0 ? (
            <CheckRunList
              runs={jobs}
              now={now}
              expansion={expansion}
              formatTimestamp={formatTimestamp}
              jobLogController={jobLogController}
              omitWorkflowPrefix
            />
          ) : entry.status === 'loading' || entry.status === 'idle' ? (
            <div role="status" className="flex justify-center py-6">
              <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <p className="py-4 text-center typography-meta text-muted-foreground">{t('ciRuns.detail.noJobs')}</p>
          )}
        </section>
      </article>
    </ScrollableOverlay>
  );
};
