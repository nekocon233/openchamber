import React from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useModelLists } from '@/hooks/useModelLists';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { orderPickerItems } from '@/lib/modelPickerOrder';
import { isNativeProviderId, NATIVE_PROVIDER_CODEX } from '@/lib/native-agents/ids';
import { codexVariantLabel } from '@/lib/native-agents/codex-speed';
import { listModelVariantIds } from '@/lib/modelVariants';
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, isAutoModel } from '@/lib/routing/autoModel';
import { selectAutoReady, useRoutingStore } from '@/stores/useRoutingStore';

interface ModelSelectorProps {
    disabled?: boolean;
    providerId: string;
    modelId: string;
    onChange: (providerId: string, modelId: string, variant?: string | null) => void;
    selectedVariant?: string | null;
    className?: string;
    allowedProviderIds?: string[];
    isModelAllowed?: (providerId: string, modelId: string) => boolean;
    /**
     * Offer native CLI models when the caller can run them. Utility pickers
     * additionally restrict providers to those their server can call.
     */
    allowNativeModels?: boolean;
    placeholder?: string;
    tooltipsEnabled?: boolean;
    dropdownPortalToBody?: boolean;
    directory?: string;
    compact?: boolean;
    offerAuto?: boolean;
    agentCombination?: { id?: string; onSelect: (id: string) => void };
    triggerTooltip?: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    disabled = false,
    providerId,
    modelId,
    onChange,
    selectedVariant,
    className,
    allowedProviderIds,
    isModelAllowed,
    allowNativeModels = false,
    placeholder,
    tooltipsEnabled = true,
    dropdownPortalToBody = false,
    compact = false,
    directory,
    offerAuto = false,
    agentCombination,
    triggerTooltip,
}) => {
    const { t } = useI18n();
    const { nativeAgents } = useRuntimeAPIs();
    const enterprise = useEnterpriseMode();
    const combinations = useConfigStore((state) => state.nativeAgentCombinations);
    const combinationOrder = useUIStore((state) => state.agentCombinationOrder);
    const [combinationsReady, setCombinationsReady] = React.useState(false);
    const offerCombinations = Boolean(agentCombination && allowNativeModels && nativeAgents.supported && !enterprise);
    React.useEffect(() => {
        let active = true;
        setCombinationsReady(false);
        if (offerCombinations) void nativeAgents.capabilities().then((value) => { if (active) setCombinationsReady(value.agentCombinations === true); }).catch(() => {});
        return () => { active = false; };
    }, [nativeAgents, offerCombinations]);
    const selectedCombination = combinations.find((entry) => entry.id === agentCombination?.id);
    const triggerProviderId = selectedCombination?.main.model.providerID ?? providerId;
    const autoReady = useRoutingStore(selectAutoReady);
    const autoEntry = React.useMemo<ModelPickerEntry | null>(() => (offerAuto && autoReady
        ? { kind: 'auto', providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, model: { id: AUTO_MODEL_ID, name: t('chat.modelControls.autoModel') } }
        : null), [autoReady, offerAuto, t]);
    const isAutoSelected = isAutoModel(providerId, modelId);
    const { isReady: openCodeReady, isUnavailable } = useOpenCodeReadiness('models', directory);
    const providers: ModelPickerProvider[] = useConfigStore((state) => directory === undefined
        ? state.providers : selectProvidersForDirectory(state, directory));
    const nativeReady = allowNativeModels && Boolean(allowedProviderIds?.length)
        && allowedProviderIds?.every(isNativeProviderId)
        && providers.some((provider) => allowedProviderIds?.includes(provider.id) && (provider.models?.length ?? 0) > 0);
    const isReady = openCodeReady || nativeReady || combinationsReady;
    const canOpen = isReady && !disabled;
    const loadProviders = useConfigStore((state) => state.loadProviders);
    React.useEffect(() => {
        if (directory !== undefined) void loadProviders({ directory });
    }, [directory, loadProviders]);
    const isMobile = useUIStore((state) => state.isMobile);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const { favoriteModelsList, recentModelsList } = useModelLists(directory);
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');

    const closePicker = React.useCallback(() => {
        setIsMobilePanelOpen(false);
        setIsDropdownOpen(false);
        setSearchQuery('');
    }, []);

    const handleSelect = React.useCallback((entry: ModelPickerEntry) => {
        // Older favorites record an explicit CLI default as null. The settings
        // field also has an inherited state, so pass the catalog's explicit id.
        const variant = entry.variant === null && entry.providerID === NATIVE_PROVIDER_CODEX && entry.kind !== 'auto'
            && listModelVariantIds(entry.model.variants).includes('default') ? 'default' : entry.variant;
        if (entry.providerID === NATIVE_PROVIDER_CODEX && variant !== undefined) onChange(entry.providerID, entry.modelID, variant);
        else onChange(entry.providerID, entry.modelID);
        if (!isAutoModel(entry.providerID, entry.modelID)) addRecentModel(entry.providerID, entry.modelID);
        closePicker();
    }, [addRecentModel, closePicker, onChange]);

    const handleSelectNone = React.useCallback(() => {
        onChange('', '');
        closePicker();
    }, [closePicker, onChange]);

    const labels = React.useMemo(() => ({
        searchPlaceholder: t('settings.agents.modelSelector.searchPlaceholder'),
        list: t('chat.modelControls.modelListAria'),
        noResults: t('settings.agents.modelSelector.state.noModelsFound'),
        favorites: t('settings.agents.modelSelector.section.favorites'),
        recent: t('settings.agents.modelSelector.section.recent'),
        keyboardHint: t('settings.agents.modelSelector.keyboardHints'),
        notSelected: placeholder || t('settings.agents.modelSelector.notSelected'),
        favorite: t('settings.agents.modelSelector.actions.favorite'),
        unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
        provider: t('chat.modelControls.provider'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
    }), [placeholder, t]);

    const selectedModel = !agentCombination?.id && providerId && modelId ? { providerID: providerId, modelID: modelId } : null;
    const displayReady = isReady || Boolean(selectedModel || agentCombination?.id);
    const triggerLabel = React.useMemo(() => {
        if (agentCombination?.id) return selectedCombination?.name ?? t('agents.combinations.defaultUnavailable');
        if (!providerId || !modelId) {
            return placeholder || t('settings.agents.modelSelector.notSelected');
        }
        if (isAutoSelected) return t('chat.modelControls.autoModel');
        const provider = providers.find((entry) => entry.id === providerId);
        const model = provider?.models?.find((entry) => entry.id === modelId);
        return (typeof model?.name === 'string' && model.name.trim()) || modelId;
    }, [agentCombination?.id, selectedCombination?.name, isAutoSelected, modelId, placeholder, providerId, providers, t]);

    const allowModel = React.useCallback((pickedProviderId: string, pickedModelId: string) => (
        (allowNativeModels || !isNativeProviderId(pickedProviderId))
        && (isModelAllowed?.(pickedProviderId, pickedModelId) ?? true)
    ), [allowNativeModels, isModelAllowed]);

    const picker = (
        <ModelPickerList
            providers={providers}
            providerOrder={providerOrder}
            favoriteModels={favoriteModelsList}
            recentModels={recentModelsList}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSelect={handleSelect}
            labels={labels}
            selectedModel={selectedModel}
            actionGroup={offerCombinations ? {
                id: 'combinations', label: t('agents.combinations.group'),
                actions: orderPickerItems(combinations, combinationOrder, (entry) => entry.id).map((entry) => ({
                    id: entry.id, label: entry.name,
                    icon: <ProviderLogo providerId={entry.main.model.providerID} className="size-3.5 shrink-0" />,
                    selected: agentCombination?.id === entry.id, disabled: !combinationsReady,
                    onSelect: () => { agentCombination?.onSelect(entry.id); closePicker(); },
                })),
            } : undefined}
            leadingEntry={autoEntry}
            hiddenModels={hiddenModels}
            allowedProviderIds={allowedProviderIds}
            isModelAllowed={allowModel}
            includeNotSelected
            onSelectNone={handleSelectNone}
            onEscape={closePicker}
            tooltipsEnabled={tooltipsEnabled && (isActuallyMobile ? isMobilePanelOpen : isDropdownOpen)}
            isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
            renderRowEnd={(entry) => entry.providerID === NATIVE_PROVIDER_CODEX && entry.variant !== undefined
                ? <span className="typography-micro whitespace-nowrap text-muted-foreground">{codexVariantLabel(entry.variant, t('chat.modelControls.default'))}</span> : null}
            onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID,
                entry.providerID === NATIVE_PROVIDER_CODEX && entry.providerID === providerId && entry.modelID === modelId ? selectedVariant : undefined)}
            {...(isActuallyMobile ? {
                autoFocus: false,
                maxHeightClassName: 'min-h-0 flex-1',
                providersStartCollapsed: true,
                showKeyboardHints: false,
            } : null)}
        />
    );

    if (isActuallyMobile) {
        return (
            <>
                <button
                    type="button"
                    onClick={canOpen ? () => setIsMobilePanelOpen(true) : undefined}
                    disabled={!canOpen}
                    className={cn(
                        dropdownTriggerVariants({ size: 'mobile' }),
                        'w-fit max-w-full',
                        className,
                    )}
                >
                    <div className="flex min-w-0 items-center gap-2">
                        {!displayReady ? (
                            <>
                                {isUnavailable ? <Icon name="error-warning" className="h-3.5 w-3.5 text-muted-foreground" /> : <Spinner className="h-3.5 w-3.5 text-muted-foreground" />}
                                <span className="typography-meta text-muted-foreground">{isUnavailable ? t('common.unavailable') : t('common.loading')}</span>
                            </>
                        ) : isAutoSelected ? (
                            <Icon name="openchamber" className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : triggerProviderId ? (
                            <ProviderLogo providerId={triggerProviderId} className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <Icon name="pencil-ai" className="h-3 w-3 text-muted-foreground" />
                        )}
                        {displayReady ? <span className="typography-meta font-medium text-foreground truncate">{triggerLabel}</span> : null}
                    </div>
                    <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                </button>
                <MobileOverlayPanel
                    open={isMobilePanelOpen}
                    onClose={closePicker}
                    title={t('settings.agents.modelSelector.title')}
                    scrollContent={false}
                >
                    {picker}
                </MobileOverlayPanel>
            </>
        );
    }

    const trigger = (
        <DropdownMenuTrigger asChild nativeButton={false} disabled={!canOpen}>
            <div
                className={cn(
                    dropdownTriggerVariants(),
                    'min-w-0 w-fit',
                    !canOpen && 'opacity-60 cursor-not-allowed',
                    className,
                )}
                title={compact && displayReady && !triggerTooltip ? triggerLabel : undefined}
            >
                {!displayReady ? (
                    <>
                        {isUnavailable ? <Icon name="error-warning" className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" /> : <Spinner className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
                        {!compact && (
                            <span className="typography-ui-label font-normal whitespace-nowrap text-muted-foreground">
                                {isUnavailable ? t('common.unavailable') : t('common.loading')}
                            </span>
                        )}
                    </>
                ) : (
                    <>
                        {isAutoSelected
                            ? <Icon name="openchamber" className="h-3.5 w-3.5 flex-shrink-0" />
                            : triggerProviderId
                                ? <ProviderLogo providerId={triggerProviderId} className="h-3.5 w-3.5 flex-shrink-0" />
                                : <Icon name="pencil-ai" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
                        {!compact && (
                            <span className="typography-ui-label min-w-0 flex-1 truncate text-start font-normal text-foreground">{triggerLabel}</span>
                        )}
                    </>
                )}
                {!compact && <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
            </div>
        </DropdownMenuTrigger>
    );

    return (
        <DropdownMenu open={canOpen && isDropdownOpen} onOpenChange={canOpen ? setIsDropdownOpen : undefined}>
            {triggerTooltip ? <HoverTooltip label={triggerTooltip} side="bottom">{trigger}</HoverTooltip> : trigger}
            <DropdownMenuContent className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col" align="start" portalToBody={dropdownPortalToBody}>
                {picker}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
