import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

/** The same delay as the tool icons beside it, so the rail answers at one pace. */
const TOOLTIP_DELAY_MS = 150;

/**
 * Shows and hides the session column that sits beside the rail at the start of
 * the line. It lives in the rail rather than in that column so the list stays
 * reachable while its own width is zero, and it is pressed while the column is
 * open, the way a rail icon reads as pressed while its surface is shown.
 */
export const SessionsRailToggle: React.FC<{ tooltipSide: 'left' | 'right' }> = ({ tooltipSide }) => {
  const { t } = useI18n();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);

  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-sessions-toggle=""
          aria-label={t('contextRail.sessions.label')}
          aria-pressed={isSidebarOpen}
          onClick={toggleSidebar}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
            isSidebarOpen
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon name="layout-left" className="h-[18px] w-[18px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={8}>
        <div className="flex flex-col gap-0.5">
          <span>{t('contextRail.sessions.label')}</span>
          <span className="typography-micro text-muted-foreground">{t('contextRail.sessions.description')}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
