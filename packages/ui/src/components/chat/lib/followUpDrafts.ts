import type { QueuedMessage } from '@/stores/messageQueueStore';

type SessionPhase = 'idle' | 'busy' | 'retry';

export const shouldUseFollowUpDelivery = ({
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
}): boolean => {
    if (inputMode !== 'normal' || !sessionId) return false;
    if (sessionPhase !== 'idle' || dismissedBlockingPrompt) return true;
    if (authoritativeSessionPhase === undefined) return false;
    return authoritativeSessionPhase !== 'idle';
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
