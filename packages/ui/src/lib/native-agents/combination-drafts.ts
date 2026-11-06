import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { NativeAgentConfigurationWrite, NativeAgentModel } from './combinations';

export type AgentCombinationDraftConfiguration = NativeAgentConfigurationWrite & { inheritedMain?: NativeAgentModel };
export type AgentCombinationDraftTarget = string | { draftId: number };
export type AgentCombinationDraftSnapshot = { target: AgentCombinationDraftTarget; configuration: AgentCombinationDraftConfiguration };
const keyOf = (target: AgentCombinationDraftTarget) => JSON.stringify([getRuntimeKey(), target]);
export const useAgentCombinationDrafts = create<{
  drafts: Map<string, AgentCombinationDraftConfiguration>;
  set: (target: AgentCombinationDraftTarget, configuration: AgentCombinationDraftConfiguration) => void;
  clear: (target: AgentCombinationDraftTarget, configuration: AgentCombinationDraftConfiguration) => void;
}>((set) => ({
  drafts: new Map(),
  clear: (directory, configuration) => set((state) => {
    const key = keyOf(directory);
    if (state.drafts.get(key) !== configuration) return state;
    const drafts = new Map(state.drafts); drafts.delete(key);
    return { drafts };
  }),
  set: (directory, configuration) => set((state) => {
    const drafts = new Map(state.drafts);
    drafts.set(keyOf(directory), configuration);
    if (drafts.size > 50) {
      const first = drafts.keys().next().value;
      if (first !== undefined) drafts.delete(first);
    }
    return { drafts };
  }),
}));
export const readAgentCombinationDraft = (target: AgentCombinationDraftTarget) => useAgentCombinationDrafts.getState().drafts.get(keyOf(target));
export const captureAgentCombinationDraft = (target: AgentCombinationDraftTarget): AgentCombinationDraftSnapshot | undefined => {
  const configuration = readAgentCombinationDraft(target);
  return configuration ? { target, configuration } : undefined;
};
export const agentCombinationDraftKey = keyOf;
