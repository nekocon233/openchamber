import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { NativeCommandResult } from '@/lib/api/types';
import { createTestNativeAgentsAPI } from '@/lib/native-agents/test-utils/runtime';
import { createComposerText } from '../state/composerText';
import { useNativeComposerCommand } from './useNativeComposerCommand';

const sessionId = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';
let dom: ReturnType<typeof installHookTestDom>;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
    dom = installHookTestDom();
    root = createRoot(dom.container);
});

afterEach(async () => {
    await act(() => root.unmount());
    dom.restore();
});

async function mountCommand(
    text: string,
    backend: 'codex' | 'deepseek',
    api = createTestNativeAgentsAPI({}),
) {
    const directory = '/work/native-command-test';
    const composerText = createComposerText(text);
    const options: Parameters<typeof useNativeComposerCommand>[0] = {
        i18n: { t: (key) => key },
        sessionScope: {
            inputMode: 'normal',
            isBtwActive: false,
            currentSessionId: sessionId,
            currentDirectory: directory,
            currentSessionDirectoryForSync: directory,
            chatDraftIdentity: createChatDraftIdentity('fixture', directory, sessionId),
            activeRuntimeKey: 'fixture',
        },
        selection: {
            nativeTargetBackend: backend,
            currentModelId: 'test-model',
            currentAgentName: 'build',
            currentVariant: undefined,
            pinnedComposerSelection: null,
            setScopedModelSelectorOpen: () => {},
        },
        runtime: { nativeAgents: api },
        draftText: {
            composerText, setMessage: (value) => composerText.set(value),
            confirmedMentionsRef: { current: new Set<string>() },
        },
        draftHistory: { persistDraftImmediately: () => {}, restoreDraft: () => {} },
        editorState: { composerRef: { current: null } },
        preferences: { isMobile: false },
        mobilePanels: { setMobileControlsPanel: () => {} },
        autocompleteState: { closeAutocomplete: () => {}, setOpenAutocomplete: () => {}, setAutocompleteQuery: () => {} },
    };
    let latest: ReturnType<typeof useNativeComposerCommand> | undefined;
    function Probe() {
        latest = useNativeComposerCommand(options);
        return null;
    }
    await act(() => root.render(<Probe />));
    return {
        composerText,
        command() {
            if (!latest) throw new Error('Native command composer did not render');
            return latest;
        },
    };
}

test('a Codex prompt command leaves draft ownership with the send path', async () => {
    const draft = '/init review the documentation';
    const view = await mountCommand(draft, 'codex');
    await act(async () => {
        expect(await view.command().run(draft, () => true)).toEqual({ kind: 'continue', text: draft });
    });
    expect(view.composerText.get()).toBe(draft);
});

test('a DeepSeek result preserves text typed while the command was pending', async () => {
    const draft = '/status';
    let respond: (result: NativeCommandResult) => void = () => { throw new Error('Native request was not ready'); };
    const response = new Promise<NativeCommandResult>((resolve) => { respond = resolve; });
    const view = await mountCommand(draft, 'deepseek', createTestNativeAgentsAPI({
        deepseekCommand: () => response,
    }));
    await act(async () => {
        const command = view.command().run(draft, () => true);
        view.composerText.set('The next draft');
        respond({ kind: 'output', notices: [], entries: [{ label: 'Status', detail: 'Ready' }] });
        await command;
    });
    expect(view.composerText.get()).toBe('The next draft');
    expect(view.command().output?.output.entries[0]?.detail).toBe('Ready');
});
