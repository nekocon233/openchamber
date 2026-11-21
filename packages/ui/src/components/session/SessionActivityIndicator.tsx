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
 * (busy/retry), a pause kept open by a workflow run, a background subagent, a
 * background command, a native CLI's background tasks, background image work,
 * an agent waiting on a pull request or extension, or a finished turn the user
 * has not seen.
 */
type SessionActivityIndicatorState = 'running' | 'workflow' | 'subagent' | 'shell' | 'tasks' | 'image' | 'pullRequest' | 'extensionWait' | 'unread';

const PRESENTATION = {
  running: { icon: 'circle', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.active' },
  workflow: { icon: 'flow-chart', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.workflowRunning' },
  subagent: { icon: 'robot-2', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundSubagent' },
  shell: { icon: 'terminal', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundCommand' },
  tasks: { icon: 'task', colorClass: 'text-status-info', labelKey: 'chat.nativeTasks.background' },
  image: { icon: 'image', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundImage' },
  pullRequest: { icon: 'circle', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.waitingOnPullRequest' },
  extensionWait: { icon: 'timer', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.waitingOnExtension' },
  unread: { icon: 'checkbox-circle', colorClass: 'text-status-success', labelKey: 'sessions.sidebar.session.status.unread' },
} as const satisfies Record<SessionActivityIndicatorState, { icon: IconName; colorClass: string; labelKey: string }>;

/**
 * Live-activity marker for one session row or aggregate. Each state has its
 * own static icon, so a row says why it is busy without motion; motion lives
 * in the 1 Hz elapsed counter (see faa9c243). The opt-in
 * `animatedActivityIndicators` preference replaces every running kind with a
 * circular loader at 20 frames per second; the unread icon stays.
 * Hidden surfaces pause it through the same context as the shared clock.
 */
export const SessionActivityIndicator: React.FC<{
  state: SessionActivityIndicatorState;
  className?: string;
  runningClassName?: string;
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
