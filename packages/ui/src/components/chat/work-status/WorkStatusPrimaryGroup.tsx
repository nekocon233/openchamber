import { DiffCount } from '@/components/ui/diff-count';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { resolvePrRowTarget } from './prRowTarget';
import { WorkStatusWarmingToggle } from './WorkStatusWarmingToggle';
import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { useFreshestSourceControlVisualSummaryForBranch } from '@/stores/useGitHubPrStatusStore';
import { useSessionMessages } from '@/sync/sync-context';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSpaceProjectDirectory } from '@/lib/spaces/spaces-store';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveUsageTone } from '@/lib/quota';
import { sessionEvents } from '@/lib/sessionEvents';
import { normalizePath } from '@/lib/pathNormalization';
import { isNativeSessionId } from '@/lib/native-agents/ids';
import { computeContextUsage, computeLastReplyCacheHit } from './contextUsage';
import { formatCost } from './subagentCost';
import { useSubagentCostRollup } from './useSubagentCostRollup';
import {
  WorkStatusCallout,
  WorkStatusMeter,
  WorkStatusNote,
  WorkStatusPill,
  WorkStatusRow,
  WorkStatusSection,
  WorkStatusValue,
} from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { useWorkStatusNavigation } from './useWorkStatusNavigation';
import { WorkStatusPrPrewarm } from './useWorkStatusPrPrewarm';
import { PrChecksValue } from './PrChecksValue';
import { ciRunLookOf, useBranchLatestCiRun } from '@/components/views/git/ciRunsStore';
import { CiRunStatusGlyph } from '@/components/views/git/CiRunDetail';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';
import { isVSCodeRuntime } from '@/lib/desktop';

type Props = {
  sessionId: string | null;
  directory: string | null;
  goalRow: React.ReactNode;
  showSession: boolean;
  showRepository: boolean;
  /** The phone has no header tooltip for the context's token counts. */
  showContextTokens?: boolean;
  /** Mobile sheet only: warm the branch's change-request summary on open. */
  prewarmPrStatus?: boolean;
  /** Lets the panel place the two readouts independently without duplicating their subscriptions. */
  children: (sections: { session: React.ReactNode; repository: React.ReactNode }) => React.ReactNode;
};

const formatPercent = (percent: number): string => `${Math.min(percent, 999).toFixed(1)}%`;
const UNKNOWN_PERCENT = '\u2014';

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
};

/**
 * The persistent readouts — how full the context is, what the working tree and
 * the pull request look like. All of it stays true for as long as the session
 * is open, so it sits above anything episodic.
 */
