import { getRuntimeKey, getRuntimeEndpointGeneration } from '@/lib/runtime-switch';
import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { DefaultModelVariantFields } from '../shared/DefaultModelVariantFields';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SettingsGroupTitle,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SessionWarmingCheckbox } from './SessionWarmingCheckbox';
import { PermissionDefaultModeField } from './PermissionDefaultModeField';
import { isVSCodeRuntime } from '@/lib/desktop';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { NATIVE_PROVIDER_CODEX } from '@/lib/native-agents/ids';
import { codexVariantLabel } from '@/lib/native-agents/codex-speed';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { listModelVariantIds, preferredModelVariant } from '@/lib/modelVariants';

const getDisplayModel = (
  storedModel: string | undefined
): { providerId: string; modelId: string } => {
  const parsed = parseModelIdentifier(storedModel);
  if (parsed) {
    return parsed;
  }

  return { providerId: '', modelId: '' };
};

type SessionDefaults = { model?: string; variant?: string; combination?: string };

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const defaultSelectionRevision = React.useRef(0);
  const setAgent = useConfigStore((state) => state.setAgent);
  const setCurrentVariantOverride = useConfigStore((state) => state.setCurrentVariantOverride);
  const setSettingsDefaultAgentCombinationId = useConfigStore((state) => state.setSettingsDefaultAgentCombinationId);
  const combinations = useConfigStore((state) => state.nativeAgentCombinations);
  const [defaults, setDefaults] = React.useState<SessionDefaults>({});
  const confirmedDefaults = React.useRef<{ revision: number; selection: SessionDefaults }>({ revision: 0, selection: {} });
  const { model: defaultModel, variant: defaultVariant, combination: defaultAgentCombinationId } = defaults;
  const selectedCombination = combinations.find((entry) => entry.id === defaultAgentCombinationId);
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  const setSettingsDefaultVariant = useConfigStore((state) => state.setSettingsDefaultVariant);
  const setSettingsDefaultAgent = useConfigStore((state) => state.setSettingsDefaultAgent);
  // A default describes new sessions. Applying it to the open chat is a
  // convenience, not the point, so it stops where the chat carries a choice the
  // user made for it — the same pair of signals ModelControls restores from
  // (`shouldPreserveManualModelOverride`).
  const selectionIsManual = useConfigStore((state) => state.selectionSource === 'manual');
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
  const getSessionAgentSelection = useSelectionStore((state) => state.getSessionAgentSelection);
  const agentIsPicked = useConfigStore((state) => state.agentSelectionSource === 'manual');
  // An agent picked for this chat brings the model its config pins, and a pin
  // outranks the global default the same way it does in `setAgent`.
  const pickedAgentPinsModel = useConfigStore((state) => {
    if (state.agentSelectionSource !== 'manual') return false;
    const agent = state.agents.find((candidate) => candidate.name === state.currentAgentName);
    return Boolean(agent?.model?.providerID && agent.model.id);
  });
  const chatHasOwnModel = Boolean(
    (!currentSessionId && selectionIsManual) || pickedAgentPinsModel
    || (selectionIsManual && currentSessionId && getSessionModelSelection(currentSessionId)),
  );
  const chatHasOwnAgent = Boolean(
    agentIsPicked && currentSessionId && getSessionAgentSelection(currentSessionId),
  );
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const showChatsSection = useSessionDisplayStore((state) => state.showChatsSection);
  const setShowChatsSection = useSessionDisplayStore((state) => state.setShowChatsSection);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  // Fail closed: never offer providers whose credentials were not verified.
  const smallModelProviders = useCallableModelProviders() ?? [];
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await loadDesktopSettings();
        if (data) {
          const model = data.defaultModel?.trim() || undefined;
          const variant = data.defaultVariant?.trim() || undefined;
          const agent = data.defaultAgent?.trim() || undefined;

          const selection = { model, variant, combination: data.defaultAgentCombinationId || undefined };
          confirmedDefaults.current = { revision: 0, selection };
          setDefaults(selection);
          if (agent !== undefined) setDefaultAgent(agent);
          if (data.smallModelUseDefault !== undefined) setSmallModelUseDefault(data.smallModelUseDefault);
          const smallOverride = data.smallModelOverride?.trim();
          if (smallOverride) {
            setSmallModelOverride(smallOverride);
          }
          const walkthroughOverride = data.walkthroughModelOverride?.trim();
          if (walkthroughOverride) {
            setWalkthroughModelOverride(walkthroughOverride);
          }
        }
      } catch (error) {
        console.warn('Failed to load defaults settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, []);

  // The two fields can change within a single settings debounce. Write the whole
  // choice each time so a pending effort cannot be saved against another model.
  const saveDefaults = async (next: SessionDefaults, applyEffortToChat = false) => {
    const revision = ++defaultSelectionRevision.current;
    const runtimeKey = getRuntimeKey();
    const generation = getRuntimeEndpointGeneration();
    setDefaults(next);
    const result = await updateDesktopSettings({
      defaultModel: next.model ?? '', defaultVariant: next.variant ?? '', defaultAgentCombinationId: next.combination ?? '',
    }).catch(() => ({ ok: false }));
    if (runtimeKey !== getRuntimeKey() || generation !== getRuntimeEndpointGeneration()) return;
    if (result.ok && revision > confirmedDefaults.current.revision) confirmedDefaults.current = { revision, selection: next };
    if (revision !== defaultSelectionRevision.current) return;
    const saved = confirmedDefaults.current.selection;
    if (!result.ok) setDefaults(saved);
    if (saved.combination) {
      setSettingsDefaultAgentCombinationId(saved.combination);
      return;
    }
    setSettingsDefaultVariant(saved.variant);
    setSettingsDefaultModel(saved.model);
    if (!result.ok || !applyEffortToChat || chatHasOwnModel) return;
    const current = useConfigStore.getState();
    if (currentSessionId === useSessionUIStore.getState().currentSessionId
      && next.model === `${current.currentProviderId}/${current.currentModelId}` && current.currentVariantSelection.override === undefined) {
      setCurrentVariantOverride(undefined, next.variant);
    }
  };

  const handleAgentChange = React.useCallback(
    async (agentName: string) => {
      const newValue = agentName || undefined;
      setDefaultAgent(newValue);
      setSettingsDefaultAgent(newValue);

      if (agentName && !chatHasOwnAgent) {
        setAgent(agentName);
      }

      try {
        await updateDesktopSettings({ defaultAgent: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default agent:', error);
      }
    },
    [chatHasOwnAgent, setAgent, setSettingsDefaultAgent]
  );

  const handleSmallModelUseDefaultChange = React.useCallback(
    async (useDefault: boolean) => {
      setSmallModelUseDefault(useDefault);
      try {
        await updateDesktopSettings({ smallModelUseDefault: useDefault });
      } catch (error) {
        console.warn('Failed to save small model preference:', error);
      }
    },
    []
  );

  const handleSmallModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setSmallModelOverride(newValue);
      try {
        await updateDesktopSettings({ smallModelOverride: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save small model override:', error);
      }
    },
    []
  );

  const handleWalkthroughModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setWalkthroughModelOverride(newValue);
      try {
        // Clearing the picker is how the user goes back to the small model, so
        // an empty value is a real choice rather than a no-op.
        await updateDesktopSettings({ walkthroughModelOverride: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save walkthrough model override:', error);
      }
    },
    []
  );

  // The walkthrough cannot work at all without schema-shaped output, so models
  // the catalog says cannot do it are hidden rather than offered and then
  // refused. A missing capability is not a "no": roughly half the catalog omits
  // the field, and those models usually work.
  const isStructuredOutputCapable = React.useCallback(
    (providerId: string, modelId: string) =>
      modelsMetadata.get(`${providerId}/${modelId}`)?.structured_output !== false,
    [modelsMetadata]
  );

  const parsedSmallModel = React.useMemo(() => getDisplayModel(smallModelOverride), [smallModelOverride]);
  const parsedWalkthroughModel = React.useMemo(
    () => getDisplayModel(walkthroughModelOverride),
    [walkthroughModelOverride]
  );
  const availableVariants = React.useMemo(() => {
    if (!parsedModel.providerId || !parsedModel.modelId) return [];
    const provider = providers.find((p) => p.id === parsedModel.providerId);
    const model = provider?.models.find((model) => model.id === parsedModel.modelId);
    return listModelVariantIds(model?.variants);
  }, [parsedModel.modelId, parsedModel.providerId, providers]);

  const supportsVariants = availableVariants.length > 0;
  const displayedVariant = defaultVariant ?? (parsedModel.providerId === NATIVE_PROVIDER_CODEX ? preferredModelVariant(availableVariants, parsedModel.providerId) : undefined);

  if (isLoading) {
    return null;
  }

  return (
    <>
      <SettingsSection title={t('settings.openchamber.defaults.title')} divider={false}>
        <div className="space-y-0">
          <div className="mt-0 mb-4 typography-meta text-muted-foreground">
            {t('settings.openchamber.defaults.summaryPrefix')}
            {' '}
            {defaultAgentCombinationId ? <span className="text-foreground">{selectedCombination?.name ?? t('agents.combinations.defaultUnavailable')}</span> : parsedModel.providerId ? (
              <span className="text-foreground">
                {parsedModel.providerId}/{parsedModel.modelId}
                {supportsVariants ? ` (${parsedModel.providerId === NATIVE_PROVIDER_CODEX
                  ? codexVariantLabel(displayedVariant, t('chat.modelControls.default'))
                  : defaultVariant ?? t('settings.openchamber.defaults.option.defaultLowercase')})` : ''}
              </span>
            ) : (
              <span className="text-foreground">{t('settings.openchamber.defaults.summaryOpenCodeDefault')}</span>
            )}
            {defaultAgent && (
              <>
                {' / '}
                <span className="text-foreground">{defaultAgent}</span>
              </>
            )}
          </div>

          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            <SettingsFieldRow
              settingsItem="sessions.default-model"
              label={t('settings.openchamber.defaults.field.defaultModel')}
            >
              <ModelSelector
                providerId={parsedModel.providerId}
                modelId={parsedModel.modelId}
                onChange={(provider, model, variant) => void saveDefaults({ model: provider && model ? `${provider}/${model}` : undefined, variant: variant ?? undefined })}
                selectedVariant={displayedVariant ?? null}
                className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                allowNativeModels
                offerAuto
                agentCombination={isVSCode ? undefined : { id: defaultAgentCombinationId, onSelect: (combination) => void saveDefaults({ combination }) }}
              />
            </SettingsFieldRow>

            <DefaultModelVariantFields scope="sessions" providerId={parsedModel.providerId} variants={availableVariants}
              value={displayedVariant} onChange={(variant) => void saveDefaults({ model: defaultModel, variant }, true)} combination={Boolean(defaultAgentCombinationId)} />

            <SettingsFieldRow
              settingsItem="sessions.default-agent"
              label={t('settings.openchamber.defaults.field.defaultAgent')}
            >
              <AgentSelector
                agentName={defaultAgent || ''}
                onChange={handleAgentChange}
                filter={(agent) => isPrimaryMode(agent.mode)}
                className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              />
            </SettingsFieldRow>

            {isVSCode ? null : <PermissionDefaultModeField agentName={defaultAgent} />}
          </div>

          <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
            <SettingsCheckboxRow
              settingsItem="sessions.deletion-dialog"
              checked={showDeletionDialog}
              onChange={setShowDeletionDialog}
              label={t('settings.openchamber.defaults.field.showDeletionDialog')}
              ariaLabel={t('settings.openchamber.defaults.field.showDeletionDialogAria')}
            />
            <SessionWarmingCheckbox />
            {isVSCode ? null : (
              <SettingsCheckboxRow
                settingsItem="sessions.show-chats"
                checked={showChatsSection}
                onChange={(checked) => {
                  setShowChatsSection(checked);
                  void updateDesktopSettings({ sidebarShowChatsSection: checked });
                }}
                label={t('settings.openchamber.defaults.field.showChats')}
                ariaLabel={t('settings.openchamber.defaults.field.showChats')}
              />
            )}
          </SettingsInset>

          <div className="space-y-3 pt-6">
            <div className="flex items-center gap-1.5">
              <SettingsGroupTitle>
                {t('settings.openchamber.defaults.smallModel.title')}
              </SettingsGroupTitle>
              <SettingsInfoHint>
                {t('settings.openchamber.defaults.smallModel.description')}
              </SettingsInfoHint>
            </div>

            <SettingsCheckboxRow
              settingsItem="sessions.small-model"
              checked={smallModelUseDefault}
              onChange={(checked) => {
                void handleSmallModelUseDefaultChange(checked);
              }}
              label={t('settings.openchamber.defaults.smallModel.useDefault')}
              ariaLabel={t('settings.openchamber.defaults.smallModel.useDefaultAria')}
            />

            {!smallModelUseDefault ? (
              <SettingsFieldRow label={t('settings.openchamber.defaults.smallModel.overrideModel')}>
                <ModelSelector
                  providerId={parsedSmallModel.providerId}
                  modelId={parsedSmallModel.modelId}
                  onChange={handleSmallModelOverrideChange}
                  allowedProviderIds={smallModelProviders}
                  allowNativeModels
                  className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                />
              </SettingsFieldRow>
            ) : null}

            <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
              <div className="flex items-center gap-1.5">
                <SettingsGroupTitle>
                  {t('settings.openchamber.defaults.walkthroughModel.title')}
                </SettingsGroupTitle>
                <SettingsInfoHint>
                  {t('settings.openchamber.defaults.walkthroughModel.description')}
                </SettingsInfoHint>
              </div>

              <SettingsFieldRow
                settingsItem="sessions.walkthrough-model"
                label={t('settings.openchamber.defaults.walkthroughModel.overrideModel')}
              >
                <ModelSelector
                  providerId={parsedWalkthroughModel.providerId}
                  modelId={parsedWalkthroughModel.modelId}
                  onChange={handleWalkthroughModelOverrideChange}
                  allowedProviderIds={smallModelProviders}
                  allowNativeModels
                  isModelAllowed={isStructuredOutputCapable}
                  placeholder={t('settings.openchamber.defaults.walkthroughModel.usesSmallModel')}
                  className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                />
              </SettingsFieldRow>
            </SettingsInset>
          </div>
        </div>
      </SettingsSection>
    </>
  );
};
