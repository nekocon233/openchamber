import type { QueuedMessage } from '@/stores/messageQueueStore';

type SessionPhase = 'idle' | 'busy' | 'retry';

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
