import React from 'react';
import type { NativePromptRequest } from '@/lib/api/types';
import { useSessionSelector } from '@/sync/sync-context';
import { configureNativeAgents } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { orderPickerItems } from '@/lib/modelPickerOrder';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { isUnifiedNativeSessionId } from '@/lib/native-agents/ids';
import { nativeAgentConfigurationOf, type NativeAgentCombination, type NativeAgentModel } from '@/lib/native-agents/combinations';
import { agentCombinationDraftKey, useAgentCombinationDrafts, type AgentCombinationDraftTarget } from '@/lib/native-agents/combination-drafts';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { listModelVariantIds } from '@/lib/modelVariants';
import type { Session } from '@/lib/opencode/model';

const selectMetadata = (session: Session | undefined) => session?.metadata;

export const useAgentCombinations = ({ enabled, sessionId, directory, agent, current, onMain }: {
  enabled: boolean; sessionId: string | null; directory: string | null; agent: string;
  current: Pick<NativePromptRequest, 'model' | 'variant'>;
  onMain: (choice: NativeAgentModel) => void;
}) => {
  const { t } = useI18n();
  const { nativeAgents } = useRuntimeAPIs();
  const blocked = useEnterpriseMode();
  const combinations = useConfigStore((state) => state.nativeAgentCombinations);
  const combinationOrder = useUIStore((state) => state.agentCombinationOrder);
  const providers = useConfigStore((state) => state.providers);
  const metadata = useSessionSelector(enabled ? sessionId ?? undefined : undefined, directory ?? undefined, selectMetadata);
  const saved = nativeAgentConfigurationOf(metadata);
  const draftId = useSessionUIStore((state) => enabled && !sessionId && state.newSessionDraft.open ? state.newSessionDraft.draftId : undefined);
  const draftTarget: AgentCombinationDraftTarget | null = draftId !== undefined ? { draftId } : directory;
  const draft = useAgentCombinationDrafts((state) => draftTarget && !sessionId ? state.drafts.get(agentCombinationDraftKey(draftTarget)) : undefined);
  const currentRef = React.useRef(current);
  currentRef.current = current;
  const [supported, setSupported] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const runtimeKey = getRuntimeKey();
  const eligible = enabled && nativeAgents.supported && (!sessionId || isUnifiedNativeSessionId(sessionId));
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current += 1; setBusy(false); setError(null);
    return () => { generation.current += 1; };
  }, [runtimeKey, sessionId, directory, enabled, draftId]);
  React.useEffect(() => {
    let active = true;
    setSupported(false);
    if (eligible && combinations.length && !blocked) void nativeAgents.capabilities()
      .then((caps) => { if (active) setSupported(caps.agentCombinations === true); }).catch(() => {});
    return () => { active = false; };
  }, [nativeAgents, runtimeKey, blocked, eligible, combinations.length]);
  const apply = async (entry: NativeAgentCombination) => {
    if ((sessionId ? !directory : !draftTarget) || blocked || busy || !supported || !eligible) return false;
    const before = JSON.stringify(currentRef.current);
    const ticket = ++generation.current;
    const next = { subagent: entry.subagent, execution: entry.execution, combination: { id: entry.id, name: entry.name } };
    setBusy(true); setError(null);
    try {
      for (const choice of [entry.main, entry.subagent, entry.execution]) {
        if (!choice) continue;
        const model = providers.find((provider) => provider.id === choice.model.providerID)?.models.find((model) => model.id === choice.model.modelID || model.nativeAliases?.some((alias) => alias.id === choice.model.modelID));
        if (!model || choice.variant && !listModelVariantIds(model.variants).includes(choice.variant)) throw new Error('Unavailable selection');
      }
      let acceptedMain = true;
      if (sessionId) {
        if (!directory) return false;
        const updated = await configureNativeAgents(sessionId, directory, next, { ...entry.main, agent: agent === 'plan' ? 'plan' : 'build' });
        acceptedMain = updated.model?.providerID === entry.main.model.providerID && updated.model.id === entry.main.model.modelID && updated.model.variant === entry.main.variant;
      } else if (draftTarget) useAgentCombinationDrafts.getState().set(draftTarget, next);
      if (generation.current !== ticket || getRuntimeKey() !== runtimeKey) return false;
      if (acceptedMain && (JSON.stringify(currentRef.current) === before || JSON.stringify(currentRef.current) === JSON.stringify(entry.main))) onMain(entry.main);
      return true;
    } catch {
      if (generation.current === ticket && getRuntimeKey() === runtimeKey) setError(t('chat.unified.selectionFailed'));
      return false;
    } finally { if (generation.current === ticket) setBusy(false); }
  };
  const clearDraftSelection = () => {
    if (!enabled || sessionId || !draftTarget || getRuntimeKey() !== runtimeKey) return;
    const configuration = useAgentCombinationDrafts.getState().drafts.get(agentCombinationDraftKey(draftTarget));
    if (configuration?.combination) useAgentCombinationDrafts.getState().set(draftTarget, { subagent: configuration.subagent, execution: configuration.execution });
  };
  return { combinations: eligible ? orderPickerItems(combinations, combinationOrder, (entry) => entry.id) : [], selectedCombination: eligible ? (sessionId ? saved : draft)?.combination : undefined,
    clearDraftSelection,
    disabled: blocked || !supported || busy || (sessionId ? !directory : !draftTarget), error: eligible ? error ?? (saved?.unavailable ? t('chat.unified.selectionFailed') : null) : null, apply };
};
