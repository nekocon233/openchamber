import { create } from 'zustand';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

export interface PullRequestReturnLocation {
  workspaceDirectory: string;
  tab: 'project' | 'branch';
}

interface PullRequestDiffOrigin extends PullRequestReturnLocation {
  reference: GitHubPullReference;
  context: SourceControlReadContext;
}

interface PullRequestReturnTarget extends PullRequestDiffOrigin {
  runtimeKey: string;
  directory: string;
  source: PullRequestSource;
}

export const pullRequestNavigationKey = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory]);

const rememberReturn = (entries: Map<string, PullRequestReturnTarget>, key: string, value: PullRequestReturnTarget) => {
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
      ? rememberReturn(state.diffReturnTargets, key, { ...origin, runtimeKey, directory, source: request })
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
      return { diffReturnTargets, returnRequests: rememberReturn(state.returnRequests,
        pullRequestNavigationKey(target.runtimeKey, target.workspaceDirectory), target) };
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
