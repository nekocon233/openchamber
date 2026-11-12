import React from 'react';
import { createValueCache, useReferenceRevalidation } from '@/components/references/referenceCache';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ChangeRequestFileStats, GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { summarizeFileStats } from '@/lib/source-control/fileStats';

let fileStatsCache = createValueCache<ChangeRequestFileStats>();
subscribeRuntimeEndpointWillChange(({ runtimeKey, previousRuntimeKey }) => {
  if (runtimeKey !== previousRuntimeKey) fileStatsCache = createValueCache<ChangeRequestFileStats>();
});

/** Mounted only in a visible project PR list; queued hidden reads never dispatch. */
export const ProjectPullFileStats: React.FC<{
  context: SourceControlReadContext;
  pull: GitHubPullReference;
  excludedTypes: readonly string[];
  refreshVersion: number;
}> = ({ context, pull, excludedTypes, refreshVersion }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const cache = fileStatsCache;
  const key = JSON.stringify([getRuntimeKey(), context, pull.sourceRepo.owner, pull.sourceRepo.repo,
    pull.number, pull.headSha, pull.base, pull.updatedAt, refreshVersion]);
  const subscribe = React.useCallback((listener: () => void) => cache.subscribe(key, listener), [cache, key]);
  const snapshot = React.useSyncExternalStore(subscribe, () => cache.read(key));
  const revalidation = useReferenceRevalidation();
  const owner = pull.sourceRepo.owner;
  const name = pull.sourceRepo.repo;
  const number = pull.number;
  const headSha = pull.headSha;

  React.useEffect(() => {
    let active = true;
    const isCurrent = captureRuntimeInstance();
    void runBackgroundNetworkTask(async () => {
      if (!active || !isCurrent()) return;
      await cache.ensure(key, () => sourceControl.changeRequestFileStats(context, number, {
        project: { owner, name }, expectedHeadSha: headSha || undefined,
      })).catch(() => undefined);
    });
    return () => { active = false; };
  }, [cache, context, headSha, key, name, number, owner, revalidation, sourceControl]);

  const summary = React.useMemo(() => snapshot?.status === 'ready'
    ? summarizeFileStats(snapshot.value, excludedTypes) : null, [excludedTypes, snapshot]);
  return (
    <div dir="auto" className="mt-1 flex min-h-4 min-w-0 items-center gap-1.5 typography-micro tabular-nums text-muted-foreground">
      {summary ? <>
        <span>{t(summary.files === 1 ? 'references.projectPulls.files.single' : 'references.projectPulls.files.plural', { count: summary.files })}</span>
        <span aria-hidden="true">·</span>
        <span dir="ltr" className="text-[var(--status-success)]">+{summary.additions ?? '—'}</span>
        <span dir="ltr" className="text-[var(--status-error)]">−{summary.deletions ?? '—'}</span>
      </> : <span className="truncate" title={snapshot?.status === 'error' ? snapshot.error : undefined}>
        {t(snapshot?.status === 'error' ? 'references.projectPulls.files.failed' : 'references.projectPulls.files.loading')}
      </span>}
    </div>
  );
};
