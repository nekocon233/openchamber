import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { NATIVE_BACKENDS, type NativeBackend } from './ids';
import { buildNativeProvider, type NativeProvider } from './providers';
import type { NativeModelDescriptor } from './schemas';

// Native CLI catalogs are shared by all directories in a runtime. A failed
// partition keeps its last catalog. Opening the picker can recheck the catalog,
// and one check per minute covers repeated opens and failed reads.

const CATALOG_FRESH_MS = 60_000;

type CatalogState = {
  providers: Map<NativeBackend, NativeProvider>;
  complete: boolean;
  checkedAt: number | null;
  inflight: Promise<NativeProvider[]> | null;
};

const states = new Map<string, CatalogState>();
const isRecent = (state: CatalogState) => state.checkedAt !== null && Date.now() - state.checkedAt < CATALOG_FRESH_MS;

const OFFICIAL_DEEPSEEK_PREFIX = 'deepseek-official/';

/**
 * DSH can expose DeepSeek through the official provider and through a gateway.
 * Keep the official entry and hide duplicated DeepSeek models from other
 * providers; gateway groups keep their non-DeepSeek models.
 */
const preferOfficialDeepSeekModels = (models: NativeModelDescriptor[]): NativeModelDescriptor[] => {
  if (!models.some((model) => model.id.startsWith(OFFICIAL_DEEPSEEK_PREFIX))) return models;
  return models.filter((model) => {
    if (model.id.startsWith(OFFICIAL_DEEPSEEK_PREFIX)) return true;
    const separator = model.id.indexOf('/');
    if (separator < 0) return true;
    let modelID = model.id.slice(separator + 1);
    try { modelID = decodeURIComponent(modelID); } catch { /* keep the encoded id */ }
    return !modelID.startsWith('deepseek/');
  });
};

const listed = (state: CatalogState): NativeProvider[] => (
  NATIVE_BACKENDS.flatMap((backend) => {
    const provider = state.providers.get(backend);
    return provider ? [provider] : [];
  })
);

/** Drop only this runtime's freshness; failed refreshes retain its last catalog. */
export const invalidateNativeProviders = (runtimeKey: string): void => {
  const previous = states.get(runtimeKey);
  states.set(runtimeKey, {
    providers: new Map(previous?.providers), complete: false, checkedAt: null, inflight: null,
  });
};

/** Recheck on demand. The caller can skip updating the store if no read starts. */
export const loadNativeProvidersIfStale = (): Promise<NativeProvider[]> | null => {
  if (!getRegisteredRuntimeAPIs()?.nativeAgents?.supported) return null;
  const runtimeKey = getRuntimeKey();
  const state = states.get(runtimeKey);
  if (state && (state.inflight || isRecent(state))) return null;
  invalidateNativeProviders(runtimeKey);
  return loadNativeProviders();
};

/** Providers for the installed native CLIs; empty where native sessions are unavailable. */
export const loadNativeProviders = async (): Promise<NativeProvider[]> => {
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents;
  if (!nativeAgents?.supported) return [];
  const runtimeKey = getRuntimeKey();
  let state = states.get(runtimeKey);
  if (!state) {
    state = { providers: new Map(), complete: false, checkedAt: null, inflight: null };
    states.set(runtimeKey, state);
  }
  const current = state;
  if (current.complete || current.inflight || isRecent(current)) {
    return current.inflight ?? listed(current);
  }
  current.inflight = (async () => {
    try {
      const catalog = await nativeAgents.catalog();
      let complete = true;
      for (const backend of NATIVE_BACKENDS) {
        const partition = catalog.backends[backend];
        // An older server has no DeepSeek adapter, rather than a failed catalog.
        if (!partition) { current.providers.delete(backend); continue; }
        if (partition.status === 'ok') {
          const models = backend === 'deepseek' ? preferOfficialDeepSeekModels(partition.models) : partition.models;
          if (models.length > 0) current.providers.set(backend, buildNativeProvider(backend, models));
          else current.providers.delete(backend);
        } else {
          complete = false;
        }
      }
      current.complete = complete;
    } catch (error) {
      console.warn('[native-agents] failed to read the native model catalog', error);
    } finally {
      current.checkedAt = Date.now();
      current.inflight = null;
    }
    if (states.get(runtimeKey) !== current && getRuntimeKey() === runtimeKey) return loadNativeProviders();
    return listed(current);
  })();
  return current.inflight;
};
