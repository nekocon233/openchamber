import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import {
  getSourceControlStatusKey,
  useGitHubPrStatusStore,
} from '@/stores/useGitHubPrStatusStore';

/**
 * Warms the branch's change-request summary for the mobile work-status sheet.
 *
 * Desktop rows stay read-only because the sidebar tracker owns discovery. The
 * mobile shell has no such tracker, so opening the sheet registers the same
 * kind of active context for one silent refresh. The store keeps its usual
 * TTL, concurrency gate and in-flight de-duplication, so repeated opens do
 * not multiply requests, and closing only releases the registration.
 */
export const useWorkStatusPrPrewarm = ({
  enabled,
  directory,
  branch,
}: {
  enabled: boolean;
  directory: string | null;
  branch: string | null;
}): void => {  const { sourceControl } = useRuntimeAPIs();
  const binding = useRepositoryBinding(directory, sourceControl, enabled && Boolean(directory));
  const contexts = binding.contexts;
  const ownerId = React.useId();

  const beginActiveContextsLoad = useGitHubPrStatusStore((state) => state.beginActiveContextsLoad);
  const commitActiveContexts = useGitHubPrStatusStore((state) => state.commitActiveContexts);
  const releaseActiveContexts = useGitHubPrStatusStore((state) => state.releaseActiveContexts);
  const ensureEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshTargets = useGitHubPrStatusStore((state) => state.refreshTargets);

  React.useEffect(() => {
    if (!enabled || !directory || !branch || contexts.length === 0) return undefined;

    const runtimeKey = getRuntimeKey();
    const requestId = beginActiveContextsLoad(runtimeKey, directory, ownerId);
    const accepted = commitActiveContexts(runtimeKey, directory, ownerId, requestId, contexts);
    if (!accepted) {
      releaseActiveContexts(runtimeKey, directory, ownerId);
      return undefined;
    }

    for (const context of contexts) {
      const key = getSourceControlStatusKey(context, branch);
      ensureEntry(key);
      setParams(key, {
        directory: context.directory,
        branch,
        remoteName: context.primaryRemote,
        canShow: true,
        identity: context,
        readContext: context,
        sourceControl,
        authChecked: true,
        connected: true,
      });
    }

    const targets = contexts.map((context) => ({ context, branch }));
    void refreshTargets(targets, { silent: true, markInitialResolved: true }).catch(() => undefined);

    return () => releaseActiveContexts(runtimeKey, directory, ownerId);
  }, [
    beginActiveContextsLoad,
    branch,
    commitActiveContexts,
    contexts,
    directory,
    enabled,
    ensureEntry,
    ownerId,
    refreshTargets,
    releaseActiveContexts,
    setParams,
    sourceControl,
  ]);
};

/** Mounts the prewarm only where it is wanted, so other hosts never read a binding. */
export const WorkStatusPrPrewarm: React.FC<{ directory: string; branch: string }> = ({ directory, branch }) => {
  useWorkStatusPrPrewarm({ enabled: true, directory, branch });
  return null;
};
