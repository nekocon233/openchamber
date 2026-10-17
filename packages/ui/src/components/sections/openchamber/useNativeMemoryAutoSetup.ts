import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { autoConnectNativeMemory, type NativeMemoryAutoSetupResult } from '@/lib/native-agents/memory-auto-setup';

type InFlightSetup = {
  generation: number;
  promise: Promise<void>;
};

/** Keeps terminal CLI hooks installed while the memory tool is enabled, without reinstalling ready ones. */
export const useNativeMemoryAutoSetup = (enabled: boolean) => {
  const { nativeAgents } = useRuntimeAPIs();
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const [result, setResult] = React.useState<NativeMemoryAutoSetupResult | null>(null);
  const requestRevisionRef = React.useRef(0);
  const inFlightRef = React.useRef<InFlightSetup | null>(null);
  const attemptedRuntimeRef = React.useRef<string | null>(null);

  const runSetup = React.useCallback(() => {
    if (!nativeAgents.supported) return Promise.resolve();
    const generation = getRuntimeEndpointGeneration();
    if (inFlightRef.current?.generation === generation) return inFlightRef.current.promise;

    const revision = ++requestRevisionRef.current;
    setResult(null);
    const promise = (async () => {
      const next = await autoConnectNativeMemory(nativeAgents);
      if (requestRevisionRef.current === revision && generation === getRuntimeEndpointGeneration()) {
        setResult(next);
      }
    })().finally(() => {
      if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
    });
    inFlightRef.current = { generation, promise };
    return promise;
  }, [nativeAgents]);

  React.useEffect(() => {
    if (!enabled || !nativeAgents.supported) {
      attemptedRuntimeRef.current = runtimeKey;
      requestRevisionRef.current += 1;
      setResult(null);
      return;
    }
    if (attemptedRuntimeRef.current === runtimeKey) return;
    attemptedRuntimeRef.current = runtimeKey;
    void runSetup();
  }, [enabled, nativeAgents.supported, runSetup, runtimeKey]);

  React.useEffect(() => () => {
    requestRevisionRef.current += 1;
  }, []);

  return { result, runSetup };
};