export const WorkStatusPrimaryGroup: React.FC<Props> = ({ sessionId, directory, goalRow, showSession, showRepository, showContextTokens = false, prewarmPrStatus = false, children }) => {
  const { t } = useI18n();
  const projectActionsContext = useProjectActionsContext();
  const isVSCode = isVSCodeRuntime();
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const clearDiffCache = useGitStore((state) => state.clearDiffCache);

  const draftSpace = useDraftSpaceTarget();
  const repositoryDirectory = sessionId ? directory : panelContentDirectory(draftSpace, directory);
  const { gitDirectory } = useNestedGitDirectory(repositoryDirectory, { enabled: showRepository });

  const gitStatus = useGitStore(
    React.useCallback(
      (state) => (gitDirectory ? state.directories.get(gitDirectory)?.status ?? null : null),
      [gitDirectory],
    ),
  );

  const worktreeCreationPending = useWorktreeBootstrapPending(gitDirectory);
  const [postBootstrapRefreshDirectory, setPostBootstrapRefreshDirectory] = React.useState<string | null>(null);
  const awaitingPostBootstrapStatus = postBootstrapRefreshDirectory !== null
    && postBootstrapRefreshDirectory === gitDirectory;

  React.useEffect(() => {
    if (!showRepository || !gitDirectory || !git) return;
    if (worktreeCreationPending) {
      setPostBootstrapRefreshDirectory(gitDirectory);
      return;
    }
    if (awaitingPostBootstrapStatus) {
      let cancelled = false;
      void runBackgroundNetworkTask(() => fetchStatus(gitDirectory, git, {
        force: true,
        silent: true,
        throwOnError: true,
      }))
        .then(() => {
          if (!cancelled) {
            setPostBootstrapRefreshDirectory((current) => (current === gitDirectory ? null : current));
          }
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    void runBackgroundNetworkTask(() => ensureStatus(gitDirectory, git));
  }, [gitDirectory, git, ensureStatus, fetchStatus, showRepository, worktreeCreationPending, awaitingPostBootstrapStatus]);

  React.useEffect(() => {
    if (!showRepository || !gitDirectory || !git) return;
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(gitDirectory)) return;
      if (hint.paths?.length) {
        clearDiffCache(gitDirectory, hint.paths);
      }
      void fetchStatus(gitDirectory, git, { silent: true });
    });
  }, [clearDiffCache, gitDirectory, fetchStatus, git, showRepository]);

  const branch = gitStatus?.current?.trim() || null;

  const nestedRepoLabel = React.useMemo(() => {
    if (!directory || !gitDirectory || gitDirectory === directory) return null;
    const rootPrefix = `${directory}/`;
    return gitDirectory.startsWith(rootPrefix) ? gitDirectory.slice(rootPrefix.length) : gitDirectory;
  }, [directory, gitDirectory]);

  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const spaceProjectDirectory = useSpaceProjectDirectory(directory);
  const projectLabel = useProjectsStore(
    React.useCallback((state) => {
      const project = resolveProjectForSessionDirectory(
        state.projects,
        availableWorktreesByProject,
        directory,
        spaceProjectDirectory,
      );
      if (!project) return null;
      return project.label?.trim()
        || project.path.split('/').filter(Boolean).pop()
        || project.path;
    }, [availableWorktreesByProject, directory, spaceProjectDirectory]),
  );

  const prSummary = useFreshestSourceControlVisualSummaryForBranch(gitDirectory, branch);
  const prUrl = prSummary?.url ?? null;
  const prDescriptor = useSourceControlProvider(prSummary?.provider);
  const prTerm = prDescriptor.terminology.changeRequest;
  const branchCi = useBranchLatestCiRun(
    gitDirectory,
    branch,
    Boolean(showRepository && !isVSCode && gitDirectory && branch && !prSummary),
  );

  const sessionMessages = useSessionMessages(sessionId ?? '', directory ?? undefined);
  const { context: contextLimit } = useContextWindowLimits(sessionId, directory ?? undefined);

  const contextUsage = React.useMemo(
    () => computeContextUsage(sessionMessages, contextLimit),
    [sessionMessages, contextLimit],
  );
  const contextWindow = contextUsage?.limit ?? contextLimit;
  const hasContext = contextUsage !== null || (showContextTokens && sessionId !== null && contextWindow > 0);

  const nav = useWorkStatusNavigation(directory);
  const prTarget = resolvePrRowTarget({ directory, prUrl, mobile: nav.isMobileHost, vscode: isVSCode });
  const openBranchChangeRequest = prSummary && prTarget
    ? () => nav.openChangeRequest(prSummary)
    : undefined;
  const showProjectActions = !nav.isMobileHost && !isVSCode && Boolean(projectActionsContext);
  const lastReplyCacheHit = React.useMemo(() => computeLastReplyCacheHit(sessionMessages), [sessionMessages]);

  const changed = React.useMemo(() => {
    if (worktreeCreationPending || awaitingPostBootstrapStatus) return null;
    const files = gitStatus?.files ?? [];
    if (files.length === 0) return null;
    const stats = gitStatus?.diffStats;
    let additions = 0;
    let deletions = 0;
    if (stats) {
      for (const entry of [...Object.values(stats.staged ?? {}), ...Object.values(stats.working ?? {})]) {
        additions += entry?.insertions ?? 0;
        deletions += entry?.deletions ?? 0;
      }
    }
    return { files: files.length, additions, deletions, hasStats: Boolean(stats) };
  }, [gitStatus?.files, gitStatus?.diffStats, worktreeCreationPending, awaitingPostBootstrapStatus]);

  const attentionReason = gitStatus?.attentionReason
    ?? (gitStatus?.rebaseInProgress ? 'rebase' : null)
    ?? (gitStatus?.mergeInProgress ? 'merge' : null);
  const attentionLabel = attentionReason === 'merge' ? t('chat.workStatus.attention.merge')
    : attentionReason === 'rebase' ? t('chat.workStatus.attention.rebase')
      : attentionReason === 'cherry-pick' ? t('chat.workStatus.attention.cherryPick')
        : attentionReason === 'revert' ? t('chat.workStatus.attention.revert')
          : attentionReason === 'bisect' ? t('chat.workStatus.attention.bisect')
            : null;

  const usagePercent = contextUsage?.state === 'measured' ? contextUsage.percent : null;
  const usageTone = usagePercent === null ? null : resolveUsageTone(Math.round(usagePercent));
  const meterColor = usageTone === 'critical' ? 'var(--status-error)'
    : usageTone === 'warn' ? 'var(--status-warning)'
      : 'var(--muted-foreground)';

  const { totalCost, ownCost, subagentCost, subagentCount } = useSubagentCostRollup(sessionId);
  const cost = totalCost !== null && totalCost > 0 ? totalCost : null;
  const showCostBreakdown = cost !== null && subagentCount > 0 && subagentCost > 0;
  const hasSession = showSession && (hasContext || cost !== null || Boolean(goalRow));
  const hasRepository = showRepository && Boolean(branch || changed || prSummary || branchCi.run || attentionLabel || showProjectActions);

  useReportWorkStatusPresence('session-repository', hasSession || hasRepository);

  return children({
      session: hasSession ? (
        <WorkStatusSection title={t('chat.workStatus.section.session')} icon="chat-4">
          {hasContext ? (
            <>
              <WorkStatusRow
                icon="donut-chart"
                onClick={directory && !isVSCode ? nav.openContext : undefined}
                ariaLabel={t('chat.workStatus.action.openContext')}
                label={t('chat.workStatus.context.label')}
                value={(
                  <>
                    {sessionId && !isNativeSessionId(sessionId) && !isVSCode ? <WorkStatusWarmingToggle sessionId={sessionId} directory={directory} /> : null}
                    <WorkStatusValue>
                      {`${usagePercent !== null ? formatPercent(usagePercent) : UNKNOWN_PERCENT}${cost !== null ? ` · ${formatCost(cost)}` : ''}`}
                    </WorkStatusValue>
                  </>
                )}
              />
              {showContextTokens ? (
                <p
                  dir="auto"
                  className="mx-1 mb-1 typography-meta text-muted-foreground tabular-nums"
                  title={[
                    ...(contextUsage?.state === 'measured'
                      ? [t('contextUsage.tooltip.usedTokens', { tokens: contextUsage.totalTokens })]
                      : []),
                    ...((contextUsage?.window ?? contextLimit) > 0
                      ? [t('contextUsage.tooltip.contextLimit', { tokens: contextUsage?.window ?? contextLimit })] : []),
                    ...(contextUsage?.compactionThreshold !== undefined
                      ? [t('contextUsage.tooltip.compactionThreshold', { tokens: contextUsage.compactionThreshold })] : []),
                  ].join(' · ')}
                >
                  {contextUsage?.state === 'measured' ? formatTokens(contextUsage.totalTokens) : UNKNOWN_PERCENT}
                  {contextWindow > 0 ? ` / ${formatTokens(contextWindow)}` : ''}
                </p>
              ) : null}
              <WorkStatusMeter percent={usagePercent ?? 0} color={meterColor} />
              {contextUsage?.state === 'compacted' ? (
                <WorkStatusNote tooltip={t('contextUsage.compacted.description')}>{t('contextUsage.compacted.short')}</WorkStatusNote>
              ) : null}
              {showCostBreakdown ? (
                <p className="mx-1 mb-1 truncate text-[11px] leading-4 text-muted-foreground tabular-nums">
                  {t('chat.workStatus.cost.breakdown', {
                    session: formatCost(ownCost),
                    subagents: formatCost(subagentCost),
                  })}
                </p>
              ) : null}
            </>
          ) : null}
          {lastReplyCacheHit !== null ? (
            <WorkStatusRow
              icon="database-2"
              label={t('chat.workStatus.replyCacheHit')}
              value={<WorkStatusValue>{`${lastReplyCacheHit.toFixed(1)}%`}</WorkStatusValue>}
            />
          ) : null}
          {goalRow}
        </WorkStatusSection>
      ) : null,

      repository: hasRepository ? (
        <WorkStatusSection
          title={t('chat.workStatus.section.project')}
          icon="folder"
          subject={projectLabel}
          summary={showProjectActions && projectActionsContext?.directory
            ? <OpenInAppButton directory={projectActionsContext.directory} />
            : null}
        >
          {prewarmPrStatus && showRepository && gitDirectory && branch
            ? <WorkStatusPrPrewarm directory={gitDirectory} branch={branch} />
            : null}
          {attentionLabel ? <WorkStatusCallout>{attentionLabel}</WorkStatusCallout> : null}

          {branch ? (
            <WorkStatusRow
              icon="git-branch"
              onClick={directory && !isVSCode ? nav.openGit : undefined}
              ariaLabel={t('chat.workStatus.action.openGit')}
              label={branch}
              labelDir="ltr"
              value={(gitStatus?.ahead ?? 0) > 0 || (gitStatus?.behind ?? 0) > 0 ? (
                <>
                  {(gitStatus?.ahead ?? 0) > 0
                    ? <WorkStatusValue tone="muted">{`↑${gitStatus?.ahead}`}</WorkStatusValue> : null}
                  {(gitStatus?.behind ?? 0) > 0
                    ? <WorkStatusValue tone="muted">{`↓${gitStatus?.behind}`}</WorkStatusValue> : null}
                </>
              ) : undefined}
            />
          ) : null}

          {nestedRepoLabel ? (
            <WorkStatusRow
              icon="folder"
              onClick={directory && !isVSCode ? nav.openGit : undefined}
              ariaLabel={t('chat.workStatus.action.openGit')}
              label={nestedRepoLabel}
              labelDir="ltr"
              muted
            />
          ) : null}

          {changed ? (
            <WorkStatusRow
              icon="file-edit"
              onClick={directory && !isVSCode ? nav.openChanges : undefined}
              ariaLabel={t('chat.workStatus.action.openChanges')}
              label={changed.files === 1
                ? t('chat.workStatus.git.changedFileSingle', { count: changed.files })
                : t('chat.workStatus.git.changedFilePlural', { count: changed.files })}
              value={changed.hasStats && (changed.additions > 0 || changed.deletions > 0) ? (
                <DiffCount added={changed.additions} removed={changed.deletions} />
              ) : undefined}
            />
          ) : null}

          {prSummary ? (
            <>
              <WorkStatusRow
                icon="git-pull-request"
                onClick={openBranchChangeRequest}
                ariaLabel={t(changeRequestCopy('chat.workStatus.action.openPr', prTerm))}
                iconColor={`var(--pr-${prSummary.visualState})`}
                label={prSummary.title ?? t(changeRequestCopy('chat.workStatus.pr.untitled', prTerm))}
                labelDir={prSummary.title ? 'auto' : undefined}
                value={(
                  <WorkStatusPill
                    color={`var(--pr-${prSummary.visualState})`}
                    background={`color-mix(in srgb, var(--pr-${prSummary.visualState}) 18%, transparent)`}
                  >
                    {prSummary.draft ? t('chat.workStatus.pr.draft') : formatChangeRequestReference(prDescriptor, prSummary.number)}
                  </WorkStatusPill>
                )}
              />
              {prSummary.checks && prSummary.checks.total > 0 ? (
                <WorkStatusRow
                  icon="checkbox-circle"
                  onClick={openBranchChangeRequest}
                  ariaLabel={t(changeRequestCopy('chat.workStatus.action.openPr', prTerm))}
                  label={t('chat.workStatus.pr.checks')}
                  muted
                  value={(
                    <>
                      {prSummary.checks.failure > 0 ? (
                        <WorkStatusValue tone="error">
                          {t('chat.workStatus.pr.checksFailed', { count: prSummary.checks.failure })}
                        </WorkStatusValue>
                      ) : null}
                      {prSummary.checks.pending > 0 ? (
                        <WorkStatusValue tone="warning">
                          {t('chat.workStatus.pr.checksPending', { count: prSummary.checks.pending })}
                        </WorkStatusValue>
                      ) : null}
                      {prSummary.checks.failure === 0 && prSummary.checks.pending === 0 ? (
                        <WorkStatusValue tone="success">
                          {t('chat.workStatus.pr.checksPassed', { count: prSummary.checks.success })}
                        </WorkStatusValue>
                      ) : null}
                    </>
                  )}
                />
              ) : null}
            </>
          ) : branchCi.run ? (() => {
            const ciRun = branchCi.run;
            const ciLook = ciRunLookOf(ciRun.status, ciRun.conclusion);
            const valueTone = ciLook.kind === 'failed'
              ? 'error'
              : ciLook.kind === 'running' || ciLook.kind === 'queued'
                ? 'warning'
                : ciLook.kind === 'passed'
                  ? 'success'
                  : 'muted';
            return (
              <WorkStatusRow
                leading={<CiRunStatusGlyph status={ciRun.status} conclusion={ciRun.conclusion} />}
                onClick={directory ? () => nav.openCiRun(ciRun.id, gitDirectory ?? undefined) : undefined}
                ariaLabel={t('chat.workStatus.action.openCi')}
                label={`${ciRun.workflowName} #${ciRun.runNumber}`}
                value={ciRun.jobSummary && ciRun.jobSummary.total > 0 ? (
                  <PrChecksValue checks={ciRun.jobSummary} />
                ) : (
                  <WorkStatusValue tone={valueTone}>{t(ciLook.labelKey)}</WorkStatusValue>
                )}
              />
            );
          })() : null}

          {/* Last: the readouts above describe the project, this runs something in it. */}
          {showProjectActions ? <ProjectActionsButton /> : null}
        </WorkStatusSection>
      ) : null,
  });
};
