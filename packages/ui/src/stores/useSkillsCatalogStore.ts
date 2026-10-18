import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import type {
  SkillsCatalogResponse,
  SkillsCatalogSource,
  SkillsCatalogItem,
  SkillsRepoScanRequest,
  SkillsRepoScanResponse,
  SkillsInstallRequest,
  SkillsInstallResponse,
  SkillsInstallError,
  SkillsCatalogSourceResponse,
  SkillsUpdateInstalledResponse,
  SkillsUpdateInstalledPlanItem,
  SkillsUpdateInstalledResult,
  SkillsUpdateInstalledError,
  SkillsUserSyncResponse,
  SkillsUserSyncPlanItem,
  SkillsUserSyncResult,
  SkillsUserSyncError,
} from '@/lib/api/types';

import { invalidateSkillsLoadCache, refreshSkillsAfterOpenCodeRestart, useSkillsStore } from '@/stores/useSkillsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { startConfigUpdate } from '@/lib/configUpdate';
import { runtimeFetch } from '@/lib/runtime-fetch';

const SKILLS_CATALOG_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_SKILLS_CATALOG_CACHE_KEY = '__default__';
const skillsCatalogLastLoadedAt = new Map<string, number>();
const skillsCatalogLoadInFlight = new Map<string, Promise<boolean>>();
const sourceLoadInFlight = new Map<string, Promise<boolean>>();
let activeSourceLoads = 0;

const getSkillsCatalogCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_SKILLS_CATALOG_CACHE_KEY;
};

const getRequestDirectory = (): string | null => {
  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();

    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn('[SkillsCatalogStore] Error resolving config directory:', err);
  }

  return null;
};

const resolveUpdateDirectory = (options?: { directory?: string | null }): string | null => {
  const override = options?.directory?.trim() || null;
  return override ?? getRequestDirectory();
};

