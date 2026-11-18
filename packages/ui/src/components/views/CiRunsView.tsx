import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useShallow } from 'zustand/react/shallow';
import { useRepositoryHost } from '@/components/references/referenceSources';
import { NestedRepoResolutionStates } from './git/NestedRepoResolutionStates';
import { NestedRepoPicker } from './git/NestedRepoPicker';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ProjectCiList } from './git/ProjectCiList';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';

/** Standalone GitHub Actions CI workflow runs surface for desktop and mobile workspaces. */
export const CiRunsView: React.FC<{ directory: string; visible?: boolean }> = ({ directory, visible = true }) => {
  const { sourceControl } = useRuntimeAPIs();
  const { rootIsGitRepo, gitDirectory, nestedRepos } = useNestedGitDirectory(directory, { enabled: visible });
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  const binding = useRepositoryBinding(gitDirectory, sourceControl);
  const host = useRepositoryHost(gitDirectory ?? directory);
  const ciPending = usePullRequestSelectionStore((state) => (
    state.ciOpenRequests.get(pullRequestNavigationKey(getRuntimeKey(), directory))
  ));
  const { ensureNestedRepos, selectNestedRepo } = useGitStore(useShallow((state) => ({
    ensureNestedRepos: state.ensureNestedRepos,
    selectNestedRepo: state.selectNestedRepo,
  })));

  React.useEffect(() => {
    if (!visible || !ciPending) return;
    if (!directory || host?.provider === 'gitlab') {
      usePullRequestSelectionStore.getState().settleCiRunRequest(ciPending);
      return;
    }
    if (
      rootIsGitRepo === false
      && Array.isArray(nestedRepos)
      && nestedRepos.includes(ciPending.sourceDirectory)
      && gitDirectory !== ciPending.sourceDirectory
    ) {
      selectNestedRepo(directory, ciPending.sourceDirectory);
    }
  }, [ciPending, directory, gitDirectory, host?.provider, nestedRepos, rootIsGitRepo, selectNestedRepo, visible]);

  const context = binding.contexts.find((candidate) => candidate.provider === 'github');
  const scopeKey = JSON.stringify([
    getRuntimeKey(),
    gitDirectory ?? directory,
    context ? sourceControlReadContextParts(context) : null,
  ]);

  if (directory && rootIsGitRepo === false && isGitRepo !== true) {
    return (
      <React.Activity mode={visible ? 'visible' : 'hidden'}>
        <NestedRepoResolutionStates
          root={directory}
          rootIsGitRepo={rootIsGitRepo}
          resolvedIsGitRepo={isGitRepo}
          nestedRepos={nestedRepos}
          onRetryDiscovery={() => {
            void ensureNestedRepos(directory, { force: true });
          }}
        />
      </React.Activity>
    );
  }

  return (
    <React.Activity mode={visible ? 'visible' : 'hidden'}>
      <div className="flex h-full min-h-0 flex-col" data-ci-runs-directory={directory}>
        {directory && rootIsGitRepo === false && Array.isArray(nestedRepos) && nestedRepos.length > 0 ? (
          <div className="shrink-0 border-b border-border/60 px-4 py-2">
            <NestedRepoPicker
              repositories={nestedRepos}
              selectedRepository={gitDirectory ?? null}
              onSelectRepository={(repository) => selectNestedRepo(directory, repository)}
              repositoryRoot={directory}
            />
          </div>
        ) : null}
        <ProjectCiList
          key={scopeKey}
          directory={gitDirectory ?? directory}
          workspaceDirectory={directory}
          active={visible}
        />
      </div>
    </React.Activity>
  );
};
