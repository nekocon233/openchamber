import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { usePullRequestNavigation } from './usePullRequestNavigation';

export const PullRequestNavigation: React.FC<{
  navigation: ReturnType<typeof usePullRequestNavigation>;
  compact?: boolean;
}> = ({ navigation, compact = false }) => {
  if (!navigation) return null;
  const { backLabel, detailsLabel, navigate, isMobile } = navigation;
  const buttonClass = cn('min-w-0', compact && isMobile && 'size-9');
  return (
    <div className={cn('flex min-w-0 items-center gap-1', compact ? 'shrink-0' : 'me-auto shrink')}>
      <Button variant="ghost" size="sm" className={buttonClass} title={backLabel} aria-label={backLabel} onClick={() => navigate('origin')}>
        <Icon name="arrow-left" className="size-4" />
        {!compact && <span className="truncate">{backLabel}</span>}
      </Button>
      {detailsLabel && (
        <Button variant="ghost" size="sm" className={buttonClass} title={detailsLabel} aria-label={detailsLabel} onClick={() => navigate('details')}>
          <Icon name="git-pull-request" className="size-4" />
          {!compact && <span className="truncate">{detailsLabel}</span>}
        </Button>
      )}
    </div>
  );
};
