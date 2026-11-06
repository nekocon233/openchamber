import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ClockPausedContext } from '@/hooks/clockPausedContext';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { cn } from '@/lib/utils';

/**
 * What a session row or aggregate is showing: its own turn running
 * (busy/retry), a pause kept open by a background subagent, a background
 * command or a native CLI's background tasks, or a finished turn the user has
 * not seen. These are the kinds `useSessionTurnActivity` reports.
 */
type SessionActivityIndicatorState = 'running' | 'workflow' | 'subagent' | 'shell' | 'tasks' | 'pullRequest' | 'unread';

const PRESENTATION = {
  running: { icon: 'circle', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.active' },
  workflow: { icon: 'flow-chart', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.workflowRunning' },
  subagent: { icon: 'robot', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundSubagent' },
  shell: { icon: 'terminal', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundCommand' },
  tasks: { icon: 'task', colorClass: 'text-status-info', labelKey: 'chat.nativeTasks.background' },
  pullRequest: { icon: 'git-pull-request', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.waitingOnPullRequest' },
  unread: { icon: 'checkbox-circle', colorClass: 'text-status-success', labelKey: 'sessions.sidebar.session.status.unread' },
} as const satisfies Record<SessionActivityIndicatorState, { icon: IconName; colorClass: string; labelKey: string }>;

/**
 * Live-activity marker for one session row or aggregate. Each state has its
 * own static icon, so a row says why it is busy without motion; motion lives
 * in the 1 Hz elapsed counter (see faa9c243). The opt-in
 * `animatedActivityIndicators` preference replaces every running kind with a
 * original circular loader at 20 frames per second; the unread icon stays.
 * Hidden surfaces pause it through the same context as the shared clock.
 */
export const SessionActivityIndicator: React.FC<{
  state: SessionActivityIndicatorState;
  className?: string;
  /** Extra classes for the running kinds only (e.g. the switcher's pulse). */
  runningClassName?: string;
  /**
   * Name the state in a tooltip above the mark instead of the native title,
   * as the sidebar's row marks do.
   */
  tooltip?: boolean;
}> = ({ state, className, runningClassName, tooltip = false }) => {
  const { t } = useI18n();
  const animated = useSessionDisplayStore((s) => s.animatedActivityIndicators);
  const paused = React.useContext(ClockPausedContext);
  const presentation = PRESENTATION[state];
  const label = t(presentation.labelKey);
  const running = state !== 'unread';

  const mark = (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      aria-label={label}
      title={tooltip ? undefined : label}
      data-session-activity-indicator={state}
    >
      {running && animated ? (
        <Icon name="loader-4" data-spinner="" className="activity-spinner h-3 w-3 text-status-info"
          style={{ animationPlayState: paused ? 'paused' : 'running' }} />
      ) : (
        <Icon
          name={presentation.icon}
          className={cn('h-3 w-3', presentation.colorClass, running && runningClassName)}
        />
      )}
    </span>
  );
  if (!tooltip) return mark;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{mark}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
};
