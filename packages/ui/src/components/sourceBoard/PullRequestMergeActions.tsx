import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { forgetLabelWrite } from '@/components/references/labelWrites';
import { toast } from '@/components/ui';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useFireworksCelebration } from '@/contexts/FireworksContext';
import { readMergeMethod, rememberMergeMethod, type RememberedMergeMethod } from '@/components/views/git/mergeMethodPreference';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PullRequestStack, RepositoryChangeRequestReference, SourceControlReadContext } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import type { ChangeRequestSubmitRequirement, MergeMethod } from '@/lib/source-control/types';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import type { TrackedThread } from '@/lib/trackedItems/model';
import { cn } from '@/lib/utils';
import { useTrackedRecords } from '@/stores/useTrackedItemsStore';

import { landsWithIt, mergeChoiceOf } from './mergeChoice';
import { newMutationKey } from './mutationKey';
import { beginPullRequestAction, usePullRequestActionPending } from './pullRequestActions';
import { useSourceControlCapabilities } from '@/hooks/useSourceControlCapabilities';

const MERGE_METHOD_LABELS = {
    squash: 'gitView.pr.mergeMethod.squash',
    merge: 'gitView.pr.mergeMethod.merge',
    rebase: 'gitView.pr.mergeMethod.rebase',
    submit: 'gitView.pr.mergeMethod.submit',
} as const;

const MERGE_METHOD_KEYS = {
    merge: 'sourceBoard.merge.method.merge',
    squash: 'sourceBoard.merge.method.squash',
    rebase: 'sourceBoard.merge.method.rebase',
    submit: 'sourceBoard.merge.method.submit',
} as const;

type PullRequestMergeActionsProps = {
    pull: RepositoryChangeRequestReference;
    context: SourceControlReadContext;
    onChanged: () => void;
    onMergeSubmitted?: () => void;
    placement?: 'toolbar' | 'detail';
    stack?: PullRequestStack | null;
    submitRequirements?: ChangeRequestSubmitRequirement[];
    submitRequirementsUnreadable?: boolean;
    mergeable?: boolean | null;
};

export function PullRequestMergeActions(props: PullRequestMergeActionsProps) {
    const { context, pull } = props;
    const runtimeGeneration = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
    const runtimeKey = getRuntimeKey();
    const mergePending = React.useRef(false);
    if (context.linked) return null;
    const scopeKey = JSON.stringify([runtimeKey, runtimeGeneration, sourceControlReadContextParts(context),
        pull.sourceRepo.owner, pull.sourceRepo.repo, pull.number, pull.state, pull.draft, pull.head, pull.base, pull.headSha]);
    return <PullRequestMergeActionsView key={scopeKey} {...props} runtimeKey={runtimeKey} runtimeGeneration={runtimeGeneration} mergePending={mergePending} />;
}

