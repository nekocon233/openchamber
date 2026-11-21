import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getChatDraftIdentityKey, writeChatDraft, readChatDraft } from '@/lib/chatDraftPersistence';
import { isNativeSessionId } from '@/lib/native-agents/ids';
import { nativeAgentConfigurationOf, type NativeAgentModel } from '@/lib/native-agents/combinations';
import { isNativeLocalCommand } from '@/sync/native-send';
import { sendClaimedFollowUp } from '@/hooks/useQueuedMessageAutoSend';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import type { ComposerSendHandlers } from './composerSendHandlers';
import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import {
  isServerOwnedMessageQueue,
  useMessageQueueStore,
  type QueuedContextPart,
  type QueuedMessage,
  type QueuedMessageGoal,
} from '@/stores/messageQueueStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useSelectionStore } from '@/sync/selection-store';
import { prepareUserMessageResume } from '@/sync/user-message-resume';
import { attachedImagesAsPathNotes, ImageSaveForTextModelError, modelCannotReadImages } from '@/sync/text-model-images';
import { useInputStore, type SyntheticContextPart } from '@/sync/input-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { CONTEXT_METADATA_KEY, draftFromContextPayload } from '@/lib/messages/contextParts';
import { toast } from '@/components/ui';
import { collectRunningActions, planRunningActionsNote } from '../../lib/runningActionsNote';
import { composerReferenceKey, toContextReference, withComposerReferences, type ComposerReference } from '../../composer/composerReferences';
import { referencesLinkedIn, withoutSharedPageLinks, withReferencesFromText } from '../../composer/referenceLinks';
import { type SessionReference } from '../../composer/sessionReferences';
import { routeGuestSlashCommand } from '../../composer/submit/guestCommands';
import { opencodeClient } from '@/lib/opencode/client';
import { buildSkillMentionInstruction } from '@/lib/skillMentionInstruction';
import { withMissingCitations } from '@/lib/attachmentIdentity';
import { filterMissingInlineAttachments } from '../../composer/attachments/inlineMentionAttachments';
import { buildComposerContext, expandCommentSnippets, queuedContextToParts } from '../../composer/submit/buildOutgoingMessage';
import { planLocalSlashCommand } from '../../composer/submit/slashCommands';
import { withoutShareLinkKeys } from '@/lib/received-pages/link';
import { withRegisteredSharedPages } from '../../sharePages/received/takeShareLink';
import type { ChatInputProps } from './chatInputProps';
import { collectInlineSkillMentions } from './composerMentionTokens';
import { recordLinkedReferences } from './recordLinkedReferences';

type Dependencies = {
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'nativeAgents'>;
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen' | 'hasDrafts' | 'attachmentsToSend' | 'inlineDraftTarget' | 'consumeDrafts'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'waitForPendingAttachments'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'confirmedMentionsRef' | 'composerText' | 'currentChatDraftIdentityRef'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleQueueMessageRef' | 'handleSubmitRef'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'getCurrentInputSnapshot'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'inputMode' | 'sendHeldByMissingFolderRef' | 'consumePendingSyntheticParts' | 'projectActionsRef' | 'clearAttachedFiles' | 'chatDraftIdentity'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'messageQueueTarget' | 'addToQueue' | 'popQueuedToInput'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'guestCommands' | 'readSessionMentionsBeforeSend' | 'linkedReferences' | 'availableSkills' | 'referenceLinksIn' | 'sessionMentionsIn' | 'rememberSessionMentions'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'mailboxTarget' | 'currentAgentName' | 'currentVariant'>;
    mentionAttachments: Pick<ReturnType<typeof useComposerMentionAttachments>, 'sanitizeAttachmentsForSend' | 'prepareReadOnSendMentions' | 'mentionableAgents' | 'extractInlineFileMentions'>;
    props: Pick<ChatInputProps, 'scrollToLatest'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'setLinkedReferencesFor' | 'updateLinkedReferencesFor' | 'updateLinkedReferences'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
};

