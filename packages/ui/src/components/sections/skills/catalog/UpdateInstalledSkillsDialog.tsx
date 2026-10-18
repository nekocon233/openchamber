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
  SkillsCatalogSource,
  SkillsUpdateInstalledError,
  SkillsUpdateInstalledPlanItem,
  SkillsUpdateInstalledResult,
} from '@/lib/api/types';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';

type Phase = 'loading' | 'error' | 'ready' | 'running' | 'done';

interface UpdateInstalledSkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string | null;
  sources: SkillsCatalogSource[];
}

const countOf = (results: SkillsUpdateInstalledResult[], status: SkillsUpdateInstalledResult['status']) => (
  results.filter((entry) => entry.status === status).length
);

export const UpdateInstalledSkillsDialog: React.FC<UpdateInstalledSkillsDialogProps> = ({
  open,
  onOpenChange,
  directory,
  sources,
}) => {
  const { t } = useI18n();
  const fetchPlan = useSkillsCatalogStore((state) => state.fetchInstalledUpdatePlan);
  const runUpdate = useSkillsCatalogStore((state) => state.updateInstalledSkills);

  const [phase, setPhase] = React.useState<Phase>('loading');
  const [errorPhase, setErrorPhase] = React.useState<'plan' | 'run'>('plan');
  const [error, setError] = React.useState<SkillsUpdateInstalledError | null>(null);
  const [plan, setPlan] = React.useState<SkillsUpdateInstalledPlanItem[]>([]);
  const [results, setResults] = React.useState<SkillsUpdateInstalledResult[]>([]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('loading');
    setErrorPhase('plan');
    setError(null);
    setPlan([]);
    setResults([]);

    void fetchPlan({ directory }).then((result) => {
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
  }, [open, directory, fetchPlan]);

  const sourceLabels = React.useMemo(
    () => new Map(sources.map((source) => [source.id, source.label])),
    [sources],
  );

  const installedIn = React.useCallback((entry: { scope: 'user' | 'project'; source?: 'opencode' | 'agents' }) => (
    t('settings.skills.catalog.conflicts.installedIn', {
      scope: entry.scope === 'project'
        ? t('settings.skills.catalog.conflicts.scope.project')
        : t('settings.skills.catalog.conflicts.scope.user'),
      source: entry.source === 'agents'
        ? t('settings.skills.catalog.conflicts.source.agents')
        : t('settings.skills.catalog.conflicts.source.opencode'),
    })
  ), [t]);

  const failureText = React.useCallback((kind?: SkillsUpdateInstalledResult['kind']) => {
    if (kind === 'authRequired') return t('settings.skills.catalog.update.failure.authRequired');
    if (kind === 'networkError') return t('settings.skills.catalog.update.failure.networkError');
    if (kind === 'gitUnavailable') return t('settings.skills.catalog.update.failure.gitUnavailable');
    if (kind === 'invalidSource') return t('settings.skills.catalog.update.failure.invalidSource');
    return t('settings.skills.catalog.update.failure.unknown');
  }, [t]);

  const requestErrorText = React.useCallback((value: SkillsUpdateInstalledError) => {
    if (value.kind === 'busy') return t('settings.skills.catalog.update.error.busy');
    if (value.kind === 'invalidSource') return t('settings.skills.catalog.update.failure.invalidSource');
    return errorPhase === 'plan'
      ? t('settings.skills.catalog.update.error.plan')
      : t('settings.skills.catalog.update.error.run');
  }, [errorPhase, t]);

  const handleRun = async () => {
    setPhase('running');
    const result = await runUpdate({ directory });
    if (!result.ok) {
      setError(result.error);
      setErrorPhase('run');
      setPhase('error');
      return;
    }
    setResults(result.results);
    setPhase('done');
  };

  // A request in flight owns the dialog: closing it would hide a run that is
  // already replacing files.
  const requestClose = (next: boolean) => {
    if (phase === 'running') return;
    onOpenChange(next);
  };

  const unfinished = results.filter((entry) => entry.status !== 'updated');
  const counts = [
    { key: 'updated', label: t('settings.skills.catalog.update.result.updated'), value: countOf(results, 'updated') },
    { key: 'skipped', label: t('settings.skills.catalog.update.result.skipped'), value: countOf(results, 'skipped') },
    { key: 'failed', label: t('settings.skills.catalog.update.result.failed'), value: countOf(results, 'failed') },
  ];

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.skills.catalog.update.title')}</DialogTitle>
          <DialogDescription>{t('settings.skills.catalog.update.description')}</DialogDescription>
        </DialogHeader>

        {phase === 'loading' ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Icon name="loader" className="h-4 w-4 animate-spin" />
            <span className="typography-meta">{t('settings.skills.catalog.update.loading')}</span>
          </div>
        ) : null}

        {phase === 'error' && error ? (
          <div className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
            <div className="typography-meta text-[var(--status-error)]">{requestErrorText(error)}</div>
          </div>
        ) : null}

        {phase === 'ready' && plan.length === 0 ? (
          <div className="py-2">
            <p className="typography-meta text-muted-foreground">{t('settings.skills.catalog.update.empty')}</p>
          </div>
        ) : null}

        {phase === 'ready' && plan.length > 0 ? (
          <div className="space-y-2">
            <div className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
              {t('settings.skills.catalog.update.list.heading')}
            </div>
            <div className="max-h-[50vh] space-y-1 overflow-y-auto">
              {plan.map((item) => {
                const sourceLabel = sourceLabels.get(item.sourceId);
                return (
                  <div key={`${item.sourceId}:${item.skillName}:${item.scope}:${item.source}`} className="min-w-0 py-1">
                    <div className="typography-ui-label truncate">{item.skillName}</div>
                    <div className="typography-micro text-muted-foreground">
                      {installedIn(item)}
                      {sourceLabel ? ` · ${sourceLabel}` : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {phase === 'running' ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Icon name="loader" className="h-4 w-4 animate-spin" />
            <span className="typography-meta">{t('settings.skills.catalog.update.actions.running')}</span>
          </div>
        ) : null}

        {phase === 'done' ? (
          <div className="space-y-3">
            <div className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
              {t('settings.skills.catalog.update.result.heading')}
            </div>
            <div className="space-y-1">
              {counts.map((entry) => (
                <div key={entry.key} className="flex items-center justify-between gap-3 py-0.5">
                  <span className="typography-meta text-muted-foreground">{entry.label}</span>
                  <span className="typography-ui-label tabular-nums">{entry.value}</span>
                </div>
              ))}
            </div>
            {unfinished.length > 0 ? (
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {unfinished.map((entry) => (
                  <div key={`${entry.skillName}:${entry.scope}:${entry.source ?? ''}`} className="min-w-0 py-1">
                    <div className="typography-ui-label truncate">
                      {entry.skillName}
                      <span className="typography-micro text-muted-foreground">
                        {' · '}
                        {entry.status === 'failed'
                          ? t('settings.skills.catalog.update.result.failed')
                          : t('settings.skills.catalog.update.result.skipped')}
                      </span>
                    </div>
                    <div className="typography-micro text-muted-foreground">
                      {entry.status === 'failed' ? failureText(entry.kind) : (entry.reason ?? installedIn(entry))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {phase === 'ready' && plan.length > 0 ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                {t('settings.common.actions.cancel')}
              </Button>
              <Button size="sm" onClick={() => void handleRun()}>
                {t('settings.skills.catalog.update.actions.run')}
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
