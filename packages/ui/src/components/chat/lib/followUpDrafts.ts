import type { QueuedMessage } from '@/stores/messageQueueStore';
import { isNativeSessionId, isUnifiedNativeSessionId, nativeBackendOfProviderId, nativeBackendOfSessionId } from '@/lib/native-agents/ids';
import type { unifiedNativeSessionState } from '@/lib/native-agents/ids';

type SessionPhase = 'idle' | 'busy' | 'retry';

type FollowUpDeliveryDecision = 'direct' | 'follow-up' | 'unavailable';

/** Keep native steering on the current source; a different CLI must wait for handoff. */
export const resolveNativeFollowUpDelivery = ({
    delivery, sessionId, providerID, sessionPhase, forceQueue, unifiedState,
}: {
    delivery: 'steer' | 'queue' | undefined;
    sessionId: string | null;
    providerID: string;
    sessionPhase: SessionPhase;
    forceQueue?: boolean;
    unifiedState?: ReturnType<typeof unifiedNativeSessionState>;
}): 'steer' | 'queue' | undefined => {
    if (!sessionId || !isNativeSessionId(sessionId)) return delivery;
    if (isUnifiedNativeSessionId(sessionId)) {
        const sameSource = unifiedState?.sourceSessionID
            && !unifiedState.preparing
            && unifiedState.backend === nativeBackendOfProviderId(providerID);
        if (sameSource && !forceQueue) return delivery === 'queue' ? 'steer' : delivery;
        return sessionPhase !== 'idle' || forceQueue ? 'queue' : delivery;
    }
    if (nativeBackendOfSessionId(sessionId) === 'antigravity') {
        return sessionPhase !== 'idle' || forceQueue ? 'queue' : delivery;
    }
    return delivery === 'queue' ? 'steer' : delivery;
};

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
