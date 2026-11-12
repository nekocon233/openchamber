import * as React from 'react';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBackgroundShellsStore } from './background-shells';
import { collectOpenTurnSessionIds, useGlobalSessionStatusStore } from './global-session-status';
import { usePrWatchStore } from './pr-watch';
import { useSessionBackgroundTasksStore } from './session-background-tasks';
import { useWorkflowActivityStore } from './workflow-activity';

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** Snapshot for non-React session lists, using the same live signals as the rows. */
export const readOpenTurnSessionIds = (): ReadonlySet<string> => collectOpenTurnSessionIds(
  useGlobalSessionStatusStore.getState().activeSessionIds,
  [
    useBackgroundShellsStore.getState().sessionIds,
    useSessionBackgroundTasksStore.getState().tasksBySession.keys(),
    useWorkflowActivityStore.getState().runningSessionIds,
    usePrWatchStore.getState().bySession.keys(),
  ],
);

/**
 * A membership-only view of the activity shown in session rows. Hold the last
 * snapshot while a drawer exits, and ignore task/watch detail changes that do
 * not change which sessions are running.
 */
export const useOpenTurnSessionIds = (enabled = true): ReadonlySet<string> => {
  const activeRef = React.useRef(EMPTY_IDS);
  const active = useGlobalSessionStatusStore(React.useCallback((state) => {
    if (enabled) activeRef.current = state.activeSessionIds;
    return activeRef.current;
  }, [enabled]));
  const shellRef = React.useRef(EMPTY_IDS);
  const shells = useBackgroundShellsStore(React.useCallback((state) => {
    if (enabled) shellRef.current = state.sessionIds;
    return shellRef.current;
  }, [enabled]));
  const workflowRef = React.useRef(EMPTY_IDS);
  const workflows = useWorkflowActivityStore(React.useCallback((state) => {
    if (enabled) workflowRef.current = state.runningSessionIds;
    return workflowRef.current;
  }, [enabled]));
  const tasksRef = React.useRef<readonly string[]>([]);
  const tasks = useSessionBackgroundTasksStore(React.useCallback((state) => {
    if (enabled && (state.tasksBySession.size !== tasksRef.current.length
      || tasksRef.current.some((id) => !state.tasksBySession.has(id)))) {
      tasksRef.current = [...state.tasksBySession.keys()];
    }
    return tasksRef.current;
  }, [enabled]));
  const watchesRef = React.useRef<readonly string[]>([]);
  const watches = usePrWatchStore(React.useCallback((state) => {
    if (enabled && (state.bySession.size !== watchesRef.current.length
      || watchesRef.current.some((id) => !state.bySession.has(id)))) {
      watchesRef.current = [...state.bySession.keys()];
    }
    return watchesRef.current;
  }, [enabled]));
  const structureRef = React.useRef(useGlobalSessionsStore.getState().structure);
  const structure = useGlobalSessionsStore(React.useCallback((state) => {
    if (enabled) structureRef.current = state.structure;
    return structureRef.current;
  }, [enabled]));
  const parents = React.useMemo(() => {
    const index = new Map<string, string>();
    for (const [parentId, children] of structure.activeChildrenByParentId) {
      for (const childId of children) index.set(childId, parentId);
    }
    return index;
  }, [structure]);
  return React.useMemo(
    () => collectOpenTurnSessionIds(active, [shells, tasks, workflows, watches], (id) => parents.get(id)),
    [active, parents, shells, tasks, watches, workflows],
  );
};
