import { getRuntimeKey } from '@/lib/runtime-switch';
import { workspaceReplyDraftKey } from '@/stores/useWorkspaceDraftStore';
import { useWorkspaceDraft } from '@/hooks/useWorkspaceDraft';
import { beginPullRequestAction, usePullRequestActionPending } from './pullRequestActions';
import { PendingReviewSection } from './PendingReviewSection';
import { usePendingReview } from './usePendingReview';
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { referenceNumberLabel } from '@/components/references/referencePickerItems';
import { toast } from '@/components/ui';
import { ButtonTooltip, TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryReference, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { reviewLabelsOf } from '@/lib/source-control/reviewLabels';
import type { ChangeRequestVoteLabel, ReviewChangeRequestInput, ReviewVerdict } from '@/lib/source-control/types';
import { newMutationKey } from './mutationKey';
import { SourceBoardVotes } from './SourceBoardVotes';

type Busy = 'comment' | 'thread' | 'vote' | ReviewVerdict | null;

export const SourceBoardReply: React.FC<{
    reference: RepositoryReference;
    context: SourceControlReadContext;
    onRefresh: () => void;
    onReviewDispatched?: () => void;
    onReviewCompleted?: () => void;
    active?: boolean;
    voteLabels?: ChangeRequestVoteLabel[];
    onLatestRevision?: boolean;
    latestRevision?: string;
}> = ({ reference, context, onRefresh, onReviewDispatched, onReviewCompleted, active = true, voteLabels, onLatestRevision = true, latestRevision }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const replyInput = useWorkspaceDraft(workspaceReplyDraftKey(getRuntimeKey(), context, reference));
    const { value: text, setValue: setText } = replyInput;

    const [busy, setBusy] = React.useState<Busy>(null);
    const [votes, setVotes] = React.useState<Record<string, number>>({});

    const descriptor = useSourceControlProvider(reference.provider);
    const review = reviewLabelsOf(descriptor, { voteLabels });
    const label = referenceNumberLabel(reference, descriptor);
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    const pullRef = reference.kind === 'pull' ? { owner: project.owner, repo: project.name, number: reference.number } : null;
    const actionPending = usePullRequestActionPending(context, pullRef);
    const openPull = reference.kind === 'pull' && reference.state === 'open' ? reference : null;
    const pendingReview = usePendingReview(context, reference.kind === 'pull' && context.provider === 'github'
        ? { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo, number: reference.number } : null, active);
    // external: https://docs.gitlab.com/api/discussions/#create-a-new-thread-in-the-merge-request GitLab threads general MR comments; GitHub starts review threads on diff lines.
    const canStartThread = reference.kind === 'pull' && descriptor.features.startThread;
    const body = text.trim() ? text : null;
    const shortcut = formatShortcutForDisplay('mod+enter');

    const comment = async () => {
        if (!body || busy || actionPending) return;
        setBusy('comment');
        try {
            const payload = { ...context, idempotencyKey: newMutationKey(), target: { project, number: reference.number }, body };
            if (reference.kind === 'pull') await sourceControl.changeRequestComment(payload);
            else if (reference.kind === 'discussion') await sourceControl.discussionComment(payload);
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

    const verdictNeedsBody = review.model === 'verdict' && !body && !['github', 'gitea'].includes(context.provider)
        && review.labels[0].options.some((option) => option.verdict === 'request-changes' && option.requiresBody);
    const sendVerdict = async (verdict: Exclude<ReviewVerdict, 'comment'>) => {
        const option = review.model === 'verdict' ? review.labels[0].options.find((entry) => entry.verdict === verdict) : null;
        if (!openPull || busy || !option || (verdictNeedsBody && verdict === 'request-changes')) return;
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

    const sendVotes = async () => {
        if (!openPull || busy || actionPending || review.model !== 'votes' || Object.keys(votes).length === 0) return;
        setBusy('vote');
        try {
            const input: ReviewChangeRequestInput = {
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project, number: openPull.number, headSha: latestRevision ?? openPull.headSha },
                votes,
            };
            if (body) input.body = body;
            const receipt = await sourceControl.changeRequestReview(input);
            setVotes({});
            if (body && !receipt.result.commented) {
                toast.warning(t('sourceBoard.vote.toast.voted', { reference: label }), { description: t('sourceBoard.reply.toast.textNotPosted') });
            } else {
                replyInput.acknowledge(text);
                toast.success(t('sourceBoard.vote.toast.voted', { reference: label }));
            }
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.vote.toast.failed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
            onRefresh();
        } finally {
            setBusy(null);
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
        <section className="flex flex-col gap-2 border-t border-edge pt-4" aria-label={t('sourceBoard.reply.label')}>
            <PendingReviewSection controller={pendingReview} onSubmitted={onRefresh} onReviewDispatched={onReviewDispatched} onReviewCompleted={onReviewCompleted} />
            <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('sourceBoard.reply.placeholder')}
                aria-label={t('sourceBoard.reply.label')}
                disabled={busy !== null}
                rows={3}
            />
            {openPull && review.model === 'votes' ? (
                onLatestRevision ? (
                    <SourceBoardVotes labels={review.labels} votes={votes} onChange={setVotes} disabled={busy !== null} />
                ) : (
                    <p className="typography-meta text-muted-foreground">{t('sourceBoard.vote.olderRevision')}</p>
                )
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
                {openPull && review.model === 'votes' && onLatestRevision && review.labels.some((entry) => entry.permitted.length > 0) ? (
                    <ButtonTooltip label={t('contextTooltips.tracker.sendVotes')}>
                        <Button size="sm" variant="outline" onClick={() => void sendVotes()} disabled={busy !== null || Object.keys(votes).length === 0}>
                            {busyIcon('vote') ?? <Icon name="check" className="size-3.5" />}
                            {t('sourceBoard.vote.send')}
                        </Button>
                    </ButtonTooltip>
                ) : null}
                {openPull && !pendingReview.data?.review && review.model === 'verdict' ? (
                    <>
                        <ButtonTooltip label={t('sourceBoard.reply.requestChangesHint')}>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void sendVerdict('request-changes')}
                                disabled={busy !== null || actionPending || verdictNeedsBody || (context.provider === 'github' && (pendingReview.loading || Boolean(pendingReview.readError)))}
                            >
                                {busyIcon('request-changes') ?? <Icon name="file-edit" className="size-3.5" />}
                                {t('sourceBoard.reply.requestChanges')}
                            </Button>
                        </ButtonTooltip>
                        <ButtonTooltip label={t('contextTooltips.tracker.approve')}>
                            <Button size="sm" variant="outline" onClick={() => void sendVerdict('approve')} disabled={busy !== null || actionPending || (context.provider === 'github' && (pendingReview.loading || Boolean(pendingReview.readError)))}>
                                {busyIcon('approve') ?? <Icon name="check" className="size-3.5" />}
                                {t('sourceBoard.reply.approve')}
                            </Button>
                        </ButtonTooltip>
                    </>
                ) : null}
                {canStartThread ? (
                    <ButtonTooltip label={t('sourceBoard.reply.startThreadHint')}>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void startThread()}
                            disabled={busy !== null || !body}
                        >
                            {busyIcon('thread') ?? <Icon name="chat-thread" className="size-3.5" />}
                            {t('sourceBoard.reply.startThread')}
                        </Button>
                    </ButtonTooltip>
                ) : null}
                <ButtonTooltip label={<TooltipLabelWithShortcut label={t('sourceBoard.reply.comment')} shortcut={shortcut} />}>
                    <Button
                        size="sm"
                        onClick={() => void comment()}
                        disabled={busy !== null || !body}
                    >
                        {busyIcon('comment') ?? <Icon name="chat-1" className="size-3.5" />}
                        {t('sourceBoard.reply.comment')}
                    </Button>
                </ButtonTooltip>
            </div>
        </section>
    );
};
