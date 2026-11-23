import * as React from 'react';

import { invalidateProjectPullLists } from '@/components/references/referenceSources';
import { newMutationKey } from '@/components/sourceBoard/mutationKey';
import { beginPullRequestAction, usePullRequestActionPending } from '@/components/sourceBoard/pullRequestActions';
import { toast } from '@/components/ui';
import { readComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { formatChangeRequestLabel } from '@/lib/source-control/providers/terminology';
import type {
    ChangeRequest,
    ChangeRequestReviewState,
    ReviewCommentPosition,
    ReviewThread,
    ReviewVerdict,
    SourceControlProvider,
    SourceControlReadContext,
} from '@/lib/source-control/types';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { workspaceRepositoryIdentity, workspaceViewKey } from '@/stores/useWorkspaceViewStateStore';

export type ChangeRequestReviewTarget = {
    context: SourceControlReadContext;
    provider: SourceControlProvider;
    project: { owner: string; name: string };
    number: number;
    headSha: string | undefined;
    directory: string;
};

export type ReviewSubmission = { body?: string } & (
    | { verdict: ReviewVerdict; votes?: never }
    | { votes: Record<string, number>; verdict?: never; publishDrafts?: boolean }
);

export type ChangeRequestReview = {
    state: ChangeRequestReviewState | null;
    readFailed: boolean;
    submissionPending: boolean;
    summaryDraftKey: string;
    fileComments: boolean;
    addComment: (position: ReviewCommentPosition, body: string, headSha?: string) => Promise<boolean>;
    updateComment: (commentId: string, body: string) => Promise<boolean>;
    deleteComment: (commentId: string) => Promise<boolean>;
    reply: (threadId: string, body: string) => Promise<boolean>;
    setResolved: (threadId: string, resolved: boolean) => Promise<boolean>;
    attachThread: (thread: ReviewThread) => void;
    submit: (submission: ReviewSubmission, onVerdictDispatched?: () => void) => Promise<boolean>;
    discard: () => Promise<boolean>;
};

const threadForAgent = (thread: ReviewThread): string => thread.comments
    .map((comment) => `@${comment.author?.login ?? 'unknown'}: ${comment.body}`)
    .join('\n\n');

export function useChangeRequestReview(target: ChangeRequestReviewTarget | null): ChangeRequestReview | null {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const descriptor = useSourceControlProvider(target?.provider);
    const available = Boolean(target && descriptor.features.reviewDrafts);
    const context = target?.context ?? null;
    const owner = target?.project.owner;
    const name = target?.project.name;
    const number = target?.number;
    const headSha = target?.headSha;
    const directory = target?.directory ?? null;
    const [state, setState] = React.useState<ChangeRequestReviewState | null>(null);
    const [readFailed, setReadFailed] = React.useState(false);

    const runtime = getRuntimeKey();
    const reviewKey = available && context && owner !== undefined && name && number
        ? workspaceViewKey(runtime, context.directory, 'review', workspaceRepositoryIdentity(context), owner, name, number)
        : null;
    const pullRef = React.useMemo(() => (
        reviewKey && owner !== undefined && name && number ? { owner, repo: name, number } : null
    ), [name, number, owner, reviewKey]);
    const submissionPending = usePullRequestActionPending(context, pullRef);
    const currentKey = React.useRef<string | null>(null);
    const readSequence = React.useRef(0);
    const read = React.useCallback(async () => {
        if (!reviewKey || !context || owner === undefined || !name || !number || currentKey.current !== reviewKey) return;
        readSequence.current += 1;
        const sequence = readSequence.current;
        const isCurrent = () => sequence === readSequence.current && currentKey.current === reviewKey;
        try {
            const result = await sourceControl.changeRequestReviewState(context, { owner, repo: name, number });
            if (!isCurrent()) return;
            if (result.connected) {
                const { viewerIsAuthor, headSha: liveHead, draft, threads, truncated } = result;
                const next = { viewerIsAuthor, headSha: liveHead, draft, threads, truncated };
                setState((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
            }
            setReadFailed(!result.connected);
        } catch {
            if (isCurrent()) setReadFailed(true);
        }
    }, [context, name, number, owner, reviewKey, sourceControl]);
    const readLatest = React.useRef(read);
    React.useEffect(() => { readLatest.current = read; }, [read]);

    React.useEffect(() => {
        currentKey.current = reviewKey;
        setState(null);
        setReadFailed(false);
        void readLatest.current();
        return () => { currentKey.current = null; };
    }, [reviewKey]);

    React.useEffect(() => {
        if (!reviewKey) return undefined;
        const onReturn = () => {
            if (document.visibilityState === 'visible') void read();
        };
        window.addEventListener('focus', onReturn);
        document.addEventListener('visibilitychange', onReturn);
        const releaseEvents = subscribeOpenchamberEvents((event) => {
            if (event.type === 'source-control-activity' && event.directory === directory) void read();
        });
        return () => {
            window.removeEventListener('focus', onReturn);
            document.removeEventListener('visibilitychange', onReturn);
            releaseEvents();
        };
    }, [directory, read, reviewKey]);

    return React.useMemo(() => {
        if (!reviewKey || !context || owner === undefined || !name || !number) return null;
        const project = { owner, name };
        const existing = { project, number };
        const reviewed = { ...existing, headSha: headSha ?? state?.headSha };
        const label = formatChangeRequestLabel(descriptor, number);
        const write = async <T,>(perform: () => Promise<T>, failure: string): Promise<boolean> => {
            try {
                await perform();
                await read();
                return true;
            } catch (error) {
                toast.error(failure, { description: error instanceof Error ? error.message : String(error) });
                await read();
                return false;
            }
        };
        const mutation = () => ({ ...context, idempotencyKey: newMutationKey() });
        return {
            state,
            readFailed,
            submissionPending,
            summaryDraftKey: reviewKey,
            fileComments: descriptor.features.reviewDraftFileComments,
            addComment: (position, body, commentHead = reviewed.headSha) => write(
                () => sourceControl.changeRequestReviewComment({ ...mutation(), target: { ...reviewed, headSha: commentHead }, ...position, body }),
                t('review.toast.addFailed', { reference: label }),
            ),
            updateComment: (commentId, body) => write(
                () => sourceControl.changeRequestReviewCommentUpdate({ ...mutation(), target: existing, commentId, body }),
                t('review.toast.updateFailed', { reference: label }),
            ),
            deleteComment: (commentId) => write(
                () => sourceControl.changeRequestReviewCommentDelete({ ...mutation(), target: existing, commentId }),
                t('review.toast.deleteFailed', { reference: label }),
            ),
            reply: (threadId, body) => write(
                () => sourceControl.changeRequestReplyToThread({ ...mutation(), target: existing, threadId, body }),
                t('sourceBoard.thread.toast.replyFailed', { reference: label }),
            ),
            setResolved: (threadId, resolved) => write(
                () => sourceControl.changeRequestResolveThread({ ...mutation(), target: existing, threadId, resolved }),
                t(resolved ? 'sourceBoard.thread.toast.resolveFailed' : 'sourceBoard.thread.toast.unresolveFailed', { reference: label }),
            ),
            attachThread: (thread) => {
                const into = readComposerDraftTarget(directory);
                if (!into) {
                    toast.error(t('gitView.pr.toast.noActiveSession'), { description: t('gitView.pr.toast.noActiveSessionDescription') });
                    return;
                }
                const lines = thread.line === null ? '' : `:${thread.line}`;
                const draftId = useInlineCommentDraftStore.getState().addDraft(into, {
                    source: 'pr-comment',
                    fileLabel: `${label} · ${thread.path}${lines}`,
                    startLine: 0,
                    endLine: 0,
                    code: threadForAgent(thread),
                    language: 'markdown',
                    text: '',
                    provider: target?.provider,
                });
                if (!draftId) toast.error(t('inlineComment.toast.noRoom'));
            },
            submit: async (submission, onVerdictDispatched) => {
                if (currentKey.current !== reviewKey) return false;
                const action = beginPullRequestAction(context, pullRef);
                if (!action) return false;
                const verdict = submission.verdict;
                const background = verdict === 'approve' || verdict === 'request-changes' ? onVerdictDispatched : undefined;
                const reference = background ? `${owner}/${name} ${label}` : label;
                let toastId: string | number | undefined;
                try {
                    const request = sourceControl.changeRequestReview({ ...mutation(), target: reviewed, ...submission });
                    if (background) {
                        toastId = action.showProgress(t(verdict === 'approve' ? 'sourceBoard.reply.toast.approving' : 'sourceBoard.reply.toast.requestingChanges', { reference }));
                        background();
                    }
                    const receipt = await request;
                    const posted = !background || !submission.body || receipt.result.commented;
                    if (action.isRuntimeCurrent()) {
                        const done = t(background
                            ? verdict === 'approve' ? 'sourceBoard.reply.toast.approved' : 'sourceBoard.reply.toast.changesRequested'
                            : 'review.toast.submitted', { reference });
                        if (posted) toast.success(done, { id: toastId });
                        else toast.warning(done, { id: toastId, description: t('sourceBoard.reply.toast.textNotPosted') });
                        if (background) {
                            void sourceControl.refreshProviderReads(context, { lists: true }).then(() => {
                                if (action.isRuntimeCurrent()) invalidateProjectPullLists(context, runtime);
                            }).catch((error) => {
                                if (action.isRuntimeCurrent()) toast.error(t('references.projectPulls.refreshFailed'), { description: error instanceof Error ? error.message : String(error) });
                            });
                        }
                    }
                    return posted;
                } catch (error) {
                    if (action.isRuntimeCurrent()) toast.error(t('review.toast.submitFailed', { reference }), { id: toastId, description: error instanceof Error ? error.message : String(error) });
                    return false;
                } finally {
                    await read();
                    action.finish();
                }
            },
            discard: () => write(
                () => sourceControl.changeRequestReviewDiscard({ ...mutation(), target: existing }),
                t('review.toast.discardFailed', { reference: label }),
            ),
        };
    }, [context, descriptor, directory, headSha, name, number, owner, pullRef, read, readFailed, reviewKey, runtime, sourceControl, state, submissionPending, t, target?.provider]);
}

type ComparisonReview = { review: ChangeRequestReview | null; provider: SourceControlProvider | null };

export function useComparisonReview(
    comparison: {
        selectedSource: PullRequestSource | null;
        prs: ChangeRequest[];
        readContext: SourceControlReadContext | null;
        provider: SourceControlProvider | null;
    },
    directory: string | null | undefined,
    enabled: boolean,
    comparedHead?: string | null,
): ComparisonReview {
    const { selectedSource: source, prs, readContext, provider } = comparison;
    const record = source ? prs.find((pr) => pr.number === source.number) : undefined;
    const owner = source?.sourceRepo?.owner ?? record?.project.owner;
    const name = source?.sourceRepo?.repo ?? record?.project.name;
    const number = source?.number;
    const reviewable = enabled && !source?.revision && !source?.linked && (!record || record.state === 'open');
    const headSha = comparedHead ?? record?.headSha;
    const target = React.useMemo<ChangeRequestReviewTarget | null>(() => (
        reviewable && readContext && provider && directory && owner !== undefined && name && number
            ? { context: readContext, provider, project: { owner, name }, number, headSha, directory }
            : null
    ), [directory, headSha, name, number, owner, provider, readContext, reviewable]);
    return { review: useChangeRequestReview(target), provider };
}

export const ChangeRequestReviewContext = React.createContext<ChangeRequestReview | null>(null);

export const useChangeRequestReviewContext = (): ChangeRequestReview | null => React.useContext(ChangeRequestReviewContext);

export const reviewDraftCount = (review: ChangeRequestReview | null): number => review?.state?.draft?.comments.length ?? 0;