const requestInstalledUpdate = async (
  directory: string | null,
  dryRun: boolean,
): Promise<SkillsUpdateInstalledResponse | null> => {
  const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  try {
    const response = await runtimeFetch(`/api/config/skills/catalog/update${queryParams}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
    return (await response.json().catch(() => null)) as SkillsUpdateInstalledResponse | null;
  } catch (error) {
    console.warn('[SkillsCatalogStore] Could not reach the installed skill update:', error);
    return null;
  }
};

type InstalledUpdatePlanResult =
  | { ok: true; plan: SkillsUpdateInstalledPlanItem[] }
  | { ok: false; error: SkillsUpdateInstalledError };

type InstalledUpdateRunResult =
  | { ok: true; results: SkillsUpdateInstalledResult[]; updated: number; skipped: number; failed: number }
  | { ok: false; error: SkillsUpdateInstalledError };

const requestUserSkillSync = async (dryRun: boolean): Promise<SkillsUserSyncResponse | null> => {
  try {
    const response = await runtimeFetch('/api/config/skills/user/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
    // SAFETY: the sync route answers with `SkillsUserSyncResponse`; a missing
    // body or a non-JSON answer becomes null and is treated as a failure.
    return (await response.json().catch(() => null)) as SkillsUserSyncResponse | null;
  } catch (error) {
    console.warn('[SkillsCatalogStore] Could not reach the user skill sync:', error);
    return null;
  }
};

type UserSkillSyncPlanResult =
  | { ok: true; plan: SkillsUserSyncPlanItem[] }
  | { ok: false; error: SkillsUserSyncError };

type UserSkillSyncRunResult =
  | { ok: true; results: SkillsUserSyncResult[]; updated: number; skipped: number; failed: number }
  | { ok: false; error: SkillsUserSyncError };

interface SkillsCatalogState {
  sources: SkillsCatalogSource[];
  itemsBySource: Record<string, SkillsCatalogItem[]>;
  selectedSourceId: string | null;
  loadedSourceIds: Record<string, boolean>;

  isLoadingCatalog: boolean;
  isLoadingSource: boolean;
  isScanning: boolean;
  isInstalling: boolean;
  isUpdatingInstalled: boolean;

  lastCatalogError: SkillsCatalogResponse['error'] | null;
  lastScanError: SkillsRepoScanResponse['error'] | null;
  lastInstallError: SkillsInstallError | null;

  scanResults: SkillsCatalogItem[] | null;

  setSelectedSource: (id: string | null) => void;

  loadCatalog: (options?: { refresh?: boolean }) => Promise<boolean>;
  loadSource: (sourceId: string, options?: { refresh?: boolean }) => Promise<boolean>;
  scanRepo: (request: SkillsRepoScanRequest) => Promise<SkillsRepoScanResponse>;
  installSkills: (request: SkillsInstallRequest, options?: { directory?: string | null }) => Promise<SkillsInstallResponse>;
  fetchInstalledUpdatePlan: (options?: { directory?: string | null }) => Promise<InstalledUpdatePlanResult>;
  updateInstalledSkills: (options?: { directory?: string | null }) => Promise<InstalledUpdateRunResult>;
  fetchUserSkillSyncPlan: () => Promise<UserSkillSyncPlanResult>;
  syncUserSkills: () => Promise<UserSkillSyncRunResult>;
  isSyncingUserSkills: boolean;
}

export const useSkillsCatalogStore = create<SkillsCatalogState>()(
  devtools(
    (set, get) => ({
      // Empty until the server answers: it decides which catalogs exist, and a
      // machine policy can hide the built-in ones.
      sources: [],
      itemsBySource: {},
      selectedSourceId: null,
      loadedSourceIds: {},

      isLoadingCatalog: false,
      isLoadingSource: false,
      isScanning: false,
      isInstalling: false,
      isUpdatingInstalled: false,
      isSyncingUserSkills: false,

      lastCatalogError: null,
      lastScanError: null,
      lastInstallError: null,

      scanResults: null,

      setSelectedSource: (id) => set({ selectedSourceId: id }),

      loadCatalog: async (options) => {
        const currentDirectory = getRequestDirectory();
        const cacheKey = getSkillsCatalogCacheKey(currentDirectory);
        const now = Date.now();
        const loadedAt = skillsCatalogLastLoadedAt.get(cacheKey) ?? 0;
        // An empty list can be the answer, so freshness alone decides.
        const hasCachedCatalog = loadedAt > 0;
        if (!options?.refresh && hasCachedCatalog && now - loadedAt < SKILLS_CATALOG_LOAD_CACHE_TTL_MS) {
          return true;
        }

        const inFlight = skillsCatalogLoadInFlight.get(cacheKey);
        if (!options?.refresh && inFlight) {
          return inFlight;
        }

        const request = (async () => {
          set({ isLoadingCatalog: true, lastCatalogError: null });

          const previous = {
            sources: get().sources,
            itemsBySource: get().itemsBySource,
            loadedSourceIds: get().loadedSourceIds,
          };

          let lastError: SkillsCatalogResponse['error'] | null = null;

          try {
            const refresh = options?.refresh ? '?refresh=true' : '';
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), 3000);

            try {
              const response = await runtimeFetch(`/api/config/skills/catalog${refresh}`, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: controller.signal,
              });

              const payload = (await response.json().catch(() => null)) as SkillsCatalogResponse | null;
              if (!response.ok || !payload?.ok) {
                lastError = payload?.error || { kind: 'unknown', message: `Failed to load catalog (${response.status})` };
                throw new Error(lastError.message);
              }

              // The server's list is the answer, empty included: a machine
              // policy can hide every built-in catalog.
              const sources = payload.sources ?? previous.sources;
              const itemsBySource = options?.refresh ? {} : (get().itemsBySource || {});
              const loadedSourceIds = options?.refresh ? {} : (get().loadedSourceIds || {});
              const currentSelected = get().selectedSourceId;
              const selectedSourceId =
                (currentSelected && sources.some((s) => s.id === currentSelected))
                  ? currentSelected
                  : (sources[0]?.id ?? null);

              set({
                sources,
                itemsBySource,
                loadedSourceIds,
                selectedSourceId,
              });

              skillsCatalogLastLoadedAt.set(cacheKey, Date.now());
              return true;
            } finally {
              window.clearTimeout(timeoutId);
            }
          } catch (error) {
            lastError = lastError || { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };

            set({
              sources: previous.sources,
              itemsBySource: previous.itemsBySource,
              loadedSourceIds: previous.loadedSourceIds,
              lastCatalogError: lastError || { kind: 'unknown', message: 'Failed to load catalog' },
            });

            return false;
          } finally {
            set({ isLoadingCatalog: false });
          }
        })();

        skillsCatalogLoadInFlight.set(cacheKey, request);
        try {
          return await request;
        } finally {
          skillsCatalogLoadInFlight.delete(cacheKey);
        }
      },

      loadSource: async (sourceId, options) => {
        if (!sourceId) {
          return false;
        }

        // Deduplicate concurrent loads of the same source: the background
        // loader effect can restart while a request for this source is
        // already in flight.
        if (!options?.refresh) {
          const inFlight = sourceLoadInFlight.get(sourceId);
          if (inFlight) {
            return inFlight;
          }
        }

        activeSourceLoads += 1;
        set({ isLoadingSource: true, lastCatalogError: null });

        const request = (async () => {
          try {
            const currentDirectory = getRequestDirectory();
            const refresh = options?.refresh ? '&refresh=true' : '';
            const queryParams = currentDirectory
              ? `?directory=${encodeURIComponent(currentDirectory)}&sourceId=${encodeURIComponent(sourceId)}${refresh}`
              : `?sourceId=${encodeURIComponent(sourceId)}${refresh}`;

            const response = await runtimeFetch(`/api/config/skills/catalog/source${queryParams}`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
            });

            const payload = (await response.json().catch(() => null)) as SkillsCatalogSourceResponse | null;
            const hasItems = Array.isArray((payload as SkillsCatalogSourceResponse | null)?.items);
            if (!response.ok || (!payload?.ok && !hasItems)) {
              const fallback = await runtimeFetch(`/api/config/skills/catalog${queryParams}`, {
                method: 'GET',
                headers: { Accept: 'application/json' },
              });
              const fallbackPayload = (await fallback.json().catch(() => null)) as SkillsCatalogResponse | null;
              const fallbackItems = fallbackPayload?.itemsBySource?.[sourceId];
              if (fallback.ok && fallbackPayload?.ok && Array.isArray(fallbackItems)) {
                set((state) => ({
                  itemsBySource: { ...state.itemsBySource, [sourceId]: fallbackItems },
                  loadedSourceIds: { ...state.loadedSourceIds, [sourceId]: true },
                }));
                return true;
              }

              set({
                lastCatalogError: payload?.error || { kind: 'unknown', message: `Failed to load source (${response.status})` },
              });
              return false;
            }

            const items = payload?.items || [];

            set((state) => ({
              itemsBySource: { ...state.itemsBySource, [sourceId]: items },
              loadedSourceIds: { ...state.loadedSourceIds, [sourceId]: true },
            }));

            return true;
          } catch (error) {
            set({
              lastCatalogError: { kind: 'unknown', message: error instanceof Error ? error.message : String(error) },
            });
            return false;
          } finally {
            activeSourceLoads -= 1;
            if (activeSourceLoads === 0) {
              set({ isLoadingSource: false });
            }
          }
        })();

        sourceLoadInFlight.set(sourceId, request);
        try {
          return await request;
        } finally {
          if (sourceLoadInFlight.get(sourceId) === request) {
            sourceLoadInFlight.delete(sourceId);
          }
        }
      },

      scanRepo: async (request) => {
        set({ isScanning: true, lastScanError: null, scanResults: null });
        try {
          const currentDirectory = getRequestDirectory();
          const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

          const response = await runtimeFetch(`/api/config/skills/scan${queryParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request),
          });

          const payload = (await response.json().catch(() => null)) as SkillsRepoScanResponse | null;
          if (!response.ok || !payload) {
            const error = payload?.error || { kind: 'unknown', message: 'Failed to scan repository' };
            set({ lastScanError: error });
            return { ok: false, error };
          }

          if (!payload.ok) {
            set({ lastScanError: payload.error || { kind: 'unknown', message: 'Failed to scan repository' } });
            return payload;
          }

          set({ scanResults: payload.items || [] });
          return payload;
        } finally {
          set({ isScanning: false });
        }
      },

      installSkills: async (request, options) => {
        set({ isInstalling: true, lastInstallError: null });
        try {
          const directoryOverride = typeof options?.directory === 'string' && options.directory.trim().length > 0
            ? options.directory.trim()
            : null;
          const currentDirectory = directoryOverride ?? getRequestDirectory();
          const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

          const response = await runtimeFetch(`/api/config/skills/install${queryParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request),
          });

          const payload = (await response.json().catch(() => null)) as SkillsInstallResponse | null;
          if (!payload) {
            const error = { kind: 'unknown', message: 'Failed to install skills' } as SkillsInstallError;
            set({ lastInstallError: error });
            return { ok: false, error };
          }

          if (!response.ok || !payload.ok) {
            const error = payload.error || ({ kind: 'unknown', message: 'Failed to install skills' } as SkillsInstallError);
            set({ lastInstallError: error });
            return { ok: false, error };
          }

          invalidateSkillsLoadCache(currentDirectory);

          if (payload.requiresManualRestart) {
            void get().loadCatalog({ refresh: true });
            return payload;
          }

          if (payload.requiresReload) {
            startConfigUpdate('Installing skills…');
            await refreshSkillsAfterOpenCodeRestart({
              message: payload.message,
              delayMs: payload.reloadDelayMs,
            });
          } else {
            void useSkillsStore.getState().loadSkills();
          }

          return payload;
        } catch (error) {
          const err = { kind: 'unknown', message: error instanceof Error ? error.message : String(error) } as SkillsInstallError;
          set({ lastInstallError: err });
          return { ok: false, error: err };
        } finally {
          set({ isInstalling: false });
        }
      },

      fetchInstalledUpdatePlan: async (options) => {
        const directory = resolveUpdateDirectory(options);
        const payload = await requestInstalledUpdate(directory, true);
        if (!payload?.ok || !Array.isArray(payload.plan)) {
          return {
            ok: false,
            error: payload?.error ?? { kind: 'unknown', message: 'Failed to read installed skills' },
          };
        }
        return { ok: true, plan: payload.plan };
      },

      updateInstalledSkills: async (options) => {
        set({ isUpdatingInstalled: true });
        try {
          const directory = resolveUpdateDirectory(options);
          const payload = await requestInstalledUpdate(directory, false);
          if (!payload?.ok || !Array.isArray(payload.results)) {
            return {
              ok: false,
              error: payload?.error ?? { kind: 'unknown', message: 'Failed to update installed skills' },
            };
          }

          const results = payload.results;
          const countOf = (status: SkillsUpdateInstalledResult['status']) => (
            results.filter((entry) => entry.status === status).length
          );
          // The files on disk changed, so the next skills read must not come
          // from the cached list.
          invalidateSkillsLoadCache(directory);
          void useSkillsStore.getState().loadSkills();

          return {
            ok: true,
            results,
            updated: payload.updated ?? countOf('updated'),
            skipped: payload.skipped ?? countOf('skipped'),
            failed: payload.failed ?? countOf('failed'),
          };
        } finally {
          set({ isUpdatingInstalled: false });
        }
      },

      fetchUserSkillSyncPlan: async () => {
        const payload = await requestUserSkillSync(true);
        if (!payload?.ok || !Array.isArray(payload.plan)) {
          return {
            ok: false,
            error: payload?.error ?? { kind: 'unknown', message: 'Failed to read the user skill library' },
          };
        }
        return { ok: true, plan: payload.plan };
      },

      syncUserSkills: async () => {
        set({ isSyncingUserSkills: true });
        try {
          const payload = await requestUserSkillSync(false);
          if (!payload?.ok || !Array.isArray(payload.results)) {
            return {
              ok: false,
              error: payload?.error ?? { kind: 'unknown', message: 'Failed to sync the user skill library' },
            };
          }

          const results = payload.results;
          const countOf = (status: SkillsUserSyncResult['status']) => (
            results.filter((entry) => entry.status === status).length
          );
          // The files on disk changed, so the next skills read must not come
          // from the cached list.
          invalidateSkillsLoadCache();
          void useSkillsStore.getState().loadSkills();

          return {
            ok: true,
            results,
            updated: payload.updated ?? countOf('updated'),
            skipped: payload.skipped ?? countOf('skipped'),
            failed: payload.failed ?? countOf('failed'),
          };
        } finally {
          set({ isSyncingUserSkills: false });
        }
      },
    }),
    { name: 'skills-catalog-store' }
  )
);
