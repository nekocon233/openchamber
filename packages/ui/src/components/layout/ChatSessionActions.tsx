import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { useI18n } from '@/lib/i18n';
import { shortcutRegistry } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const ICON_BUTTON_CLASS = 'w-6 px-0 has-[>svg]:px-0 text-muted-foreground hover:bg-transparent hover:text-foreground';

/** Session navigation belongs to the conversation header in both desktop layouts. */
export const ChatSessionActions: React.FC = () => {
  const { t } = useI18n();
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const closeSessions = React.useCallback(() => setSessionsOpen(false), []);
  React.useLayoutEffect(() => {
    if (sessionsOpen) return shortcutRegistry.suspend();
  }, [sessionsOpen]);
  const handleNewSession = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().openNewSessionDraft();
  }, []);

  return <div data-chat-session-actions="" className="app-region-no-drag flex shrink-0 items-center gap-2">
    <Popover.Root open={sessionsOpen} onOpenChange={setSessionsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger
            render={<Button variant="ghost" size="xs" />}
            data-session-picker-trigger=""
            aria-label={t('header.actions.openSessionsAria')}
            aria-haspopup="dialog"
            aria-pressed={sessionsOpen}
            className={cn(ICON_BUTTON_CLASS, sessionsOpen && 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground')}
          >
            <Icon name="layout-left" className="size-4" />
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('header.actions.openSessionsAria')}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup
            data-session-picker=""
            role="dialog"
            aria-label={t('header.actions.openSessionsAria')}
            className={cn(dropdownMenuPopupClass, 'flex h-[min(36rem,75dvh)] w-[360px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0')}
            onKeyDownCapture={event => {
              if (event.key !== 'Escape' || event.defaultPrevented || isIMECompositionEvent(event)) return;
              if (!(event.target instanceof Element) || event.target.closest('[role="dialog"], [role="menu"], [role="alertdialog"], [role="listbox"]') !== event.currentTarget) return;
              if (event.target.closest('input, textarea, [contenteditable="true"]')) return;
              event.preventDefault();
              event.stopPropagation();
              closeSessions();
            }}
          >
            {sessionsOpen ? <SessionSidebar isVisible allowReselect onSessionSelected={closeSessions} renderSharedDialogs={false} /> : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="xs" onClick={handleNewSession} data-new-session-trigger=""
          aria-label={t('sessions.sidebar.header.actions.newSession')} className={ICON_BUTTON_CLASS}>
          <Icon name="chat-new" className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('sessions.sidebar.header.actions.newSession')}</TooltipContent>
    </Tooltip>
  </div>;
};
