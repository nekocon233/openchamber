import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Background tasks a session's CLI still runs after its turn ended. The
 * session goes on by itself when one finishes, so rows show it while their
 * status is idle.
 */
export const SessionBackgroundBadge: React.FC<{ count: number; className?: string }> = ({ count, className }) => {
  const { t } = useI18n();
  const label = count === 1
    ? t('sessions.sidebar.session.status.backgroundSingle')
    : t('sessions.sidebar.session.status.backgroundMany', { count });
  return (
    <span
      className={cn('inline-flex flex-shrink-0 items-center gap-1 rounded bg-muted px-1 py-0.5 text-[0.7rem] text-muted-foreground', className)}
      title={label}
      aria-label={label}
    >
      <Icon name="hourglass-fill" className="h-3 w-3" />
      <span className="leading-none">{count}</span>
    </span>
  );
};
