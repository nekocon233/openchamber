import { getRuntimeKey } from '@/lib/runtime-switch';
import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { Icon } from '@/components/icon/Icon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { forgetLabelWrite } from '@/components/references/labelWrites';
import { REFERENCE_META_TEXT, referenceNumberLabel } from '@/components/references/referencePickerItems';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { reviewDraftCount, useChangeRequestReview } from '@/components/review/useChangeRequestReview';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePendingComposerReferences, type ComposerReferenceHandoff } from '@/components/chat/composer/pendingComposerReferences';
import type { ReferencePickerItem, ReferencePickerSelection } from '@/components/references/referencePickerItems';
import { readTrackerItemDetail } from '@/components/references/referenceSources';
import { readTrackerDescriptor } from '@/lib/trackers/registry';
import { resolveComposerReferences } from '@/components/references/resolveComposerReferences';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryChangeRequestReference, RepositoryDiscussionReference, PullRequestStack, SourceControlReadContext } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ChangeRequestSubmitRequirement, DiscussionCloseReason, DraftChangeRequestInput, SetStateInput } from '@/lib/source-control/types';
import { useChangeRequestDiffServing, useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import { useOpenSourceBoardPull, type PullLinkProps } from './useOpenSourceBoardPull';
import { PullRequestMergeActions } from './PullRequestMergeActions';
import { useSourceControlCapabilities } from '@/hooks/useSourceControlCapabilities';
import { newMutationKey } from './mutationKey';

export type SourceBoardProject = { id: string; path: string };

const isStackable = (pull: RepositoryChangeRequestReference): boolean => (
    !pull.headRepo
    || (pull.headRepo.owner.toLowerCase() === pull.sourceRepo.owner.toLowerCase() && pull.headRepo.repo.toLowerCase() === pull.sourceRepo.repo.toLowerCase())
);

const selectionOf = (item: ReferencePickerItem): ReferencePickerSelection => (
    item.source === 'tracker' ? item : { source: 'repository', reference: item.reference, includeDiff: false }
);

type SourceBoardActionsProps = {
    item: ReferencePickerItem;
    project: SourceBoardProject | null;
    context: SourceControlReadContext | null;
    onStartWorktree: (project: SourceBoardProject, selection: ReferencePickerSelection) => void;
    onChanged: () => void;
    startIn?: React.ReactNode;
    onLeave?: () => void;
    worktreeAvailable?: boolean;
    onMergeSubmitted?: () => void;
    stack?: PullRequestStack | null;
    onStartOnTop?: (pull: RepositoryChangeRequestReference) => void;
    submitRequirements?: ChangeRequestSubmitRequirement[];
    submitRequirementsUnreadable?: boolean;
    mergeable?: boolean | null;
    showSquashShortcut?: boolean;
};

export const SourceBoardActions: React.FC<SourceBoardActionsProps> = ({
    item, project, context: readContext, onStartWorktree, onChanged, onMergeSubmitted, startIn, onLeave,
    worktreeAvailable = Boolean(project), stack, onStartOnTop, submitRequirements, submitRequirementsUnreadable, mergeable,
    showSquashShortcut,
}) => {
    const { t } = useI18n();
    const { sourceControl, trackers } = useRuntimeAPIs();
    const pull = item.source === 'repository' && item.reference.kind === 'pull' ? item.reference : null;
    const openPull = pull?.state === 'open' ? pull : null;
    const descriptor = useSourceControlProvider(pull?.provider);
    const currentSessionId = useSessionUIStore((state) => (state.newSessionDraft?.open ? null : state.currentSessionId));
    const currentSession = useSession(currentSessionId, currentSessionId ? useSessionUIStore.getState().getDirectoryForSession(currentSessionId) ?? undefined : undefined);

    const attachToComposer = (target: ComposerReferenceHandoff) => {
        void resolveComposerReferences([selectionOf(item)], {
            sourceControl,
            context: readContext,
            readTrackerDetail: (provider, itemId) => (trackers
                ? readTrackerItemDetail(trackers, provider, itemId)
                : Promise.reject(new Error('Trackers are not available here'))),
            trackerName: (provider) => readTrackerDescriptor(provider).name,
        }).then(({ references, failures }) => {
            if (references.length > 0) usePendingComposerReferences.getState().push(references, target);
            const failure = failures[0];
            if (failure) toast.error(t('sourceBoard.error.attachFailed', { item: failure.label }), { description: failure.error });
        });
    };

    const startSession = () => {
        if (!project) return;
        useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
        onLeave?.();
        const { workDraftId } = useSessionUIStore.getState().newSessionDraft;
        if (workDraftId) attachToComposer({ kind: 'draft', workDraftId, runtimeKey: getRuntimeKey() });
    };

    const attachToCurrentSession = () => {
        if (!currentSessionId) return;
        useUIStore.getState().closeMainSurfaces();
        onLeave?.();
        attachToComposer({ kind: 'session', sessionId: currentSessionId });
    };

    const stackOnTop = onStartOnTop && openPull && descriptor.features.branchHeads && isStackable(openPull) ? () => onStartOnTop(openPull) : null;
    const stackOnTopLabel = t('stacks.actions.newOnTop');

    return (
        <div className="flex min-h-8 flex-wrap items-center gap-2">
            <div className="me-auto flex min-w-0 flex-wrap items-center gap-2">
                {startIn}
                {openPull && readContext ? (
                    <PullRequestMergeActions pull={openPull} context={readContext} onChanged={onChanged} onMergeSubmitted={onMergeSubmitted}
                        placement={showSquashShortcut ? 'detail' : undefined} stack={stack} submitRequirements={submitRequirements}
                        submitRequirementsUnreadable={submitRequirementsUnreadable} mergeable={mergeable} />
                ) : null}
                {stackOnTop && !project ? (
                    <ButtonTooltip label={t('contextTooltips.tracker.startOnTop')}>
                        <Button size="sm" variant="outline" onClick={stackOnTop}>
                            <Icon name="stack" className="size-3.5" />
                            {stackOnTopLabel}
                        </Button>
                    </ButtonTooltip>
                ) : null}
            </div>
            {project || currentSessionId ? (
                <DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="default" className="shrink-0">
                                    <Icon name="attachment-2" className="size-3.5" />
                                    {t('sourceBoard.actions.attach')}
                                    <Icon name="arrow-down-s" className="size-3.5 opacity-70" />
                                </Button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.chooseAttachTarget')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" className="w-64">
                        {currentSessionId ? (
                            <DropdownMenuItem onSelect={attachToCurrentSession}>
                                <Icon name="chat-4" className="size-4 shrink-0" />
                                <span className="flex min-w-0 flex-col">
                                    <span>{t('sourceBoard.actions.currentSession')}</span>
                                    {currentSession?.title ? (
                                        <span className="truncate typography-micro text-muted-foreground">{currentSession.title}</span>
                                    ) : null}
                                </span>
                            </DropdownMenuItem>
                        ) : null}
                        {project ? (
                            <>
                                <DropdownMenuItem onSelect={startSession}>
                                    <Icon name="chat-new" className="size-4 shrink-0" />
                                    {t('sourceBoard.actions.newSession')}
                                </DropdownMenuItem>
                                {worktreeAvailable ? (
                                    <DropdownMenuItem onSelect={() => onStartWorktree(project, selectionOf(item))}>
                                        <Icon name="worktree" className="size-4 shrink-0" />
                                        {t(pull ? 'sourceBoard.actions.checkoutWorktree' : 'sourceBoard.actions.newWorktreeSession')}
                                    </DropdownMenuItem>
                                ) : null}
                                {worktreeAvailable && stackOnTop ? (
                                    <DropdownMenuItem onSelect={stackOnTop}>
                                        <Icon name="stack" className="size-4 shrink-0" />
                                        {stackOnTopLabel}
                                    </DropdownMenuItem>
                                ) : null}
                            </>
                        ) : null}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
        </div>
    );
};

const LINK_CLASS = cn(
    'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta hover:bg-interactive-hover hover:text-foreground',
    REFERENCE_META_TEXT,
);

export const SourceBoardPullLinks: React.FC<PullLinkProps> = (props) => {
    const { t } = useI18n();
    const mobile = useMobileAppActions();
    const diffServing = useChangeRequestDiffServing(props.context.provider);
    const open = useOpenSourceBoardPull();
    if (diffServing === 'not-served') return null;
    return (
        <span className="inline-flex items-center gap-1">
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" className={LINK_CLASS} onClick={() => open('diff', props)}>
                        <DiffViewIcon className="size-3.5" />
                        {t('sourceBoard.actions.changes')}
                        <Icon name="external-link" className="size-3.5" />
                    </button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.openChanges')}</TooltipContent>
            </Tooltip>
            {mobile ? null : (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button type="button" className={LINK_CLASS} onClick={() => open('walkthrough', props)}>
                            <Icon name="route" className="size-3.5 text-[var(--status-info)]" />
                            {t('walkthrough.action.open')}
                            <Icon name="external-link" className="size-3.5" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.openWalkthrough')}</TooltipContent>
                </Tooltip>
            )}
        </span>
    );
};


export const SourceBoardReviewDraft: React.FC<PullLinkProps> = (props) => {
    const { pull, context, project } = props;
    const { t } = useI18n();
    const open = useOpenSourceBoardPull();
    const target = React.useMemo(() => (pull.state === 'open' ? {
        context,
        provider: context.provider,
        project: { owner: pull.sourceRepo.owner, name: pull.sourceRepo.repo },
        number: pull.number,
        headSha: pull.headSha,
        directory: context.directory ?? project.path,
    } : null), [context, project.path, pull.headSha, pull.number, pull.sourceRepo.owner, pull.sourceRepo.repo, pull.state]);
    const review = useChangeRequestReview(target);
    const count = reviewDraftCount(review);
    if (count === 0) return null;
    const login = review?.state?.draft?.comments[0]?.author?.login;
    const label = t(count === 1 ? 'review.board.draft.one' : 'review.board.draft.other', { count });
    return (
        <button type="button" className={LINK_CLASS} onClick={() => open('diff', props)}>
            {login ? `${login} · ${label}` : label}
        </button>
    );
};

const DISCUSSION_CLOSE_REASONS = ['resolved', 'outdated', 'duplicate'] as const satisfies readonly DiscussionCloseReason[];
const DISCUSSION_CLOSE_KEYS = {
    resolved: 'sourceBoard.discussion.closeResolved',
    outdated: 'sourceBoard.discussion.closeOutdated',
    duplicate: 'sourceBoard.discussion.closeDuplicate',
} as const satisfies Record<DiscussionCloseReason, I18nKey>;
const DISCUSSION_CLOSE_ICONS = {
    resolved: 'chat-check',
    outdated: 'chat-off',
    duplicate: 'file-copy',
} as const satisfies Record<DiscussionCloseReason, IconName>;

const DiscussionStateMenuItems: React.FC<{
    discussion: RepositoryDiscussionReference;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ discussion, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const descriptor = useSourceControlProvider(discussion.provider);
    const label = referenceNumberLabel(discussion, descriptor);
    const change = async (input: { state: 'closed'; reason: DiscussionCloseReason } | { state: 'open' }) => {
        try {
            const base = {
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: discussion.sourceRepo.owner, name: discussion.sourceRepo.repo }, number: discussion.number },
            };
            await sourceControl.discussionSetState(input.state === 'closed' ? { ...base, state: 'closed', reason: input.reason } : { ...base, state: 'open' });
            forgetLabelWrite(discussion);
            toast.success(t(input.state === 'closed' ? 'sourceBoard.toast.closed' : 'sourceBoard.toast.reopened', { reference: label }));
        } catch (error) {
            toast.error(
                t(input.state === 'closed' ? 'sourceBoard.toast.closeFailed' : 'sourceBoard.toast.reopenFailed', { reference: label }),
                { description: error instanceof Error ? error.message : String(error) },
            );
        } finally {
            onChanged();
        }
    };
    if (discussion.state !== 'open') {
        return (
            <DropdownMenuItem onSelect={() => void change({ state: 'open' })}>
                <Icon name="arrow-go-back" className="size-4 shrink-0" />
                {t('sourceBoard.discussion.reopen')}
            </DropdownMenuItem>
        );
    }
    return (
        <>
            {DISCUSSION_CLOSE_REASONS.map((reason) => (
                <DropdownMenuItem key={reason} onSelect={() => void change({ state: 'closed', reason })}>
                    <Icon name={DISCUSSION_CLOSE_ICONS[reason]} className="size-4 shrink-0" />
                    {t(DISCUSSION_CLOSE_KEYS[reason])}
                </DropdownMenuItem>
            ))}
        </>
    );
};

export const SourceBoardStateMenuItems: React.FC<{
    item: ReferencePickerItem;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ item, context, onChanged }) => {
    if (item.source === 'repository' && item.reference.kind === 'discussion') {
        return <DiscussionStateMenuItems discussion={item.reference} context={context} onChanged={onChanged} />;
    }
    return <ItemStateMenuItems item={item} context={context} onChanged={onChanged} />;
};

