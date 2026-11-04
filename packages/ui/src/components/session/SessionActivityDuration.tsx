import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useSessionActivityStartedAt } from '@/sync/session-activity-timing';
import { useSessionFinishedTurnDurationMs } from '@/sync/session-turn-duration';
import { formatSessionActivityDuration } from './sessionActivityDurationFormat';

/** Activity duration updates once per second. */
const _TICK_MS = 1000;

/**
 * Elapsed time of a session's current turn, or of the turn that just finished.
 * Colored for the current running or unread state.
 *
 * Deliberately a leaf so the tick re-renders this span alone rather than the
 * session row around it.
 */
export const SessionActivityDuration: React.FC<{
  sessionId: string;
  /** Turn still running (`busy` or `retry`); false renders the settled total. */
  running: boolean;
  className?: string;
}> = ({ sessionId, running, className }) => {
  const { t } = useI18n();
  const startedAt = useSessionActivityStartedAt(sessionId);
  const settledMs = useSessionFinishedTurnDurationMs(sessionId);
  const now = useDurationTickerNow(running);

  // A running turn with no known start shows nothing rather than a guess.
  const durationMs = running ? (startedAt === undefined ? undefined : Math.max(0, now - startedAt)) : settledMs;
  if (durationMs === undefined) return null;

  const label = formatSessionActivityDuration(durationMs, t);
  const description = running
    ? t('sessions.sidebar.session.status.activeFor', { duration: label })
    : t('sessions.sidebar.session.status.lastTurnDuration', { duration: label });

  return (
    <span
      className={cn(
        'shrink-0 tabular-nums',
        // The readout wears its dot's color, so the row reads as one signal:
        // primary while the turn runs, info once it is waiting to be read.
        running ? 'text-[var(--status-info)]' : 'text-[var(--status-success)]',
        className,
      )}
      aria-label={description}
      title={description}
    >
      {label}
    </span>
  );
};
