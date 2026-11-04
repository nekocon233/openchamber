import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import {
    ActivityRowSkipContext,
    LIVE_ACTIVITY_VISIBLE_ROWS,
    activityRowParts,
    planActivityTrim,
} from '../lib/turns/activityRows';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getLiveFinalMessage, getShownPages } from '../lib/turns/liveActivity';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { LiveFinalActivityContext, LiveTurnHoistedPagesContext, LiveTurnHoistedPlanContext } from './liveActivityContext';
import { FinalPlanCard } from '../message/parts/PlanToolPart';
import { ShownPartCard } from '../message/parts/ShownToolCard';
import { TurnMessageWindow } from './TurnMessageWindow';
import { useActivityRowGlide, useLiveRowsFloor } from './useActivityRowGlide';
import { foldContentId, finalActivityContentId, useTurnFold } from './useTurnFold';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';
import { TurnMessageWindowContext, isReaderAtTimelineEnd, openedFoldMessageWindow } from '../lib/turns/turnMessageWindow';

const NO_MESSAGES: ChatMessageEntry[] = [];

interface LiveTurnActivityProps {
    turn: TurnRecord;
    hasLaterAssistant: boolean;
    expanded: boolean;
    onToggle: () => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

export function LiveTurnActivity({ turn, hasLaterAssistant, expanded, onToggle, renderMessage }: LiveTurnActivityProps) {
    const { t } = useI18n();
    const contentId = React.useId();
    const finalContentId = React.useId();
    const finalMessage = getLiveFinalMessage(turn.assistantMessages);
    const finalPlan = turn.finalPlan;
    const planParts = finalPlan?.sourcePartIDs ?? null;
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
    const settled = Boolean(finalMessage) || hasLaterAssistant;
    const isExpanded = !settled || expanded;
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const trimRows = !expanded;
    const trim = React.useMemo(() => (trimRows
        ? planActivityTrim(
            activityMessages.map((message) => activityRowParts(message.parts, showReasoningTraces, planParts ?? undefined).length),
            LIVE_ACTIVITY_VISIBLE_ROWS,
        )
        : null), [activityMessages, showReasoningTraces, trimRows, planParts]);
    const shownMessages = React.useMemo(
        () => (trim && trim.hiddenMessages > 0 ? activityMessages.slice(trim.hiddenMessages) : activityMessages),
        [activityMessages, trim],
    );
    const skippedMessageId = trim && trim.skipRows > 0 ? shownMessages[0]?.info.id : undefined;
    const skippedRows = trim?.skipRows ?? 0;
    const rowSkip = React.useMemo(
        () => (skippedMessageId ? { messageId: skippedMessageId, rows: skippedRows } : null),
        [skippedMessageId, skippedRows],
    );
    const hiddenRows = trim?.hiddenRows ?? 0;
    const rowsRef = React.useRef<HTMLDivElement>(null);
    useActivityRowGlide(rowsRef, hiddenRows, !settled && !expanded);
    const previouslySettled = React.useRef(settled);
    const animateFinalCollapse = settled && !previouslySettled.current;
    React.useLayoutEffect(() => { previouslySettled.current = settled; }, [settled]);
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages), [turn.assistantMessages]);
    const hoistedPages = React.useMemo(() => new Set(pages.map((part) => part.id)), [pages]);
    const finalContext = React.useMemo(() => finalMessage ? {
        messageId: finalMessage.info.id, expanded: isExpanded, contentId: finalContentId, animateCollapse: animateFinalCollapse, pages,
    } : null, [finalMessage, isExpanded, finalContentId, animateFinalCollapse, pages]);
    const summary = React.useMemo(() => settled ? summarizeLiveActivity(turn.assistantMessages) : null,
        [settled, turn.assistantMessages]);
    const fileLabel = summary && summary.files > 0
        ? t(summary.files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: summary.files })
        : null;
    const details = summary ? [
        summary.explored ? t('chat.liveActivity.explored') : null,
        summary.commands > 0 ? t(summary.commands === 1 ? 'chat.liveActivity.ranCommand' : 'chat.liveActivity.ranCommands', { count: summary.commands }) : null,
        summary.researched ? t('chat.liveActivity.researched') : null,
        summary.subagents > 0 ? t(summary.subagents === 1 ? 'chat.liveActivity.usedSubagent' : 'chat.liveActivity.usedSubagents', { count: summary.subagents }) : null,
    ].filter(Boolean).join(' · ') : '';
    const label = (
        <>
            <Icon name="stack" className="size-3.5 shrink-0 text-[var(--tools-icon)]" />
            <span className="shrink-0 font-semibold text-[var(--tools-title)]">{t('chat.liveActivity.title')}</span>
            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0" />
            {fileLabel ? (
                <span className="flex min-w-0 items-center gap-1 typography-meta @min-[560px]:shrink-0">
                    <span className="truncate">{fileLabel}</span>
                    {summary?.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0) ? (
                        <span className="shrink-0 tabular-nums">
                            <span className="text-[var(--status-success)]">+{summary.additions}</span>
                            <span aria-hidden="true">/</span>
                            <span className="text-[var(--status-error)]">-{summary.deletions}</span>
                        </span>
                    ) : null}
                </span>
            ) : null}
            {details ? <span className="hidden min-w-0 flex-1 truncate text-start typography-meta @min-[560px]:inline" title={details}>{fileLabel ? '· ' : ''}{details}</span> : null}
            {!settled && hiddenRows > 0 ? (
                <span className="shrink-0 typography-meta">{t('chat.liveActivity.moreRows', { count: hiddenRows })}</span>
            ) : null}
        </>
    );
    const windowStore = React.useContext(TurnMessageWindowContext);
    const handleToggle = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (!expanded && windowStore) {
            windowStore.setRange(turn.turnId, openedFoldMessageWindow(activityMessages.length, isReaderAtTimelineEnd(event.currentTarget)));
        }
        onToggle();
    }, [activityMessages.length, expanded, onToggle, turn.turnId, windowStore]);
    const headerClass = 'w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    return (
        <LiveTurnHoistedPagesContext.Provider value={hoistedPages}>
          <LiveTurnHoistedPlanContext.Provider value={planParts}>
            <div className="relative z-0" data-live-turn-activity={turn.turnId}>
                <div className="chat-message-column @container">
                    <div className="mt-1">
                        <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle}
                            aria-expanded={expanded} aria-controls={finalMessage ? `${contentId} ${finalContentId}` : contentId}>
                            {label}
                        </Button>
                    </div>
                </div>
                <LiveActivityCollapse expanded={isExpanded} id={contentId}>
                    <div ref={rowsRef}>
                        <ActivityRowSkipContext.Provider value={rowSkip}>
                            <TurnMessageWindow turnId={turn.turnId} messages={shownMessages} renderMessage={renderMessage} />
                        </ActivityRowSkipContext.Provider>
                    </div>
                </LiveActivityCollapse>
                {!finalMessage && pages.length > 0 ? <TurnPages pages={pages} /> : null}
                {finalPlan ? <FinalPlanCard plan={finalPlan} /> : null}
                <LiveFinalActivityContext.Provider value={finalContext}>
                    {finalMessage ? renderMessage(finalMessage) : null}
                </LiveFinalActivityContext.Provider>
            </div>
          </LiveTurnHoistedPlanContext.Provider>
        </LiveTurnHoistedPagesContext.Provider>
    );
}

