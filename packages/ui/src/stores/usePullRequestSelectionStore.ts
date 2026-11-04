import { create } from 'zustand';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import type { BoardLinkFailureBehavior } from './useSourceBoardStore';

export interface PullRequestOpenRequest {
  runtimeKey: string;
  workspaceDirectory: string;
  sourceDirectory: string;
  url: string;
  failureBehavior: BoardLinkFailureBehavior;
}

export type PullRequestReturnLocation = {
  workspaceDirectory: string;
} & ({ tab: 'project' | 'branch' } | { tab: 'linked'; request: PullRequestOpenRequest });

type PullRequestDiffOrigin = PullRequestReturnLocation & {
  reference: GitHubPullReference;
  context: SourceControlReadContext;
  restoreWorkspace?: () => void;
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
  requestOpen: (request: Omit<PullRequestOpenRequest, 'runtimeKey'>) => boolean;
  settleOpenRequest: (request: PullRequestOpenRequest) => void;
  resetOpenRequests: () => void;
  selections: Map<string, PullRequestSelection>;
  /** A pull request another surface asked Changes to show, per directory. */
  diffRequests: Map<string, PullRequestSource>;
  diffReturnTargets: Map<string, PullRequestReturnTarget>;
  returnRequests: Map<string, PullRequestReturnTarget>;
  select: (key: string, source: PullRequestSource) => void;
  acceptHandoff: (key: string, source: PullRequestSource) => void;
  /** Each call is a new request, so asking for the same PR again shows it again. */
  requestDiff: (directory: string, source: PullRequestSource, origin?: PullRequestDiffOrigin) => void;
  /** Drops `source` once Changes has taken it, so it never comes back on another branch. */
  settleDiffRequest: (directory: string, source: PullRequestSource) => void;
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
      return { returnRequests, openRequests: rememberRequest(state.openRequests,
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
  resetOpenRequests: () => set({ openRequests: new Map() }),
  selections: new Map(),
  diffRequests: new Map(),
  diffReturnTargets: new Map(),
  returnRequests: new Map(),
  select: (key, source) => set((state) => remember(state, key, { source, handoff: state.selections.get(key)?.handoff ?? null })),
  // A retained request is consumed once even if the walkthrough tab remounts.
  acceptHandoff: (key, source) => set((state) => state.selections.get(key)?.handoff === source
    ? state : remember(state, key, { source, handoff: source })),
  requestDiff: (directory, source, origin) => set((state) => {
    const diffRequests = new Map(state.diffRequests);
    const request = { ...source };
    diffRequests.set(directory, request);
    const runtimeKey = getRuntimeKey();
    const key = pullRequestNavigationKey(runtimeKey, directory);
    const diffReturnTargets = origin
      ? rememberRequest(state.diffReturnTargets, key, { ...origin, runtimeKey, directory, source: request })
      : new Map(state.diffReturnTargets);
    if (!origin) diffReturnTargets.delete(key);
    return { diffRequests, diffReturnTargets };
  }),
  settleDiffRequest: (directory, source) => set((state) => {
    if (state.diffRequests.get(directory) !== source) return state;
    const diffRequests = new Map(state.diffRequests);
    diffRequests.delete(directory);
    return { diffRequests };
  }),
  requestReturn: (target) => {
    const key = pullRequestNavigationKey(target.runtimeKey, target.directory);
    if (target.runtimeKey !== getRuntimeKey() || get().diffReturnTargets.get(key) !== target) return false;
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
