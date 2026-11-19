import React from 'react';
import { createValueCache, revalidateReferences, useReferenceRevalidation } from '@/components/references/referenceCache';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ChangeRequestFileStats, GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

let fileStatsCache = createValueCache<ChangeRequestFileStats>();
subscribeRuntimeEndpointWillChange(({ runtimeKey, previousRuntimeKey }) => {
  if (runtimeKey !== previousRuntimeKey) fileStatsCache = createValueCache<ChangeRequestFileStats>();
});

const contextKey = (context: SourceControlReadContext) => `${JSON.stringify([getRuntimeKey(), context])}|`;
const pullKey = (context: SourceControlReadContext, pull: GitHubPullReference) =>
  `${contextKey(context)}${JSON.stringify([pull.sourceRepo.owner, pull.sourceRepo.repo, pull.number])}|`;

export function invalidateProjectPullFileStats(context: SourceControlReadContext, pull?: GitHubPullReference): void {
  const prefix = pull ? pullKey(context, pull) : contextKey(context);
  fileStatsCache.invalidate((key) => key.startsWith(prefix));
  revalidateReferences();
}

export function useProjectPullFileStats(context: SourceControlReadContext, pull: GitHubPullReference) {
  const { sourceControl } = useRuntimeAPIs();
  const cache = fileStatsCache;
  const { number, headSha, base, updatedAt, sourceRepo: { owner, repo } } = pull;
  const key = `${pullKey(context, pull)}${JSON.stringify([headSha, base, updatedAt])}`;
  const subscribe = React.useCallback((listener: () => void) => cache.subscribe(key, listener), [cache, key]);
  const snapshot = React.useSyncExternalStore(subscribe, () => cache.read(key));
  const revalidation = useReferenceRevalidation();

  React.useEffect(() => {
    let active = true;
    const isCurrent = captureRuntimeInstance();
    const canRead = () => active && isCurrent();
    void runBackgroundNetworkTask(async () => {
      if (!canRead()) return;
      await cache.ensure(key, async () => {
        // A read can wait for an invalidated request to finish. Retire the
        // cancelled read so another visible subscriber can ask for the key.
        if (!canRead()) {
          cache.invalidate((candidate) => candidate === key);
          throw new Error('File statistics read retired');
        }
        return sourceControl.changeRequestFileStats(context, number, {
          project: { owner, name: repo }, expectedHeadSha: headSha || undefined,
        });
      }).catch(() => undefined);
    });
    return () => { active = false; };
  }, [cache, context, headSha, key, number, owner, repo, revalidation, sourceControl]);

  return snapshot;
}