interface TurnFoldProps {
    turn: TurnRecord;
    hasLaterAssistant: boolean;
    expanded: boolean;
    finalMessageId: string | undefined;
    onToggle: () => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

export function TurnFold({ turn, hasLaterAssistant, expanded, finalMessageId, onToggle, renderMessage }: TurnFoldProps) {
    const { t } = useI18n();
    const { finalMessage, activityMessages, settled, isExpanded, pages } = useTurnFold(turn, hasLaterAssistant, expanded, finalMessageId);
    const finalPlan = turn.finalPlan;
    const planParts = finalPlan?.sourcePartIDs ?? null;
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const trim = React.useMemo(() => (expanded
        ? null
        : planActivityTrim(
            activityMessages.map((message) => activityRowParts(message.parts, showReasoningTraces, planParts ?? undefined).length),
            LIVE_ACTIVITY_VISIBLE_ROWS,
        )), [activityMessages, expanded, showReasoningTraces, planParts]);
    const shownMessages = React.useMemo(
        () => (trim && trim.hiddenMessages > 0 ? activityMessages.slice(trim.hiddenMessages) : activityMessages),
        [activityMessages, trim],
    );
    const skippedMessageId = trim && trim.skipRows > 0 ? shownMessages[0]?.info.id : undefined;
    const skippedRows = trim?.skipRows ?? 0;
    const rowSkip = React.useMemo(
        () => (skippedMessageId ? { messageId: skippedMessageId, rows: skippedRows } : null),
        [skippedMessageId, skippedRows],
    );
    const hiddenRows = trim?.hiddenRows ?? 0;
    const rowsRef = React.useRef<HTMLDivElement>(null);
    const previewFloorRef = React.useRef<HTMLDivElement>(null);
    const previewRef = React.useRef<HTMLDivElement>(null);
    useActivityRowGlide(rowsRef, hiddenRows, !settled && !expanded);
    useLiveRowsFloor(previewFloorRef, previewRef, !settled && !expanded);
    const lastPageMessageId = !finalMessage && pages.length > 0 ? pages[pages.length - 1]?.messageID : undefined;
    const [messagesAbovePages, messagesBelowPages] = React.useMemo(() => {
        const pageIndex = lastPageMessageId ? activityMessages.findIndex((message) => message.info.id === lastPageMessageId) : -1;
        if (pageIndex < 0) return [shownMessages, NO_MESSAGES];
        const split = Math.max(0, pageIndex + 1 - (activityMessages.length - shownMessages.length));
        return [shownMessages.slice(0, split), shownMessages.slice(split)];
    }, [activityMessages, lastPageMessageId, shownMessages]);
    const summary = React.useMemo(() => settled ? summarizeLiveActivity(turn.assistantMessages) : null,
        [settled, turn.assistantMessages]);
    const fileLabel = summary && summary.files > 0
        ? t(summary.files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: summary.files })
        : null;
    const details = summary ? [
        summary.explored ? t('chat.liveActivity.explored') : null,
        summary.commands > 0 ? t(summary.commands === 1 ? 'chat.liveActivity.ranCommand' : 'chat.liveActivity.ranCommands', { count: summary.commands }) : null,
        summary.researched ? t('chat.liveActivity.researched') : null,
        summary.subagents > 0 ? t(summary.subagents === 1 ? 'chat.liveActivity.usedSubagent' : 'chat.liveActivity.usedSubagents', { count: summary.subagents }) : null,
    ].filter(Boolean).join(' · ') : '';
    const label = (
        <>
            <Icon name="stack" className="size-3.5 shrink-0 text-[var(--tools-icon)]" />
            <span className="shrink-0 font-semibold text-[var(--tools-title)]">{t('chat.liveActivity.title')}</span>
            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0" />
            {fileLabel ? (
                <span className="flex min-w-0 items-center gap-1 typography-meta @min-[560px]:shrink-0">
                    <span className="truncate">{fileLabel}</span>
                    {summary?.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0) ? (
                        <span className="shrink-0 tabular-nums">
                            <span className="text-[var(--status-success)]">+{summary.additions}</span>
                            <span aria-hidden="true">/</span>
                            <span className="text-[var(--status-error)]">-{summary.deletions}</span>
                        </span>
                    ) : null}
                </span>
            ) : null}
            {details ? <span className="hidden min-w-0 flex-1 truncate text-start typography-meta @min-[560px]:inline" title={details}>{fileLabel ? '· ' : ''}{details}</span> : null}
            {!settled && hiddenRows > 0 ? (
                <span className="shrink-0 typography-meta">{t('chat.liveActivity.moreRows', { count: hiddenRows })}</span>
            ) : null}
        </>
    );
    const handleToggle = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (!expanded) dispatchRowExpand(event.currentTarget);
        onToggle();
    }, [expanded, onToggle]);
    const headerClass = 'w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    const contentId = foldContentId(turn.turnId);
    return (
        <div className="relative z-0" data-live-turn-activity={turn.turnId}>
            <div className="chat-message-column @container">
                <div className="mt-1">
                    <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle}
                        aria-expanded={expanded} aria-controls={finalMessage ? `${contentId} ${finalActivityContentId(turn.turnId)}` : contentId}>
                        {label}
                    </Button>
                </div>
            </div>
            {expanded ? null : (
                <div ref={previewFloorRef}>
                    <div ref={previewRef}>
                        <LiveActivityCollapse expanded={isExpanded} id={contentId}>
                            <div ref={rowsRef}>
                                <ActivityRowSkipContext.Provider value={rowSkip}>
                                    {messagesAbovePages.map((message) => (
                                        <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                                    ))}
                                </ActivityRowSkipContext.Provider>
                            </div>
                        </LiveActivityCollapse>
                        {!finalMessage && pages.length > 0 ? <TurnPages pages={pages} /> : null}
                        {messagesBelowPages.length > 0 ? (
                            <ActivityRowSkipContext.Provider value={rowSkip}>
                                {messagesBelowPages.map((message) => (
                                    <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                                ))}
                            </ActivityRowSkipContext.Provider>
                        ) : null}
                    </div>
                </div>
            )}
            {finalPlan ? <FinalPlanCard plan={finalPlan} /> : null}
        </div>
    );
}

function TurnPages({ pages }: { pages: ReturnType<typeof getShownPages> }) {
    return (
        <div className="chat-message-column">
            {pages.map((part) => <ShownPartCard key={part.id} part={part} />)}
        </div>
    );
}

export function TurnPagesRow({ turn }: { turn: TurnRecord }) {
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages), [turn.assistantMessages]);
    return pages.length > 0 ? <TurnPages pages={pages} /> : null;
}
