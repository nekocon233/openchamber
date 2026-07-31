import { describe, expect, test } from 'bun:test';

import type { QueuedMessage } from '@/stores/messageQueueStore';
import {
    selectFollowUpDraft,
    shouldStageFollowUpAsDraft,
    shouldUseFollowUpDelivery,
} from './followUpDrafts';

const activeFollowUp = {
    inputMode: 'normal' as const,
    hasContent: true,
    sessionId: 'session-1',
    sessionPhase: 'busy' as const,
    autoReviewRunning: false,
};

describe('shouldStageFollowUpAsDraft', () => {
    test('stages normal follow-ups while the session is active', () => {
        expect(shouldStageFollowUpAsDraft(activeFollowUp)).toBe(true);
        expect(shouldStageFollowUpAsDraft({ ...activeFollowUp, sessionPhase: 'retry' })).toBe(true);
        expect(shouldStageFollowUpAsDraft({
            ...activeFollowUp,
            sessionPhase: 'idle',
            autoReviewRunning: true,
        })).toBe(true);
    });

    test('keeps idle, empty, shell, and sessionless submissions out of drafts', () => {
        expect(shouldStageFollowUpAsDraft({ ...activeFollowUp, sessionPhase: 'idle' })).toBe(false);
        expect(shouldStageFollowUpAsDraft({ ...activeFollowUp, hasContent: false })).toBe(false);
        expect(shouldStageFollowUpAsDraft({ ...activeFollowUp, inputMode: 'shell' })).toBe(false);
        expect(shouldStageFollowUpAsDraft({ ...activeFollowUp, sessionId: null })).toBe(false);
    });
});

describe('shouldUseFollowUpDelivery', () => {
    const idleSubmission = {
        inputMode: 'normal' as const,
        sessionId: 'session-1',
        sessionPhase: 'idle' as const,
        dismissedBlockingPrompt: false,
    };

    test('uses follow-up handling when authoritative activity is busy, retrying, or unavailable', () => {
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, authoritativeSessionPhase: 'busy' })).toBe(true);
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, authoritativeSessionPhase: 'retry' })).toBe(true);
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, authoritativeSessionPhase: null })).toBe(true);
    });

    test('sends directly only after authoritative idle and preserves existing local activity rules', () => {
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, authoritativeSessionPhase: 'idle' })).toBe(false);
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, sessionPhase: 'busy' })).toBe(true);
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, dismissedBlockingPrompt: true })).toBe(true);
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, inputMode: 'shell' })).toBe(false);
        expect(shouldUseFollowUpDelivery({ ...idleSubmission, sessionId: null })).toBe(false);
    });
});

describe('selectFollowUpDraft', () => {
    const drafts: QueuedMessage[] = [
        { id: 'draft-1', messageId: 'msg_first', content: 'first', createdAt: 1, status: 'staged' },
        { id: 'draft-2', messageId: 'msg_second', content: 'second', createdAt: 2, status: 'staged' },
    ];

    test('returns only the explicitly selected draft', () => {
        expect(selectFollowUpDraft(drafts, 'draft-2')).toBe(drafts[1]);
    });

    test('never falls back to another draft when selection is absent or stale', () => {
        expect(selectFollowUpDraft(drafts, undefined)).toBeNull();
        expect(selectFollowUpDraft(drafts, 'missing')).toBeNull();
    });
});