export function useComposerQueueActions({
    inlineContext, attachmentWork, i18n, draftText, editorState, sendHandlers, sendAvailability,
    sessionScope, queueState, language, selection, mentionAttachments, props, referenceDrafts,
    preferences, runtime,
}: Dependencies) {
    const { isMobileCommentOpen, hasDrafts, attachmentsToSend, inlineDraftTarget, consumeDrafts } = inlineContext;
    const { waitForPendingAttachments } = attachmentWork;
    const { t } = i18n;
    const { setMessage, confirmedMentionsRef, composerText, currentChatDraftIdentityRef } = draftText;
    const { composerRef } = editorState;
    const { handleQueueMessageRef, handleSubmitRef } = sendHandlers;
    const { getCurrentInputSnapshot } = sendAvailability;
    const {
        currentSessionId, inputMode, sendHeldByMissingFolderRef, consumePendingSyntheticParts,
        projectActionsRef, chatDraftIdentity,
    } = sessionScope;
    const { messageQueueTarget, addToQueue, popQueuedToInput } = queueState;
    const {
        guestCommands, readSessionMentionsBeforeSend, linkedReferences, availableSkills,
        referenceLinksIn, sessionMentionsIn, rememberSessionMentions,
    } = language;
    const { currentProviderId, currentModelId, mailboxTarget, currentAgentName, currentVariant } = selection;
    const {
        sanitizeAttachmentsForSend, prepareReadOnSendMentions, mentionableAgents,
        extractInlineFileMentions,
    } = mentionAttachments;
    const { scrollToLatest } = props;
    const { updateLinkedReferencesFor, updateLinkedReferences } = referenceDrafts;
    const { isMobile } = preferences;

    const handleQueueMessage = React.useCallback(async (captured?: {
        message: string; hasContent: boolean; attachments: AttachedFile[];
        originalMessage?: string;
        selection?: QueuedMessage['sendConfig'];
    }) => {
        if (isMobileCommentOpen()) return;
        if (!captured && await waitForPendingAttachments()) {
            void handleQueueMessageRef.current();
            return;
        }
        const inputSnapshot = captured ?? getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent || !currentSessionId || !messageQueueTarget) return;

        const { providerID, modelID, agent, variant } = captured?.selection ?? {
            providerID: currentProviderId, modelID: currentModelId, agent: currentAgentName, variant: currentVariant,
        };
        const native = isNativeSessionId(currentSessionId);
        const command = planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, true);
        if ((command && (!native || isNativeLocalCommand(command.command.name)))
            || (!native && routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands))) {
            void handleSubmitRef.current();
            return;
        }
        if (sendHeldByMissingFolderRef.current()) return;
        const queueRuntimeKey = getRuntimeKey();
        const queueTarget = messageQueueTarget;
        const queueSessionId = currentSessionId;
        const queueDraftKey = chatDraftIdentity && getChatDraftIdentityKey(chatDraftIdentity);
        const ownsDraft = () => {
            const showing = currentChatDraftIdentityRef.current;
            return (showing && getChatDraftIdentityKey(showing)) === queueDraftKey && getRuntimeKey() === queueRuntimeKey;
        };
        const inputAttachments = captured?.attachments ?? attachmentsToSend(inputSnapshot.message);
        let subagentModel: NativeAgentModel | null | undefined;
        if (native) {
            try {
                if ((await runtime.nativeAgents.capabilities()).agentCombinations) {
                    const session = await runtime.nativeAgents.getSession(queueSessionId, queueTarget.directory);
                    subagentModel = nativeAgentConfigurationOf(session.metadata)?.subagent ?? null;
                }
            } catch {
                toast.error(t('chat.queuedMessage.toast.queueFailed'));
                return;
            }
            if (getRuntimeKey() !== queueRuntimeKey) return;
        }
        const settleModelPick = useSelectionStore.getState().captureSessionModelPickSettlement(
            queueSessionId, providerID, modelID, queueRuntimeKey,
        );
        const resumeAfterQueue = prepareUserMessageResume(queueSessionId, queueRuntimeKey);
        const messageToQueue = withoutShareLinkKeys(inputSnapshot.message.replace(/^\n+|\n+$/g, ''));
        if (!(await readSessionMentionsBeforeSend(messageToQueue))) return;
        const composerAttachments = sanitizeAttachmentsForSend(inputAttachments);

        const readOnSendMentions = await prepareReadOnSendMentions(
            [messageToQueue],
            new Set(composerAttachments.map((attachment) => attachment.filename)),
            queueRuntimeKey,
            composerAttachments,
        );
        if (readOnSendMentions.status === 'runtime-changed') return;
        if (readOnSendMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: readOnSendMentions.filename }));
            return;
        }
        const { sanitizedText, mention } = parseAgentMentions(withoutSharedPageLinks(messageToQueue, linkedReferences), mentionableAgents());
        const { attachments: extractedMentionAttachments } = extractInlineFileMentions(sanitizedText, readOnSendMentions.prepared, composerAttachments);
        // external: #3898 OpenCode rejects the entire prompt when an inline file mention does not exist.
        const { sendable: mentionAttachments } = await filterMissingInlineAttachments(
            extractedMentionAttachments,
            opencodeClient,
        );
        let attachmentsToQueue = [...composerAttachments, ...mentionAttachments];
        if (modelCannotReadImages(providerID, modelID)) {
            try {
                attachmentsToQueue = await attachedImagesAsPathNotes(attachmentsToQueue, queueTarget.directory);
            } catch (error) {
                if (!(error instanceof ImageSaveForTextModelError)) throw error;
                toast.error(t('chat.chatInput.toast.textModelImageSaveFailed', { files: error.filenames.join(', ') }));
                return;
            }
            if (getRuntimeKey() !== queueRuntimeKey) return;
        }
        const availableSkillNames = new Set(
            availableSkills.map((skill) => skill.name),
        );
        const skillInstruction = buildSkillMentionInstruction(collectInlineSkillMentions(sanitizedText, availableSkillNames));
        const textToQueue = await useSnippetsStore.getState().expandText(sanitizedText).catch((error) => {
            console.warn('[queue] Failed to expand snippets, queueing original text:', error);
            return sanitizedText;
        });

        if (!ownsDraft()) return;
        const syntheticParts = consumePendingSyntheticParts(mailboxTarget) ?? [];
        const draftTarget = inlineDraftTarget;
        const drafts = draftTarget ? consumeDrafts(draftTarget) : [];
        const linked = referencesLinkedIn(messageToQueue, linkedReferences);
        const linkedToQueue = await withRegisteredSharedPages(withReferencesFromText(linked, referenceLinksIn(messageToQueue)));
        const expandedDrafts = await expandCommentSnippets(drafts, useSnippetsStore.getState().expandText);
        const actionsNote = currentSessionId
            ? planRunningActionsNote(currentSessionId, collectRunningActions(projectActionsRef.current))
            : null;
        const context = buildComposerContext({
            inlineComments: expandedDrafts,
            syntheticTexts: [...syntheticParts.map((part) => part.text), ...(actionsNote?.text ? [actionsNote.text] : [])],
            references: [...linkedToQueue.map(toContextReference), ...sessionMentionsIn(messageToQueue)],
        }, skillInstruction);
        const goalArm = !native && textToQueue.trim()
            ? useSessionGoalArmStore.getState().consume()
            : { armed: false, objectiveOverride: null };
        const goalSettings = useUIStore.getState();
        const goal: QueuedMessageGoal | undefined = goalArm.armed ? {
            tokenBudget: goalSettings.sessionGoalDefaultBudgetEnabled ? goalSettings.sessionGoalDefaultBudget : null,
        } : undefined;
        if (goal && goalArm.objectiveOverride?.trim()) goal.objective = goalArm.objectiveOverride;

        scrollToLatest?.();

        try {
            const sendConfig = providerID && modelID ? {
                providerID,
                modelID,
                agent: agent ?? undefined,
                variant: variant ?? undefined,
                ...(subagentModel !== undefined ? { subagentModel } : {}),
            } : undefined;
            const attachments = attachmentsToQueue.length ? attachmentsToQueue : undefined;
            if (!isServerOwnedMessageQueue(queueTarget)) {
                await addToQueue(queueTarget, {
                    content: textToQueue, agentMentionName: mention?.name, attachments,
                    additionalParts: queuedContextToParts(context), status: native ? 'staged' : 'queued', sendConfig, goal,
                });
            } else {
                await addToQueue(queueTarget, {
                    content: messageToQueue, text: textToQueue, agentMention: mention?.name,
                    attachments, context: context.length ? context : undefined, sendConfig, goal,
                });
            }
        } catch (error) {
            console.warn('[queue] failed to queue message:', error);
            toast.error(t('chat.queuedMessage.toast.queueFailed'));
            if (goalArm.armed) useSessionGoalArmStore.getState().setArmed(true, goalArm.objectiveOverride);
            if (draftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(draftTarget, drafts);
            }
            if (syntheticParts.length > 0) {
                useInputStore.getState().setPendingSyntheticParts(syntheticParts, mailboxTarget);
            }
            return;
        }
        const originalMessage = captured?.originalMessage ?? inputSnapshot.message;
        if (ownsDraft() && (composerRef.current?.getValue() ?? composerText.get()) === originalMessage) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            if (!isMobile) composerRef.current?.focus();
        }
        if (composerAttachments.length) {
            const input = useInputStore.getState();
            const current = input.attachmentDraftKey === queueDraftKey ? input.attachedFiles : (queueDraftKey && input.attachmentDrafts.get(queueDraftKey)) || [];
            const sent = new Set(composerAttachments.map((file) => file.id));
            input.setAttachedFiles(current.filter((file) => !sent.has(file.id)), chatDraftIdentity);
        }
        const usedRefs = new Set(linked.map(composerReferenceKey));
        updateLinkedReferencesFor(chatDraftIdentity, (current) => current.filter((ref) => !usedRefs.has(composerReferenceKey(ref))));
        if (queueSessionId && agent) {
            useSelectionStore.getState().settleSessionAgentPick(queueSessionId, agent);
        }
        if (inputMode !== 'shell') settleModelPick();
        void resumeAfterQueue().catch(console.warn);
        recordLinkedReferences(queueSessionId, queueTarget.directory, linkedToQueue);
        if (currentSessionId) actionsNote?.commit(currentSessionId);
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, inputMode, hasDrafts, guestCommands, attachmentsToSend, sanitizeAttachmentsForSend, prepareReadOnSendMentions, extractInlineFileMentions, mentionableAgents, availableSkills, consumePendingSyntheticParts, mailboxTarget, inlineDraftTarget, consumeDrafts, linkedReferences, scrollToLatest, chatDraftIdentity, currentChatDraftIdentityRef, runtime.nativeAgents, updateLinkedReferencesFor, isMobile, isMobileCommentOpen, addToQueue, currentProviderId, currentModelId, currentAgentName, currentVariant, t, readSessionMentionsBeforeSend, sessionMentionsIn, referenceLinksIn, composerText, setMessage, waitForPendingAttachments, projectActionsRef, handleSubmitRef, handleQueueMessageRef, confirmedMentionsRef, sendHeldByMissingFolderRef, composerRef]);

    const restoreQueuedContext = React.useCallback((context: readonly QueuedContextPart[]) => {
        const synthetic: SyntheticContextPart[] = [];
        const restored: Exclude<ComposerReference, { kind: 'shared-page' }>[] = [];
        const sharedPages: ComposerReference[] = [];
        const mentions: SessionReference[] = [];
        for (const part of context) {
            if (part.kind === 'synthetic') {
                synthetic.push({ text: part.text, synthetic: true });
                continue;
            }
            if (part.kind !== 'context') continue;
            const payload = part.metadata[CONTEXT_METADATA_KEY];
            if (payload.kind === 'shared-page') {
                sharedPages.push({
                    kind: 'shared-page',
                    shareKey: payload.receivedId ?? payload.host,
                    receivedId: payload.receivedId,
                    host: payload.host,
                    title: payload.title || null,
                    opened: payload.opened,
                    contextText: part.text,
                });
            } else if (payload.kind === 'repository-issue') {
                restored.push({
                    kind: 'repository-issue',
                    ...(payload.provider ? { provider: payload.provider } : {}),
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                });
            } else if (payload.kind === 'repository-discussion') {
                restored.push({
                    kind: 'repository-discussion',
                    provider: payload.provider,
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                });
            } else if (payload.kind === 'change-request') {
                restored.push({
                    kind: 'change-request',
                    provider: payload.provider ?? 'github',
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    head: '',
                    base: '',
                    includeDiff: false,
                    contextText: part.text,
                });
            } else if (payload.kind === 'tracker-item') {
                restored.push({ kind: 'tracker-item', provider: payload.provider, identifier: payload.identifier, title: payload.title, url: payload.url, contextText: part.text });
            } else if (payload.kind === 'session') {
                mentions.push({ kind: 'session', sessionId: payload.sessionId, title: payload.title, contextText: part.text });
            } else if (payload.kind === 'session-message') {
                mentions.push({
                    kind: 'session-message',
                    sessionId: payload.sessionId,
                    messageId: payload.messageId,
                    sessionTitle: payload.sessionTitle,
                    excerpt: payload.excerpt,
                    contextText: part.text,
                });
            } else if (payload.kind === 'guest-issue' || payload.kind === 'guest-pr') {
                restored.push({
                    kind: 'guest',
                    providerId: payload.providerId,
                    id: payload.id,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                    thread: payload.kind === 'guest-pr' ? 'pull' : 'issue',
                    data: payload.data,
                });
            } else {
                const draft = draftFromContextPayload(payload);
                if (draft && inlineDraftTarget) {
                    useInlineCommentDraftStore.getState().addDraft(inlineDraftTarget, draft, { written: true });
                }
            }
        }
        const chips: ComposerReference[] = [...restored, ...sharedPages];
        if (chips.length > 0) {
            updateLinkedReferences((current) => withComposerReferences(current, chips));
        }
        rememberSessionMentions(mentions);
        if (synthetic.length > 0) {
            const pending = useInputStore.getState().getPendingSyntheticParts(mailboxTarget) ?? [];
            useInputStore.getState().setPendingSyntheticParts([...pending, ...synthetic], mailboxTarget);
        }
    }, [inlineDraftTarget, mailboxTarget, rememberSessionMentions, updateLinkedReferences]);

    const handleQueuedMessageEdit = React.useCallback((messageId: string) => {
        if (!messageQueueTarget) return;
        void Promise.resolve(popQueuedToInput(messageQueueTarget, messageId)).then((queued) => {
            if (!queued) return;
            const input = useInputStore.getState();
            if (queued.attachments?.length) input.restoreAttachedFiles(queued.attachments, chatDraftIdentity);
            if (queued.additionalParts?.length) {
                input.setPendingSyntheticParts([...queued.additionalParts, ...(input.getPendingSyntheticParts(mailboxTarget) ?? [])], mailboxTarget);
            }
            const text = withMissingCitations([queued.agentMentionName && `@${queued.agentMentionName}`, queued.content].filter(Boolean).join(' '), queued.attachments ?? []);
            const showing = currentChatDraftIdentityRef.current;
            if ((showing && getChatDraftIdentityKey(showing)) !== (chatDraftIdentity && getChatDraftIdentityKey(chatDraftIdentity))) {
                if (chatDraftIdentity) {
                    const draft = readChatDraft(chatDraftIdentity);
                    writeChatDraft(chatDraftIdentity, [draft.text, text].filter(Boolean).join('\n'), draft.confirmedMentions);
                }
                return;
            }
            setMessage(text);
            if (queued.goal) useSessionGoalArmStore.getState().setArmed(true, queued.goal.objective ?? null);
            restoreQueuedContext(queued.context ?? []);
            setTimeout(() => {
                composerRef.current?.focus();
            }, 0);
        }).catch((error) => {
            console.warn('[queue] failed to take queued message for editing:', error);
            toast.error(t('chat.queuedMessage.toast.takeFailed'));
        });
    }, [messageQueueTarget, popQueuedToInput, restoreQueuedContext, t, setMessage, composerRef, chatDraftIdentity, currentChatDraftIdentityRef, mailboxTarget]);

    const handleQueuedMessageSend = React.useCallback((messageId: string) => {
        if (!messageQueueTarget) return;
        const queue = useMessageQueueStore.getState();
        const item = queue.getQueueForTarget(messageQueueTarget).find((message) => message.id === messageId);
        if (!item) return;
        const send = item.deliveryOwner === 'server'
            ? queue.sendServerItem(messageQueueTarget, item.id)
            : sendClaimedFollowUp(messageQueueTarget, item.id, 'manual');
        void send.catch(() => toast.error(t('chat.queuedMessage.sendFailed')));
    }, [messageQueueTarget, t]);

    return {
        handleQueueMessage, handleQueuedMessageEdit, handleQueuedMessageSend,
    };
}
