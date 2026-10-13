import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { NativeTaskOutput } from '@/lib/native-agents/task-schemas';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { setTaskStopRequest, useNativeTasksUIStore, type TaskStopRequest } from './task-ui-store';

export type NativeTaskScope = {
  sessionId: string;
  directory: string;
  generation: string;
  runtimeGeneration: number;
};

type OutputState =
  | { status: 'loading'; output: NativeTaskOutput | null }
  | { status: 'ready'; output: NativeTaskOutput }
  | { status: 'error'; output: NativeTaskOutput | null };

/** Output lives only while its detail is mounted. Refresh is explicit, never a timer. */
export function useNativeTaskOutput(scope: NativeTaskScope, taskId: string) {
  const { nativeAgents } = useRuntimeAPIs();
  const [state, setState] = React.useState<OutputState>({ status: 'loading', output: null });
  const request = React.useRef<AbortController | null>(null);
  const mounted = React.useRef(false);
  const { sessionId, directory, generation, runtimeGeneration } = scope;
  const refresh = React.useCallback(async () => {
    if (!mounted.current || runtimeGeneration !== getRuntimeEndpointGeneration()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((previous) => ({ status: 'loading', output: previous.output }));
    const current = () => mounted.current && !controller.signal.aborted
      && request.current === controller && runtimeGeneration === getRuntimeEndpointGeneration();
    try {
      const output = await nativeAgents.taskOutput(sessionId, taskId, directory, generation, { signal: controller.signal });
      if (current()) setState({ status: 'ready', output });
    } catch {
      if (current()) setState((previous) => ({ status: 'error', output: previous.output }));
    }
  }, [nativeAgents, sessionId, taskId, directory, generation, runtimeGeneration]);

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => request.current?.abort());
    return () => {
      mounted.current = false;
      request.current?.abort();
      unsubscribe();
    };
  }, [refresh]);
  return { ...state, refresh };
}

/** An accepted request is not a terminal outcome. Only the sync record can end it. */
export function useNativeTaskStop(scope: NativeTaskScope, taskId: string, active: boolean, canStop: boolean) {
  const { nativeAgents } = useRuntimeAPIs();
  const { sessionId, directory, generation, runtimeGeneration } = scope;
  const scopeKey = JSON.stringify([runtimeGeneration, directory, sessionId, generation]);
  const status = useNativeTasksUIStore((state) => state.stopScope === scopeKey ? state.stops.get(taskId)?.status ?? 'idle' : 'idle');
  const stop = async () => {
    const held = useNativeTasksUIStore.getState();
    const previous = held.stops.get(taskId)?.status;
    if (held.stopScope !== scopeKey || previous === 'submitting' || previous === 'accepted'
      || !active || !canStop || runtimeGeneration !== getRuntimeEndpointGeneration()) return;
    const request: TaskStopRequest = { status: 'submitting' };
    setTaskStopRequest(taskId, request);
    const current = () => {
      const state = useNativeTasksUIStore.getState();
      return runtimeGeneration === getRuntimeEndpointGeneration() && state.stopScope === scopeKey && state.stops.get(taskId) === request;
    };
    try {
      await nativeAgents.stopTask(sessionId, taskId, directory, generation);
      if (current()) setTaskStopRequest(taskId, { status: 'accepted' });
    } catch {
      if (current()) setTaskStopRequest(taskId, { status: 'error' });
    }
  };
  return { status, stop };
}
