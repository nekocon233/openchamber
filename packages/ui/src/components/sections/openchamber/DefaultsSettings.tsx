import React from 'react';
import { getRuntimeEndpointGeneration, getRuntimeKey } from '@/lib/runtime-switch';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { DefaultModelVariantFields } from '../shared/DefaultModelVariantFields';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { CompactionSettings } from './CompactionSettings';
import { SessionWarmingCheckbox } from './SessionWarmingCheckbox';
import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { SessionWarmingModeField } from './SessionWarmingModeField';
import { PermissionDefaultModeField } from './PermissionDefaultModeField';
import { isVSCodeRuntime } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { selectIsModelMissingFromCatalog, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { NATIVE_PROVIDER_CODEX } from '@/lib/native-agents/ids';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { listModelVariantIds, preferredModelVariant, type ModelVariantSource } from '@/lib/modelVariants';
import { ModelVariantSelect } from './ModelVariantSelect';

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
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  const setSettingsDefaultVariant = useConfigStore((state) => state.setSettingsDefaultVariant);
  const setSettingsDefaultAgent = useConfigStore((state) => state.setSettingsDefaultAgent);
  const selectionIsManual = useConfigStore((state) => state.selectionSource === 'manual');
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
  const getSessionAgentSelection = useSelectionStore((state) => state.getSessionAgentSelection);
  const agentIsPicked = useConfigStore((state) => state.agentSelectionSource === 'manual');
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
  const requestSettingsJump = useUIStore((state) => state.requestSettingsJump);
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

  const [defaults, setDefaults] = React.useState<SessionDefaults>({});
  const confirmedDefaults = React.useRef<{ revision: number; selection: SessionDefaults }>({ revision: 0, selection: {} });
  const { model: defaultModel, variant: defaultVariant, combination: defaultAgentCombinationId } = defaults;
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  const [smallModelVariant, setSmallModelVariant] = React.useState<string | undefined>();
  const smallModelProviders = useCallableModelProviders() ?? [];
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [walkthroughModelVariant, setWalkthroughModelVariant] = React.useState<string | undefined>();
  const [fallbackModel, setFallbackModel] = React.useState<string | undefined>();
  const [fallbackVariant, setFallbackVariant] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);
  const defaultModelMissing = useConfigStore((state) => (
    !defaultAgentCombinationId
    && selectIsModelMissingFromCatalog(state, undefined, parsedModel.providerId, parsedModel.modelId)
  ));

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await loadDesktopSettings();
        if (data) {
          const model = data.defaultModel?.trim() || undefined;
          const variant = data.defaultVariant?.trim() || undefined;
          const agent = data.defaultAgent?.trim() || undefined;

          const selection: SessionDefaults = {
            model,
            variant,
            combination: data.defaultAgentCombinationId || undefined,
          };
          confirmedDefaults.current = { revision: 0, selection };
          setDefaults(selection);
          if (agent !== undefined) setDefaultAgent(agent);
          if (data.smallModelUseDefault !== undefined) setSmallModelUseDefault(data.smallModelUseDefault);
          const smallOverride = data.smallModelOverride?.trim();
          if (smallOverride) {
            setSmallModelOverride(smallOverride);
          }
          const smallVariant = data.smallModelVariant?.trim();
          if (smallVariant) {
            setSmallModelVariant(smallVariant);
          }
          const walkthroughOverride = data.walkthroughModelOverride?.trim();
          if (walkthroughOverride) {
            setWalkthroughModelOverride(walkthroughOverride);
          }
          const walkthroughVariant = data.walkthroughModelVariant?.trim();
          if (walkthroughVariant) {
            setWalkthroughModelVariant(walkthroughVariant);
          }
          const fallback = data.fallbackModel?.trim();
          if (fallback) {
            setFallbackModel(fallback);
          }
          const fallbackThinking = data.fallbackVariant?.trim();
          if (fallbackThinking) {
            setFallbackVariant(fallbackThinking);
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
      defaultModel: next.model ?? '',
      defaultVariant: next.variant ?? '',
      defaultAgentCombinationId: next.combination ?? '',
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
      setSmallModelVariant(undefined);
      try {
        await updateDesktopSettings({
          smallModelOverride: newValue ?? '',
          smallModelVariant: '',
        });
      } catch (error) {
        console.warn('Failed to save small model override:', error);
      }
    },
    []
  );

  const handleSmallModelVariantChange = React.useCallback(
    async (variant: string | undefined) => {
      setSmallModelVariant(variant);
      try {
        await updateDesktopSettings({ smallModelVariant: variant ?? '' });
      } catch (error) {
        console.warn('Failed to save small model variant:', error);
      }
    },
    []
  );

  const handleWalkthroughModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setWalkthroughModelOverride(newValue);
      setWalkthroughModelVariant(undefined);
      try {
        await updateDesktopSettings({ walkthroughModelOverride: newValue ?? '', walkthroughModelVariant: '' });
      } catch (error) {
        console.warn('Failed to save walkthrough model override:', error);
      }
    },
    []
  );

  const handleWalkthroughModelVariantChange = React.useCallback(
    async (variant: string | undefined) => {
      setWalkthroughModelVariant(variant);
      try {
        await updateDesktopSettings({ walkthroughModelVariant: variant ?? '' });
      } catch (error) {
        console.warn('Failed to save walkthrough model variant:', error);
      }
    },
    []
  );

  const handleFallbackModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setFallbackModel(newValue);
      setFallbackVariant(undefined);
      try {
        await updateDesktopSettings({ fallbackModel: newValue ?? '', fallbackVariant: '' });
      } catch (error) {
        console.warn('Failed to save fallback model:', error);
      }
    },
    []
  );

  const handleFallbackVariantChange = React.useCallback(
    async (variant: string | undefined) => {
      setFallbackVariant(variant);
      try {
        await updateDesktopSettings({ fallbackVariant: variant ?? '' });
      } catch (error) {
        console.warn('Failed to save fallback thinking:', error);
      }
    },
    []
  );

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
  const parsedFallbackModel = React.useMemo(() => getDisplayModel(fallbackModel), [fallbackModel]);
  const variantsOf = React.useCallback((providerId: string, modelId: string) => {
    if (!providerId || !modelId) return [];
    const provider = providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === modelId) as
      | { variants?: ModelVariantSource }
      | undefined;
    return listModelVariantIds(model?.variants);
  }, [providers]);
  const availableVariants = React.useMemo(
    () => variantsOf(parsedModel.providerId, parsedModel.modelId),
    [parsedModel.modelId, parsedModel.providerId, variantsOf]
  );
  const displayedVariant = defaultVariant ?? (parsedModel.providerId === NATIVE_PROVIDER_CODEX
    ? preferredModelVariant(availableVariants, parsedModel.providerId) : undefined);
  const fallbackVariants = React.useMemo(
    () => variantsOf(parsedFallbackModel.providerId, parsedFallbackModel.modelId),
    [parsedFallbackModel.modelId, parsedFallbackModel.providerId, variantsOf]
  );
  const smallModelVariants = React.useMemo(
    () => variantsOf(parsedSmallModel.providerId, parsedSmallModel.modelId),
    [parsedSmallModel.modelId, parsedSmallModel.providerId, variantsOf]
  );
  const walkthroughModelVariants = React.useMemo(
    () => variantsOf(parsedWalkthroughModel.providerId, parsedWalkthroughModel.modelId),
    [parsedWalkthroughModel.modelId, parsedWalkthroughModel.providerId, variantsOf]
  );

  if (isLoading) {
    return null;
  }

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.defaults.newSessionsTitle')}
      >
        <div>
          <SettingsFieldRow
            settingsItem="sessions.default-model"
            label={t('settings.openchamber.defaults.field.model')}
            description={defaultModelMissing
              ? <span className="text-[var(--status-warning)]">{t('settings.openchamber.defaults.field.modelUnavailable')}</span>
              : undefined}
          >
            <ModelSelector
              providerId={parsedModel.providerId}
              modelId={parsedModel.modelId}
              onChange={(provider, model, variant) => void saveDefaults({
                model: provider && model ? `${provider}/${model}` : undefined,
                variant: variant ?? undefined,
              })}
              selectedVariant={displayedVariant ?? null}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              allowNativeModels
              offerAuto
              agentCombination={isVSCode ? undefined : {
                id: defaultAgentCombinationId,
                onSelect: (combination) => void saveDefaults({ combination }),
              }}
            />
          </SettingsFieldRow>

          {availableVariants.length > 0 || Boolean(displayedVariant) || Boolean(defaultAgentCombinationId) ? (
            <DefaultModelVariantFields
              scope="sessions"
              providerId={parsedModel.providerId}
              variants={availableVariants}
              value={displayedVariant}
              onChange={(variant) => void saveDefaults({ model: defaultModel, variant }, true)}
              combination={Boolean(defaultAgentCombinationId)}
            />
          ) : null}

          <SettingsFieldRow
            settingsItem="sessions.default-agent"
            label={t('settings.openchamber.defaults.field.agent')}
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
      </SettingsSection>

      <SettingsSection title={t('settings.layout.sessions.helperModels.title')} contentClassName="space-y-2">
        <SettingsCheckboxRow
          settingsItem="sessions.small-model"
          checked={smallModelUseDefault}
          onChange={(checked) => {
            void handleSmallModelUseDefaultChange(checked);
          }}
          label={t('settings.openchamber.defaults.smallModel.useDefault')}
          ariaLabel={t('settings.openchamber.defaults.smallModel.useDefaultAria')}
          info={t('settings.openchamber.defaults.smallModel.description')}
        />
        <div>
          {!smallModelUseDefault ? (
            <>
              <SettingsFieldRow label={t('settings.openchamber.defaults.smallModel.title')}>
                <ModelSelector
                  providerId={parsedSmallModel.providerId}
                  modelId={parsedSmallModel.modelId}
                  onChange={handleSmallModelOverrideChange}
                  allowedProviderIds={smallModelProviders}
                  allowNativeModels
                  className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                />
                <ModelVariantSelect
                  variants={smallModelVariants}
                  value={smallModelVariant}
                  onChange={handleSmallModelVariantChange}
                  ariaLabel={t('settings.openchamber.defaults.smallModel.thinking')}
                />
              </SettingsFieldRow>
            </>
          ) : null}
          <SettingsFieldRow
            settingsItem="sessions.walkthrough-model"
            label={t('settings.openchamber.defaults.walkthroughModel.title')}
            info={t('settings.openchamber.defaults.walkthroughModel.description')}
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
            <ModelVariantSelect
              variants={walkthroughModelVariants}
              value={walkthroughModelVariant}
              onChange={handleWalkthroughModelVariantChange}
              ariaLabel={t('settings.openchamber.defaults.smallModel.thinking')}
            />
          </SettingsFieldRow>
        </div>
      </SettingsSection>

      {isVSCode ? null : (
        <SettingsSection title={t('settings.openchamber.defaults.usageLimitsTitle')} contentClassName="space-y-1">
          <SettingsFieldRow
            settingsItem="sessions.fallback-model"
            label={t('settings.openchamber.defaults.field.fallbackModel')}
            info={t('settings.openchamber.defaults.field.fallbackModelInfo')}
          >
            <ModelSelector
              providerId={parsedFallbackModel.providerId}
              modelId={parsedFallbackModel.modelId}
              onChange={handleFallbackModelChange}
              allowedProviderIds={smallModelProviders}
              placeholder={t('settings.openchamber.defaults.field.fallbackModelNone')}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
            />
            <ModelVariantSelect
              variants={fallbackVariants}
              value={fallbackVariant}
              onChange={handleFallbackVariantChange}
              ariaLabel={t('settings.openchamber.defaults.field.fallbackThinking')}
            />
          </SettingsFieldRow>
          <p className={SETTINGS_HELPER_CLASS}>
            {t('settings.openchamber.defaults.usageLimits.accountSwitching')}
            {' '}
            <SettingsInlineLink onClick={() => requestSettingsJump('providers')}>
              {t('settings.openchamber.defaults.usageLimits.openProviders')}
            </SettingsInlineLink>
          </p>
        </SettingsSection>
      )}
    </>
  );
};

export const SessionContextSettings: React.FC = () => {
  const { t } = useI18n();
  const isVSCode = isVSCodeRuntime();
  return (
    <>
      <CompactionSettings />
      <SettingsSection title={t('settings.openchamber.defaults.promptCacheTitle')}>
        {isVSCode ? <SessionWarmingCheckbox /> : <SessionWarmingModeField />}
      </SettingsSection>
    </>
  );
};
