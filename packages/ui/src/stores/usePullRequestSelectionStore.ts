import { create } from 'zustand';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import type { BoardLinkFailureBehavior } from './useSourceBoardStore';
import type { NavigationReturn } from '@/sync/navigation-return';
import { useWorkspaceViewStateStore, workspaceRepositoryIdentity, workspaceViewKey } from './useWorkspaceViewStateStore';

const diffRequestAuthorities = new WeakMap<PullRequestSource, { runtimeKey: string; directory: string; identity: string | null }>();
export const getPullRequestRequestAuthority = (source: PullRequestSource) => diffRequestAuthorities.get(source);

export interface PullRequestOpenRequest {
  runtimeKey: string;
  workspaceDirectory: string;
  sourceDirectory: string;
  url: string;
  failureBehavior: BoardLinkFailureBehavior;
}

interface CiRunOpenRequest {
  runtimeKey: string;
  workspaceDirectory: string;
  sourceDirectory: string;
  runId: string;
}

export type PullRequestReturnLocation = {
  workspaceDirectory: string;
} & ({ tab: 'project' | 'branch' } | { tab: 'linked'; request: PullRequestOpenRequest });

type PullRequestDiffOrigin = PullRequestReturnLocation & {
  reference: GitHubPullReference;
  context: SourceControlReadContext;
  restoreWorkspace?: () => void;
  navigationReturn?: NavigationReturn | null;
};

type PullRequestReturnTarget = PullRequestDiffOrigin & {
  runtimeKey: string;
  directory: string;
  source: PullRequestSource;
};

export const pullRequestNavigationKey = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory]);

const rememberRequest = <T,>(entries: Map<string, T>, key: string, value: T) => {
  const next = new Map(entries);
  next.delete(key); next.set(key, value);
  if (next.size > 100) {
    const oldest = next.keys().next().value;
    if (oldest !== undefined) next.delete(oldest);
  }
  return next;
};

interface PullRequestSelection {
  source: PullRequestSource;
  handoff: PullRequestSource | null;
}

interface PullRequestSelectionState {
  openRequests: Map<string, PullRequestOpenRequest>;
  ciOpenRequests: Map<string, CiRunOpenRequest>;
  requestOpen: (request: Omit<PullRequestOpenRequest, 'runtimeKey'>) => boolean;
  settleOpenRequest: (request: PullRequestOpenRequest) => void;
  requestCiRun: (workspaceDirectory: string, sourceDirectory: string, runId: string) => boolean;
  settleCiRunRequest: (request: CiRunOpenRequest) => void;
  resetOpenRequests: () => void;
  selections: Map<string, PullRequestSelection>;
  /** A pull request another surface asked Changes to show, per directory. */
  diffRequests: Map<string, PullRequestSource>;
  changesRepositories: Map<string, string>;
  diffReturnTargets: Map<string, PullRequestReturnTarget>;
  returnRequests: Map<string, PullRequestReturnTarget>;
  select: (key: string, source: PullRequestSource) => void;
  acceptHandoff: (key: string, source: PullRequestSource) => void;
  /** Each call is a new request, so asking for the same PR again shows it again. */
  requestDiff: (directory: string, source: PullRequestSource, originOrRepository?: PullRequestDiffOrigin | string | null, authority?: SourceControlReadContext) => void;
  clearChangesRepository: (directory: string) => void;
  /** Drops `source` once Changes has taken it, so it never comes back on another branch. */
  settleDiffRequest: (directory: string, source: PullRequestSource) => void;
  bindDiffRequest: (directory: string, source: PullRequestSource, context: SourceControlReadContext) => void;
  requestReturn: (target: PullRequestReturnTarget) => boolean;
  settleReturnRequest: (target: PullRequestReturnTarget) => void;
}

const remember = (state: PullRequestSelectionState, key: string, selection: PullRequestSelection) => {
  const selections = new Map(state.selections);
  selections.delete(key);
  selections.set(key, selection);
  if (selections.size > 100) {
    const oldest = selections.keys().next().value;
    if (oldest !== undefined) selections.delete(oldest);
  }
  return { selections };
};

