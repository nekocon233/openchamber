import { useState } from 'react';
import type { NativePlanExecutionChoice } from '@/lib/api/types';
import { nativeModelAliasVariant, type FormRequest, type Session } from '@/lib/opencode/model';
import { readNativePlanExecution } from '@/lib/native-agents/forms';
import { isProviderPickableForSession, isUnifiedNativeSessionId, nativeBackendOfProviderId } from '@/lib/native-agents/ids';
import { supportsUnifiedNativeBackend } from '@/lib/native-agents/capabilities';
import { useUnifiedNativeState } from '@/lib/native-agents/useNativeSession';
import { configuredVariantForModel, listModelVariantIds, preferredModelVariant } from '@/lib/modelVariants';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionSelector } from '@/sync/sync-context';
import { useChatSessionSelection } from './chatColumnSession';
import type { FormAnswer } from '@/sync/session-actions';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { nativeAgentConfigurationOf } from '@/lib/native-agents/combinations';

export type PlanComposerModel = { providerID?: string; modelID?: string; variant?: string };
const drafts = new Map<string, NativePlanExecutionChoice>();
const NO_PROVIDERS: ReturnType<typeof useConfigStore.getState>['providers'] = [];
const selectModel = (session: Session | undefined) => session?.model;
const selectMetadata = (session: Session | undefined) => session?.metadata;
const isApproval = (answer: FormAnswer): boolean => {
  const value = answer['question-0'];
  return Object.keys(answer).length === 1 && (value === 'build' || Array.isArray(value) && value.length === 1 && value[0] === 'build');
};

/** A request owns the draft; the composer supplies its live default until a pick. */
export const usePlanExecutionModel = (form: FormRequest, composer?: PlanComposerModel) => {
  const metadata = readNativePlanExecution(form);
  const enabled = metadata !== null;
  const enterpriseMode = useEnterpriseMode();
  const blocked = enabled && isUnifiedNativeSessionId(form.sessionID) && enterpriseMode;
  const { directory } = useChatSessionSelection();
  const key = JSON.stringify([getRuntimeKey(), form.sessionID, form.id]);
  const [local, setLocal] = useState(() => ({ key, value: drafts.get(key) }));
  const saved = useSelectionStore((state) => enabled ? state.sessionModelSelections.get(form.sessionID) : undefined);
  const record = useSessionSelector(enabled ? form.sessionID : undefined, directory ?? undefined, selectModel);
  const configuration = useSessionSelector(enabled ? form.sessionID : undefined, directory ?? undefined, selectMetadata);
  const unified = useUnifiedNativeState(enabled ? form.sessionID : null, directory);
  const providers = useConfigStore((state) => enabled ? state.providers : NO_PROVIDERS);
  const defaultVariant = useConfigStore((state) => enabled ? state.settingsDefaultVariant : undefined);
  const defaultModel = useConfigStore((state) => enabled ? state.settingsDefaultModel : undefined);
  const providerID = composer?.providerID ?? saved?.providerId ?? record?.providerID;
  const modelID = composer?.modelID ?? saved?.modelId ?? record?.id;
  const hasComposerModel = Boolean(composer?.providerID && composer?.modelID);
  const savedVariant = useSelectionStore((state) => enabled && providerID && modelID
    ? state.getAgentModelVariantForSession(form.sessionID, state.getSessionAgentSelection(form.sessionID) ?? 'plan', providerID, modelID)
    : undefined);
  const current = providerID && modelID ? {
    model: { providerID, modelID },
    variant: hasComposerModel ? composer?.variant : savedVariant === null ? undefined : savedVariant ?? record?.variant,
  } : undefined;
  const pending = metadata?.openchamberPlanExecutionPending;
  const value = pending ?? (local.key === key ? local.value : drafts.get(key)) ?? nativeAgentConfigurationOf(configuration)?.execution ?? current;
  const allowed = (providerId: string): boolean => {
    if (blocked) return false;
    if (!isProviderPickableForSession(form.sessionID, providerId)) return false;
    if (!isUnifiedNativeSessionId(form.sessionID)) return true;
    const backend = nativeBackendOfProviderId(providerId);
    return backend !== null && supportsUnifiedNativeBackend({ unifiedSessions: true, unifiedBackends: unified?.unifiedBackends }, backend);
  };
  const pickable = providers.filter((provider) => allowed(provider.id));
  const model = value ? pickable.find((provider) => provider.id === value.model.providerID)?.models.find((model) => (
    model.id === value.model.modelID || model.nativeAliases?.some((alias) => alias.id === value.model.modelID)
  )) : undefined;
  const available = Boolean(model);
  const choose = (providerId: string, modelId: string) => {
    const target = pickable.find((provider) => provider.id === providerId)?.models.find((model) => model.id === modelId);
    if (!target || pending) return;
    const variants = listModelVariantIds(target.variants);
    const preference = useSelectionStore.getState().getAgentModelVariantForSession(form.sessionID, 'build', providerId, modelId);
    const configured = configuredVariantForModel({ defaultModel, defaultVariant, providerId, modelId, model: target });
    const composerModel = current?.model.providerID === providerId && (current.model.modelID === modelId || target.nativeAliases?.some((alias) => alias.id === current.model.modelID));
    const aliasVariant = current ? nativeModelAliasVariant(target, current.model.modelID) : undefined;
    const variant = value?.model.providerID === providerId && (value.model.modelID === modelId || model?.id === modelId)
      ? value.variant
      : composerModel ? current?.variant ?? (aliasVariant && variants.includes(aliasVariant) ? aliasVariant : undefined)
      : preference === null ? undefined : preference && variants.includes(preference) ? preference
        : configured && variants.includes(configured) ? configured : preferredModelVariant(variants);
    const next = { model: { providerID: providerId, modelID: modelId }, variant };
    drafts.delete(key);
    drafts.set(key, next);
    if (drafts.size > 50) {
      const oldest = drafts.keys().next().value;
      if (oldest !== undefined) drafts.delete(oldest);
    }
    setLocal({ key, value: next });
  };
  return {
    enabled, value, model, providers: pickable, available, blocked, pending: Boolean(pending), choose,
    approving: (answer: FormAnswer) => enabled && isApproval(answer),
    canApprove: !blocked && Boolean(value && (available || pending)),
    executionFor: (answer: FormAnswer): NativePlanExecutionChoice | undefined => {
      if (!enabled || !isApproval(answer) || !value) return undefined;
      if (pending) return pending;
      const execution: NativePlanExecutionChoice = { ...value };
      if (unified) execution.expectedRevision = unified.revision;
      return execution;
    },
    clear: () => drafts.delete(key),
  };
};

export type PlanExecutionModelState = ReturnType<typeof usePlanExecutionModel>;
