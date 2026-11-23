import React from 'react';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { getRuntimeEndpointGeneration } from '@/lib/runtime-switch';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import type { useI18n } from '@/lib/i18n';
import { parseCodexComposerCommand } from '@/lib/native-agents/codex-commands';
import { useUIStore } from '@/stores/useUIStore';
import { isNativeLocalCommand } from '@/sync/native-send';
import { toast } from '@/components/ui';
import type { CodexCommandOutputState } from '../../CodexCommandOutput';
import { appendWithLineBreaks } from '../text';
import { resolveAutocompleteTrigger } from '../language/triggers';
import { executeCodexComposerCommand } from '../submit/codexCommands';
import { createComposerSubmitErrorMessage } from './createComposerSubmitErrorMessage';
import type { useComposerAutocompleteState } from './useComposerAutocompleteState';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerSessionScope } from './useComposerSessionScope';

interface NativeComposerCommandOptions {
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'inputMode' | 'currentSessionId' | 'currentDirectory' | 'currentSessionDirectoryForSync' | 'chatDraftIdentity' | 'activeRuntimeKey'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'nativeTargetBackend' | 'currentModelId' | 'currentAgentName' | 'currentVariant' | 'pinnedComposerSelection' | 'setScopedModelSelectorOpen'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'nativeAgents'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'composerText' | 'confirmedMentionsRef'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'persistDraftImmediately' | 'restoreDraft'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'setMobileControlsPanel'>;
    autocompleteState: Pick<ReturnType<typeof useComposerAutocompleteState>, 'closeAutocomplete' | 'setAutocompleteQuery' | 'setOpenAutocomplete'>;
}

type NativeCommandOutcome =
    | { kind: 'handled' }
    | { kind: 'continue'; text: string; agent?: 'plan' }
    | null;

export function useNativeComposerCommand({
    i18n, sessionScope, selection, runtime, draftText, draftHistory, editorState,
    preferences, mobilePanels, autocompleteState,
}: NativeComposerCommandOptions) {
    const { t } = i18n;
    const { activeRuntimeKey, chatDraftIdentity, currentSessionId, currentDirectory, currentSessionDirectoryForSync, inputMode, isBtwActive } = sessionScope;
    const { nativeTargetBackend, currentModelId, currentAgentName, currentVariant } = selection;
    const pinned = Boolean(selection.pinnedComposerSelection);
    const scope = JSON.stringify([activeRuntimeKey, getRuntimeEndpointGeneration(), chatDraftIdentity && getChatDraftIdentityKey(chatDraftIdentity)]);
    const [output, setOutput] = React.useState<{ scope: string; value: CodexCommandOutputState } | null>(null);
    const running = React.useRef(false);
    if (output && output.scope !== scope) setOutput(null);

    const setCommandText = (text: string) => {
        draftText.setMessage(text);
        draftHistory.persistDraftImmediately(chatDraftIdentity, text);
    };

    const run = async (text: string, ownsInput: () => boolean): Promise<NativeCommandOutcome> => {
        if (inputMode !== 'normal' || isBtwActive) return null;
        const codex = nativeTargetBackend === 'codex' ? parseCodexComposerCommand(text) : null;
        const deepseekCommand = nativeTargetBackend === 'deepseek' ? /^\/([a-z][a-z0-9_-]*)(?:\s|$)/i.exec(text.trim())?.[1] : undefined;
        const deepseek = deepseekCommand && !isNativeLocalCommand(deepseekCommand.toLowerCase()) ? deepseekCommand : null;
        if (!codex && !deepseek) return null;
        const handled = { kind: 'handled' } as const;
        if (running.current || !ownsInput()) return handled;
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return handled;
        }
        const directory = currentSessionDirectoryForSync ?? currentDirectory;
        if (deepseek && !currentSessionId) {
            toast.error(t('chat.deepseekCommand.needsSession'));
            return handled;
        }
        if (deepseek && !directory) return handled;
        if (codex && (!directory || !currentModelId)) {
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return handled;
        }

        const draftBefore = draftText.composerText.get();
        const mentions = new Set(draftText.confirmedMentionsRef.current);
        const draftContainsCommand = draftBefore === text;
        const continuesAsPrompt = codex?.name === 'init' || codex?.name === 'side' || (codex?.name === 'plan' && Boolean(codex.argument));
        const clearBeforeAction = Boolean(codex && !continuesAsPrompt && draftContainsCommand);
        running.current = true;
        autocompleteState.closeAutocomplete();
        try {
            if (deepseek && currentSessionId && directory) {
                const result = await runtime.nativeAgents.deepseekCommand({ sessionId: currentSessionId, directory, line: text.trim() });
                if (ownsInput()) {
                    if (draftContainsCommand && draftText.composerText.get() === draftBefore) setCommandText('');
                    if (result.kind === 'output') setOutput({ scope, value: { cliName: 'DeepSeek Harness', command: deepseek, output: result } });
                }
            } else if (codex && directory && currentModelId) {
                if (clearBeforeAction) setCommandText('');
                const result = await executeCodexComposerCommand(codex, {
                    sessionId: currentSessionId,
                    directory,
                    model: currentModelId,
                    variant: currentVariant,
                    agent: currentAgentName ?? 'build',
                    api: runtime.nativeAgents,
                    t,
                    isCurrent: ownsInput,
                    pinned,
                    openModelMenu: () => {
                        if (pinned) {
                            selection.setScopedModelSelectorOpen(true);
                            return;
                        }
                        if (preferences.isMobile) mobilePanels.setMobileControlsPanel('model');
                        useUIStore.getState().setModelSelectorOpen(true);
                    },
                });
                if (!ownsInput()) return handled;
                if (result.kind === 'output') {
                    setOutput({ scope, value: { command: codex.name, output: result } });
                } else if (result.kind === 'edit') {
                    const expected = clearBeforeAction ? '' : draftBefore;
                    if (draftText.composerText.get() !== expected) return handled;
                    setCommandText(result.text);
                    const trigger = resolveAutocompleteTrigger(result.text, result.text.length, { inputMode });
                    autocompleteState.setAutocompleteQuery(trigger?.query ?? '');
                    autocompleteState.setOpenAutocomplete(trigger?.kind ?? null);
                    editorState.composerRef.current?.focus();
                } else if (result.kind === 'prompt') {
                    if (draftText.composerText.get() !== draftBefore) return handled;
                    return { kind: 'continue', text: result.text, agent: result.agent };
                } else if (result.kind === 'rewrite') {
                    if (draftText.composerText.get() !== draftBefore) return handled;
                    return { kind: 'continue', text: result.text };
                }
            }
        } catch (error) {
            if (clearBeforeAction && (!ownsInput() || draftText.composerText.get() === '')) {
                draftHistory.restoreDraft(chatDraftIdentity, draftBefore, mentions);
            }
            if (ownsInput()) toast.error(createComposerSubmitErrorMessage(t)(error, t(deepseek ? 'chat.deepseekCommand.failed' : 'chat.codexCommand.failed')));
        } finally {
            running.current = false;
        }
        return handled;
    };

    return {
        available: nativeTargetBackend === 'codex' || nativeTargetBackend === 'deepseek',
        run,
        output: output?.scope === scope ? output.value : null,
        close: () => setOutput(null),
        insertCommand(text: string) {
            setOutput(null);
            const current = draftText.composerText.get();
            setCommandText(current ? appendWithLineBreaks(current, text) : text);
            editorState.composerRef.current?.focus();
        },
    };
}
