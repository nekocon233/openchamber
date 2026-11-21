import { create } from 'zustand';
import type { SessionStatus } from '@/lib/opencode/model';
import { hasRunningShell, useBackgroundShellsStore } from './background-shells';
import { hasRunningImage, useBackgroundImagesStore } from './background-images';
import { useSessionBackgroundTasksStore } from './session-background-tasks';
import { usePrWatchStore } from './pr-watch';
import { useExtensionWaitsStore } from './extension-waits';

type ActiveStatusType = 'busy' | 'retry';

export type ResolvedStatusType = ActiveStatusType | 'idle';

export type GlobalSessionStatusEntry = {
  status: SessionStatus;
  directory: string;
  optimisticUntil?: number;
};

export type ObservedOutcome = { directory: string; outcome: 'completed' | 'failed' | null };

type GlobalSessionStatusState = {
  /** Last explicitly observed activity/outcome. Bounded memory, never persisted. */
  observedById: ReadonlyMap<string, ObservedOutcome>;
  statusById: Map<string, GlobalSessionStatusEntry>;
  activeSessionIds: ReadonlySet<string>;
  resolvedStatusById: Map<string, ResolvedStatusType>;
  statusSnapshotAtByDirectory: Map<string, number>;
  revision: number;
  revisionById: Map<string, number>;
  revisionFloor: number;
};

export const EMPTY_ACTIVE_SESSION_IDS: ReadonlySet<string> = new Set();

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => ({
  observedById: new Map(),
  statusById: new Map(),
  activeSessionIds: EMPTY_ACTIVE_SESSION_IDS,
  resolvedStatusById: new Map(),
  statusSnapshotAtByDirectory: new Map(),
  revision: 0,
  revisionById: new Map(),
  revisionFloor: 0,
}));

// A parent session goes idle while a background subagent keeps working in a
// child session; OpenCode then hands the result back and the parent runs
// again. For everything the user reads as "this session is working" (the row's
// status dot and turn timer), that pause is still the same turn. The parent
// lookup is injected by the sync provider: the sessions store sits above this
// module in the import graph.
export type SessionParentResolver = (sessionId: string) => string | undefined;

export let resolveSessionParentId: SessionParentResolver = () => undefined;

export const setSessionParentResolver = (resolver: SessionParentResolver): void => {
  resolveSessionParentId = resolver;
};

/** Subagents nest; a deeper chain than this is treated as unrelated. */
const MAX_SUBAGENT_DEPTH = 8;

export const forEachAncestorId = (sessionId: string, visit: (ancestorId: string) => void, resolveParentId: SessionParentResolver = resolveSessionParentId): void => {
  let current = resolveParentId(sessionId);
  for (let depth = 0; current && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
    visit(current);
    current = resolveParentId(current);
  }
};

/** True when a subagent anywhere below the session is running. */
export const hasActiveSubagent = (sessionId: string, activeSessionIds: ReadonlySet<string>, resolveParentId: SessionParentResolver = resolveSessionParentId): boolean => {
  for (const activeId of activeSessionIds) {
    if (activeId === sessionId) continue;
    let found = false;
    forEachAncestorId(activeId, (ancestorId) => {
      if (ancestorId === sessionId) found = true;
    }, resolveParentId);
    if (found) return true;
  }
  return false;
};

/**
 * Active sessions plus every session whose turn they keep open: ancestors of
 * running subagents, and sessions waiting on a background command or a pull
 * request.
 */
