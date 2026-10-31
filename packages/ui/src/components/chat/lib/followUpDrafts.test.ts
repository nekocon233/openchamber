import { describe, expect, test } from 'bun:test';

import type { QueuedMessage } from '@/stores/messageQueueStore';
import {
    resolveFollowUpDeliveryDecision,
    resolveNativeFollowUpDelivery,
    selectFollowUpDraft,
    shouldStageFollowUpAsDraft,
} from './followUpDrafts';

const activeFollowUp = {
    inputMode: 'normal' as const,
    hasContent: true,
    sessionId: 'session-1',
    sessionPhase: 'busy' as const,
    autoReviewRunning: false,
};

describe('native follow-up delivery', () => {
    const sessionId = 'ncv_da191fca-62c9-4acb-875a-8847578e36ca';
    const state = {
        kind: 'unified' as const, backend: 'codex' as const, revision: 1, recordRevision: 1,
        historyRevision: 0, sourceSessionID: 'ncx_source', switchReady: false, preparing: false,
    };
    const busy = {
        sessionId, providerID: 'codex-native', sessionPhase: 'busy' as const,
        delivery: 'queue' as const, unifiedState: state,
    };

    test('steers a running Codex source even though the whole execution is not switch-ready', () => {
        expect(resolveNativeFollowUpDelivery(busy)).toBe('steer');
        expect(resolveNativeFollowUpDelivery({ ...busy, delivery: 'steer' })).toBe('steer');
        expect(resolveNativeFollowUpDelivery({ ...busy, sessionPhase: 'retry' })).toBe('steer');
    });

    test('keeps Claude and DeepSeek follow-ups on their current native source', () => {
        for (const backend of ['claude', 'deepseek'] as const) {
            expect(resolveNativeFollowUpDelivery({
                ...busy, providerID: `${backend}-native`, unifiedState: { ...state, backend },
            })).toBe('steer');
        }
    });

    test('queues a different backend even when the requested preference is steer', () => {
        expect(resolveNativeFollowUpDelivery({ ...busy, providerID: 'claude-native', delivery: 'steer' })).toBe('queue');
    });

    test('does not steer while source ownership is unknown or handoff is preparing', () => {
        expect(resolveNativeFollowUpDelivery({ ...busy, unifiedState: undefined })).toBe('queue');
        expect(resolveNativeFollowUpDelivery({ ...busy, unifiedState: { ...state, sourceSessionID: null } })).toBe('queue');
        expect(resolveNativeFollowUpDelivery({ ...busy, unifiedState: { ...state, preparing: true } })).toBe('queue');
    });

    test('preserves explicit queueing and sends idle handoffs normally', () => {
        expect(resolveNativeFollowUpDelivery({ ...busy, forceQueue: true })).toBe('queue');
        expect(resolveNativeFollowUpDelivery({ ...busy, providerID: 'claude-native', sessionPhase: 'idle', delivery: undefined })).toBeUndefined();
    });

    test('sends idle Antigravity prompts directly and queues only busy or explicitly queued prompts', () => {
        const agy = { sessionId: 'nag_e6166e67-797f-41d1-bda4-984fbfcf2a2e', providerID: 'antigravity-native' };
        expect(resolveNativeFollowUpDelivery({ ...agy, sessionPhase: 'idle', delivery: undefined })).toBeUndefined();
        expect(resolveNativeFollowUpDelivery({ ...agy, sessionPhase: 'busy', delivery: 'steer' })).toBe('queue');
        expect(resolveNativeFollowUpDelivery({ ...agy, sessionPhase: 'idle', delivery: undefined, forceQueue: true })).toBe('queue');
    });

    test('retains the independent CLI and OpenCode delivery paths', () => {
        for (const id of ['ncx_source', 'ncl_source', 'ndh_source']) {
            expect(resolveNativeFollowUpDelivery({ ...busy, sessionId: id, unifiedState: undefined })).toBe('steer');
        }
        expect(resolveNativeFollowUpDelivery({ ...busy, sessionId: 'ses_opencode' })).toBe('queue');
        expect(resolveNativeFollowUpDelivery({ ...busy, sessionId: null, delivery: undefined })).toBeUndefined();
    });
});

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

describe('resolveFollowUpDeliveryDecision', () => {
    const idleSubmission = {
        inputMode: 'normal' as const,
        sessionId: 'session-1',
        sessionPhase: 'idle' as const,
        dismissedBlockingPrompt: false,
    };

    test('uses follow-up handling when authoritative activity is busy or retrying', () => {
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, authoritativeSessionPhase: 'busy' })).toBe('follow-up');
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, authoritativeSessionPhase: 'retry' })).toBe('follow-up');
    });

    test('blocks an idle-looking send when authoritative activity is unavailable', () => {
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, authoritativeSessionPhase: null })).toBe('unavailable');
    });

    test('sends directly only after authoritative idle and preserves existing local activity rules', () => {
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, authoritativeSessionPhase: 'idle' })).toBe('direct');
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission })).toBe('direct');
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, sessionPhase: 'busy' })).toBe('follow-up');
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, dismissedBlockingPrompt: true })).toBe('follow-up');
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, inputMode: 'shell' })).toBe('direct');
        expect(resolveFollowUpDeliveryDecision({ ...idleSubmission, sessionId: null })).toBe('direct');
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
