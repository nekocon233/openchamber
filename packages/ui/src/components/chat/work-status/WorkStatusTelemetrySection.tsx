import React from 'react';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  buildSessionMessageRecordsSnapshot,
  useDirectoryStore,
  useDirectorySync,
  useSessionMessageLoadState,
  useSessionMessageRecords,
  useSessionSelector,
  useSyncDirectory,
  useSyncRuntime,
} from '@/sync/sync-context';
import { normalizePath } from '@/lib/pathNormalization';
import { useUIStore } from '@/stores/useUIStore';
import {
  WorkStatusCollapsibleSection,
  WorkStatusRow,
  WorkStatusValue,
} from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import {
  formatTelemetryDuration,
  formatTelemetryTokens,
  formatThroughputRate,
  getCompletedTurnTelemetry,
  type CompletedTurnTelemetry,
} from './telemetry';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

/** One hover/focus target covers both the label and its value. */
const TelemetryRow: React.FC<{ label: string; description: string; value: React.ReactNode }> = ({ label, description, value }) => (
  <Tooltip delayDuration={750}>
    <TooltipTrigger asChild>
      <div tabIndex={0} className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <WorkStatusRow label={label} value={value} />
      </div>
    </TooltipTrigger>
    <TooltipContent side="left" sideOffset={8} className="max-w-[min(320px,calc(100vw-24px))] whitespace-normal break-words text-start">
      <p className="font-medium">{label}</p>
      <p>{description}</p>
    </TooltipContent>
  </Tooltip>
);

