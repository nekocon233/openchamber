import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';

type Props = {
  orientation?: 'vertical' | 'horizontal';
  tooltipSide?: 'left' | 'right' | 'top';
  showRuntimeButtons?: boolean;
  onOpenSettings?: () => void;
};

/** App actions stay reachable independently of the session list. */
export function AppActions({ orientation = 'vertical', tooltipSide = 'top', showRuntimeButtons = true, onOpenSettings }: Props): React.ReactNode {
  const { t } = useI18n();
  const isDesktopRemote = useDesktopRemoteHostActive();
  const settingsOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const usageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  const helpOpen = useUIStore((state) => state.isHelpDialogOpen);
  const aboutOpen = useUIStore((state) => state.isAboutDialogOpen);
  const [updateOpen, setUpdateOpen] = React.useState(false);
  const update = useUpdateStore(useShallow((state) => ({
    available: state.available, runtimeType: state.runtimeType, info: state.info,
    downloading: state.downloading, downloaded: state.downloaded, installing: state.installing,
    progress: state.progress, error: state.error,
    downloadUpdate: state.downloadUpdate, restartToUpdate: state.restartToUpdate,
  })));
  const showUpdate = update.available && (update.runtimeType === 'desktop' || update.runtimeType === 'web');
  const openUpdate = async () => {
    const current = useUpdateStore.getState();
    if (current.available && current.info) { setUpdateOpen(true); return; }
    await current.checkForUpdates();
    const result = useUpdateStore.getState();
    if (result.error) {
      toast.error(t('sessions.sidebar.updateCheck.errorTitle'), { description: result.error });
    } else if (!result.available) {
      toast.success(t('sessions.sidebar.updateCheck.latestVersion'));
    } else {
      setUpdateOpen(true);
    }
  };
  const updateAction = {
    icon: 'download', label: t(isDesktopRemote ? 'sessions.sidebar.footer.actions.updateApp' : 'sessions.sidebar.footer.actions.update'),
    pressed: updateOpen, onClick: () => { void openUpdate(); },
  } satisfies { icon: IconName; label: string; pressed: boolean; onClick: () => void };
  const actions = showRuntimeButtons ? [
    { icon: 'settings-3', label: t('sessions.sidebar.footer.actions.settings'), pressed: settingsOpen,
      onClick: onOpenSettings ?? (() => useUIStore.getState().setSettingsDialogOpen(!settingsOpen)) },
    { icon: 'bar-chart', label: t('usageStats.openAction'), pressed: usageOpen,
      onClick: () => useUIStore.getState().setUsageStatsPageOpen(!usageOpen) },
    { icon: 'command', label: t('sessions.sidebar.footer.actions.shortcuts'), pressed: helpOpen,
      onClick: () => useUIStore.getState().toggleHelpDialog() },
    showUpdate ? updateAction : {
      icon: 'information', label: t('sessions.sidebar.footer.actions.aboutOpenChamber'), pressed: aboutOpen,
      onClick: () => useUIStore.getState().setAboutDialogOpen(!aboutOpen),
    },
  ] satisfies Array<{ icon: IconName; label: string; pressed: boolean; onClick: () => void }>
    : showUpdate ? [updateAction] : [];

  if (actions.length === 0) return null;
  return <>
    <div data-app-actions={orientation} className={cn('flex shrink-0 items-center gap-1', orientation === 'vertical' && 'flex-col')}>
      {actions.map(action => <Tooltip key={action.icon}>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={action.onClick} aria-label={action.label} aria-pressed={action.pressed}
            className={cn('text-muted-foreground',
              'aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground',
              'aria-pressed:hover:bg-interactive-selection aria-pressed:hover:text-interactive-selection-foreground',
              action.icon === 'download' && 'text-[var(--status-info-text)]',
            )}>
            <Icon name={action.icon} className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide} sideOffset={8}>{action.label}</TooltipContent>
      </Tooltip>)}
    </div>
    <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen}
      info={update.info} downloading={update.downloading} downloaded={update.downloaded} installing={update.installing}
      progress={update.progress} error={update.error} onDownload={update.downloadUpdate} onRestart={update.restartToUpdate}
      runtimeType={update.runtimeType} />
  </>;
}
