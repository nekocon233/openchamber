import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { z } from 'zod';
import React from 'react';
import { create, type StoreApi } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProviderResult, QuotaProviderId } from '@/types';
import type { QuotaProviderMeta } from '@/lib/quota';
import { fetchExtensionQuotaProviders, quotaProviderIds, quotaProviderList, sameExtensionQuotaProviders, type ExtensionQuotaProvider } from '@/lib/quota/extensionProviders';
import { getDesktopWindowVisibility, isDesktopShell, type DesktopSettings } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { getDefaultModels } from '@/lib/quota/model-families';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { fetchConfiguredQuotaProviders, fetchQuota, readCachedClaudeQuota } from '@/lib/quota/fetchQuota';
import { getRuntimeKey, isTransientRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { runBackgroundNetworkTask } from '@/lib/background-network';

const QUOTA_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const QUOTA_OPEN_FRESHNESS_MS = 15 * 1000;
let quotaGeneration = 0;
let nativeQuotaRevision = 0;
let providerSelectionRevision = 0;
let nativeQuotaLoad: Promise<void> | null = null;
const nativeQuotaId = z.templateLiteral(['kimi-claude:', z.string().uuid()]);
type NativeQuotaProvider = { id: QuotaProviderId; name: string; revision: number };
let inFlightRuntimeLoad: Promise<void> | null = null;
let inFlightExtensionLoad: Promise<void> | null = null;
let extensionLoadAgain = false;
const quotaRequests = new Map<QuotaProviderId, { controller: AbortController; promise: Promise<boolean>; source: 'live' | 'cached' }>();
let claudeCacheLoaded = false;
let configuredProvidersRequest: Promise<ReadonlySet<string> | null> | null = null;
const quotaAutoRefreshConsumers = new Map<symbol, boolean>();
let quotaAutoRefreshInterval: number | null = null;
let lastVisibleRefreshAt: number | null = null;
let lastVisibleRefreshIncludedAll = false;
let nativeQuotaWindowVisible = false;

interface QuotaSettingsState {
  dropdownProvidersExplicit: boolean;
  displayMode: 'usage' | 'remaining';
  dropdownProviderIds: QuotaProviderId[];
  savedDropdownProviderIds: string[] | null;
  selectedModels: Record<string, string[]>;
  expandedFamilies: Record<string, string[]>;
}

interface QuotaStore extends QuotaSettingsState {
  nativeProviders: NativeQuotaProvider[];
  nativeProviderError: string | null;
  loadNativeProviders: (force?: boolean) => Promise<void>;
  refreshSelectedQuotas: (options?: { manual?: boolean }) => Promise<boolean>;
  results: ProviderResult[];
  extensionProviders: ExtensionQuotaProvider[];
  loadedRuntimeKey: string | null;
  selectedProviderId: QuotaProviderId | null;
  isLoading: boolean;
  isFetchingProvider: Record<string, boolean>;
  lastUpdated: number | null;
  error: string | null;
  refreshErrors: Partial<Record<QuotaProviderId, string>>;

  invalidateProviderQuota: (providerId: QuotaProviderId) => void;
  loadCachedClaudeQuota: () => Promise<boolean>;
  setDropdownProviderIds: (providerIds: QuotaProviderId[]) => void;
  toggleModelSelected: (providerId: string, modelName: string) => void;
  loadSettings: () => Promise<void>;
  loadExtensionProviders: () => Promise<void>;
  fetchAllQuotas: (options?: { manual?: boolean }) => Promise<void>;
  fetchQuotas: (providerIds: QuotaProviderId[], options?: { invalidate?: boolean; manual?: boolean }) => Promise<boolean>;
  fetchProviderQuota: (providerId: QuotaProviderId, invalidate?: boolean) => Promise<boolean>;
  setSelectedProvider: (providerId: QuotaProviderId | null) => void;
  setDisplayMode: (mode: 'usage' | 'remaining') => void;
  setProviderInDropdown: (providerId: QuotaProviderId, shown: boolean) => string[];
  setSelectedModels: (providerId: string, modelNames: string[]) => void;
  setExpandedFamilies: (providerId: string, familyIds: string[]) => void;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  applyDefaultSelections: (providerId: string, availableModels: string[]) => void;
  ensureLoadedForRuntime: (options?: { refresh?: boolean; allProviders?: boolean; visibleOnly?: boolean }) => Promise<void>;
  resetForRuntimeSwitch: () => void;
  refreshAfterCredentialChange: () => Promise<void>;
}

type QuotaRequest =
  | { source: 'live'; providerId: QuotaProviderId; invalidate: boolean }
  | { source: 'cached'; providerId: 'claude' | 'magpie' };

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
      const result = source === 'cached' && providerId === 'claude'
        ? await readCachedClaudeQuota({ signal: controller.signal })
        : await fetchQuota(providerId, { signal: controller.signal, manual: source === 'live' });
      if (generation !== quotaGeneration || quotaRequests.get(providerId)?.controller !== controller) return false;
      if (source === 'cached' && providerId === 'claude') claudeCacheLoaded = true;
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
          const results = providerId === 'magpie' && previous?.usage && !invalidate
            ? [...state.results.filter(entry => entry.providerId !== providerId), { ...result, usage: previous.usage }]
            : keepPrevious ? state.results
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

const providerIdsFor = (extensions: readonly ExtensionQuotaProvider[], native: readonly NativeQuotaProvider[]) => (
  [...quotaProviderIds(extensions), ...native.map((provider) => provider.id)]
);

const resolveDropdownProviderIds = (saved: readonly string[] | null, known: readonly QuotaProviderId[]): QuotaProviderId[] => (
  saved === null
    ? [...known]
    : saved.filter((entry): entry is QuotaProviderId => known.some((id) => id === entry))
);

const parseSettings = (data: DesktopSettings, extensionProviders: readonly ExtensionQuotaProvider[]): QuotaSettingsState => {
  const displayMode = data.usageDisplayMode === 'remaining' ? 'remaining' : 'usage';
  const savedDropdownProviderIds = data.usageDropdownProviders ?? null;

  return {
    displayMode,
    dropdownProvidersExplicit: savedDropdownProviderIds !== null,
    savedDropdownProviderIds,
    dropdownProviderIds: resolveDropdownProviderIds(savedDropdownProviderIds, quotaProviderIds(extensionProviders)),
    selectedModels: data.usageSelectedModels ?? {},
    expandedFamilies: data.usageExpandedFamilies ?? {},
  };
};

const defaultQuotaSettings = (extensionProviders: readonly ExtensionQuotaProvider[] = []): QuotaSettingsState => ({
  dropdownProvidersExplicit: false,
  displayMode: 'usage',
  savedDropdownProviderIds: null,
  dropdownProviderIds: quotaProviderIds(extensionProviders),
  selectedModels: {},
  expandedFamilies: {},
});

const loadSettingsFromRuntime = async (extensionProviders: readonly ExtensionQuotaProvider[]): Promise<QuotaSettingsState> => {
  const settings = await loadDesktopSettings();
  return settings ? parseSettings(settings, extensionProviders) : defaultQuotaSettings(extensionProviders);
};

const applyExtensionProviders = (next: ExtensionQuotaProvider[]): void => {
  const state = useQuotaStore.getState();
  if (sameExtensionQuotaProviders(state.extensionProviders, next)) return;
  const gone = state.extensionProviders.map((previous) => previous.id).filter((id) => !next.some((entry) => entry.id === id));
  const isGone = (id: string): boolean => gone.some((goneId) => goneId === id);
  for (const id of gone) {
    quotaRequests.get(id)?.controller.abort();
    quotaRequests.delete(id);
  }
  useQuotaStore.setState((current) => {
    const refreshErrors = { ...current.refreshErrors };
    for (const id of gone) delete refreshErrors[id];
    return {
      extensionProviders: next,
      dropdownProviderIds: resolveDropdownProviderIds(current.savedDropdownProviderIds, providerIdsFor(next, current.nativeProviders)),
      results: gone.length > 0 ? current.results.filter((result) => !isGone(result.providerId)) : current.results,
      refreshErrors,
      selectedProviderId: current.selectedProviderId !== null && isGone(current.selectedProviderId) ? null : current.selectedProviderId,
      isFetchingProvider: Object.fromEntries(Object.entries(current.isFetchingProvider).filter(([id]) => !isGone(id))),
      isLoading: quotaRequests.size > 0,
    };
  });
  const { results, loadedRuntimeKey, fetchQuotas } = useQuotaStore.getState();
  const arrived = next.map((entry) => entry.id).filter((id) => !results.some((result) => result.providerId === id) && !quotaRequests.has(id));
  if (arrived.length > 0 && (loadedRuntimeKey !== null || claudeCacheLoaded || results.length > 0)) void fetchQuotas(arrived);
};

const readConfiguredProviders = () => {
  if (configuredProvidersRequest) return configuredProvidersRequest;
  const request: Promise<ReadonlySet<string> | null> = fetchConfiguredQuotaProviders().finally(() => {
    if (configuredProvidersRequest === request) configuredProvidersRequest = null;
  });
  configuredProvidersRequest = request;
  return request;
};

const recordNotConfigured = (set: (update: (state: QuotaStore) => Partial<QuotaStore>) => void, providerIds: QuotaProviderId[]) => {
  const absent = new Set<QuotaProviderId>(providerIds);
  const fetchedAt = Date.now();
  set((state) => {
    const refreshErrors = { ...state.refreshErrors };
    for (const providerId of absent) delete refreshErrors[providerId];
    return {
      results: [
        ...state.results.filter((entry) => !absent.has(entry.providerId)),
        ...quotaProviderList(state.extensionProviders).filter((provider) => absent.has(provider.id)).map((provider) => ({
          providerId: provider.id, providerName: provider.name, ok: false, configured: false, error: 'Not configured', usage: null, fetchedAt,
        })),
      ],
      refreshErrors,
      error: Object.values(refreshErrors)[0] ?? null,
      lastUpdated: fetchedAt,
    };
  });
};

export const useQuotaStore = create<QuotaStore>()(
  devtools(
    (set, get) => ({
      results: [],
      nativeProviders: [],
      nativeProviderError: null,
      extensionProviders: [],
      loadedRuntimeKey: null,
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      refreshErrors: {},
      ...defaultQuotaSettings(),

      loadSettings: async () => {
        const generation = quotaGeneration;
        const selectionRevision = providerSelectionRevision;
        try {
          const settings = await loadSettingsFromRuntime(get().extensionProviders);
          if (generation !== quotaGeneration) return;
          const current = get();
          const saved = selectionRevision === providerSelectionRevision ? settings.savedDropdownProviderIds : current.savedDropdownProviderIds;
          const known = providerIdsFor(current.extensionProviders, current.nativeProviders);
          const dropdownProviderIds = saved === null ? known : saved.filter((id): id is QuotaProviderId => known.some((entry) => entry === id) || nativeQuotaId.safeParse(id).success);
          set({ ...settings, savedDropdownProviderIds: saved, dropdownProviderIds, dropdownProvidersExplicit: saved !== null });
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
                  ? resolveDropdownProviderIds(state.savedDropdownProviderIds, providerIdsFor(state.extensionProviders, providers))
                  : [...quotaProviderIds(state.extensionProviders), ...ids],
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

      loadExtensionProviders: async () => {
        if (inFlightExtensionLoad) {
          extensionLoadAgain = true;
          return inFlightExtensionLoad;
        }
        const generation = quotaGeneration;
        inFlightExtensionLoad = (async () => {
          try {
            const next = await fetchExtensionQuotaProviders();
            if (generation !== quotaGeneration) return;
            applyExtensionProviders(next);
          } catch (error) {
            if (generation === quotaGeneration) console.warn('Failed to load extension usage providers:', error);
          }
        })().finally(() => {
          if (generation !== quotaGeneration) return;
          inFlightExtensionLoad = null;
          if (extensionLoadAgain) {
            extensionLoadAgain = false;
            void get().loadExtensionProviders();
          }
        });
        return inFlightExtensionLoad;
      },

      fetchQuotas: async (providerIds, { invalidate = false, manual = false } = {}) => {
        const generation = quotaGeneration;
        if (!manual && invalidate && providerIds.includes('claude')) get().invalidateProviderQuota('claude');
        const ids = [...new Set(providerIds)];
        const ordinary = ids.filter((id) => id !== 'claude' && id !== 'magpie' && id !== 'antigravity-cli' && !id.startsWith('kimi-claude:'));
        const cached = !manual && !invalidate && providerIds.includes('claude')
          ? [get().loadCachedClaudeQuota()] : [];
        try {
          if (ordinary.length && !invalidate) set({ isLoading: true });
          const configured = ordinary.length && !invalidate ? await readConfiguredProviders() : null;
          if (generation !== quotaGeneration) return false;
          const absent = configured ? ordinary.filter((id) => !configured.has(id)) : [];
          if (absent.length) recordNotConfigured(set, absent);
          const targets = ids.filter((id) => (manual || id !== 'claude') && !absent.includes(id));
          if (!targets.length) set({ isLoading: hasLiveQuotaRequests() });
          const answered = await Promise.all(
            [...targets.map((providerId) => providerId === 'magpie' && !manual
              ? requestProviderQuota({ source: 'cached', providerId }, set)
              : get().fetchProviderQuota(providerId, invalidate)), ...cached]
          );
          if (generation !== quotaGeneration) return false;
          return absent.length > 0 || answered.some(Boolean);
        } catch (error) {
          if (generation !== quotaGeneration) return false;
          const message = error instanceof Error ? error.message : 'Failed to fetch quotas';
          set({ error: message });
          return false;
        }
      },

      fetchAllQuotas: async ({ manual = false } = {}) => {
        const generation = quotaGeneration;
        await Promise.all([get().loadNativeProviders(), get().loadExtensionProviders()]);
        if (generation === quotaGeneration) await get().fetchQuotas(providerIdsFor(get().extensionProviders, get().nativeProviders), { manual });
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

      ensureLoadedForRuntime: async ({ refresh = false, allProviders = false, visibleOnly = false } = {}) => {
        const runtimeKey = getRuntimeKey();
        if (isTransientRuntimeKey(runtimeKey)) return;
        if (!useConfigStore.getState().isInitialized) return;
        if (visibleOnly && !hasVisibleQuotaReadout()) return;
        if (!refresh && get().loadedRuntimeKey === runtimeKey) return;
        const generation = quotaGeneration;
        let missingProvidersOnly = false;
        if (inFlightRuntimeLoad) {
          await inFlightRuntimeLoad;
          if (generation !== quotaGeneration) return;
          if (!allProviders) return;
          missingProvidersOnly = true;
        }

        inFlightRuntimeLoad = (async () => {
          if (get().loadedRuntimeKey !== runtimeKey) {
            await get().loadSettings();
            if (generation !== quotaGeneration) return;
            if (!allProviders && get().dropdownProvidersExplicit && !get().dropdownProviderIds.length) return;
            await Promise.all([get().loadExtensionProviders(), get().loadNativeProviders()]);
          }
          if (generation !== quotaGeneration) return;
          if (visibleOnly && !hasVisibleQuotaReadout()) {
            lastVisibleRefreshAt = null;
            lastVisibleRefreshIncludedAll = false;
            return;
          }
          if (!useConfigStore.getState().isInitialized) return;
          const { dropdownProviderIds, fetchQuotas } = get();
          const requestedIds = allProviders ? providerIdsFor(get().extensionProviders, get().nativeProviders) : dropdownProviderIds;
          const providerIds = missingProvidersOnly
            ? requestedIds.filter(providerId => !get().results.some(result => result.providerId === providerId))
            : requestedIds;
          if (providerIds.length === 0) return;
          const answered = await fetchQuotas(providerIds);
          if (answered && generation === quotaGeneration) set({ loadedRuntimeKey: runtimeKey });
        })().finally(() => { if (generation === quotaGeneration) inFlightRuntimeLoad = null; });

        return inFlightRuntimeLoad;
      },

      resetForRuntimeSwitch: () => {
        quotaGeneration += 1;
        claudeCacheLoaded = false;
        nativeQuotaRevision += 1;
        nativeQuotaLoad = null;
        configuredProvidersRequest = null;
        for (const request of quotaRequests.values()) request.controller.abort();
        quotaRequests.clear();
        inFlightRuntimeLoad = null;
        inFlightExtensionLoad = null;
        extensionLoadAgain = false;
        lastVisibleRefreshAt = null;
        lastVisibleRefreshIncludedAll = false;
        set({
          ...defaultQuotaSettings(),
          extensionProviders: [],
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

      refreshAfterCredentialChange: async () => {
        quotaGeneration += 1;
        claudeCacheLoaded = false;
        nativeQuotaRevision += 1;
        nativeQuotaLoad = null;
        configuredProvidersRequest = null;
        for (const request of quotaRequests.values()) request.controller.abort();
        quotaRequests.clear();
        inFlightRuntimeLoad = null;
        inFlightExtensionLoad = null;
        extensionLoadAgain = false;
        lastVisibleRefreshAt = null;
        lastVisibleRefreshIncludedAll = false;
        set({ results: [], loadedRuntimeKey: null, isLoading: false, isFetchingProvider: {}, lastUpdated: null, refreshErrors: {}, error: null });
        if (!hasVisibleQuotaReadout()) return;
        await get().ensureLoadedForRuntime({ refresh: true, allProviders: [...quotaAutoRefreshConsumers.values()].some(Boolean), visibleOnly: true });
      },

      setSelectedProvider: (providerId) => set({ selectedProviderId: providerId }),
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setProviderInDropdown: (providerId, shown) => {
        providerSelectionRevision += 1;
        const { savedDropdownProviderIds, dropdownProviderIds, extensionProviders, nativeProviders } = get();
        const base: readonly string[] = savedDropdownProviderIds ?? dropdownProviderIds;
        const next = shown ? [...new Set([...base, providerId])] : base.filter((id) => id !== providerId);
        set({ dropdownProvidersExplicit: true, savedDropdownProviderIds: next, dropdownProviderIds: resolveDropdownProviderIds(next, providerIdsFor(extensionProviders, nativeProviders)) });
        return next;
      },

      setDropdownProviderIds: (providerIds) => {
        providerSelectionRevision += 1;
        set({ dropdownProviderIds: providerIds, savedDropdownProviderIds: providerIds, dropdownProvidersExplicit: true });
      },

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
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      applyDefaultSelections: (providerId, availableModels) => {
        const state = get();
        if ((state.selectedModels[providerId]?.length ?? 0) > 0) return;

        const defaults = getDefaultModels(providerId as QuotaProviderId, availableModels);
        if (defaults.length === 0) return;

        set((s) => ({
          selectedModels: { ...s.selectedModels, [providerId]: defaults },
        }));
        void updateDesktopSettings({ usageSelectedModels: get().selectedModels });
      },
    }),
    { name: 'quota-store' }
  )
);

const hasVisibleQuotaReadout = () => quotaAutoRefreshConsumers.size > 0
  && globalThis.document !== undefined && document.visibilityState !== 'hidden'
  && ((!isDesktopShell() && !isCapacitorApp()) || nativeQuotaWindowVisible);

const refreshVisibleQuotas = (tray = false) => {
  if ((!tray && !hasVisibleQuotaReadout()) || !useConfigStore.getState().isInitialized) return;
  const allProviders = !tray && [...quotaAutoRefreshConsumers.values()].some(Boolean);
  const now = Date.now();
  if (lastVisibleRefreshAt !== null && now - lastVisibleRefreshAt < QUOTA_OPEN_FRESHNESS_MS
    && (!allProviders || lastVisibleRefreshIncludedAll)) return;
  lastVisibleRefreshAt = now;
  lastVisibleRefreshIncludedAll = allProviders;
  void runBackgroundNetworkTask(async () => {
    if (!tray && !hasVisibleQuotaReadout()) {
      if (lastVisibleRefreshAt === now) {
        lastVisibleRefreshAt = null;
        lastVisibleRefreshIncludedAll = false;
      }
      return;
    }
    await useQuotaStore.getState().ensureLoadedForRuntime({ refresh: true, allProviders, visibleOnly: !tray });
  }, 'active-session');
};

export const refreshTrayQuotas = (initial = false) => {
  if (initial && useQuotaStore.getState().loadedRuntimeKey === getRuntimeKey()) return;
  refreshVisibleQuotas(true);
};

const updateQuotaAutoRefresh = () => {
  if (!hasVisibleQuotaReadout()) {
    if (quotaAutoRefreshInterval !== null) window.clearInterval(quotaAutoRefreshInterval);
    quotaAutoRefreshInterval = null;
    return;
  }
  refreshVisibleQuotas();
  if (quotaAutoRefreshInterval === null) quotaAutoRefreshInterval = window.setInterval(refreshVisibleQuotas, QUOTA_REFRESH_INTERVAL_MS);
};

export const useQuotaAutoRefresh = (visible = true, allProviders = false) => {
  const isInitialized = useConfigStore(state => state.isInitialized);
  const [nativeVisible, setNativeVisible] = React.useState(() => !isDesktopShell() && !isCapacitorApp());
  React.useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | undefined;
    const reportNativeVisibility = (value: boolean) => {
      nativeQuotaWindowVisible = value;
      setNativeVisible(value);
      updateQuotaAutoRefresh();
    };
    if (isDesktopShell()) {
      let revision = 0;
      const onVisibility = (event: Event) => {
        if (!(event instanceof CustomEvent) || (event.detail !== true && event.detail !== false)) return;
        revision += 1;
        reportNativeVisibility(event.detail);
      };
      window.addEventListener('openchamber:window-visibility', onVisibility);
      void getDesktopWindowVisibility().then(value => {
        if (!disposed && revision === 0) reportNativeVisibility(value === true);
      }).catch(() => undefined);
      removeListener = () => window.removeEventListener('openchamber:window-visibility', onVisibility);
    } else if (isCapacitorApp()) {
      void import('@capacitor/app').then(async ({ App }) => {
        if (disposed) return;
        let revision = 0;
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          revision += 1;
          if (!disposed) reportNativeVisibility(isActive);
        });
        if (disposed) { void handle.remove(); return; }
        removeListener = () => { void handle.remove(); };
        const state = await App.getState();
        if (!disposed && revision === 0) reportNativeVisibility(state.isActive);
      }).catch(() => undefined);
    }
    return () => { disposed = true; removeListener?.(); };
  }, []);
  React.useEffect(() => {
    if (!visible || !isInitialized || !nativeVisible) return;
    const consumer = Symbol();
    quotaAutoRefreshConsumers.set(consumer, allProviders);
    if (quotaAutoRefreshConsumers.size === 1) document.addEventListener('visibilitychange', updateQuotaAutoRefresh);
    updateQuotaAutoRefresh();

    return () => {
      quotaAutoRefreshConsumers.delete(consumer);
      if (quotaAutoRefreshConsumers.size === 0) document.removeEventListener('visibilitychange', updateQuotaAutoRefresh);
      updateQuotaAutoRefresh();
    };
  }, [visible, allProviders, isInitialized, nativeVisible]);
};

export const useQuotaProviders = (): QuotaProviderMeta[] => {
  const extensionProviders = useQuotaStore((state) => state.extensionProviders);
  return React.useMemo(() => quotaProviderList(extensionProviders), [extensionProviders]);
};
