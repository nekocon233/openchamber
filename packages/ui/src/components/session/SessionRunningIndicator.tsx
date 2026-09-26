import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

type SessionRunningIndicatorProps = {
  label: string;
  className?: string;
};

export function SessionRunningIndicator({ label, className }: SessionRunningIndicatorProps): React.ReactElement {
  const animated = useSessionDisplayStore((state) => state.animatedActivityIndicators);
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
      {animated
        ? <Icon name="loader-4" className="session-running-spinner size-3.5 animate-spin text-[var(--status-info)]" />
        : <span className="size-1.5 rounded-full bg-[var(--status-info)]" />}
    </span>
  );
}
