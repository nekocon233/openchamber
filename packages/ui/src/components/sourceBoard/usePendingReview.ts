import * as React from 'react';
import { z } from 'zod';
import { createValueCache, useCachedValue } from '@/components/references/referenceCache';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullRequestRef, SourceControlReadContext } from '@/lib/api/types';
import type { GitHubPendingReviewAction, GitHubPendingReviewState } from '@/lib/source-control/pendingReview';
import { pendingReviewActionSignature, pendingReviewAttemptSchema } from '@/lib/source-control/pendingReview';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/useGitStore';
import { usePendingReviewDraftStore } from '@/stores/usePendingReviewDraftStore';
import { newMutationKey } from './mutationKey';
import { toast } from '@/components/ui';
import { beginPullRequestAction, usePullRequestActionPending } from './pullRequestActions';

const cache = createValueCache<GitHubPendingReviewState>(64);
const errorSchema = z.object({ code: z.string() });
const definiteFailures = new Set(['SOURCE_CONTROL_MUTATION_REJECTED', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED']);

export function usePendingReview(context: SourceControlReadContext | null, pull: GitHubPullRequestRef | null, enabled = true) {
  const { sourceControl } = useRuntimeAPIs();
  const { t } = useI18n();
  const runtimeKey = useGitStore(state => state.runtimeKey);
  const provider = context?.provider, instance = context?.instance, accountId = context?.accountId;
  const repositoryId = context?.repositoryId, bindingRevision = context?.bindingRevision, primaryRemote = context?.primaryRemote, directory = context?.directory;
  const owner = pull?.owner, repo = pull?.repo, number = pull?.number;
  const scope = React.useMemo<{ context: SourceControlReadContext; pull: GitHubPullRequestRef } | null>(() => {
    if (provider !== 'github' || !instance || !accountId || !repositoryId || bindingRevision === undefined || !primaryRemote || !directory || !owner || !repo || !number) return null;
    return { context: { provider, instance, accountId, repositoryId, bindingRevision, primaryRemote, directory }, pull: { owner, repo, number } };
  }, [provider, instance, accountId, repositoryId, bindingRevision, primaryRemote, directory, owner, repo, number]);
  const key = scope ? JSON.stringify([runtimeKey, scope]) : null;
  const read = React.useCallback(async () => {
    if (!scope || getRuntimeKey() !== runtimeKey || !sourceControl.githubPendingReview) throw new Error(t('pendingReview.loadFailed'));
    return sourceControl.githubPendingReview(scope.context, scope.pull);
  }, [runtimeKey, scope, sourceControl, t]);
  const value = useCachedValue(cache, key, read, enabled);
  const last = React.useRef<{ key: string | null; data: GitHubPendingReviewState } | null>(null);
  React.useEffect(() => { if (value.status === 'ready') last.current = { key, data: value.value }; }, [key, value]);
  const data = value.status === 'ready' ? value.value : last.current?.key === key ? last.current.data : null;
  const draftBusy = usePendingReviewDraftStore(state => key ? state.busy[key] ?? false : false);
  const actionPending = usePullRequestActionPending(context, pull);
  const busy = draftBusy || actionPending;
  const [failure, setFailure] = React.useState<{ key: string; message: string } | null>(null);

  const refresh = React.useCallback(async () => {
    if (key && enabled) await cache.ensure(key, read, { force: true }).catch(() => {});
  }, [enabled, key, read]);
  React.useEffect(() => {
    if (!enabled || !key) return;
    const revalidate = () => { if (document.visibilityState === 'visible') void cache.ensure(key, read).catch(() => {}); };
    window.addEventListener('focus', revalidate);
    return () => window.removeEventListener('focus', revalidate);
  }, [enabled, key, read]);

  const mutate = React.useCallback(async (action: GitHubPendingReviewAction, headSha: string, onSucceeded?: (currentRuntime: boolean) => void, onDispatched?: () => void): Promise<boolean> => {
    if (!scope || !key || getRuntimeKey() !== runtimeKey) return false;
    const drafts = usePendingReviewDraftStore.getState();
    if (!drafts.begin(key)) return false;
    const operation = beginPullRequestAction(scope.context, scope.pull);
    if (!operation) { drafts.end(key); return false; }
    const backgroundReview = action.kind === 'submit' && action.verdict !== 'comment' && Boolean(onDispatched);
    const reference = `${scope.pull.owner}/${scope.pull.repo} #${scope.pull.number}`;
    let toastId: string | number | undefined;
    const fingerprint = JSON.stringify([headSha, action]);
    const signature = pendingReviewActionSignature(headSha, action);
    const previous = drafts.attempts[key]?.find(attempt => attempt.signature === signature);
    let requestAction = action;
    if (previous) {
      try {
        const [revision, restored] = pendingReviewAttemptSchema.parse(JSON.parse(previous.fingerprint));
        if (pendingReviewActionSignature(revision, restored) === signature) requestAction = restored;
      } catch { /* A malformed local record cannot replace the current action. */ }
    }
    const idempotencyKey = previous ? previous.key : newMutationKey();
    if (!drafts.setAttempt(key, { signature, fingerprint, key: idempotencyKey })) {
      setFailure({ key, message: t('pendingReview.draftLimit') }); drafts.end(key); operation.finish(); return false;
    }
    setFailure(null);
    try {
      if (!sourceControl.githubPendingReviewAction) throw new Error(t('pendingReview.actionFailed'));
      const request = sourceControl.githubPendingReviewAction({ ...scope.context, idempotencyKey,
        target: { project: { owner: scope.pull.owner, name: scope.pull.repo }, number: scope.pull.number, headSha }, action: requestAction });
      if (backgroundReview && action.kind === 'submit') {
        toastId = operation.showProgress(t(action.verdict === 'approve' ? 'sourceBoard.reply.toast.approving' : 'sourceBoard.reply.toast.requestingChanges', { reference }));
        onDispatched?.();
      }
      await request;
      usePendingReviewDraftStore.getState().clearAttempt(key, signature);
      if (action.kind === 'submit' && operation.isRuntimeCurrent()) {
        if (backgroundReview) toast.success(t(action.verdict === 'approve' ? 'sourceBoard.reply.toast.approved' : 'sourceBoard.reply.toast.changesRequested', { reference }), { id: toastId });
        else toast.success(t('pendingReview.submitted'));
      }
      onSucceeded?.(operation.isRuntimeCurrent());
      if (operation.isRuntimeCurrent()) await cache.ensure(key, read, { force: true }).catch(() => {});
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : t('pendingReview.actionFailed');
      const parsedError = errorSchema.safeParse(error);
      const code = parsedError.success ? parsedError.data.code : null;
      // Lock, transport and replay conflicts cannot prove the first write did
      // not land. Only a definite refusal permits a fresh request key.
      if (code && definiteFailures.has(code)) {
        usePendingReviewDraftStore.getState().clearAttempt(key, signature);
      }
      setFailure({ key, message });
      if (backgroundReview && operation.isRuntimeCurrent()) toast.error(t('sourceBoard.reply.toast.reviewFailed', { reference }), { id: toastId, description: message });
      if (operation.isRuntimeCurrent()) await cache.ensure(key, read, { force: true }).catch(() => {});
      return false;
    } finally { usePendingReviewDraftStore.getState().end(key); operation.finish(); }
  }, [key, read, runtimeKey, scope, sourceControl, t]);

  return { key, data, busy, mutate, refresh,
    loading: value.status === 'idle' || value.status === 'loading',
    readError: value.status === 'error' ? value.error : null,
    error: failure?.key === key ? failure.message : null,
  };
}
export type PendingReviewController = ReturnType<typeof usePendingReview>;
