import { create } from 'zustand';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

export type NativeTasksTab = 'checklist' | 'background' | 'plan' | 'todos';

export type TaskStopRequest = { status: 'submitting' | 'accepted' | 'error' };

/** Selected tab and submitted actions only. Task records belong to the sync owners. */
export const useNativeTasksUIStore = create<{
  tab: NativeTasksTab;
  stopScope: string | null;
  stops: ReadonlyMap<string, TaskStopRequest>;
}>(() => ({ tab: 'checklist', stopScope: null, stops: new Map() }));

subscribeRuntimeEndpointWillChange(() => {
  useNativeTasksUIStore.setState({ stopScope: null, stops: new Map() });
});

export function selectTaskStopScope(scope: string | null, activeIds: readonly string[]): void {
  const state = useNativeTasksUIStore.getState();
  if (state.stopScope !== scope) {
    useNativeTasksUIStore.setState({ stopScope: scope, stops: new Map() });
    return;
  }
  const active = new Set(activeIds);
  if ([...state.stops.keys()].some((id) => !active.has(id))) {
    useNativeTasksUIStore.setState({ stops: new Map([...state.stops].filter(([id]) => active.has(id))) });
  }
}

export function setTaskStopRequest(key: string, request: TaskStopRequest | null): void {
  const stops = new Map(useNativeTasksUIStore.getState().stops);
  if (request) stops.set(key, request);
  else stops.delete(key);
  useNativeTasksUIStore.setState({ stops });
}

export function selectNativeTasksTab(tab: NativeTasksTab): void {
  if (useNativeTasksUIStore.getState().tab !== tab) {
    useNativeTasksUIStore.setState({ tab });
  }
}
