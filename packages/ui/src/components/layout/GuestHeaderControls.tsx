import React from 'react';

import { StatusHeaderControls } from '@/components/chat/work-status/StatusHeaderControls';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Props = {
  controls: GuestStatusControlBinding | null;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onClose?: () => void;
  className?: string;
};

/** Renders guest header controls alongside an optional host-managed fullscreen toggle. */
export const GuestHeaderControls: React.FC<Props> = ({
  controls,
  fullscreen = false,
  onToggleFullscreen,
  onClose,
  className,
}) => {
  const { t } = useI18n();
  const close = fullscreen ? onClose : undefined;
  if (!controls && !onToggleFullscreen && !close) return null;

  const fullscreenLabel = t(fullscreen ? 'filesView.editor.exitFullscreen' : 'filesView.editor.fullscreen');

  return (
    <div className={cn('flex shrink-0 items-center gap-1', className)}>
      {controls ? (
        <StatusHeaderControls
          controls={controls.controls}
          layout="inline"
          appearance="toolbar"
          onActivate={(id, value) => controls.dispatch(value === undefined ? { id } : { id, value })}
        />
      ) : null}
      {onToggleFullscreen ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onToggleFullscreen}
          aria-pressed={fullscreen}
          aria-label={fullscreenLabel}
          data-guest-fullscreen-toggle={fullscreen ? 'exit' : 'enter'}
          className="app-region-no-drag max-w-[10rem]"
        >
          <Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} className="size-3.5" />
          <span className="truncate">{fullscreenLabel}</span>
        </Button>
      ) : null}
      {close ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={close}
          aria-label={t('dialog.common.actions.close')}
          title={t('dialog.common.actions.close')}
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
};
