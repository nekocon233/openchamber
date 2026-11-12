import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { referenceNumberLabel } from '@/components/references/referencePickerItems';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubReference, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import type { ReviewChangeRequestInput, ReviewVerdict } from '@/lib/source-control/types';
import { newMutationKey } from './mutationKey';
import { usePendingReview } from './usePendingReview';
import { PendingReviewSection } from './PendingReviewSection';
import { useWorkspaceDraft } from '@/hooks/useWorkspaceDraft';
import { workspaceReplyDraftKey } from '@/stores/useWorkspaceDraftStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { beginPullRequestAction, usePullRequestActionPending } from './pullRequestActions';

type Busy = 'comment' | 'thread' | ReviewVerdict | null;

/**
 * Below an issue's or pull request's activity: write a comment, or on an
 * open pull request approve it or request changes with the text as the
 * review's body. The text stays in the box until the host has it.
 */
export const SourceBoardReply: React.FC<{
    reference: GitHubReference;
    context: SourceControlReadContext;
    /**
     * The item's feed and the list read again: after a write so it shows, and
     * after a refused review, which is most often a push since the preview
     * was read.
     */
    onRefresh: () => void;
    onReviewDispatched?: () => void;
    onReviewCompleted?: () => void;
    active?: boolean;
}> = ({ reference, context, onRefresh, onReviewDispatched, onReviewCompleted, active = true }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const replyInput = useWorkspaceDraft(workspaceReplyDraftKey(getRuntimeKey(), context, reference));
    const { value: text, setValue: setText } = replyInput;
    const [busy, setBusy] = React.useState<Busy>(null);

    const label = referenceNumberLabel(reference);
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    const pullRef = reference.kind === 'pull' ? { owner: project.owner, repo: project.name, number: reference.number } : null;
    const actionPending = usePullRequestActionPending(context, pullRef);
    const openPull = reference.kind === 'pull' && reference.state === 'open' ? reference : null;
    const pendingReview = usePendingReview(context, reference.kind === 'pull' && reference.provider !== 'gitlab'
        ? { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo, number: reference.number } : null, active);
    // GitLab threads any merge request comment; GitHub's only start from a line in a review.
    const canStartThread = reference.kind === 'pull' && reference.provider === 'gitlab';
    const body = text.trim() ? text : null;
    const shortcut = formatShortcutForDisplay('mod+enter');

    const comment = async () => {
        if (!body || busy || actionPending) return;
        setBusy('comment');
        try {
            const payload = { ...context, idempotencyKey: newMutationKey(), target: { project, number: reference.number }, body };
            if (reference.kind === 'pull') await sourceControl.changeRequestComment(payload);
            else await sourceControl.issueComment(payload);
            replyInput.acknowledge(text);
            toast.success(t('sourceBoard.reply.toast.commented', { reference: label }));
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.reply.toast.commentFailed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(null);
        }
    };

    const startThread = async () => {
        if (!body || busy || actionPending || !canStartThread) return;
        setBusy('thread');
        try {
            await sourceControl.changeRequestStartThread({ ...context, idempotencyKey: newMutationKey(), target: { project, number: reference.number }, body });
            replyInput.acknowledge(text);
            toast.success(t('sourceBoard.reply.toast.threadStarted', { reference: label }));
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.reply.toast.commentFailed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(null);
        }
    };

    const review = async (verdict: Exclude<ReviewVerdict, 'comment'>) => {
        if (!openPull || busy) return;
        const action = beginPullRequestAction(context, pullRef);
        if (!action) return;
        setBusy(verdict);
        let toastId: string | number | undefined;
        const background = Boolean(onReviewDispatched);
        const feedbackReference = background ? `${project.owner}/${project.name} ${label}` : label;
        try {
            const input: ReviewChangeRequestInput = {
                ...context,
                idempotencyKey: newMutationKey(),
                // The verdict is for the commit shown; a push since refuses it.
                target: { project, number: openPull.number, headSha: openPull.headSha },
                verdict,
            };
            if (body) input.body = body;
            const request = sourceControl.changeRequestReview(input);
            if (background) {
                toastId = action.showProgress(t(verdict === 'approve' ? 'sourceBoard.reply.toast.approving' : 'sourceBoard.reply.toast.requestingChanges', { reference: feedbackReference }));
                onReviewDispatched?.();
            }
            const receipt = await request;
            const doneKey = verdict === 'approve' ? 'sourceBoard.reply.toast.approved' : 'sourceBoard.reply.toast.changesRequested';
            if (body && !receipt.result.commented) {
                // GitLab posts the verdict and its text separately: the verdict
                // stands, the text stays here to post again.
                if (action.isRuntimeCurrent()) toast.warning(t(doneKey, { reference: feedbackReference }), { id: toastId, description: t('sourceBoard.reply.toast.textNotPosted') });
            } else {
                replyInput.acknowledge(text);
                if (action.isRuntimeCurrent()) toast.success(t(doneKey, { reference: feedbackReference }), { id: toastId });
            }
            if (action.isRuntimeCurrent()) (onReviewCompleted ?? onRefresh)();
        } catch (error) {
            if (action.isRuntimeCurrent()) {
                toast.error(t('sourceBoard.reply.toast.reviewFailed', { reference: feedbackReference }), { id: toastId, description: error instanceof Error ? error.message : String(error) });
                onRefresh();
            }
        } finally {
            setBusy(null);
            action.finish();
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isIMECompositionEvent(event)) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void comment();
        }
    };

    const busyIcon = (kind: Busy) => (busy === kind ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null);

    return (
      <>
        <PendingReviewSection controller={pendingReview} onSubmitted={onRefresh} onReviewDispatched={onReviewDispatched} onReviewCompleted={onReviewCompleted} />
        <section className="flex flex-col gap-2 border-t border-border/60 pt-4" aria-label={t('sourceBoard.reply.label')}>
            <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('sourceBoard.reply.placeholder')}
                aria-label={t('sourceBoard.reply.label')}
                disabled={busy !== null || actionPending}
                rows={3}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
                {openPull && !pendingReview.data?.review ? (
                    <>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void review('request-changes')}
                            disabled={busy !== null || actionPending || (context.provider === 'github' && (pendingReview.loading || Boolean(pendingReview.readError)))}
                        >
                            {busyIcon('request-changes') ?? <Icon name="file-edit" className="size-3.5" />}
                            {t('sourceBoard.reply.requestChanges')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void review('approve')} disabled={busy !== null || actionPending || (context.provider === 'github' && (pendingReview.loading || Boolean(pendingReview.readError)))}>
                            {busyIcon('approve') ?? <Icon name="check" className="size-3.5" />}
                            {t('sourceBoard.reply.approve')}
                        </Button>
                    </>
                ) : null}
                {canStartThread ? (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void startThread()}
                        disabled={busy !== null || actionPending || !body}
                        title={t('sourceBoard.reply.startThreadHint')}
                    >
                        {busyIcon('thread') ?? <Icon name="chat-thread" className="size-3.5" />}
                        {t('sourceBoard.reply.startThread')}
                    </Button>
                ) : null}
                <Button
                    size="sm"
                    onClick={() => void comment()}
                    disabled={busy !== null || actionPending || !body}
                    title={t('sourceBoard.reply.commentShortcut', { shortcut })}
                >
                    {busyIcon('comment') ?? <Icon name="chat-1" className="size-3.5" />}
                    {t('sourceBoard.reply.comment')}
                </Button>
            </div>
        </section>
      </>
    );
};
