import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { z } from 'zod';
import React from 'react';
import { create, type StoreApi } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import type { DesktopSettings } from '@/lib/desktop';
import { getDefaultModels } from '@/lib/quota/model-families';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { fetchQuota, readCachedClaudeQuota } from '@/lib/quota/fetchQuota';
import { getRuntimeKey, isTransientRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';

const QUOTA_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
// Quotas and their display settings are read from the connected OpenChamber
// instance, so both belong to that instance. Bumped on every reset so a
// response in flight for the previous instance cannot land in the new one.
let quotaGeneration = 0;
let nativeQuotaRevision = 0;
let providerSelectionRevision = 0;
let nativeQuotaLoad: Promise<void> | null = null;
const nativeQuotaId = z.templateLiteral(['kimi-claude:', z.string().uuid()]);
type NativeQuotaProvider = { id: QuotaProviderId; name: string; revision: number };
let inFlightRuntimeLoad: Promise<void> | null = null;
const quotaRequests = new Map<QuotaProviderId, { controller: AbortController; promise: Promise<boolean>; source: 'live' | 'cached' }>();
let claudeCacheLoaded = false;
let quotaAutoRefreshConsumers = 0;
let quotaAutoRefreshInterval: number | null = null;

interface QuotaSettingsState {
  dropdownProvidersExplicit: boolean;
  displayMode: 'usage' | 'remaining';
  dropdownProviderIds: QuotaProviderId[];
  selectedModels: Record<string, string[]>;  // Map of providerId -> selected model names
  expandedFamilies: Record<string, string[]>;  // Map of providerId -> EXPANDED family IDs (header dropdown - inverted)
}

interface QuotaStore extends QuotaSettingsState {
  nativeProviders: NativeQuotaProvider[];
  nativeProviderError: string | null;
  loadNativeProviders: (force?: boolean) => Promise<void>;
  refreshSelectedQuotas: (options?: { manual?: boolean }) => Promise<boolean>;
  results: ProviderResult[];
  /** Runtime whose bootstrap finished; Claude may have no saved sample yet. */
  loadedRuntimeKey: string | null;
  selectedProviderId: QuotaProviderId | null;
  isLoading: boolean;
  isFetchingProvider: Record<string, boolean>;
  lastUpdated: number | null;
  error: string | null;
  /** Refresh failures are not authoritative provider configuration or usage. */
  refreshErrors: Partial<Record<QuotaProviderId, string>>;

  loadSettings: () => Promise<void>;
  fetchAllQuotas: (options?: { manual?: boolean }) => Promise<void>;
  /** Resolves true when at least one provider answered — see `ensureLoadedForRuntime`. */
  fetchQuotas: (providerIds: QuotaProviderId[], options?: { invalidate?: boolean; manual?: boolean }) => Promise<boolean>;
  /** Explicit single-provider query. Claude callers must be user initiated. */
  fetchProviderQuota: (providerId: QuotaProviderId, invalidate?: boolean) => Promise<boolean>;
  invalidateProviderQuota: (providerId: QuotaProviderId) => void;
  loadCachedClaudeQuota: () => Promise<boolean>;
  setSelectedProvider: (providerId: QuotaProviderId | null) => void;
  setDisplayMode: (mode: 'usage' | 'remaining') => void;
  setDropdownProviderIds: (providerIds: QuotaProviderId[]) => void;
  setSelectedModels: (providerId: string, modelNames: string[]) => void;
  toggleModelSelected: (providerId: string, modelName: string) => void;
  setExpandedFamilies: (providerId: string, familyIds: string[]) => void;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  applyDefaultSelections: (providerId: QuotaProviderId, availableModels: string[]) => void;
  /**
   * Load settings and automatic quotas once per ready instance. Claude restores
   * its saved sample; only an explicit refresh queries its provider.
   *
   * Providers report themselves as configured only after the instance can read
   * their credentials, which on a remote instance is not true the moment the UI
   * mounts. A fetch fired at mount therefore answers "nothing configured", and
   * because every provider then has a result, no consumer asks again until the
   * three-minute refresh — which is why Usage stayed missing from the
   * work-status panel until Settings -> Usage forced a fresh fetch.
   */
  ensureLoadedForRuntime: () => Promise<void>;
  resetForRuntimeSwitch: () => void;
}

type QuotaRequest =
  | { source: 'live'; providerId: QuotaProviderId; invalidate: boolean }
  | { source: 'cached'; providerId: 'claude' };

const hasLiveQuotaRequests = () => {
  for (const request of quotaRequests.values()) if (request.source === 'live') return true;
  return false;
};

const requestProviderQuota = (request: QuotaRequest, set: StoreApi<QuotaStore>['setState']): Promise<boolean> => {
  const { providerId, source } = request;
  const invalidate = request.source === 'live' && request.invalidate;
  const existing = quotaRequests.get(providerId);
  // A manual refresh retires cache hydration. Cache reads can join a pending
  // manual request, but can never overwrite the sample it is producing.
  if (existing && !invalidate && (source === 'cached' || existing.source === 'live')) return existing.promise;
  if (existing) { existing.controller.abort(); quotaRequests.delete(providerId); }
  if (source === 'live' && providerId === 'claude') claudeCacheLoaded = true;
  const generation = quotaGeneration;
  const controller = new AbortController();
  const promise = Promise.resolve().then(async () => {
    try {
      const result = source === 'cached'
        ? await readCachedClaudeQuota({ signal: controller.signal })
        : await fetchQuota(providerId, { signal: controller.signal });
      if (generation !== quotaGeneration || quotaRequests.get(providerId)?.controller !== controller) return false;
      if (source === 'cached') claudeCacheLoaded = true;
      if (result === null) {
        set(state => {
          const refreshErrors = { ...state.refreshErrors };
          delete refreshErrors[providerId];
          return { results: state.results.filter(entry => entry.providerId !== providerId), refreshErrors,
            error: Object.values(refreshErrors)[0] ?? null };
        });
        return true;
      }
      if (!result.ok && result.configured) {
        const message = result.error || 'Failed to fetch quota';
        set(state => {
          const previous = state.results.find(entry => entry.providerId === providerId);
          const keepPrevious = previous?.configured && !invalidate && !result.refresh;
          const results = keepPrevious ? state.results
            : [...state.results.filter(entry => entry.providerId !== providerId), result];
          return { results, refreshErrors: { ...state.refreshErrors, [providerId]: message }, error: message };
        });
        return true;
      }
      set(state => {
        const refreshErrors = { ...state.refreshErrors };
        delete refreshErrors[providerId];
        return {
          results: [...state.results.filter(entry => entry.providerId !== providerId), result],
          refreshErrors,
          error: Object.values(refreshErrors)[0] ?? null,
          lastUpdated: source === 'cached'
            ? state.lastUpdated ?? result.refresh?.sampledAt ?? null
            : Date.now(),
        };
      });
      return true;
    } catch (error) {
      if (generation !== quotaGeneration || quotaRequests.get(providerId)?.controller !== controller || controller.signal.aborted) return false;
      const message = error instanceof Error ? error.message : 'Failed to fetch quota';
      set(state => ({ refreshErrors: { ...state.refreshErrors, [providerId]: message }, error: message }));
      return false;
    } finally {
      if (quotaRequests.get(providerId)?.controller === controller) quotaRequests.delete(providerId);
      if (generation === quotaGeneration) {
        set(state => ({
          isFetchingProvider: { ...state.isFetchingProvider, [providerId]: quotaRequests.get(providerId)?.source === 'live' },
          isLoading: hasLiveQuotaRequests(),
        }));
      }
    }
  });
  quotaRequests.set(providerId, { controller, promise, source });
  if (source === 'live') set(state => ({ isLoading: true, isFetchingProvider: { ...state.isFetchingProvider, [providerId]: true } }));
  return promise;
};

const parseSettings = (data: DesktopSettings): QuotaSettingsState => {
  const allProviderIds = QUOTA_PROVIDERS.map((provider) => provider.id);
  const displayMode = data.usageDisplayMode === 'remaining' ? 'remaining' : 'usage';
  const dropdownProviderIds = data.usageDropdownProviders
    ? data.usageDropdownProviders.filter((entry): entry is QuotaProviderId =>
        allProviderIds.some((id) => id === entry) || nativeQuotaId.safeParse(entry).success
      )
    : allProviderIds;

  return {
    dropdownProvidersExplicit: data.usageDropdownProviders !== undefined,
    displayMode,
    dropdownProviderIds,
    // Map of providerId -> selected model names
    selectedModels: data.usageSelectedModels ?? {},
    // Expanded families (inverted collapsed logic for header dropdown)
    expandedFamilies: data.usageExpandedFamilies ?? {},
  };
};

const defaultQuotaSettings = (): QuotaSettingsState => ({
  dropdownProvidersExplicit: false,
  displayMode: 'usage',
  dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
  selectedModels: {},
  expandedFamilies: {},
});

const loadSettingsFromRuntime = async (): Promise<QuotaSettingsState> => {
  const settings = await loadDesktopSettings();
  return settings ? parseSettings(settings) : defaultQuotaSettings();
};

export const useQuotaStore = create<QuotaStore>()(
  devtools(
    (set, get) => ({
      nativeProviders: [],
      nativeProviderError: null,
      dropdownProvidersExplicit: false,
      results: [],
      loadedRuntimeKey: null,
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      refreshErrors: {},
      displayMode: 'usage',
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
      selectedModels: {},
      expandedFamilies: {},

      loadSettings: async () => {
        const generation = quotaGeneration;
        const selectionRevision = providerSelectionRevision;
        try {
          const settings = await loadSettingsFromRuntime();
          if (generation !== quotaGeneration) return;
          if (selectionRevision !== providerSelectionRevision) {
            settings.dropdownProviderIds = get().dropdownProviderIds;
            settings.dropdownProvidersExplicit = get().dropdownProvidersExplicit;
          } else if (!settings.dropdownProvidersExplicit) {
            settings.dropdownProviderIds = [...settings.dropdownProviderIds, ...get().nativeProviders.map((provider) => provider.id)];
          }
          set(settings);
        } catch (error) {
          console.warn('Failed to load usage settings:', error);
        }
      },

      loadNativeProviders: async (force = false) => {
        if (nativeQuotaLoad && !force) return nativeQuotaLoad;
        const generation = quotaGeneration;
        const revision = ++nativeQuotaRevision;
        const api = getRegisteredRuntimeAPIs()?.nativeAgents;
        nativeQuotaLoad = (async () => {
          try {
            const connections = api?.supported ? await api.listClaudeConnections() : [];
            if (generation !== quotaGeneration || revision !== nativeQuotaRevision) return;
            const providers: NativeQuotaProvider[] = connections.flatMap((connection) => connection.quotaProviderId
              ? [{ id: connection.quotaProviderId, name: `${connection.name} / Claude Code`, revision: connection.revision }]
              : []);
            const previous = get().nativeProviders;
            const hasMissingChoice = get().dropdownProviderIds.some((id) => id.startsWith('kimi-claude:') && !providers.some((provider) => provider.id === id));
            if (!hasMissingChoice && providers.length === previous.length && providers.every((provider, index) => (
              provider.id === previous[index].id && provider.name === previous[index].name && provider.revision === previous[index].revision
            ))) {
              if (get().nativeProviderError) set({ nativeProviderError: null, error: Object.values(get().refreshErrors)[0] ?? null });
              return;
            }
            const invalidated = new Set(previous.filter((provider) => !providers.some((next) => next.id === provider.id && next.revision === provider.revision)).map((provider) => provider.id));
            for (const id of invalidated) { quotaRequests.get(id)?.controller.abort(); quotaRequests.delete(id); }
            const ids = new Set(providers.map((provider) => provider.id));
            set((state) => {
              const refreshErrors = { ...state.refreshErrors };
              const isFetchingProvider = { ...state.isFetchingProvider };
              for (const id of invalidated) { delete refreshErrors[id]; delete isFetchingProvider[id]; }
              return {
                nativeProviderError: null,
                error: Object.values(refreshErrors)[0] ?? null,
                nativeProviders: providers,
                results: state.results.filter((result) => !invalidated.has(result.providerId)),
                refreshErrors,
                isFetchingProvider,
                isLoading: hasLiveQuotaRequests(),
                selectedProviderId: state.selectedProviderId?.startsWith('kimi-claude:') && !ids.has(state.selectedProviderId) ? null : state.selectedProviderId,
                dropdownProviderIds: state.dropdownProvidersExplicit
                  ? state.dropdownProviderIds.filter((id) => !id.startsWith('kimi-claude:') || ids.has(id))
                  : [...QUOTA_PROVIDERS.map((provider) => provider.id), ...ids],
              };
            });
          } catch (error) {
            if (generation === quotaGeneration && revision === nativeQuotaRevision) {
              const message = error instanceof Error ? error.message : 'Could not read native quota providers';
              set({ error: message, nativeProviderError: message });
            }
          }
        })().finally(() => { if (generation === quotaGeneration && revision === nativeQuotaRevision) nativeQuotaLoad = null; });
        return nativeQuotaLoad;
      },

      refreshSelectedQuotas: async ({ manual = false } = {}) => {
        const generation = quotaGeneration;
        const state = get();
        if (state.dropdownProvidersExplicit && state.dropdownProviderIds.length === 0) return false;
        if (!state.dropdownProvidersExplicit || state.dropdownProviderIds.some((id) => id.startsWith('kimi-claude:'))) {
          await get().loadNativeProviders();
        }
        if (generation !== quotaGeneration) return false;
        return get().fetchQuotas(get().dropdownProviderIds, { manual });
      },

      fetchQuotas: async (providerIds, { invalidate = false, manual = false } = {}) => {
        const generation = quotaGeneration;
        if (!manual && invalidate && providerIds.includes('claude')) get().invalidateProviderQuota('claude');
        const targets = providerIds.filter(id => manual || id !== 'claude');
        const cached = !manual && !invalidate && providerIds.includes('claude')
          ? [get().loadCachedClaudeQuota()] : [];
        try {
          const answered = await Promise.all(
            [...targets.map((providerId) => get().fetchProviderQuota(providerId, invalidate)), ...cached]
          );
          if (generation !== quotaGeneration) return false;
          return answered.some(Boolean);
        } catch (error) {
          if (generation !== quotaGeneration) return false;
          const message = error instanceof Error ? error.message : 'Failed to fetch quotas';
          set({ error: message });
          return false;
        }
      },

      fetchAllQuotas: async ({ manual = false } = {}) => {
        const generation = quotaGeneration;
        await get().loadNativeProviders();
        if (generation !== quotaGeneration) return;
        await get().fetchQuotas([...QUOTA_PROVIDERS, ...get().nativeProviders].map((provider) => provider.id), { manual });
      },

      invalidateProviderQuota: (providerId) => {
        if (providerId === 'claude') claudeCacheLoaded = false;
        quotaRequests.get(providerId)?.controller.abort();
        quotaRequests.delete(providerId);
        set(state => {
          const refreshErrors = { ...state.refreshErrors };
          delete refreshErrors[providerId];
          return {
            results: state.results.filter(result => result.providerId !== providerId),
            refreshErrors,
            error: Object.values(refreshErrors)[0] ?? null,
            isFetchingProvider: { ...state.isFetchingProvider, [providerId]: false },
            isLoading: hasLiveQuotaRequests(),
          };
        });
      },

      fetchProviderQuota: (providerId, invalidate = false) => requestProviderQuota({ source: 'live', providerId, invalidate }, set),

      loadCachedClaudeQuota: () => claudeCacheLoaded
        ? Promise.resolve(true)
        : requestProviderQuota({ source: 'cached', providerId: 'claude' }, set),

      ensureLoadedForRuntime: async () => {
        const runtimeKey = getRuntimeKey();
        if (isTransientRuntimeKey(runtimeKey)) return;
        // Wait for the instance to report itself initialised. Asking earlier
        // gets an honest-looking "not configured" for every provider, which is
        // then cached as if it were the answer.
        if (!useConfigStore.getState().isInitialized) return;
        if (get().loadedRuntimeKey === runtimeKey) return;
        if (inFlightRuntimeLoad) return inFlightRuntimeLoad;

        const generation = quotaGeneration;
        inFlightRuntimeLoad = (async () => {
          await get().loadSettings();
          if (generation !== quotaGeneration) return;
          if (get().dropdownProvidersExplicit && get().dropdownProviderIds.length === 0) return;
          await get().loadNativeProviders();
          if (generation !== quotaGeneration) return;
          const { dropdownProviderIds, fetchQuotas } = get();
          if (dropdownProviderIds.length === 0) return;
          const answered = await fetchQuotas(dropdownProviderIds);
          // Mark the instance loaded only once it actually answered. Claiming it
          // up front meant a load that failed on a cold or briefly unreachable
          // instance was never attempted again — Usage would stay empty until
          // the three-minute refresh, or forever after a switch.
          if (answered && generation === quotaGeneration) set({ loadedRuntimeKey: runtimeKey });
        })().finally(() => { if (generation === quotaGeneration) inFlightRuntimeLoad = null; });

        return inFlightRuntimeLoad;
      },

      resetForRuntimeSwitch: () => {
        quotaGeneration += 1;
        claudeCacheLoaded = false;
        nativeQuotaRevision += 1;
        nativeQuotaLoad = null;
        for (const request of quotaRequests.values()) request.controller.abort();
        quotaRequests.clear();
        inFlightRuntimeLoad = null;
        set({
          // Display mode, the provider selection and the per-provider model
          // picks all come from the instance's own settings, and
          // `dropdownProviderIds` decides what gets fetched — carrying them
          // over would query the new instance through the old one's choices.
          ...defaultQuotaSettings(),
          nativeProviders: [],
          nativeProviderError: null,
          results: [],
          loadedRuntimeKey: null,
          selectedProviderId: null,
          isLoading: false,
          isFetchingProvider: {},
          lastUpdated: null,
          error: null,
          refreshErrors: {},
        });
      },

      setSelectedProvider: (providerId) => set({ selectedProviderId: providerId }),
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setDropdownProviderIds: (providerIds) => { providerSelectionRevision += 1; set({ dropdownProviderIds: providerIds, dropdownProvidersExplicit: true }); },

      setSelectedModels: (providerId, modelNames) => {
        set((state) => ({
          selectedModels: { ...state.selectedModels, [providerId]: modelNames }
        }));
      },

      toggleModelSelected: (providerId, modelName) => {
        set((state) => {
          const currentSelected = state.selectedModels[providerId] ?? [];
          const isSelected = currentSelected.includes(modelName);
          const nextSelected = isSelected
            ? currentSelected.filter((m) => m !== modelName)
            : [...currentSelected, modelName];
          return {
            selectedModels: { ...state.selectedModels, [providerId]: nextSelected }
          };
        });
      },

      setExpandedFamilies: (providerId, familyIds) => {
        set((state) => ({
          expandedFamilies: { ...state.expandedFamilies, [providerId]: familyIds }
        }));
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      toggleFamilyExpanded: (providerId, familyId) => {
        set((state) => {
          const currentExpanded = state.expandedFamilies[providerId] ?? [];
          const isExpanded = currentExpanded.includes(familyId);
          const nextExpanded = isExpanded
            ? currentExpanded.filter((id) => id !== familyId)
            : [...currentExpanded, familyId];
          return {
            expandedFamilies: { ...state.expandedFamilies, [providerId]: nextExpanded }
          };
        });
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      applyDefaultSelections: (providerId, availableModels) => {
        const state = get();
        // Only apply if no prior selections exist
        if ((state.selectedModels[providerId]?.length ?? 0) > 0) return;

        const defaults = getDefaultModels(providerId, availableModels);
        if (defaults.length === 0) return;

        set((s) => ({
          selectedModels: { ...s.selectedModels, [providerId]: defaults },
        }));
        // Persist
        void updateDesktopSettings({ usageSelectedModels: get().selectedModels });
      },
    }),
    { name: 'quota-store' }
  )
);

export const useQuotaAutoRefresh = () => {
  React.useEffect(() => {
    quotaAutoRefreshConsumers += 1;
    if (quotaAutoRefreshInterval === null) {
      quotaAutoRefreshInterval = window.setInterval(() => {
        void useQuotaStore.getState().refreshSelectedQuotas();
      }, QUOTA_REFRESH_INTERVAL_MS);
    }

    return () => {
      quotaAutoRefreshConsumers -= 1;
      if (quotaAutoRefreshConsumers === 0 && quotaAutoRefreshInterval !== null) {
        window.clearInterval(quotaAutoRefreshInterval);
        quotaAutoRefreshInterval = null;
      }
    };
  }, []);
};
