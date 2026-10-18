import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type {
  SkillsUserSyncError,
  SkillsUserSyncPlanItem,
  SkillsUserSyncResult,
  SkillsUserSyncSource,
} from '@/lib/api/types';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';

type Phase = 'loading' | 'error' | 'ready' | 'running' | 'done';

interface SyncUserSkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a run that changed files, so the caller can reload its list. */
  onSynced?: () => void;
}

const sourceLabel = (source: SkillsUserSyncSource | null): string | null => {
  if (!source) return null;
  const agent = source.agent === 'claude' ? 'Claude Code' : 'Codex';
  return `${agent} · ${source.plugin} ${source.version}`;
};

export const SyncUserSkillsDialog: React.FC<SyncUserSkillsDialogProps> = ({ open, onOpenChange, onSynced }) => {
  const { t } = useI18n();
  const fetchPlan = useSkillsCatalogStore((state) => state.fetchUserSkillSyncPlan);
  const runSync = useSkillsCatalogStore((state) => state.syncUserSkills);

  const [phase, setPhase] = React.useState<Phase>('loading');
  const [errorPhase, setErrorPhase] = React.useState<'plan' | 'run'>('plan');
  const [error, setError] = React.useState<SkillsUserSyncError | null>(null);
  const [plan, setPlan] = React.useState<SkillsUserSyncPlanItem[]>([]);
  const [results, setResults] = React.useState<SkillsUserSyncResult[]>([]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('loading');
    setErrorPhase('plan');
    setError(null);
    setPlan([]);
    setResults([]);

    void fetchPlan().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        setErrorPhase('plan');
        setPhase('error');
        return;
      }
      setPlan(result.plan);
      setPhase('ready');
    });

    return () => {
      cancelled = true;
    };
  }, [open, fetchPlan]);

  const updateItems = plan.filter((item) => item.status === 'update');
  const keepItems = plan.filter((item) => item.status !== 'update');

  const statusText = React.useCallback((status: SkillsUserSyncPlanItem['status']) => {
    if (status === 'current') return t('settings.skills.userSync.status.current');
    if (status === 'external') return t('settings.skills.userSync.status.external');
    return t('settings.skills.userSync.status.noSource');
  }, [t]);

  const requestErrorText = React.useCallback((value: SkillsUserSyncError) => {
    if (value.kind === 'busy') return t('settings.skills.userSync.error.busy');
    return errorPhase === 'plan'
      ? t('settings.skills.userSync.error.plan')
      : t('settings.skills.userSync.error.run');
  }, [errorPhase, t]);

  const handleRun = async () => {
    setPhase('running');
    const result = await runSync();
    if (!result.ok) {
      setError(result.error);
      setErrorPhase('run');
      setPhase('error');
      return;
    }
    setResults(result.results);
    setPhase('done');
    if (result.results.some((entry) => entry.status === 'updated')) onSynced?.();
  };

  // A request in flight owns the dialog: closing it would hide a run that is
  // already replacing files.
  const requestClose = (next: boolean) => {
    if (phase === 'running') return;
    onOpenChange(next);
  };

  const failed = results.filter((entry) => entry.status === 'failed');
  const counts = [
    { key: 'updated', label: t('settings.skills.userSync.result.updated'), value: results.filter((entry) => entry.status === 'updated').length },
    { key: 'skipped', label: t('settings.skills.userSync.result.skipped'), value: results.filter((entry) => entry.status === 'skipped').length },
    { key: 'failed', label: t('settings.skills.userSync.result.failed'), value: failed.length },
  ];

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.skills.userSync.title')}</DialogTitle>
          <DialogDescription>{t('settings.skills.userSync.description')}</DialogDescription>
        </DialogHeader>

        {phase === 'loading' ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Icon name="loader" className="h-4 w-4 animate-spin" />
            <span className="typography-meta">{t('settings.skills.userSync.loading')}</span>
          </div>
        ) : null}

        {phase === 'error' && error ? (
          <div className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
            <div className="typography-meta text-[var(--status-error)]">{requestErrorText(error)}</div>
          </div>
        ) : null}

        {phase === 'ready' && plan.length === 0 ? (
          <div className="py-2">
            <p className="typography-meta text-muted-foreground">{t('settings.skills.userSync.empty')}</p>
          </div>
        ) : null}

        {phase === 'ready' && plan.length > 0 ? (
          <div className="max-h-[55vh] space-y-4 overflow-y-auto">
            {updateItems.length > 0 ? (
              <div className="space-y-2">
                <div className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
                  {t('settings.skills.userSync.replace.heading')}
                </div>
                <div className="space-y-1">
                  {updateItems.map((item) => (
                    <div key={item.skillName} className="min-w-0 py-1">
                      <div className="typography-ui-label truncate">{item.skillName}</div>
                      <div className="typography-micro text-muted-foreground">{sourceLabel(item.source)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="typography-meta text-muted-foreground">{t('settings.skills.userSync.nothingToReplace')}</p>
            )}

            {keepItems.length > 0 ? (
              <div className="space-y-2">
                <div className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
                  {t('settings.skills.userSync.keep.heading')}
                </div>
                <div className="space-y-1">
                  {keepItems.map((item) => (
                    <div key={item.skillName} className="min-w-0 py-1">
                      <div className="typography-ui-label truncate">
                        {item.skillName}
                        <span className="typography-micro text-muted-foreground">
                          {' · '}
                          {statusText(item.status)}
                        </span>
                      </div>
                      {item.source ? (
                        <div className="typography-micro text-muted-foreground">{sourceLabel(item.source)}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === 'running' ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Icon name="loader" className="h-4 w-4 animate-spin" />
            <span className="typography-meta">{t('settings.skills.userSync.actions.running')}</span>
          </div>
        ) : null}

        {phase === 'done' ? (
          <div className="space-y-3">
            <div className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
              {t('settings.skills.userSync.result.heading')}
            </div>
            <div className="space-y-1">
              {counts.map((entry) => (
                <div key={entry.key} className="flex items-center justify-between gap-3 py-0.5">
                  <span className="typography-meta text-muted-foreground">{entry.label}</span>
                  <span className="typography-ui-label tabular-nums">{entry.value}</span>
                </div>
              ))}
            </div>
            {failed.length > 0 ? (
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {failed.map((entry) => (
                  <div key={entry.skillName} className="min-w-0 py-1">
                    <div className="typography-ui-label truncate">{entry.skillName}</div>
                    <div className="typography-micro text-muted-foreground">
                      {t('settings.skills.userSync.failure.copy')}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {phase === 'ready' && updateItems.length > 0 ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                {t('settings.common.actions.cancel')}
              </Button>
              <Button size="sm" onClick={() => void handleRun()}>
                {t('settings.skills.userSync.actions.run')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={phase === 'running'}>
              {t('settings.common.actions.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