const withBackgroundWork = (
  activeSessionIds: ReadonlySet<string>,
  shellSessionIds: ReadonlySet<string> = useBackgroundShellsStore.getState().sessionIds,
  tasksBySession: ReadonlyMap<string, unknown> = useSessionBackgroundTasksStore.getState().tasksBySession,
): ReadonlySet<string> => {
  let extended: Set<string> | null = null;
  const add = (sessionId: string): void => {
    if (activeSessionIds.has(sessionId)) return;
    extended ??= new Set(activeSessionIds);
    extended.add(sessionId);
  };
  for (const activeId of activeSessionIds) forEachAncestorId(activeId, add);
  for (const sessionId of shellSessionIds) add(sessionId);
  for (const sessionId of useBackgroundImagesStore.getState().sessionIds) add(sessionId);
  for (const sessionId of tasksBySession.keys()) add(sessionId);
  for (const sessionId of usePrWatchStore.getState().bySession.keys()) add(sessionId);
  for (const sessionId of useExtensionWaitsStore.getState().bySession.keys()) add(sessionId);
  return extended ?? activeSessionIds;
};

// A native CLI can end its turn while background tasks it started keep
// running, and starts a turn by itself when one finishes. For display that
// wait is the same turn too, as with a subagent.
const hasBackgroundTasks = (sessionId: string): boolean => (
  useSessionBackgroundTasksStore.getState().tasksBySession.has(sessionId)
);

/**
 * True when the session idles only while its background work runs: a subagent
 * below it, a command it started, an image, tasks a native CLI keeps running,
 * a pull request watch, or an extension wait.
 */
export const hasBackgroundWork = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => (
  hasActiveSubagent(sessionId, activeSessionIds)
  || hasRunningShell(sessionId)
  || hasRunningImage(sessionId)
  || hasBackgroundTasks(sessionId)
  || usePrWatchStore.getState().bySession.has(sessionId)
  || useExtensionWaitsStore.getState().bySession.has(sessionId)
);

/**
 * Whether one kind of background work ending leaves the turn open: the session
 * runs again, or another subagent, command, or task still holds it.
 */
export const turnStaysOpen = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => (
  activeSessionIds.has(sessionId) || hasBackgroundWork(sessionId, activeSessionIds)
);

/** Sessions whose turn is open: active ones, their ancestors, and those waiting on background work. */
export const withOpenTurns = (
  activeSessionIds: ReadonlySet<string>,
  shellSessionIds: ReadonlySet<string> = useBackgroundShellsStore.getState().sessionIds,
  tasksBySession: ReadonlyMap<string, unknown> = useSessionBackgroundTasksStore.getState().tasksBySession,
): ReadonlySet<string> => withBackgroundWork(activeSessionIds, shellSessionIds, tasksBySession);

/** Sessions whose turn is open now: active sessions, their ancestors, and shell/task waiters. */
export const getOpenTurnSessionIds = (
  activeSessionIds: ReadonlySet<string> = useGlobalSessionStatusStore.getState().activeSessionIds,
  shellSessionIds: ReadonlySet<string> = useBackgroundShellsStore.getState().sessionIds,
  tasksBySession: ReadonlyMap<string, unknown> = useSessionBackgroundTasksStore.getState().tasksBySession,
): ReadonlySet<string> => withOpenTurns(activeSessionIds, shellSessionIds, tasksBySession);

/**
 * What keeps the session's turn open, or null when nothing does: the session
 * runs itself, or it idles while a subagent below it runs, while a command it
 * started in the background runs, or while tasks a native CLI keeps running
 * will wake it. The session's own run wins; a pause with both kinds of
 * background work reports the subagent.
 */
export type SessionTurnActivity = 'running' | 'workflow' | 'subagent' | 'shell' | 'tasks' | 'image' | 'pullRequest' | 'extensionWait';

export const resolveSessionTurnActivity = (
  status: 'running' | 'subagent' | null,
  workflowRunning: boolean,
  waitingOnShell: boolean,
  waitingOnPullRequest = false,
  waitingOnImage = false,
  waitingOnExtension = false,
): SessionTurnActivity | null => {
  if (status === 'running') return status;
  if (workflowRunning) return 'workflow';
  if (status) return status;
  if (waitingOnShell) return 'shell';
  if (waitingOnImage) return 'image';
  if (waitingOnPullRequest) return 'pullRequest';
  return waitingOnExtension ? 'extensionWait' : null;
};
