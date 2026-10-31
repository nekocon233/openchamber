import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useDetectedWorktreeMetadata } from '@/hooks/useDetectedWorktreeRoot';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getAttachedSessionDirectory } from '@/sync/session-worktree-contract';
import { useGitStatus, useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useShallow } from 'zustand/react/shallow';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useRepositoryHost } from '@/components/references/referenceSources';
import { normalizePath } from '@/lib/pathNormalization';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { PullRequestSection } from './git/PullRequestSection';
import { NestedRepoResolutionStates } from './git/NestedRepoResolutionStates';
import { NestedRepoPicker } from './git/NestedRepoPicker';
import { deriveBaseBranch } from './git/baseBranch';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { sourceControlReadContextParts, hasSameSourceControlReadContext } from '@/lib/source-control/identity';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { ProjectPullRequestList } from './git/ProjectPullRequestList';
import { pullRequestNavigationKey, usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';

const PullRequestTabs: React.FC<{ directory: string; workspaceDirectory: string; context: SourceControlReadContext | null }> = ({ directory, workspaceDirectory, context }) => {
  const { t } = useI18n();
  const [tab, setTab] = React.useState<'project' | 'branch'>('project');
  const runtimeKey = useGitStore(state => state.runtimeKey);
  const returning = usePullRequestSelectionStore(state => state.returnRequests.get(pullRequestNavigationKey(runtimeKey, workspaceDirectory)));
  React.useEffect(() => {
    if (!returning || !context) return;
    if (!hasSameSourceControlReadContext(returning.context, context)) {
      usePullRequestSelectionStore.getState().settleReturnRequest(returning);
      return;
    }
    setTab(returning.tab);
    if (returning.tab === 'branch') usePullRequestSelectionStore.getState().settleReturnRequest(returning);
  }, [context, returning]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 px-4 py-2">
        <SortableTabsStrip
          items={[
            { id: 'project', label: t('gitView.pullRequest.tab.project') },
            { id: 'branch', label: t('gitView.pullRequest.tab.branch') },
          ]}
          activeId={tab}
          onSelect={(id) => setTab(id === 'branch' ? 'branch' : 'project')}
          variant="active-pill"
          layoutMode="fit"
        />
      </div>
      <React.Activity mode={tab === 'project' ? 'visible' : 'hidden'}>
        <ProjectPullRequestList directory={directory} workspaceDirectory={workspaceDirectory} active />
      </React.Activity>
      <React.Activity mode={tab === 'branch' ? 'visible' : 'hidden'}>
        <CurrentBranchPullRequestView directory={workspaceDirectory} />
      </React.Activity>
    </div>
  );
};

/** Repository browsing stays available even when the checkout cannot create a PR. */
export const PullRequestView: React.FC<{ directory: string; visible?: boolean }> = ({ directory, visible = true }) => {
  const { sourceControl } = useRuntimeAPIs();
  const { rootIsGitRepo, gitDirectory, nestedRepos } = useNestedGitDirectory(directory, { enabled: visible });
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  const binding = useRepositoryBinding(gitDirectory, sourceControl);
  const host = useRepositoryHost(gitDirectory ?? directory);
  const returning = usePullRequestSelectionStore(state => state.returnRequests.get(pullRequestNavigationKey(getRuntimeKey(), directory)));
  React.useEffect(() => {
    if (host?.provider === 'gitlab' && returning) usePullRequestSelectionStore.getState().settleReturnRequest(returning);
  }, [host?.provider, returning]);
  const context = binding.contexts.find((candidate) => candidate.provider === 'github');
  const scopeKey = JSON.stringify([getRuntimeKey(), gitDirectory ?? directory, context ? sourceControlReadContextParts(context) : null]);
  const selectNestedRepo = useGitStore((state) => state.selectNestedRepo);

  if (!directory || (rootIsGitRepo === false && isGitRepo !== true)) {
    return <React.Activity mode={visible ? 'visible' : 'hidden'}><CurrentBranchPullRequestView directory={directory} /></React.Activity>;
  }
  // Keep the binding owner outside Activity: its last subscription releasing
  // clears read contexts, which would otherwise replace the retained view's key.
  return (
    <React.Activity mode={visible ? 'visible' : 'hidden'}>
      <div className="flex h-full min-h-0 flex-col" data-pull-request-directory={directory}>
        {rootIsGitRepo === false && Array.isArray(nestedRepos) && nestedRepos.length > 0 ? (
          <div className="shrink-0 border-b border-border/60 px-4 py-2">
            <NestedRepoPicker
              repositories={nestedRepos}
              selectedRepository={gitDirectory ?? null}
              onSelectRepository={(repository) => selectNestedRepo(directory, repository)}
              repositoryRoot={directory}
            />
          </div>
        ) : null}
        {host?.provider === 'gitlab'
          ? <CurrentBranchPullRequestView directory={directory} />
          : <PullRequestTabs key={scopeKey} directory={gitDirectory ?? directory} workspaceDirectory={directory} context={context ?? null} />}
      </div>
    </React.Activity>
  );
};

// Remotes rarely change; remembering the last fetched list per directory lets
// a remount pick the same PR-status key immediately instead of flashing
// through the remote-less "checking status" state while remotes reload.
// Runtime-scoped so a backend switch never serves another runtime's remotes.
/**
 * Standalone pull-request surface: resolves the same repository context
 * GitView does (branch, base branch, remotes) from the shared git stores and
 * renders the pull-request workflow full-size in the context panel.
 */
const CurrentBranchPullRequestView: React.FC<{ directory: string }> = ({ directory: currentDirectory }) => {
  const { t } = useI18n();
  const { git, sourceControl } = useRuntimeAPIs();
  // When the root is not itself a repository, the pull-request workflow
  // operates on the resolved nested repository instead.
  const { rootIsGitRepo, gitDirectory, nestedRepos } = useNestedGitDirectory(currentDirectory ?? null);
  const status = useGitStatus(gitDirectory ?? null);
  const branches = useGitBranches(gitDirectory ?? null);
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  // The binding follows the repository actually in view.
  const binding = useRepositoryBinding(gitDirectory, sourceControl);
  const { ensureAll, ensureNestedRepos } = useGitStore(useShallow((state) => ({
    ensureAll: state.ensureAll,
    ensureNestedRepos: state.ensureNestedRepos,
  })));

  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const worktreeMap = useSessionUIStore((s) => s.worktreeMetadata);
  const availableWorktrees = useSessionUIStore((s) => s.availableWorktrees);

  const normalizedCurrentDirectory = normalizePath(currentDirectory);
  const inferredWorktreeMetadata = React.useMemo(() => {
    if (!normalizedCurrentDirectory) {
      return undefined;
    }

    const fromAvailable = availableWorktrees.find(
      (metadata) => normalizePath(metadata.path) === normalizedCurrentDirectory
    );
    if (fromAvailable) {
      return fromAvailable;
    }

    for (const metadata of worktreeMap.values()) {
      if (normalizePath(metadata.path) === normalizedCurrentDirectory) {
        return metadata;
      }
    }

    return undefined;
  }, [availableWorktrees, normalizedCurrentDirectory, worktreeMap]);

  const storeWorktreeMetadata = React.useMemo(() => {
    const sessionMetadata = currentSessionId ? worktreeMap.get(currentSessionId) : undefined;
    return sessionMetadata && normalizePath(sessionMetadata.path) === normalizedCurrentDirectory
      ? sessionMetadata
      : inferredWorktreeMetadata;
  }, [currentSessionId, inferredWorktreeMetadata, normalizedCurrentDirectory, worktreeMap]);

  const worktreeAttachment = useSessionWorktreeStore((s) =>
    currentSessionId ? s.getAttachment(currentSessionId) : undefined
  );
  const authoritativeProjectRoot = worktreeAttachment && getAttachedSessionDirectory(worktreeAttachment) === normalizedCurrentDirectory
    && !worktreeAttachment.degraded && !worktreeAttachment.legacy
    ? worktreeAttachment.worktreeRoot ?? undefined
    : undefined;

  const worktreeMetadata = useDetectedWorktreeMetadata(currentDirectory, storeWorktreeMetadata, status?.current ?? undefined);

  React.useEffect(() => {
    if (!gitDirectory || !git) {
      return;
    }
    void ensureAll(gitDirectory, git);
  }, [gitDirectory, ensureAll, git]);

  const [rootBranchHint, setRootBranchHint] = React.useState<string | null>(null);
  React.useEffect(() => {
    const projectRoot = authoritativeProjectRoot || worktreeMetadata?.projectDirectory;
    if (!projectRoot) {
      setRootBranchHint(null);
      return;
    }

    let cancelled = false;
    void getRootBranch(projectRoot)
      .then((branch) => {
        if (cancelled) return;
        const normalized = branch.trim();
        setRootBranchHint(normalized && normalized !== 'HEAD' ? normalized : null);
      })
      .catch(() => {
        if (!cancelled) {
          setRootBranchHint(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authoritativeProjectRoot, worktreeMetadata?.projectDirectory]);

  const localBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => !branchName.startsWith('remotes/'))
      .sort();
  }, [branches]);

  const remoteBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => branchName.startsWith('remotes/'))
      .map((branchName: string) => branchName.replace(/^remotes\//, ''))
      .sort();
  }, [branches]);

  const currentBranch = status?.current ?? null;

  // A pull request opened against a branch that does not exist is worse than a
  // broken walkthrough, so this surface reads the repository's default branch
  // too rather than guessing at main/master/develop.
  const defaultBranch = React.useMemo(() => {
    const primaryRemote = binding.contexts[0]?.primaryRemote;
    return primaryRemote ? branches?.defaultBranches?.[primaryRemote] : undefined;
  }, [binding.contexts, branches]);

  const baseBranch = React.useMemo(() => deriveBaseBranch({
    remoteNames: new Set(binding.contexts[0]?.primaryRemote ? [binding.contexts[0].primaryRemote] : []),
    knownRemoteNames: new Set(binding.read?.repository.remotes.map((remote) => remote.name) ?? []),
    localBranches,
    worktreeCreatedFromBranch: worktreeMetadata?.createdFromBranch,
    rootBranchHint,
    defaultBranch,
    headBranch: currentBranch,
    fallbackToConventional: false,
  }), [
    currentBranch,
    defaultBranch,
    binding.contexts,
    binding.read,
    localBranches,
    rootBranchHint,
    worktreeMetadata?.createdFromBranch,
  ]);

  // Empty states name the host's own kind of change request.
  const repositoryProvider = useRepositoryHost(currentDirectory ?? null)?.provider;

  if (!currentDirectory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t(changeRequestCopy('gitView.pullRequest.title', repositoryProvider))}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t(changeRequestCopy('gitView.pullRequest.createHint', repositoryProvider))}</div>
      </div>
    );
  }

  // Non-repo root: surface nested-repository resolution while the operating
  // directory has not proven to be a repository (discovering, failed,
  // unsupported, none found, or settling on the auto-selected one).
  if (rootIsGitRepo === false && isGitRepo !== true) {
    return (
      <NestedRepoResolutionStates
        root={currentDirectory}
        rootIsGitRepo={rootIsGitRepo}
        resolvedIsGitRepo={isGitRepo}
        nestedRepos={nestedRepos}
        onRetryDiscovery={() => {
          void ensureNestedRepos(currentDirectory, { force: true });
        }}
      />
    );
  }

  if (!currentBranch) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t(changeRequestCopy('gitView.pullRequest.title', repositoryProvider))}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t(changeRequestCopy('gitView.pullRequest.createHint', repositoryProvider))}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollableOverlay
        as={ScrollShadow}
        outerClassName="h-full min-h-0 flex-1"
        // The section pads its own form; an open PR's preview fills the panel.
        className="h-full"
        disableHorizontal
        preventOverscroll
      >
        <PullRequestSection
          directory={gitDirectory ?? currentDirectory}
          branch={currentBranch}
          baseBranch={baseBranch}
          trackingBranch={status?.tracking ?? undefined}
          ahead={status?.ahead ?? 0}
          remoteBranches={remoteBranches}
        />
      </ScrollableOverlay>
    </div>
  );
};
