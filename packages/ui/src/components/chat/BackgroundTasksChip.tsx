import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import type { SessionBackgroundTask } from '@/lib/opencode/events';

const CHIP_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'status-row' };

/**
 * The chip above the composer while an idle session's CLI still runs
 * background tasks. The session goes on by itself when one finishes, and the
 * working chip takes this place again.
 */
export const BackgroundTasksChip: React.FC<{ tasks: readonly SessionBackgroundTask[] }> = ({ tasks }) => {
  const { t } = useI18n();
  const [first, ...rest] = tasks;
  if (!first) return null;
  const describe = (task: SessionBackgroundTask) => task.description.trim() || t('chat.statusRow.background.unnamed');

  return (
    // Same overlay slot and glass chip as StatusRow, which it replaces
    // while the session is idle.
    <div style={CHIP_CONTAINER_STYLE}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="oc-glass-popover inline-flex w-max max-w-full items-center gap-2 h-8 whitespace-nowrap rounded-full [corner-shape:round] px-3 [backdrop-filter:none]! [-webkit-backdrop-filter:none]! text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
            tabIndex={0}
          >
            <Icon name="hourglass-fill" className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-shrink-0">{t('chat.statusRow.background.label')}</span>
            <span className="min-w-0 truncate text-foreground">{describe(first)}</span>
            {rest.length > 0 ? <span className="flex-shrink-0 tabular-nums">+{rest.length}</span> : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-sm">
          <p>
            {tasks.length === 1
              ? t('chat.statusRow.background.countSingle')
              : t('chat.statusRow.background.countMany', { count: tasks.length })}
          </p>
          <ul className="list-disc pl-4">
            {tasks.map((task) => <li key={task.id}>{describe(task)}</li>)}
          </ul>
          <p>{t('chat.statusRow.background.hint')}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
};
