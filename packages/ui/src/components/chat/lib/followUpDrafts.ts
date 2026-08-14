import type { QueuedMessage } from '@/stores/messageQueueStore';

type SessionPhase = 'idle' | 'busy' | 'retry';

type FollowUpDeliveryDecision = 'direct' | 'follow-up' | 'unavailable';

export const resolveFollowUpDeliveryDecision = ({
    inputMode,
    sessionId,
    sessionPhase,
    dismissedBlockingPrompt,
    authoritativeSessionPhase,
}: {
    inputMode: 'normal' | 'shell';
    sessionId: string | null;
    sessionPhase: SessionPhase;
    dismissedBlockingPrompt: boolean;
    authoritativeSessionPhase?: SessionPhase | null;
}): FollowUpDeliveryDecision => {
    if (inputMode !== 'normal' || !sessionId) return 'direct';
    if (sessionPhase !== 'idle' || dismissedBlockingPrompt) return 'follow-up';
    if (authoritativeSessionPhase === null) return 'unavailable';
    if (authoritativeSessionPhase === undefined || authoritativeSessionPhase === 'idle') return 'direct';
    return 'follow-up';
};

export const shouldStageFollowUpAsDraft = ({
    inputMode,
    hasContent,
    sessionId,
    sessionPhase,
    autoReviewRunning,
}: {
    inputMode: 'normal' | 'shell';
    hasContent: boolean;
    sessionId: string | null;
    sessionPhase: SessionPhase;
    autoReviewRunning: boolean;
}): boolean => (
    inputMode === 'normal'
    && hasContent
    && Boolean(sessionId)
    && (sessionPhase !== 'idle' || autoReviewRunning)
);

export const selectFollowUpDraft = (
    drafts: readonly QueuedMessage[],
    draftId: string | undefined,
): QueuedMessage | null => {
    if (!draftId) return null;
    return drafts.find((draft) => draft.id === draftId) ?? null;
};
