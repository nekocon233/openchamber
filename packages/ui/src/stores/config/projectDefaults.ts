import { type NativeAgentModel, resolveCombinationModelDefault } from '@/lib/native-agents/combinations';
import { readAgentCombinationDraft } from '@/lib/native-agents/combination-drafts';
import type { ConfigStore } from './types';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '../useConfigStore';
import { normalizeConfigPath, toDirectoryKey } from './directories';
import { normalizeOptionalString } from './selectionResolution';
import { resolveProjectDirectory } from './worktreeProjects';

export const readDefaultCombinationMain = (id: string | undefined, directory?: string | null): NativeAgentModel | undefined => {
    if (!id) return undefined;
    const state = useConfigStore.getState();
    const session = useSessionUIStore.getState();
    if (!session.currentSessionId && session.newSessionDraft.open
        && (!directory || toDirectoryKey(directory) === state.activeDirectoryKey)) {
        const held = readAgentCombinationDraft({ draftId: session.newSessionDraft.draftId });
        if (held?.combination?.id === id && held.inheritedMain) return held.inheritedMain;
    }
    return state.nativeAgentCombinations.find((entry) => entry.id === id)?.main;
};

export const readGlobalModelDefaults = (state: Pick<ConfigStore, 'settingsDefaultAgentCombinationId' | 'settingsDefaultModel' | 'settingsDefaultVariant'>, directory?: string | null) => ({
    settingsDefaultModel: state.settingsDefaultModel,
    settingsDefaultVariant: state.settingsDefaultVariant,
    settingsDefaultAgentCombinationId: state.settingsDefaultAgentCombinationId,
    settingsDefaultCombinationMain: readDefaultCombinationMain(state.settingsDefaultAgentCombinationId, directory),
});

export const getFallbackProjectDirectory = (): string | null => {
    try {
        const { projects, activeProjectId } = useProjectsStore.getState();
        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId)
            : null;
        return normalizeConfigPath(active?.path ?? projects[0]?.path ?? null);
    } catch {
        return null;
    }
};

export type ProjectDefaults = { projectDefaultAgent?: string; projectDefaultModel?: string; projectDefaultVariant?: string; projectDefaultAgentCombinationId?: string; projectDefaultCombinationMain?: NativeAgentModel };

export const isChatDraftOpen = (): boolean => {
    const session = useSessionUIStore.getState();
    return !session.currentSessionId && Boolean(session.newSessionDraft?.open) && session.newSessionDraft.target === 'chat';
};

export const getProjectDefaultsForConfigDirectory = (directory: string | null | undefined): ProjectDefaults => {
    const configDirectory = normalizeConfigPath(directory);
    if (!configDirectory) {
        return {};
    }
    if (isChatDraftOpen() && toDirectoryKey(configDirectory) === useConfigStore.getState().activeDirectoryKey) return {};
    return readProjectDefaults(configDirectory);
};

export const readProjectDefaults = (configDirectory: string): ProjectDefaults => {
    const projectDirectory = resolveProjectDirectory(configDirectory);
    const project = useProjectsStore.getState().projects.find((entry) => normalizeConfigPath(entry.path) === projectDirectory);
    const main = readDefaultCombinationMain(project?.defaultAgentCombinationId, configDirectory);
    const resolved = main ? { defaultModel: `${main.model.providerID}/${main.model.modelID}`, defaultVariant: main.variant }
        : resolveCombinationModelDefault(project ?? {}, useConfigStore.getState().nativeAgentCombinations);
    return {
        projectDefaultAgent: normalizeOptionalString(project?.defaultAgent),
        projectDefaultAgentCombinationId: project?.defaultAgentCombinationId,
        projectDefaultCombinationMain: main,
        projectDefaultModel: normalizeOptionalString(resolved.defaultModel),
        projectDefaultVariant: normalizeOptionalString(resolved.defaultVariant),
    };
};
