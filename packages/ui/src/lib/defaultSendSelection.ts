import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { resolveEffortChoice, resolveEffortForModelSelection } from '@/lib/modelEfforts';
import { configuredVariantForModel, modelVariantNames } from '@/lib/modelVariants';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

const resolveDefaultAgentName = (): string | undefined => {
  const configState = useConfigStore.getState();
  if (configState.settingsDefaultAgent) {
    return configState.settingsDefaultAgent;
  }
  const visibleAgents = configState.agents.filter((agent) => !agent.hidden);
  return (
    configState.currentAgentName
    || visibleAgents.find((agent) => agent.mode === 'primary' || !agent.mode)?.name
    || visibleAgents[0]?.name
  );
};

const resolveDefaultModelSelection = (): { providerID: string; modelID: string } | null => {
  const parsed = parseModelIdentifier(useConfigStore.getState().settingsDefaultModel);
  if (!parsed) {
    return null;
  }
  if (!useConfigStore.getState().getModelMetadata(parsed.providerId, parsed.modelId)) {
    return null;
  }
  return { providerID: parsed.providerId, modelID: parsed.modelId };
};

const resolveDefaultVariant = (
  providerID: string,
  modelID: string,
  agentName: string | undefined,
): string | null | undefined => {
  const configState = useConfigStore.getState();
  const provider = configState.providers.find((entry) => entry.id === providerID);
  const model = provider?.models.find((entry) => entry.id === modelID);
  const configuredVariant = configState.getDefaultVariantForModel(providerID, modelID)
    ?? configuredVariantForModel({
      defaultModel: configState.settingsDefaultModel,
      defaultVariant: configState.settingsDefaultVariant,
      providerId: providerID,
      modelId: modelID,
      model,
    });
  const currentVariant = configState.currentProviderId === providerID && configState.currentModelId === modelID
    ? configState.currentVariant
    : undefined;
  const variantNames = modelVariantNames(model);
  if (variantNames.length === 0) {
    return configuredVariant || currentVariant || undefined;
  }
  return resolveEffortChoice(
    [resolveEffortForModelSelection({
      providerID, modelID, variants: variantNames,
      agents: configState.agents, agentName, configuredVariant,
    }), currentVariant],
    variantNames,
  );
};

export const captureDefaultSendSelection = () => {
  const configState = useConfigStore.getState();
  const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
  const defaultModel = resolveDefaultModelSelection();
  const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
  const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
  const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
  if (!providerID || !modelID) {
    return null;
  }
  return { providerID, modelID, agentName, variant: resolveDefaultVariant(providerID, modelID, agentName) };
};

type SessionSendSelection = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

/**
 * The model, agent and effort a send into an existing session should carry: the
 * agent and model the session was set up with, then the model its last user
 * message ran on, then the app-wide selection. A surface that sends outside
 * that session's composer (a project todo sent to the current conversation)
 * would otherwise switch the session to whatever the app has selected.
 */
export const resolveSessionSendSelection = (sessionId: string): SessionSendSelection | null => {
  const selection = useSelectionStore.getState();
  const configState = useConfigStore.getState();
  const lastChoice = useSessionUIStore.getState().getLastUserChoice(sessionId);

  const agent = selection.getSessionAgentSelection(sessionId)
    || lastChoice?.agent
    || configState.currentAgentName
    || undefined;
  const agentModel = agent ? selection.getAgentModelForSession(sessionId, agent) : null;
  const sessionModel = selection.getSessionModelSelection(sessionId);
  const lastChoiceModel = lastChoice?.providerID && lastChoice.modelID
    ? { providerId: lastChoice.providerID, modelId: lastChoice.modelID }
    : null;
  const model = agentModel
    || sessionModel
    || lastChoiceModel
    || (configState.currentProviderId && configState.currentModelId
      ? { providerId: configState.currentProviderId, modelId: configState.currentModelId }
      : null);
  if (!model?.providerId || !model.modelId) {
    return null;
  }

  // Variants are model-specific, so only one recorded for this model counts.
  const agentVariant = agent
    ? selection.getAgentModelVariantForSession(sessionId, agent, model.providerId, model.modelId)
    : undefined;
  const lastChoiceVariant = lastChoiceModel
    && lastChoiceModel.providerId === model.providerId
    && lastChoiceModel.modelId === model.modelId
    ? lastChoice?.variant
    : undefined;
  const configVariant = configState.currentProviderId === model.providerId
    && configState.currentModelId === model.modelId
    ? configState.currentVariant
    : undefined;

  return {
    providerID: model.providerId,
    modelID: model.modelId,
    agent,
    variant: agentVariant || lastChoiceVariant || configVariant || undefined,
  };
};
