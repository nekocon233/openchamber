import React from 'react';

import type { NativeCommandList, NativeReadOptions } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { NativeBackend } from './ids';

type NativeCommandsState =
  | { status: 'loading' }
  | { status: 'ready'; commands: NativeCommandList['commands']; warnings?: string[] }
  | { status: 'failed' };

const LOADING: NativeCommandsState = { status: 'loading' };
const EMPTY: NativeCommandsState = { status: 'ready', commands: [] };

/**
 * The slash commands a native CLI offers in a directory, for the composer's
 * command menu. A failed listing leaves built-in composer actions available.
 */
export const useNativeCommands = (backend: NativeBackend | null, directory: string | null, sessionId: string | null = null): NativeCommandsState => {
  const { nativeAgents } = useRuntimeAPIs();
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const [loaded, setLoaded] = React.useState<{
    backend: NativeBackend;
    directory: string;
    sessionId: string | null;
    runtimeKey: string;
    api: typeof nativeAgents;
    result: NativeCommandsState;
  } | null>(null);

  React.useEffect(() => {
    if (!backend || backend === 'antigravity' || !directory || !nativeAgents.supported) {
      return;
    }
    const controller = new AbortController();
    const setState = (result: NativeCommandsState) => setLoaded({ backend, directory, sessionId, runtimeKey, api: nativeAgents, result });
    setState(LOADING);
    const options: NativeReadOptions & { sessionId?: string } = { signal: controller.signal };
    if (backend === 'deepseek' && sessionId) options.sessionId = sessionId;
    nativeAgents.commands(backend, directory, options).then(
      (list) => {
        if (!controller.signal.aborted) setState({ status: 'ready', commands: list.commands, warnings: list.warnings });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      },
    );
    return () => controller.abort();
  }, [backend, directory, sessionId, nativeAgents, runtimeKey]);

  if (!backend || backend === 'antigravity' || !directory || !nativeAgents.supported) return EMPTY;
  return loaded?.backend === backend && loaded.directory === directory && loaded.sessionId === sessionId && loaded.runtimeKey === runtimeKey && loaded.api === nativeAgents
    ? loaded.result
    : LOADING;
};