function PullRequestMergeActionsView({
    pull, context, onChanged, onMergeSubmitted, placement, stack,
    submitRequirements, submitRequirementsUnreadable = false, mergeable = null, runtimeKey, runtimeGeneration, mergePending,
}: PullRequestMergeActionsProps & { runtimeKey: string; runtimeGeneration: number; mergePending: React.RefObject<boolean> }) {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const { sourceControl } = useRuntimeAPIs();
    const confirmation = useConfirmDialog();
    const { triggerFireworks } = useFireworksCelebration();
    const [busy, setBusy] = React.useState(false);
    const mounted = React.useRef(true);
    React.useLayoutEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const isCurrent = () => mounted.current
        && getRuntimeKey() === runtimeKey
        && getRuntimeEndpointGeneration() === runtimeGeneration;

    const toolbar = placement === 'toolbar';
    const descriptor = useSourceControlProvider(context.provider);
    const pullRef = { owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo, number: pull.number };
    const actionPending = usePullRequestActionPending(context, pullRef);
    const trackedPulls: TrackedThread<'pull'>[] = pull.state === 'open' ? [{
        provider: context.provider, instance: context.instance, accountId: context.accountId, kind: 'pull', ...pullRef,
    }] : [];
    useTrackedItems(toolbar ? trackedPulls : []);
    const [liveRecord] = useTrackedRecords(trackedPulls);
    const live = liveRecord?.type === 'pull' ? liveRecord.state : null;
    const openPull = pull.state === 'open' && (!toolbar || !live || live.state === 'open') ? pull : null;
    const activeMerge = live?.state === 'open' ? live : null;
    const queued = activeMerge?.isInMergeQueue === true;
    const autoMerge = activeMerge?.autoMergeRequest;
    const cancelAutoMerge = !queued && context.provider === 'github' ? autoMerge ?? undefined : undefined;
    const waitingLabel = queued
        ? activeMerge.mergeQueueEntry?.position != null
            ? t('sourceBoard.merge.queuePosition', { position: activeMerge.mergeQueueEntry.position })
            : t('sourceBoard.merge.inQueue')
        : t('sourceBoard.merge.autoMerge');
    const capabilities = useSourceControlCapabilities(openPull ? context : null);

    const [chosenMethod, setChosenMethod] = React.useState<RememberedMergeMethod>(readMergeMethod);
    const { methods: mergeMethods, method: mergeMethod, unmet, hold: submitHold, blocked: submitBlocked } = mergeChoiceOf({
        allowed: capabilities?.mergeChangeRequests ? capabilities.mergeMethods ?? [] : [],
        remembered: chosenMethod,
        checksRequirements: descriptor.features.submitRequirements,
        requirements: submitRequirements,
        requirementsUnreadable: submitRequirementsUnreadable,
        mergeable,
    });
    const chooseMergeMethod = (value: string) => {
        const method = mergeMethods.find((candidate) => candidate === value);
        if (!method || method === 'submit') return;
        setChosenMethod(method);
        rememberMergeMethod(method);
    };
    const submits = mergeMethod === 'submit';
    const reference = formatChangeRequestReference(descriptor, pull.number);
    const referenceOf = (number: number) => formatChangeRequestReference(descriptor, number);
    const submitChain = submits ? landsWithIt({ stack: stack ?? null, number: pull.number, method: mergeMethod }) : [];
    const submitsBelow = submitChain.length > 0
        ? t(submitChain.length === 1 ? 'sourceBoard.submit.alsoBelow.one' : 'sourceBoard.submit.alsoBelow.other', { count: submitChain.length })
        : null;
    const target = { project: { owner: pullRef.owner, name: pullRef.repo }, number: pull.number, head: pull.head, base: pull.base, headSha: pull.headSha };
    const pending = busy || actionPending;

    const merge = async (method: MergeMethod, origin: HTMLElement) => {
        if (!openPull || openPull.draft || !mergeMethods.includes(method) || submitBlocked || mergePending.current || !isCurrent()) return;
        const submits = method === 'submit';
        const cancel = method === 'squash' ? cancelAutoMerge : undefined;
        const action = beginPullRequestAction(context, pullRef);
        if (!action) return;
        mergePending.current = true;
        let dispatched = false;
        const canReport = () => onMergeSubmitted ? action.isRuntimeCurrent() : isCurrent();
        const resultReference = onMergeSubmitted ? `${openPull.sourceRepo.owner}/${openPull.sourceRepo.repo} ${reference}` : reference;
        try {
            let confirmedStack = stack;
            if (placement && confirmedStack === undefined && descriptor.features.referenceDetail) {
                setBusy(true);
                const result = await sourceControl.referenceDetail(context, pullRef);
                if (!isCurrent()) return;
                setBusy(false);
                if (!result.connected) throw new Error(t('sourceBoard.link.disconnected'));
                if (!result.detail?.pull) throw new Error(t('sourceBoard.link.notFound'));
                confirmedStack = result.detail.pull.stack;
            }
            const landsBelow = landsWithIt({ stack: confirmedStack ?? null, number: openPull.number, method });
            const methodNote = t(MERGE_METHOD_KEYS[method], { base: openPull.base });
            const stackNote = submits
                ? submitsBelow
                : landsBelow.length === 0
                    ? null
                    : landsBelow.length === 1
                        ? t('stacks.merge.alsoBelow.one', { reference: referenceOf(landsBelow[0].number) })
                        : t('stacks.merge.alsoBelow.other', { count: landsBelow.length, references: landsBelow.map((layer) => referenceOf(layer.number)).join(', ') });
            const approved = await confirmation.confirm({
                title: submits && submitsBelow
                    ? t(landsBelow.length === 1 ? 'sourceBoard.submit.confirmTitleWithChain.one' : 'sourceBoard.submit.confirmTitleWithChain.other', { reference, count: landsBelow.length })
                    : t(`sourceBoard.merge.confirmTitle.${descriptor.terminology.changeRequest}`, { reference }),
                message: [stackNote, cancel ? t('sourceBoard.merge.cancelBeforeSquash') : null, methodNote].filter(Boolean).join('\n\n'),
                action: t(toolbar || cancel ? MERGE_METHOD_LABELS.squash : submits ? MERGE_METHOD_LABELS.submit : 'sourceBoard.actions.merge'),
            });
            if (!approved || !isCurrent()) return;
            setBusy(true);
            const request = sourceControl.changeRequestMerge({
                ...context,
                idempotencyKey: newMutationKey(),
                target,
                method,
                cancel,
            });
            dispatched = true;
            onMergeSubmitted?.();
            const receipt = await request;
            if (!canReport()) return;
            const { merged, outcome, message } = receipt.result;
            if (merged) forgetLabelWrite(openPull);
            if (merged) triggerFireworks({ kind: 'merge', volleys: 2 + landsBelow.length, origin });
            if (submits) {
                if (merged) toast.success(t('sourceBoard.toast.submitted', { reference: resultReference }));
                else toast.message(t('sourceBoard.toast.notSubmitted', { reference: resultReference }), { description: message });
            } else if (merged) {
                toast.success(landsBelow.length === 0
                    ? t('sourceBoard.toast.merged', { reference: resultReference })
                    : landsBelow.length === 1
                        ? t('stacks.toast.mergedWithBelow.one', { reference: resultReference })
                        : t('stacks.toast.mergedWithBelow.other', { reference: resultReference, count: landsBelow.length }));
            } else if (outcome === 'queued') {
                toast.message(t('sourceBoard.toast.mergeQueued', { reference: resultReference }));
            } else if (outcome === 'auto-merge') {
                toast.message(t('sourceBoard.toast.autoMerge', { reference: resultReference }));
            } else if (outcome === 'cancelled') {
                toast.error(t('sourceBoard.toast.mergeFailed', { reference: resultReference }), {
                    description: t('sourceBoard.toast.mergeCancelled', { reference: resultReference }),
                });
            } else if (outcome === 'merging') {
                toast.message(t('sourceBoard.toast.mergeRunning', { reference: resultReference }), { description: t('sourceBoard.toast.mergeRunningDescription') });
            } else {
                toast.message(t('sourceBoard.toast.notMerged', { reference: resultReference }), { description: message });
            }
        } catch (error) {
            if (canReport()) toast.error(t(submits ? 'sourceBoard.toast.submitFailed' : 'sourceBoard.toast.mergeFailed', { reference: resultReference }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            mergePending.current = false;
            if (mounted.current) setBusy(false);
            action.finish();
            if (dispatched && canReport()) onChanged();
        }
    };

    const cancelMerge = async () => {
        if (!openPull || mergePending.current || !isCurrent()) return;
        const action = beginPullRequestAction(context, pullRef);
        if (!action) return;
        mergePending.current = true;
        setBusy(true);
        try {
            const receipt = await sourceControl.changeRequestMerge({
                ...context, idempotencyKey: newMutationKey(), method: chosenMethod, cancel: true, target,
            });
            if (isCurrent()) toast.success(t(receipt.result.merged ? 'sourceBoard.toast.merged' : 'sourceBoard.toast.mergeCancelled', { reference }));
        } catch (error) {
            if (isCurrent()) toast.error(t('sourceBoard.toast.mergeCancelFailed', { reference }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            mergePending.current = false;
            if (isCurrent()) { setBusy(false); onChanged(); }
            action.finish();
        }
    };

    const mergeIcon = <Icon name={busy ? 'loader-4' : 'git-merge'} className={cn('size-4', busy && 'animate-spin')} />;
    const squashLabel = t(MERGE_METHOD_LABELS.squash);
    const squashAvailable = openPull && !openPull.draft && (!toolbar || !live?.draft) && !queued && mergeMethods.includes('squash');
    const squashButton = squashAvailable ? (
        <ButtonTooltip label={t(MERGE_METHOD_KEYS.squash, { base: pull.base })}>
            <Button size={toolbar && isMobile ? 'lg' : 'sm'} variant="outline"
                className={toolbar && !isMobile ? 'diff-toolbar__merge-button' : undefined} aria-label={squashLabel}
                disabled={pending} onClick={(event) => void merge('squash', event.currentTarget)}>
                {mergeIcon}
                <span className={toolbar && !isMobile ? 'diff-toolbar__merge-label' : undefined}>{squashLabel}</span>
            </Button>
        </ButtonTooltip>
    ) : null;

    if (toolbar) return <>{squashButton}{confirmation.dialog}</>;
    if (!openPull) return null;
    return (
        <>
            {queued || autoMerge ? (
                <>
                    <span className="text-muted-foreground typography-small">{waitingLabel}</span>
                    {autoMerge ? squashButton : null}
                    <ButtonTooltip label={t('contextTooltips.tracker.cancelMerge')}>
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => void cancelMerge()}>
                            <Icon name={busy ? 'loader-4' : 'close'} className={cn('size-3.5', busy && 'animate-spin')} />
                            {t('sourceBoard.merge.cancel')}
                        </Button>
                    </ButtonTooltip>
                </>
            ) : !openPull.draft && mergeMethod ? (
                <>
                    {placement === 'detail' && mergeMethod !== 'squash' ? squashButton : null}
                    <div className="flex shrink-0 items-center">
                        <ButtonTooltip label={t(submits ? 'contextTooltips.tracker.submitTo' : 'contextTooltips.tracker.mergeInto', { branch: pull.base })}>
                            <Button
                                size="sm"
                                variant="outline"
                                className={cn(mergeMethods.length > 1 && 'rounded-e-none')}
                                disabled={pending || submitBlocked}
                                onClick={(event) => void merge(mergeMethod, event.currentTarget)}
                            >
                                {mergeIcon}
                                {t(MERGE_METHOD_LABELS[mergeMethod])}
                            </Button>
                        </ButtonTooltip>
                        {mergeMethods.length > 1 ? (
                            <DropdownMenu>
                                <ButtonTooltip label={t('contextTooltips.tracker.chooseMergeMethod')}>
                                    <DropdownMenuTrigger asChild>
                                        <Button size="sm" variant="outline" className="rounded-s-none border-s-0 px-1.5"
                                            disabled={busy} aria-label={t('sourceBoard.merge.methodAria')}>
                                            <Icon name="arrow-down-s" className="size-3.5" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                </ButtonTooltip>
                                <DropdownMenuContent align="start" className="w-56">
                                    <DropdownMenuRadioGroup value={mergeMethod} onValueChange={(value) => chooseMergeMethod(String(value))}>
                                        {mergeMethods.map((method) => (
                                            <DropdownMenuRadioItem key={method} value={method}>{t(MERGE_METHOD_LABELS[method])}</DropdownMenuRadioItem>
                                        ))}
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ) : null}
                    </div>
                </>
            ) : null}
            {openPull && !openPull.draft && unmet.length > 0 ? (
                <span
                    className="min-w-0 max-w-[16rem] truncate typography-meta text-muted-foreground"
                    title={unmet.map((requirement) => requirement.description ? `${requirement.name}: ${requirement.description}` : requirement.name).join('\n')}
                >
                    {t('sourceBoard.submit.needs', { requirements: unmet.map((requirement) => requirement.name).join(', ') })}
                </span>
            ) : openPull && !openPull.draft && submitHold ? (
                <span className="min-w-0 max-w-[16rem] truncate typography-meta text-muted-foreground">
                    {t(submitHold === 'unreadable' ? 'sourceBoard.submit.unreadable' : 'sourceBoard.submit.notSubmittable')}
                </span>
            ) : openPull && !openPull.draft && submitsBelow ? (
                <span className="min-w-0 max-w-[16rem] truncate typography-meta text-muted-foreground" title={submitsBelow}>
                    {submitsBelow}
                </span>
            ) : null}
            {confirmation.dialog}
        </>
    );
}