// Keys are runtime/directory/branch tuples supplied by usePullRequestComparison.
export const usePullRequestSelectionStore = create<PullRequestSelectionState>((set, get) => ({
  openRequests: new Map(),
  ciOpenRequests: new Map(),
  requestOpen: (request) => {
    const workspaceDirectory = normalizePath(request.workspaceDirectory);
    const sourceDirectory = normalizePath(request.sourceDirectory);
    const reference = parseChangeRequestReference(request.url);
    if (!workspaceDirectory || !sourceDirectory || reference?.identity?.provider !== 'github' || !reference.project) return false;
    const runtimeKey = getRuntimeKey();
    const key = pullRequestNavigationKey(runtimeKey, workspaceDirectory);
    set(state => {
      const returnRequests = new Map(state.returnRequests);
      returnRequests.delete(key);
      const ciOpenRequests = new Map(state.ciOpenRequests);
      ciOpenRequests.delete(key);
      return { returnRequests, ciOpenRequests, openRequests: rememberRequest(state.openRequests,
        key, { ...request, runtimeKey, workspaceDirectory, sourceDirectory }) };
    });
    return true;
  },
  settleOpenRequest: (request) => set(state => {
    const key = pullRequestNavigationKey(request.runtimeKey, request.workspaceDirectory);
    if (state.openRequests.get(key) !== request) return state;
    const openRequests = new Map(state.openRequests);
    openRequests.delete(key);
    return { openRequests };
  }),
  requestCiRun: (rawWorkspaceDirectory, rawSourceDirectory, rawRunId) => {
    const workspaceDirectory = normalizePath(rawWorkspaceDirectory);
    const sourceDirectory = normalizePath(rawSourceDirectory);
    const runId = rawRunId.trim();
    if (!workspaceDirectory || !sourceDirectory || !/^[1-9]\d*$/.test(runId)) return false;
    const runtimeKey = getRuntimeKey();
    const key = pullRequestNavigationKey(runtimeKey, workspaceDirectory);
    set((state) => {
      const openRequests = new Map(state.openRequests);
      openRequests.delete(key);
      const returnRequests = new Map(state.returnRequests);
      returnRequests.delete(key);
      return {
        openRequests,
        returnRequests,
        ciOpenRequests: rememberRequest(state.ciOpenRequests, key, {
          runtimeKey,
          workspaceDirectory,
          sourceDirectory,
          runId,
        }),
      };
    });
    return true;
  },
  settleCiRunRequest: (request) => set((state) => {
    const key = pullRequestNavigationKey(request.runtimeKey, request.workspaceDirectory);
    if (state.ciOpenRequests.get(key) !== request) return state;
    const ciOpenRequests = new Map(state.ciOpenRequests);
    ciOpenRequests.delete(key);
    return { ciOpenRequests };
  }),
  resetOpenRequests: () => set({ openRequests: new Map(), ciOpenRequests: new Map() }),
  selections: new Map(),
  diffRequests: new Map(),
  changesRepositories: new Map(),
  diffReturnTargets: new Map(),
  returnRequests: new Map(),
  select: (key, source) => set((state) => remember(state, key, { source, handoff: state.selections.get(key)?.handoff ?? null })),
  // A retained request is consumed once even if the walkthrough tab remounts.
  acceptHandoff: (key, source) => set((state) => state.selections.get(key)?.handoff === source
    ? state : remember(state, key, { source, handoff: source })),
  requestDiff: (directory, source, originOrRepository, authority) => set((state) => {
    const diffRequests = new Map(state.diffRequests);
    const request = { ...source };
    const context = originOrRepository && typeof originOrRepository === 'object' ? originOrRepository.context : authority;
    const identity = context ? workspaceRepositoryIdentity(context) : null;
    diffRequestAuthorities.set(request, { runtimeKey: getRuntimeKey(), directory, identity });
    diffRequests.set(directory, request);
    const owner = workspaceViewKey(getRuntimeKey(), directory, 'pr-navigation');
    if (owner) useWorkspaceViewStateStore.getState().update('changes', owner, previous => ({
      ...previous,
      pullRequest: identity && source.sourceRepo ? { ...source, sourceRepo: source.sourceRepo } : null,
      pullRequestIdentity: identity,
      returnTo: originOrRepository && typeof originOrRepository === 'object' && source.sourceRepo ? {
        workspaceDirectory: originOrRepository.workspaceDirectory,
        sourceDirectory: originOrRepository.context.directory,
        tab: originOrRepository.tab,
        url: originOrRepository.reference.url,
        repositoryIdentity: workspaceRepositoryIdentity(originOrRepository.context),
        source: { ...source, sourceRepo: source.sourceRepo },
        navigation: originOrRepository.navigationReturn ?? null,
      } : null,
    }));
    if (typeof originOrRepository === 'string' || originOrRepository === null) {
      if (!originOrRepository && !state.changesRepositories.has(directory)) return { diffRequests };
      const changesRepositories = new Map(state.changesRepositories);
      if (originOrRepository) changesRepositories.set(directory, originOrRepository);
      else changesRepositories.delete(directory);
      return { diffRequests, changesRepositories };
    }
    const origin = originOrRepository;
    const runtimeKey = getRuntimeKey();
    const key = pullRequestNavigationKey(runtimeKey, directory);
    const diffReturnTargets = origin
      ? rememberRequest(state.diffReturnTargets, key, { ...origin, runtimeKey, directory, source: request })
      : new Map(state.diffReturnTargets);
    if (!origin) diffReturnTargets.delete(key);
    return { diffRequests, diffReturnTargets };
  }),
  clearChangesRepository: (directory) => set((state) => {
    if (!state.changesRepositories.has(directory)) return state;
    const changesRepositories = new Map(state.changesRepositories);
    changesRepositories.delete(directory);
    return { changesRepositories };
  }),
  settleDiffRequest: (directory, source) => set((state) => {
    if (state.diffRequests.get(directory) !== source) return state;
    const diffRequests = new Map(state.diffRequests);
    diffRequests.delete(directory);
    return { diffRequests };
  }),
  // An external URL starts as intent, not a choice for an unknown account.
  // Resolve it once; replacing the object makes a later rebind reject it.
  bindDiffRequest: (directory, source, context) => set(state => {
    const authority = diffRequestAuthorities.get(source);
    if (!authority || authority.runtimeKey !== getRuntimeKey() || authority.identity !== null
      || state.diffRequests.get(directory) !== source) return state;
    const bound = { ...source };
    diffRequestAuthorities.set(bound, { ...authority, identity: workspaceRepositoryIdentity(context) });
    const diffRequests = new Map(state.diffRequests); diffRequests.set(directory, bound); return { diffRequests };
  }),
  requestReturn: (target) => {
    const key = pullRequestNavigationKey(target.runtimeKey, target.directory);
    if (target.runtimeKey !== getRuntimeKey() || get().diffReturnTargets.get(key) !== target) return false;
    const owner = workspaceViewKey(target.runtimeKey, target.directory, 'pr-navigation');
    if (owner) useWorkspaceViewStateStore.getState().update('changes', owner, previous => ({ ...previous, returnTo: null }));
    set(state => {
      const diffReturnTargets = new Map(state.diffReturnTargets);
      diffReturnTargets.delete(key);
      const workspaceKey = pullRequestNavigationKey(target.runtimeKey, target.workspaceDirectory);
      const openRequests = new Map(state.openRequests);
      openRequests.delete(workspaceKey);
      return { diffReturnTargets, openRequests, returnRequests: rememberRequest(state.returnRequests, workspaceKey, target) };
    });
    return true;
  },
  settleReturnRequest: (target) => set(state => {
    const key = pullRequestNavigationKey(target.runtimeKey, target.workspaceDirectory);
    if (state.returnRequests.get(key) !== target) return state;
    const returnRequests = new Map(state.returnRequests);
    returnRequests.delete(key);
    return { returnRequests };
  }),
}));
