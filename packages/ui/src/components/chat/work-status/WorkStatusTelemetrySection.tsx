import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  buildSessionMessageRecordsSnapshot,
  useDirectoryStore,
  useDirectorySync,
  useSessionMessageLoadState,
  useSessionMessageRecords,
  useSessionMessagesSelector,
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

const formatCost = (cost: number): string => `$${cost.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;

// Text deltas can arrive after idle. Timing changes and tool transitions still
// matter to the heading, even when the metric rows are collapsed.
const sameTelemetryParts = (before: readonly Part[], after: readonly Part[]): boolean =>
  before.length === after.length && before.every((part, index) => {
    const next = after[index];
    if (part === next) return true;
    if ((part.type !== 'text' && part.type !== 'reasoning') || next?.type !== part.type) return false;
    return part.id === next.id && part.time?.start === next.time?.start && part.time?.end === next.time?.end
      && Boolean(part.text) === Boolean(next.text)
      && (part.type !== 'text' || (next.type === 'text' && part.metadata?.nativeSubagentMessage === next.metadata?.nativeSubagentMessage));
  });

const lastUserId = (messages: readonly Message[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user') return message.id;
  }
  return undefined;
};

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
    React.useCallback((state) => state.workStatusExpandedSections['telemetry'] ?? false, []),
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
  const eligibleForStats = Boolean(sessionId && historyReady && status === 'idle');

  const records = useSessionMessageRecords(
    sessionId ?? '',
    directory ?? undefined,
    { enabled: eligibleForStats, ignorePartChanges: expanded ? undefined : sameTelemetryParts },
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
  const retainedForScope = historyReady && hasRecords && retained?.scope === scope && retained.revertMessageID === revertMessageID
    ? retained.computed : null;
  const sampleRunning = turnInProgress && historyReady && hasRecords && !retainedForScope;
  // Busy may arrive before the new user message. A cold panel resamples when
  // that boundary arrives, without following the running assistant's deltas.
  const runningUserId = useSessionMessagesSelector(
    sampleRunning ? sessionId ?? '' : '', effectiveDirectory,
    lastUserId,
  );
  const runningSnapshot = React.useMemo(() => {
    if (!sampleRunning || !runningUserId || !sessionId || (loadState.status === 'loading' && !loadState.resolved)) return null;
    const snapshot = buildSessionMessageRecordsSnapshot(store.getState(), sessionId);
    return snapshot.revertMessageID === revertMessageID ? getCompletedTurnTelemetry(snapshot.list, true) : null;
  }, [sampleRunning, runningUserId, sessionId, store, loadState, revertMessageID]);
  const current = turnInProgress ? retainedForScope ?? runningSnapshot : computed;
  React.useEffect(() => {
    if (computed && computed !== retainedForScope) {
      setRetained({ scope, revertMessageID, computed });
    } else if (!computed && (!turnInProgress || !retainedForScope)) {
      setRetained(null);
    }
  }, [scope, revertMessageID, turnInProgress, retainedForScope, computed]);
  const stats = current?.stats ?? null;
  const summaryRate = stats?.tokensPerSecond ?? null;
  const summary = summaryRate !== null ? formatThroughputRate(summaryRate) : undefined;

  useReportWorkStatusPresence('telemetry', Boolean(sessionId));

  if (!sessionId) return null;

  return (
    <WorkStatusCollapsibleSection
      id="telemetry"
      title={t('chat.workStatus.section.telemetry')}
      icon="bar-chart-2"
      summary={summary}
    >
      {stats ? (
        <>
          {stats.tokensPerSecond !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.speed')}
              description={t('chat.workStatus.telemetry.speedDescription')}
              value={<WorkStatusValue>{formatThroughputRate(stats.tokensPerSecond)}</WorkStatusValue>}
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

          {stats.avgFirstOutputMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.firstOutput')}
              description={t('chat.workStatus.telemetry.firstOutputDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.avgFirstOutputMs)}</WorkStatusValue>}
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

          {stats.cacheHitPercent !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.cacheHit')}
              description={t('chat.workStatus.telemetry.cacheHitDescription')}
              value={(
                <WorkStatusValue tone={stats.cacheHitPercent >= 50 ? 'success' : 'default'}>
                  {`${stats.cacheHitPercent}%`}
                </WorkStatusValue>
              )}
            />
          ) : null}

          {stats.cost !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.cost')}
              description={t('chat.workStatus.telemetry.costDescription')}
              value={<WorkStatusValue tone="muted">{formatCost(stats.cost)}</WorkStatusValue>}
            />
          ) : null}
        </>
      ) : turnInProgress ? (
        <WorkStatusRow muted label={t('chat.workStatus.telemetry.inProgress')} />
      ) : null}
    </WorkStatusCollapsibleSection>
  );
};
