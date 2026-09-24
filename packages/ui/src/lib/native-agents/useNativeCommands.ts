import React from 'react';

import type { NativeCommandList } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { NativeBackend } from './ids';

type NativeCommandsState =
  | { status: 'loading' }
  | { status: 'ready'; commands: NativeCommandList['commands'] }
  | { status: 'failed' };

/**
 * The slash commands a native CLI offers in a directory, for the composer's
 * command menu. A failed listing only leaves the menu shorter: the CLI still
 * runs any command typed out.
 */
export const useNativeCommands = (backend: NativeBackend | null, directory: string | null): NativeCommandsState => {
  const { nativeAgents } = useRuntimeAPIs();
  const [state, setState] = React.useState<NativeCommandsState>({ status: 'loading' });

  React.useEffect(() => {
    if (!backend || !directory || !nativeAgents.supported) {
      setState({ status: 'ready', commands: [] });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    nativeAgents.commands(backend, directory, { signal: controller.signal }).then(
      (list) => setState({ status: 'ready', commands: list.commands }),
      () => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      },
    );
    return () => controller.abort();
  }, [backend, directory, nativeAgents]);

  return state;
};