export const WorkStatusTelemetrySection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const expanded = useUIStore(
    React.useCallback((state) => state.workStatusExpandedSections['telemetry'] ?? true, []),
  );
  const { runtimeKey } = useSyncRuntime();
  const syncDirectory = useSyncDirectory();
  const effectiveDirectory = directory ?? syncDirectory;
  const store = useDirectoryStore(effectiveDirectory);
  const scope = JSON.stringify([runtimeKey, normalizePath(effectiveDirectory), sessionId]);
  const status = useDirectorySync(
    React.useCallback((state) => sessionId
      ? state.session_status[sessionId]?.type ?? (state.sessionStatusReady && !state.sessionStatusInvalidated?.[sessionId] ? 'idle' : 'unknown')
      : 'unknown', [sessionId]),
    directory ?? undefined,
  );
  const hasRecords = useDirectorySync(
    React.useCallback((state) => Boolean(sessionId && state.message[sessionId]?.length), [sessionId]),
    effectiveDirectory,
  );
  const revertMessageID = useSessionSelector(
    sessionId,
    effectiveDirectory,
    React.useCallback((session) => session?.revert?.messageID, []),
  );
  const loadState = useSessionMessageLoadState(sessionId ?? '', effectiveDirectory);
  // A provider can keep its directory stores while its runtime changes. After
  // a switch, only the new runtime's loader can authorize reading that history.
  const historyRuntime = React.useRef({ key: runtimeKey, switched: false });
  if (historyRuntime.current.key !== runtimeKey) historyRuntime.current = { key: runtimeKey, switched: true };
  const historyReady = !historyRuntime.current.switched || loadState.resolved;
  const turnInProgress = status === 'busy' || status === 'retry';
  const eligibleForStats = Boolean(sessionId && expanded && historyReady && status === 'idle');

  const records = useSessionMessageRecords(
    sessionId ?? '',
    directory ?? undefined,
    { enabled: eligibleForStats },
  );

  const computed = React.useMemo(() => {
    if (!eligibleForStats) return null;
    return getCompletedTurnTelemetry(records, false);
  }, [eligibleForStats, records]);

  // Retain only one committed result, never message history or a global ID cache.
  const [retained, setRetained] = React.useState<{
    scope: string;
    revertMessageID: string | undefined;
    computed: CompletedTurnTelemetry;
  } | null>(null);
  const retainedForScope = hasRecords && retained?.scope === scope && retained.revertMessageID === revertMessageID
    ? retained.computed
    : null;
  const runningSnapshot = React.useMemo(() => {
    if (!sessionId || !expanded || !turnInProgress || !hasRecords || !historyReady) return null;
    if (retained?.scope === scope && retained.revertMessageID === revertMessageID) return retained.computed;
    if (loadState.status === 'loading' && !loadState.resolved) return null;
    // Sample once on opening or history publication, without a live records
    // subscription. A delayed initial history load can then supply the last turn.
    const snapshot = buildSessionMessageRecordsSnapshot(store.getState(), sessionId);
    return getCompletedTurnTelemetry(snapshot.list, true);
  }, [scope, sessionId, expanded, turnInProgress, hasRecords, historyReady, retained, store, loadState, revertMessageID]);
  const current = status === 'unknown' ? null : expanded ? computed ?? runningSnapshot : retainedForScope;
  React.useEffect(() => {
    if (expanded || !current) {
      setRetained(current ? { scope, revertMessageID, computed: current } : null);
    }
  }, [scope, revertMessageID, expanded, current]);
  const stats = current?.stats ?? null;
  const averages = current?.averages ?? null;
  const summaryRate = stats
    ? stats.responseTokensPerSecond ?? averages?.tokensPerSecond ?? null
    : null;
  const summary = summaryRate !== null ? formatThroughputRate(summaryRate) : undefined;

  useReportWorkStatusPresence('telemetry', Boolean(sessionId));

  if (!sessionId) return null;

  return (
    <WorkStatusCollapsibleSection
      id="telemetry"
      title={t('chat.workStatus.section.telemetry')}
      icon="bar-chart-2"
      summary={summary}
      defaultExpanded
    >
      {stats ? (
        <>
          {stats.responseTokensPerSecond !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.responseSpeed')}
              description={t('chat.workStatus.telemetry.responseSpeedDescription')}
              value={<WorkStatusValue>{formatThroughputRate(stats.responseTokensPerSecond)}</WorkStatusValue>}
            />
          ) : null}
          {averages && averages.tokensPerSecond !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.speed')}
              description={t('chat.workStatus.telemetry.speedDescription')}
              value={<WorkStatusValue>{formatThroughputRate(averages.tokensPerSecond)}</WorkStatusValue>}
            />
          ) : null}
          {stats.elapsedDurationMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.elapsed')}
              description={t('chat.workStatus.telemetry.elapsedDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.elapsedDurationMs)}</WorkStatusValue>}
            />
          ) : null}

          {stats.totalLlmDurationMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.llmDuration')}
              description={t('chat.workStatus.telemetry.llmDurationDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.totalLlmDurationMs)}</WorkStatusValue>}
            />
          ) : null}

          {stats.totalToolDurationMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.toolDuration')}
              description={t('chat.workStatus.telemetry.toolDurationDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.totalToolDurationMs)}</WorkStatusValue>}
            />
          ) : null}

          {stats.avgTtftMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.ttft')}
              description={t('chat.workStatus.telemetry.ttftDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.avgTtftMs)}</WorkStatusValue>}
            />
          ) : null}

          {stats.stepsCount > 1 ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.steps')}
              description={t('chat.workStatus.telemetry.stepsDescription')}
              value={<WorkStatusValue>{stats.stepsCount}</WorkStatusValue>}
            />
          ) : null}

          {stats.inputTokens !== null && stats.outputTokens !== null && stats.reasoningTokens !== null && stats.totalGeneratedTokens !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.tokens')}
              description={t('chat.workStatus.telemetry.tokensDescription', {
                input: stats.inputTokens.toLocaleString(getCurrentIntlLocale()),
                output: stats.outputTokens.toLocaleString(getCurrentIntlLocale()),
                reasoning: stats.reasoningTokens.toLocaleString(getCurrentIntlLocale()),
              })}
              value={(
                <WorkStatusValue>
                  {t('chat.workStatus.telemetry.tokens.inOut', {
                    input: formatTelemetryTokens(stats.inputTokens),
                    output: formatTelemetryTokens(stats.totalGeneratedTokens),
                  })}
                </WorkStatusValue>
              )}
            />
          ) : null}

          {averages && averages.cacheHitPercent !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.cacheHit')}
              description={t('chat.workStatus.telemetry.cacheHitDescription')}
              value={(
                <WorkStatusValue tone={averages.cacheHitPercent >= 50 ? 'success' : 'default'}>
                  {`${averages.cacheHitPercent}%`}
                </WorkStatusValue>
              )}
            />
          ) : null}

          {stats.cost !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.cost')}
              description={t('chat.workStatus.telemetry.costDescription')}
              value={<WorkStatusValue tone="muted">{`$${stats.cost.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`}</WorkStatusValue>}
            />
          ) : null}
        </>
      ) : turnInProgress ? (
        <WorkStatusRow muted label={t('chat.workStatus.telemetry.inProgress')} />
      ) : null}
    </WorkStatusCollapsibleSection>
  );
};
