import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

type SessionRunningIndicatorProps = {
  label: string;
  className?: string;
};

export function SessionRunningIndicator({ label, className }: SessionRunningIndicatorProps): React.ReactElement {
  return (
    <span
      role="img"
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--status-info)]',
        className,
      )}
      aria-label={label}
      title={label}
    >
      <Icon name="loader-4" className="session-running-spinner size-3.5 animate-spin text-[var(--status-info)]" />
    </span>
  );
}
