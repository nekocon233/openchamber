import { create } from 'zustand';
import { toast } from '@/components/ui';
import type { GitHubPullRequestRef, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const useActions = create<{ pending: Map<string, symbol> }>(() => ({ pending: new Map() }));
const actionKey = (context: SourceControlReadContext | null, pull: GitHubPullRequestRef | null) => context && pull
  ? JSON.stringify([getRuntimeKey(), context.provider, context.instance, context.accountId,
    context.provider === 'github' ? pull.owner.toLowerCase() : pull.owner,
    context.provider === 'github' ? pull.repo.toLowerCase() : pull.repo, pull.number]) : null;

export const usePullRequestActionPending = (context: SourceControlReadContext | null, pull: GitHubPullRequestRef | null) => {
  const key = actionKey(context, pull);
  return useActions(state => key !== null && state.pending.has(key));
};

/** The request keeps its lock and feedback after its originating detail leaves. */
export const beginPullRequestAction = (context: SourceControlReadContext | null, pull: GitHubPullRequestRef | null) => {
  const key = actionKey(context, pull);
  if (!key || useActions.getState().pending.has(key)) return null;
  const token = Symbol();
  const runtimeKey = getRuntimeKey(), generation = getRuntimeEndpointGeneration();
  const isRuntimeCurrent = () => getRuntimeKey() === runtimeKey && getRuntimeEndpointGeneration() === generation;
  let toastId: string | number | undefined;
  useActions.setState(state => ({ pending: new Map(state.pending).set(key, token) }));
  const unsubscribe = subscribeRuntimeEndpointChanged(() => {
    if (!isRuntimeCurrent() && toastId !== undefined) toast.dismiss(toastId);
  });
  return {
    isRuntimeCurrent,
    showProgress: (message: string) => {
      if (isRuntimeCurrent()) toastId = toast.loading(message);
      return toastId;
    },
    finish: () => {
      unsubscribe();
      if (!isRuntimeCurrent() && toastId !== undefined) toast.dismiss(toastId);
      useActions.setState(state => {
        if (state.pending.get(key) !== token) return state;
        const pending = new Map(state.pending); pending.delete(key); return { pending };
      });
    },
  };
};
