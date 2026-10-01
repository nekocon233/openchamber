import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { NativeBackend } from './ids';
import { buildNativeProvider, type NativeProvider } from './providers';

// Native CLI models for the model picker. The catalog is the same for every
// directory, so it is read once per runtime. A backend whose read fails keeps
// what an earlier read found, and the next load after a failure reads again,
// at most once a minute.

const RETRY_AFTER_FAILURE_MS = 60_000;
const BACKENDS: NativeBackend[] = ['claude', 'codex'];

type CatalogState = {
  providers: Map<NativeBackend, NativeProvider>;
  complete: boolean;
  failedAt: number;
  inflight: Promise<NativeProvider[]> | null;
};

const states = new Map<string, CatalogState>();

const listed = (state: CatalogState): NativeProvider[] => (
  BACKENDS.flatMap((backend) => {
    const provider = state.providers.get(backend);
    return provider ? [provider] : [];
  })
);

/** Drop only this runtime's freshness; failed refreshes retain its last catalog. */
export const invalidateNativeProviders = (runtimeKey: string): void => {
  const previous = states.get(runtimeKey);
  states.set(runtimeKey, {
    providers: new Map(previous?.providers), complete: false, failedAt: 0, inflight: null,
  });
};

/** Providers for the installed native CLIs; empty where native sessions are unavailable. */
export const loadNativeProviders = async (): Promise<NativeProvider[]> => {
  const nativeAgents = getRegisteredRuntimeAPIs()?.nativeAgents;
  if (!nativeAgents?.supported) return [];
  const runtimeKey = getRuntimeKey();
  let state = states.get(runtimeKey);
  if (!state) {
    state = { providers: new Map(), complete: false, failedAt: 0, inflight: null };
    states.set(runtimeKey, state);
  }
  const current = state;
  if (current.complete || current.inflight || Date.now() - current.failedAt < RETRY_AFTER_FAILURE_MS) {
    return current.inflight ?? listed(current);
  }
  current.inflight = (async () => {
    try {
      const catalog = await nativeAgents.catalog();
      if (states.get(runtimeKey) !== current) {
        return getRuntimeKey() === runtimeKey ? loadNativeProviders() : listed(current);
      }
      let complete = true;
      for (const backend of BACKENDS) {
        const partition = catalog.backends[backend];
        if (partition.status === 'ok') {
          if (partition.models.length > 0) current.providers.set(backend, buildNativeProvider(backend, partition.models));
          else current.providers.delete(backend);
        } else {
          complete = false;
        }
      }
      current.complete = complete;
      if (!complete) current.failedAt = Date.now();
    } catch (error) {
      console.warn('[native-agents] failed to read the native model catalog', error);
      current.failedAt = Date.now();
    } finally {
      current.inflight = null;
    }
    return listed(current);
  })();
  return current.inflight;
};
