import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import type { CIRun } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';

import { formatElapsedDuration, isFailedConclusion, type CheckRunExpansion } from './checkRunState';
import type { CiJobLogEntry } from './ciRunsStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

export interface CheckRunJobLogController {
  getLog: (jobId: string) => CiJobLogEntry;
  loadLog: (jobId: string, force?: boolean) => void;
  openLogs: ReadonlySet<string>;
  toggleLog: (jobId: string) => void;
}

const StepStatusGlyph: React.FC<{ status?: string; conclusion?: string | null }> = ({ status, conclusion }) => {
  if (status === 'in_progress') {
    return <Spinner className="size-3.5 shrink-0 text-[var(--status-warning)]" />;
  }
  if (status && status !== 'completed') {
    return <Icon name="time" className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (isFailedConclusion(conclusion)) {
    return <Icon name="close-circle" className="size-3.5 shrink-0 text-[var(--status-error)]" />;
  }
  if (conclusion === 'skipped' || conclusion === 'neutral') {
    return <Icon name="subtract" className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (conclusion === 'success') {
    return <Icon name="checkbox-circle" className="size-3.5 shrink-0 text-[var(--status-success)]" />;
  }
  return <Icon name="time" className="size-3.5 shrink-0 text-muted-foreground" />;
};

const JobLogPanel: React.FC<{
  jobId: string;
  controller: CheckRunJobLogController;
}> = ({ jobId, controller }) => {
  const { t } = useI18n();
  const entry = controller.getLog(jobId);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (entry.status === 'idle') {
      controller.loadLog(jobId, false);
    }
  }, [controller, entry.status, jobId]);

  const copyContent = () => {
    const content = entry.result?.content ?? '';
    if (!content) return;
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => undefined);
  };

  return (
    <div className="space-y-1.5 rounded oc-tile-inset p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {entry.status === 'ready' && entry.result?.truncated ? (
          <span className="typography-micro text-muted-foreground">{t('ciRuns.log.truncated')}</span>
        ) : null}
        <div className="ms-auto flex items-center gap-1">
          {entry.status === 'ready' && entry.result?.available && entry.result.content.length > 0 ? (
            <Button variant="ghost" size="xs" onClick={copyContent}>
              <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
              {t(copied ? 'ciRuns.log.copied' : 'ciRuns.log.copy')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            disabled={entry.status === 'loading'}
            onClick={() => controller.loadLog(jobId, true)}
            aria-label={t('ciRuns.log.refresh')}
            title={t('ciRuns.log.refresh')}
          >
            <Icon name="refresh" className={cn('size-3.5', entry.status === 'loading' && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {entry.status === 'loading' || entry.status === 'idle' ? (
        <div role="status" className="flex justify-center py-4">
          <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : entry.status === 'error' ? (
        <p role="alert" className="typography-micro text-[var(--status-error-text)]">
          {t('ciRuns.log.loadFailed', { error: entry.error ?? '' })}
        </p>
      ) : !entry.result?.available ? (
        <p className="typography-micro text-muted-foreground">{t('ciRuns.log.unavailable')}</p>
      ) : entry.result.content.trim().length === 0 ? (
        <p className="typography-micro text-muted-foreground">{t('ciRuns.log.empty')}</p>
      ) : (
        <ScrollableOverlay outerClassName="max-h-72" disableHorizontal>
          <pre dir="ltr" className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
            {entry.result.content}
          </pre>
        </ScrollableOverlay>
      )}
    </div>
  );
};

const CheckRunDetails: React.FC<{
  run: CIRun;
  now: number;
  expansion: CheckRunExpansion;
  formatTimestamp: (value?: string) => string;
  jobLogController?: CheckRunJobLogController;
}> = ({ run, now, expansion, formatTimestamp, jobLogController }) => {
  const { t } = useI18n();
  const annotations = run.annotations ?? [];
  const jobId = run.job?.jobId ?? (jobLogController ? run.id : undefined);
  const canViewLog = Boolean(jobLogController && jobId && run.status === 'completed');
  const logOpen = Boolean(canViewLog && jobId && jobLogController?.openLogs.has(jobId));
  return (
    <div className="space-y-2">
      {canViewLog || run.detailsUrl ? (
        <div className="flex flex-wrap items-start justify-end gap-2">
          {canViewLog && jobId && jobLogController ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-shrink-0"
              onClick={() => jobLogController.toggleLog(jobId)}
            >
              <Icon name="terminal-box" className="size-4" />
              {t(logOpen ? 'ciRuns.log.hide' : 'ciRuns.log.view')}
            </Button>
          ) : null}
          {run.detailsUrl ? (
            <Button variant="outline" size="sm" asChild className="flex-shrink-0">
              <a href={run.detailsUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="external-link" className="size-4" />
                {t('gitView.pr.checks.openRun')}
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}

      {logOpen && jobId && jobLogController ? (
        <JobLogPanel jobId={jobId} controller={jobLogController} />
      ) : null}

      {run.output?.title ? (
        <div className="typography-micro text-foreground">{run.output.title}</div>
      ) : null}
      {run.output?.summary ? (
        <div className="typography-micro text-muted-foreground whitespace-pre-wrap break-words">
          {run.output.summary}
        </div>
      ) : null}
      {run.output?.text ? (
        <ScrollableOverlay outerClassName="max-h-48 rounded oc-tile-inset" className="px-2 py-2 typography-micro text-muted-foreground whitespace-pre-wrap break-words" disableHorizontal>
          {run.output.text}
        </ScrollableOverlay>
      ) : null}

      {annotations.length > 0 ? (
        <div className="space-y-1">
          <div className="typography-micro text-muted-foreground">
            {annotations.length > 20
              ? t('gitView.pr.checks.failedAnnotationsShown', { shown: 20, total: annotations.length })
              : t('gitView.pr.checks.failedAnnotations')}
          </div>
          <div className="space-y-1">
            {annotations.slice(0, 20).map((annotation, idx) => (
              <div key={`${annotation.path || 'file'}:${annotation.startLine || idx}:${idx}`} className="rounded bg-[var(--status-error-background)]/60 px-2 py-2">
                <div className="typography-micro break-words text-[var(--status-error)]">
                  {annotation.title || annotation.level || 'Issue'}
                  {annotation.path ? ` · ${annotation.path}` : ''}
                  {annotation.startLine !== undefined ? `:${annotation.startLine}` : ''}
                  {annotation.endLine !== undefined && annotation.endLine !== annotation.startLine ? `-${annotation.endLine}` : ''}
                </div>
                <div className="typography-micro text-foreground whitespace-pre-wrap break-words mt-1">
                  {annotation.message}
                </div>
                {annotation.rawDetails ? (
                  <div className="typography-micro text-muted-foreground whitespace-pre-wrap break-words mt-1">
                    {annotation.rawDetails}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {run.job?.steps && run.job.steps.length > 0 ? (
        <div className="space-y-1">
          <div className="typography-micro text-muted-foreground">{t('gitView.pr.checks.steps')}</div>
          <div className="space-y-1">
            {run.job.steps.map((step, idx) => {
              const stepKey = `${run.id ?? 'run'}:${run.job?.jobId ?? 'job'}:${step.number ?? idx}:${step.name}`;
              if (!isFailedConclusion(step.conclusion)) {
                const stepDuration = step.status === 'in_progress'
                  ? formatElapsedDuration(step.startedAt, undefined, now)
                  : formatElapsedDuration(step.startedAt, step.completedAt);
                return (
                  <div key={stepKey} className="typography-micro flex w-full items-center gap-2 rounded px-2 py-1 text-muted-foreground">
                    <StepStatusGlyph status={step.status} conclusion={step.conclusion} />
                    <span className="min-w-0 flex-1 truncate">{step.name}</span>
                    {stepDuration ? <span dir="ltr" className="shrink-0 tabular-nums">{stepDuration}</span> : null}
                    {step.conclusion ? <span className="flex-shrink-0">{step.conclusion}</span> : null}
                  </div>
                );
              }
              const stepExpanded = expansion.steps.has(stepKey);
              return (
                <Collapsible key={stepKey} open={stepExpanded}>
                  <button
                    type="button"
                    onClick={() => expansion.toggleStep(stepKey)}
                    className="typography-micro flex w-full items-center gap-2 rounded bg-destructive/10 px-2 py-1 text-start text-destructive"
                  >
                    {stepExpanded ? <Icon name="arrow-down-s" className="size-4" /> : <Icon name="arrow-right-s" className="size-4" />}
                    <span className="truncate">{step.name}</span>
                    {step.conclusion ? <span className="ms-auto flex-shrink-0">{step.conclusion}</span> : null}
                  </button>
                  <CollapsibleContent>
                    <div className="ms-6 mt-1 rounded oc-tile-inset px-2 py-2 typography-micro text-muted-foreground space-y-1">
                      {step.number !== undefined ? <div>{t('gitView.pr.checks.stepLabel')}: {step.number}</div> : null}
                      {step.status ? <div>{t('gitView.pr.checks.statusLabel')}: {step.status}</div> : null}
                      {step.conclusion ? <div>{t('gitView.pr.checks.conclusionLabel')}: {step.conclusion}</div> : null}
                      {step.startedAt ? <div>{t('gitView.pr.checks.startedLabel')}: {formatTimestamp(step.startedAt)}</div> : null}
                      {step.completedAt ? <div>{t('gitView.pr.checks.completedLabel')}: {formatTimestamp(step.completedAt)}</div> : null}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
};

/**
 * A change request's or workflow run's check jobs, each opening to its output,
 * failed annotations, steps and optional job log.
 */
export const CheckRunList: React.FC<{
  runs: CIRun[];
  /** The clock running checks count their time against. */
  now: number;
  expansion: CheckRunExpansion;
  formatTimestamp: (value?: string) => string;
  jobLogController?: CheckRunJobLogController;
  /** Hide the workflow prefix when the enclosing page already names the workflow. */
  omitWorkflowPrefix?: boolean;
}> = ({ runs, now, expansion, formatTimestamp, jobLogController, omitWorkflowPrefix = false }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      {runs.map((run, idx) => {
        const runKey = `${run.id ?? 'run'}:${run.name}:${idx}`;
        const isRunning = run.status === 'in_progress';
        const failed = isFailedConclusion(run.conclusion);
        const isSkipped = run.conclusion === 'skipped' || run.conclusion === 'neutral';
        const isSuccess = run.conclusion === 'success';
        const isQueued = !isRunning && !failed && !isSkipped && !isSuccess;
        const expanded = expansion.runs.has(runKey);
        const steps = run.job?.steps ?? [];
        const completedSteps = steps.filter((step) => step.status === 'completed').length;
        const canViewLog = Boolean(jobLogController && run.status === 'completed');
        const hasDetails = Boolean(
          run.output?.title || run.output?.summary || run.output?.text
          || (run.annotations?.length ?? 0) > 0
          || steps.length > 0
          || run.detailsUrl
          || canViewLog,
        );
        const workflowName = omitWorkflowPrefix ? undefined : run.job?.workflowName;
        const durationLabel = isRunning
          ? formatElapsedDuration(run.startedAt, undefined, now)
          : formatElapsedDuration(run.startedAt, run.completedAt);
        return (
          <div key={runKey} className={cn('rounded-md', failed ? 'bg-[var(--status-error-background)]/60' : 'oc-tile')}>
            <button
              type="button"
              disabled={!hasDetails}
              onClick={() => expansion.toggleRun(runKey)}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-start disabled:cursor-default"
            >
              {isRunning ? (
                <Spinner className="size-4 shrink-0 text-[var(--status-warning)]" />
              ) : isQueued ? (
                <Icon name="time" className="size-4 shrink-0 text-muted-foreground" />
              ) : failed ? (
                <Icon name="close-circle" className="size-4 shrink-0 text-[var(--status-error)]" />
              ) : isSkipped ? (
                <Icon name="subtract" className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Icon name="checkbox-circle" className="size-4 shrink-0 text-[var(--status-success)]" />
              )}
              <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label text-foreground">
                {workflowName && workflowName !== run.name ? `${workflowName} / ${run.name}` : run.name}
              </span>
              {isRunning && steps.length > 0 ? (
                <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
                  {t('ciRuns.detail.stepsProgress', { completed: completedSteps, total: steps.length })}
                </span>
              ) : null}
              {durationLabel ? (
                <span dir="ltr" className="shrink-0 typography-micro tabular-nums text-muted-foreground">{durationLabel}</span>
              ) : null}
              {hasDetails ? (
                <Icon name="arrow-down-s" className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
              ) : null}
            </button>
            {expanded && hasDetails ? (
              <div className="min-w-0 overflow-hidden border-t border-edge-muted p-2.5">
                <CheckRunDetails run={run} now={now} expansion={expansion} formatTimestamp={formatTimestamp} jobLogController={jobLogController} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
