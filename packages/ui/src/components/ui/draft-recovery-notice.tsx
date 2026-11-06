import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from './button';

export const DraftRecoveryNotice: React.FC<{
  conflict: boolean;
  onResume: () => void;
  onUseLatest: () => void;
}> = ({ conflict, onResume, onUseLatest }) => {
  const { t } = useI18n();
  if (!conflict) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--status-warning-background)] p-2 typography-micro text-foreground">
      <span className="min-w-0 basis-full">{t('workspaceRestore.draftConflict')}</span>
      <Button size="sm" variant="ghost" onClick={onResume}>{t('workspaceRestore.saveDraft')}</Button>
      <Button size="sm" variant="ghost" onClick={onUseLatest}>{t('workspaceRestore.useLatest')}</Button>
    </div>
  );
};