const ItemStateMenuItems: React.FC<{
    item: ReferencePickerItem;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ item, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const repositoryItem = item.source === 'repository' && item.reference.kind !== 'discussion' ? item.reference : null;
    const descriptor = useSourceControlProvider(repositoryItem?.provider);
    const nextState = !repositoryItem || repositoryItem.state === 'merged' ? null : repositoryItem.state === 'open' ? 'closed' : 'open';
    const openPull = repositoryItem?.kind === 'pull' && repositoryItem.state === 'open' ? repositoryItem : null;
    const capabilities = useSourceControlCapabilities(openPull ? context : null);
    const stateLabel = (() => {
        if (!repositoryItem || !nextState) return '';
        if (repositoryItem.kind === 'issue') return t(nextState === 'closed' ? 'sourceBoard.actions.closeIssue' : 'sourceBoard.actions.reopenIssue');
        const term = descriptor.terminology.changeRequest;
        return t(nextState === 'closed' ? `sourceBoard.actions.closePull.${term}` : `sourceBoard.actions.reopenPull.${term}`);
    })();

    const changeState = async () => {
        if (!repositoryItem || !nextState) return;
        const label = referenceNumberLabel(repositoryItem, descriptor);
        try {
            const payload: SetStateInput = {
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: repositoryItem.sourceRepo.owner, name: repositoryItem.sourceRepo.repo }, number: repositoryItem.number },
                state: nextState,
            };
            if (repositoryItem.kind === 'pull') await sourceControl.changeRequestSetState(payload);
            else await sourceControl.issueSetState(payload);
            forgetLabelWrite(repositoryItem);
            toast.success(t(nextState === 'closed' ? 'sourceBoard.toast.closed' : 'sourceBoard.toast.reopened', { reference: label }));
        } catch (error) {
            toast.error(
                t(nextState === 'closed' ? 'sourceBoard.toast.closeFailed' : 'sourceBoard.toast.reopenFailed', { reference: label }),
                { description: error instanceof Error ? error.message : String(error) },
            );
        } finally {
            onChanged();
        }
    };

    const markDraft = async (draft: boolean) => {
        if (!openPull) return;
        const label = referenceNumberLabel(openPull, descriptor);
        try {
            const payload: DraftChangeRequestInput = {
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: openPull.sourceRepo.owner, name: openPull.sourceRepo.repo }, number: openPull.number },
            };
            if (draft) await sourceControl.changeRequestDraft(payload);
            else await sourceControl.changeRequestReady(payload);
            toast.success(t(draft ? 'sourceBoard.toast.markedDraft' : 'sourceBoard.toast.markedReady', { reference: label }));
        } catch (error) {
            toast.error(t(draft ? 'sourceBoard.toast.markDraftFailed' : 'sourceBoard.toast.markReadyFailed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            onChanged();
        }
    };

    if (!repositoryItem) return null;
    return (
        <>
            {openPull?.draft && capabilities?.draftChangeRequests ? (
                <DropdownMenuItem onSelect={() => void markDraft(false)}>
                    <Icon name="git-pull-request" className="size-4 shrink-0" />
                    {t('sourceBoard.actions.markReady')}
                </DropdownMenuItem>
            ) : null}
            {openPull && !openPull.draft && capabilities?.draftConversion ? (
                <DropdownMenuItem onSelect={() => void markDraft(true)}>
                    <Icon name="git-pr-draft" className="size-4 shrink-0" />
                    {t('sourceBoard.actions.convertToDraft')}
                </DropdownMenuItem>
            ) : null}
            {nextState ? (
                <DropdownMenuItem onSelect={() => void changeState()}>
                    <Icon name={nextState === 'open' ? 'arrow-go-back' : repositoryItem.kind === 'pull' ? 'git-close-pull-request' : 'checkbox-circle'} className="size-4 shrink-0" />
                    {stateLabel}
                </DropdownMenuItem>
            ) : null}
        </>
    );
};
