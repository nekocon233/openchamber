import type { Provider } from '@opencode-ai/sdk/v2/client';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { NativeBackend } from './ids';
import { buildNativeProvider } from './providers';

// Native CLI models for the model picker. The catalog is the same for every
// directory, so it is read once per runtime. A backend whose read fails keeps
// what an earlier read found, and the next load after a failure reads again,
// at most once a minute.

const RETRY_AFTER_FAILURE_MS = 60_000;
const BACKENDS: NativeBackend[] = ['claude', 'codex'];

type CatalogState = {
  providers: Map<NativeBackend, Provider>;
  complete: boolean;
  failedAt: number;
  inflight: Promise<Provider[]> | null;
};

const states = new Map<string, CatalogState>();

const listed = (state: CatalogState): Provider[] => (
  BACKENDS.flatMap((backend) => {
    const provider = state.providers.get(backend);
    return provider ? [provider] : [];
  })
);

/** Providers for the installed native CLIs; empty where native sessions are unavailable. */
export const loadNativeProviders = async (): Promise<Provider[]> => {
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
