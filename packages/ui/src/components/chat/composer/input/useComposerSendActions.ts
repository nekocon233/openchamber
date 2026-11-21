import { isNativeSessionId } from '@/lib/native-agents/ids';
import type { useComposerSelection } from './useComposerSelection';
import { resolveNativeFollowUpDelivery } from '../../lib/followUpDrafts';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { ComposerSendHandlers } from './composerSendHandlers';
import React from 'react';
import type { ResolvedStarter } from '../../useDraftStarters';

type Dependencies = {
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'pendingFirstSend' | 'getCurrentInputSnapshot' | 'isPageWaiting'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'inputMode' | 'currentSessionId' | 'btwSessionId'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'currentSessionPhase' | 'autoReviewRunning'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'effectiveBtwSelection' | 'unifiedState'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'followUpBehavior'>;
    queueActions: Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueueMessage'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
};

export function useComposerSendActions({
    inlineContext, sendAvailability, sendHandlers, sessionScope, sessionLifecycle, queueState,
    queueActions, editorState, draftText, selection,
}: Dependencies) {
    const { isMobileCommentOpen } = inlineContext;
    const { pendingFirstSend, getCurrentInputSnapshot, isPageWaiting } = sendAvailability;
    const { handleSubmitRef } = sendHandlers;
    const { isBtwActive, inputMode, currentSessionId } = sessionScope;
    const { currentSessionPhase, autoReviewRunning } = sessionLifecycle;
    const { followUpBehavior } = queueState;
    const { handleQueueMessage } = queueActions;
    const { composerRef } = editorState;
    const { composerText } = draftText;

    const followUpDelivery = autoReviewRunning ? 'queue' : resolveNativeFollowUpDelivery({
        sessionId: isBtwActive ? sessionScope.btwSessionId : currentSessionId,
        providerID: (isBtwActive ? selection.effectiveBtwSelection.model?.providerId : selection.currentProviderId) ?? '',
        sessionPhase: currentSessionPhase,
        delivery: followUpBehavior,
        unifiedState: isBtwActive ? undefined : selection.unifiedState,
    }) ?? followUpBehavior;

    const handlePrimaryAction = React.useCallback(() => {
        if (isMobileCommentOpen()) return;
        if (pendingFirstSend) return;
        if (currentSessionId && isNativeSessionId(currentSessionId) && !isBtwActive) {
            void handleSubmitRef.current();
            return;
        }
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = !isBtwActive && !isPageWaiting && inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);
        if (followUpDelivery === 'queue' && canQueue) {
            void handleQueueMessage();
        } else if (followUpDelivery === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, currentSessionPhase, autoReviewRunning, followUpDelivery, handleQueueMessage, isBtwActive, isPageWaiting, isMobileCommentOpen, pendingFirstSend, handleSubmitRef]);

    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        const draft = (composerRef.current?.getValue() ?? composerText.get()).trim();
        const presetText = draft ? `${text}${type === 'command' ? ' ' : '\n'}${draft}` : text;
        void handleSubmitRef.current({ presetText });
    }, [composerText, composerRef, handleSubmitRef]);

    const handlePresetChipSubmit = React.useCallback((starter: ResolvedStarter) => {
        submitPresetPrompt(starter.submitText, starter.ref.type);
    }, [submitPresetPrompt]);

    return {
        submitPresetPrompt, handlePrimaryAction, handlePresetChipSubmit, followUpDelivery,
    };
}
