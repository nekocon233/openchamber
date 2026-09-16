import { create } from 'zustand';
import type { Event, Session, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  applySessionOrderingMutations,
  reconcileSessionActivitySnapshot,
  type SessionOrderingMutation,
} from './session-ordering';
import {
  applySessionActivityTimingMutations,
  reconcileSessionActivityTiming,
  type SessionActivityTimingMutation,
} from './session-activity-timing';
import { countSyncPerformance } from './performance-diagnostics';

// Shared live busy/retry index for every directory. Events update it
// incrementally and authoritative directory snapshots reconcile it, so each
// sidebar row can subscribe to one leaf instead of every child store.
//
// Only non-idle entries are kept; absence alone does not prove idle. Entries
// carry their directory so a polled per-directory snapshot can authoritatively
// replace that directory's slice (the server omits idle sessions from
// snapshots). Recent idle resolutions are retained as bounded tombstones so
// delayed child-store publications cannot revive stale activity.

type ActiveStatusType = 'busy' | 'retry';
type ResolvedStatusType = ActiveStatusType | 'idle';

const OPTIMISTIC_STATUS_GRACE_MS = 10_000;
const MAX_STATUS_HISTORY_ENTRIES = 2_000;
const MAX_OBSERVED_ENTRIES = 2_000;

type GlobalSessionStatusEntry = {
  status: SessionStatus;
  directory: string;
  optimisticUntil?: number;
};

type ObservedOutcome = { directory: string; outcome: 'completed' | 'failed' | null };

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

const EMPTY_ACTIVE_SESSION_IDS: ReadonlySet<string> = new Set();

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
useGlobalSessionStatusStore.subscribe(() => countSyncPerformance('globalStatusPublications'));

const normalizeStatusType = (type: unknown): ResolvedStatusType => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

const statusesEqual = (left: SessionStatus, right: SessionStatus): boolean => (
  left.type === right.type && JSON.stringify(left) === JSON.stringify(right)
);

// Both write paths normalize the directory key, so a polled snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string => (
  normalizeProjectPath(directory) ?? directory
);

const deriveActiveSessionIds = (
  statusById: ReadonlyMap<string, GlobalSessionStatusEntry>,
  current: ReadonlySet<string>,
): ReadonlySet<string> => {
  const next = new Set(statusById.keys());
  return next.size === current.size && [...next].every((sessionId) => current.has(sessionId))
    ? current
    : next;
};

export const resetGlobalSessionStatuses = (): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const revision = state.revision + 1;
    return {
      observedById: new Map(),
      statusById: new Map(),
      activeSessionIds: EMPTY_ACTIVE_SESSION_IDS,
      resolvedStatusById: new Map(),
      statusSnapshotAtByDirectory: new Map(),
      revision,
      revisionById: new Map(),
      revisionFloor: revision,
    };
  });
};

/**
 * Replaces the status map wholesale and derives active membership from it.
 * This is the ONE sanctioned way to swap statusById from outside the event
 * reducers (runtime switch, tests) — previously a setState monkeypatch
 * derived membership for arbitrary callers, which silently trusted any
 * caller passing both fields to keep them consistent.
 */
export const replaceGlobalSessionStatusById = (statusById: Map<string, GlobalSessionStatusEntry>): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const revision = state.revision + 1;
    const resolvedStatusById = new Map<string, ResolvedStatusType>();
    const revisionById = new Map<string, number>();
    for (const [sessionId, entry] of statusById) {
      resolvedStatusById.set(sessionId, normalizeStatusType(entry.status.type));
      revisionById.set(sessionId, revision);
    }
    return {
      observedById: new Map(),
      statusById,
      activeSessionIds: deriveActiveSessionIds(statusById, state.activeSessionIds),
      resolvedStatusById,
      statusSnapshotAtByDirectory: new Map(),
      revision,
      revisionById,
      revisionFloor: revision,
    };
  });
};

export const getGlobalSessionStatusRevision = (): number => (
  useGlobalSessionStatusStore.getState().revision
);

export const isGlobalSessionStatusOptimisticallyProtected = (sessionId: string): boolean => (
  (useGlobalSessionStatusStore.getState().statusById.get(sessionId)?.optimisticUntil ?? 0) > Date.now()
);

export const hasGlobalSessionStatusChangedSince = (sessionId: string, baselineRevision: number): boolean => {
  const state = useGlobalSessionStatusStore.getState();
  return (state.revisionById.get(sessionId) ?? state.revisionFloor) > baselineRevision;
};

export const resolveSessionStatusType = (
  globalStatus: ResolvedStatusType | undefined,
  childStatus: ResolvedStatusType | undefined,
): ResolvedStatusType => globalStatus ?? childStatus ?? 'idle';

export const getDirectoryOwnedSessionIds = (directory: string, sessions: readonly Session[]): string[] => {
  const scope = normalizeProjectPath(directory);
  if (!scope) return [];
  const ids: string[] = [];
  for (const session of sessions) {
    if (normalizeProjectPath(session.directory) === scope) ids.push(session.id);
  }
  return ids;
};

const trimStatusHistory = (
  revisionById: Map<string, number>,
  activeStatusById: Map<string, GlobalSessionStatusEntry>,
  initialResolvedStatusById: Map<string, ResolvedStatusType>,
  initialRevisionFloor: number,
): {
  resolvedStatusById: Map<string, ResolvedStatusType>;
  revisionFloor: number;
} => {
  let revisionFloor = initialRevisionFloor;
  let resolvedStatusById = initialResolvedStatusById;
  let terminalEntryCount = revisionById.size - activeStatusById.size;
  if (terminalEntryCount <= MAX_STATUS_HISTORY_ENTRIES) {
    return { resolvedStatusById, revisionFloor };
  }

  for (const [sessionId, revision] of revisionById) {
    if (terminalEntryCount <= MAX_STATUS_HISTORY_ENTRIES) break;
    if (activeStatusById.has(sessionId)) continue;
    revisionById.delete(sessionId);
    terminalEntryCount -= 1;
    revisionFloor = Math.max(revisionFloor, revision);
    if (resolvedStatusById.has(sessionId)) {
      if (resolvedStatusById === initialResolvedStatusById) {
        resolvedStatusById = new Map(resolvedStatusById);
      }
      resolvedStatusById.delete(sessionId);
    }
  }

  return { resolvedStatusById, revisionFloor };
};

const setStatus = (
  sessionId: string,
  directory: string,
  status: SessionStatus | { type: 'idle' },
  options?: { optimistic?: boolean },
): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const type = normalizeStatusType(status.type);
    const revision = state.revision + 1;
    const revisionById = new Map(state.revisionById);
    revisionById.delete(sessionId);
    revisionById.set(sessionId, revision);

    let resolvedStatusById = state.resolvedStatusById;
    if (resolvedStatusById.get(sessionId) !== type) {
      resolvedStatusById = new Map(resolvedStatusById);
      resolvedStatusById.set(sessionId, type);
    }

    let statusById = state.statusById;
    const current = state.statusById.get(sessionId);
    if (type === 'idle') {
      if (current) {
        statusById = new Map(statusById);
        statusById.delete(sessionId);
      }
    } else {
      const normalizedStatus = { ...status, type } as SessionStatus;
      const optimisticUntil = options?.optimistic
        ? Date.now() + OPTIMISTIC_STATUS_GRACE_MS
        : undefined;
      if (
        !current
        || current.directory !== directory
        || !statusesEqual(current.status, normalizedStatus)
        || current.optimisticUntil !== optimisticUntil
      ) {
        statusById = new Map(statusById);
        statusById.set(sessionId, { status: normalizedStatus, directory, optimisticUntil });
      }
    }

    let revisionFloor = state.revisionFloor;
    if (revisionById.size > MAX_STATUS_HISTORY_ENTRIES) {
      const trimmed = trimStatusHistory(revisionById, statusById, resolvedStatusById, revisionFloor);
      resolvedStatusById = trimmed.resolvedStatusById;
      revisionFloor = trimmed.revisionFloor;
    }

    return {
      statusById,
      activeSessionIds: statusById === state.statusById
        ? state.activeSessionIds
        : deriveActiveSessionIds(statusById, state.activeSessionIds),
      resolvedStatusById,
      revision,
      revisionById,
      revisionFloor,
    };
  });
};

export const setGlobalSessionStatus = (
  sessionId: string,
  directory: string | null | undefined,
  status: ResolvedStatusType,
  options?: { optimistic?: boolean },
): void => {
  if (!sessionId) return;
  setStatus(
    sessionId,
    normalizeDirectory(directory ?? ''),
    status === 'idle' ? { type: 'idle' } : { type: status } as SessionStatus,
    options,
  );
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvents = (directory: string, payloads: readonly Event[]): void => {
  if (payloads.length === 0) return;
  const normalizedDirectory = normalizeDirectory(directory);
  const orderingMutations: SessionOrderingMutation[] = [];
  const timingMutations: SessionActivityTimingMutation[] = [];

  useGlobalSessionStatusStore.setState((state) => {
    let statusById = state.statusById;
    let activeSessionIds = state.activeSessionIds;
    let resolvedStatusById = state.resolvedStatusById;
    let observedById: Map<string, ObservedOutcome> | null = null;
    const touchedIds = new Set<string>();
    const readObserved = (): ReadonlyMap<string, ObservedOutcome> => observedById ?? state.observedById;
    const draftObserved = (): Map<string, ObservedOutcome> => (observedById ??= new Map(state.observedById));

    const observe = (id: string, outcome: 'completed' | 'failed' | null): void => {
      const previous = readObserved().get(id);
      // OpenCode may publish idle after an error for the same failed turn.
      const nextOutcome = outcome === 'completed' && previous?.outcome === 'failed' ? 'failed' : outcome;
      if (previous?.directory === normalizedDirectory && previous.outcome === nextOutcome) return;
      const draft = draftObserved();
      draft.delete(id);
      draft.set(id, { directory: normalizedDirectory, outcome: nextOutcome });
      if (draft.size > MAX_OBSERVED_ENTRIES) {
        const oldest = draft.keys().next().value;
        if (oldest) draft.delete(oldest);
      }
    };
    const forgetObservation = (sessionId: string): void => {
      if (!readObserved().has(sessionId)) return;
      draftObserved().delete(sessionId);
    };
    const removeActiveStatus = (sessionId: string): void => {
      if (statusById.has(sessionId)) {
        if (statusById === state.statusById) statusById = new Map(statusById);
        statusById.delete(sessionId);
      }
      if (activeSessionIds.has(sessionId)) {
        if (activeSessionIds === state.activeSessionIds) activeSessionIds = new Set(activeSessionIds);
        (activeSessionIds as Set<string>).delete(sessionId);
      }
    };
    const setResolvedStatus = (sessionId: string, type: ResolvedStatusType): void => {
      if (resolvedStatusById.get(sessionId) === type) return;
      if (resolvedStatusById === state.resolvedStatusById) resolvedStatusById = new Map(resolvedStatusById);
      resolvedStatusById.set(sessionId, type);
    };
    const settle = (sessionId: string): void => {
      touchedIds.add(sessionId);
      removeActiveStatus(sessionId);
      setResolvedStatus(sessionId, 'idle');
      orderingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
      timingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
    };
    const remove = (sessionId: string): void => {
      touchedIds.add(sessionId);
      removeActiveStatus(sessionId);
      forgetObservation(sessionId);
      if (resolvedStatusById.has(sessionId)) {
        if (resolvedStatusById === state.resolvedStatusById) resolvedStatusById = new Map(resolvedStatusById);
        resolvedStatusById.delete(sessionId);
      }
      orderingMutations.push({ type: 'remove', sessionId });
      timingMutations.push({ type: 'remove', sessionId });
    };

    for (const payload of payloads) {
      if (payload.type === 'session.status') {
        const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
        if (typeof props?.sessionID !== 'string' || !props.sessionID) continue;
        const type = normalizeStatusType(props.status?.type);
        observe(props.sessionID, type === 'idle' ? readObserved().get(props.sessionID)?.outcome ?? null : null);
        if (type === 'idle') {
          settle(props.sessionID);
          continue;
        }
        touchedIds.add(props.sessionID);
        setResolvedStatus(props.sessionID, type);
        const status = { ...(props.status ?? {}), type } as SessionStatus;
        const current = statusById.get(props.sessionID);
        if (
          !current
          || current.directory !== normalizedDirectory
          || !statusesEqual(current.status, status)
          || current.optimisticUntil !== undefined
        ) {
          if (statusById === state.statusById) statusById = new Map(statusById);
          statusById.set(props.sessionID, { status, directory: normalizedDirectory });
        }
        if (!activeSessionIds.has(props.sessionID)) {
          if (activeSessionIds === state.activeSessionIds) activeSessionIds = new Set(activeSessionIds);
          (activeSessionIds as Set<string>).add(props.sessionID);
        }
        orderingMutations.push({ type: 'observe', sessionId: props.sessionID, phase: 'active' });
        timingMutations.push({ type: 'observe', sessionId: props.sessionID, phase: 'active' });
        continue;
      }

      if (payload.type === 'session.idle' || payload.type === 'session.error') {
        const props = payload.properties as { sessionID?: string } | undefined;
        if (typeof props?.sessionID === 'string' && props.sessionID) {
          observe(props.sessionID, payload.type === 'session.error' ? 'failed' : 'completed');
          settle(props.sessionID);
        }
        continue;
      }

      if (payload.type === 'session.updated') {
        const props = payload.properties as {
          sessionID?: string;
          info?: { id?: string; time?: { archived?: number | null } };
        } | undefined;
        const sessionId = props?.sessionID ?? props?.info?.id;
        if (sessionId && props?.info?.time?.archived) remove(sessionId);
        continue;
      }

      if (payload.type === 'session.deleted') {
        const props = payload.properties as { sessionID?: string; info?: { id?: string } } | undefined;
        const sessionId = props?.sessionID ?? props?.info?.id;
        if (sessionId) remove(sessionId);
      }
    }

    if (touchedIds.size === 0 && observedById === null) return state;
    const revision = state.revision + 1;
    const revisionById = new Map(state.revisionById);
    for (const sessionId of touchedIds) {
      revisionById.delete(sessionId);
      revisionById.set(sessionId, revision);
    }
    let revisionFloor = state.revisionFloor;
    if (revisionById.size > MAX_STATUS_HISTORY_ENTRIES) {
      const trimmed = trimStatusHistory(revisionById, statusById, resolvedStatusById, revisionFloor);
      resolvedStatusById = trimmed.resolvedStatusById;
      revisionFloor = trimmed.revisionFloor;
    }
    return {
      observedById: observedById ?? state.observedById,
      statusById,
      activeSessionIds,
      resolvedStatusById,
      revision,
      revisionById,
      revisionFloor,
    };
  });

  applySessionOrderingMutations(orderingMutations);
  applySessionActivityTimingMutations(timingMutations);
};

export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  applyGlobalSessionStatusEvents(directory, [payload]);
};

// Polled path: an authoritative `/session/status?directory=X` snapshot. Entries
// missing from the snapshot are idle now — cleared both by directory key and by
// the caller's session-id list (the server may report a canonicalized directory
// that differs from the key an event wrote, e.g. via symlinks). Seeds the
// initial state (events only deliver changes) and reconciles missed events.
// `baselineRevision` rejects entries changed after the request started, and
// 'monotonic' mode never lowers an active status (periodic poll), while
// 'authoritative' mode treats omissions as idle (reconnect / escalated resync).
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
  baselineRevision = Number.POSITIVE_INFINITY,
  mode: 'monotonic' | 'authoritative' = 'authoritative',
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  const orderingActive = new Set<string>();
  const orderingKnown = new Set<string>();

  useGlobalSessionStatusStore.setState((state) => {
    let statusChanged = false;
    let observedById: Map<string, ObservedOutcome> | null = null;
    const draftObserved = (): Map<string, ObservedOutcome> => (observedById ??= new Map(state.observedById));
    const next = new Map(state.statusById);
    const touchedIds = new Set<string>();
    let resolvedStatusById = state.resolvedStatusById;
    let activeSessionIds = state.activeSessionIds;
    const now = Date.now();
    const statusSnapshotAtByDirectory = mode === 'authoritative'
      ? new Map(state.statusSnapshotAtByDirectory).set(directory, now)
      : state.statusSnapshotAtByDirectory;

    const setResolvedStatus = (sessionId: string, status: ResolvedStatusType): void => {
      if (resolvedStatusById.get(sessionId) === status) return;
      if (resolvedStatusById === state.resolvedStatusById) resolvedStatusById = new Map(resolvedStatusById);
      resolvedStatusById.set(sessionId, status);
    };
    const canApply = (sessionId: string): boolean => (
      (state.revisionById.get(sessionId) ?? state.revisionFloor) <= baselineRevision
    );
    const isOptimisticallyProtected = (sessionId: string): boolean => (
      (next.get(sessionId)?.optimisticUntil ?? 0) > now
    );
    const removeActiveSession = (sessionId: string): void => {
      if (!activeSessionIds.has(sessionId)) return;
      if (activeSessionIds === state.activeSessionIds) activeSessionIds = new Set(activeSessionIds);
      (activeSessionIds as Set<string>).delete(sessionId);
    };
    const addActiveSession = (sessionId: string): void => {
      if (activeSessionIds.has(sessionId)) return;
      if (activeSessionIds === state.activeSessionIds) activeSessionIds = new Set(activeSessionIds);
      (activeSessionIds as Set<string>).add(sessionId);
    };
    const markOrdering = (sessionId: string, type: ResolvedStatusType): void => {
      orderingKnown.add(sessionId);
      if (type !== 'idle') orderingActive.add(sessionId);
    };

    if (mode === 'authoritative') {
      for (const [sessionId, entry] of state.statusById) {
        if (
          (entry.directory === directory || known.has(sessionId))
          && !(sessionId in raw)
          && canApply(sessionId)
          && !isOptimisticallyProtected(sessionId)
        ) {
          next.delete(sessionId);
          removeActiveSession(sessionId);
          statusChanged = true;
          touchedIds.add(sessionId);
          setResolvedStatus(sessionId, 'idle');
          markOrdering(sessionId, 'idle');
        }
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      if (!canApply(sessionId)) continue;
      const type = normalizeStatusType(status?.type);
      if (mode === 'monotonic' && type === 'idle') continue;
      if (type === 'idle' && isOptimisticallyProtected(sessionId)) continue;
      const observed = (observedById ?? state.observedById).get(sessionId);
      if (type !== 'idle' && observed?.outcome) {
        draftObserved().set(sessionId, { directory, outcome: null });
      }
      touchedIds.add(sessionId);
      setResolvedStatus(sessionId, type);
      markOrdering(sessionId, type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          removeActiveSession(sessionId);
          statusChanged = true;
        }
        continue;
      }

      const normalizedStatus = { ...status, type } as SessionStatus;
      if (
        !current
        || current.directory !== directory
        || !statusesEqual(current.status, normalizedStatus)
        || current.optimisticUntil !== undefined
      ) {
        next.set(sessionId, { status: normalizedStatus, directory });
        statusChanged = true;
      }
      addActiveSession(sessionId);
    }

    if (mode === 'authoritative') {
      for (const sessionId of known) {
        if (!canApply(sessionId) || isOptimisticallyProtected(sessionId)) continue;
        touchedIds.add(sessionId);
        const type = normalizeStatusType(raw[sessionId]?.type);
        if (!(sessionId in raw)) setResolvedStatus(sessionId, 'idle');
        markOrdering(sessionId, type);
      }
    }
    if (touchedIds.size === 0) {
      const observedChanged = observedById !== null;
      const snapshotAtChanged = statusSnapshotAtByDirectory !== state.statusSnapshotAtByDirectory;
      if (!observedChanged && !snapshotAtChanged) return state;
      return {
        ...(observedChanged ? { observedById: observedById ?? state.observedById } : {}),
        ...(snapshotAtChanged ? { statusSnapshotAtByDirectory } : {}),
      };
    }

    const revision = state.revision + 1;
    const revisionById = new Map(state.revisionById);
    for (const sessionId of touchedIds) {
      revisionById.delete(sessionId);
      revisionById.set(sessionId, revision);
    }
    const statusById = statusChanged ? next : state.statusById;
    let revisionFloor = state.revisionFloor;
    if (revisionById.size > MAX_STATUS_HISTORY_ENTRIES) {
      const trimmed = trimStatusHistory(revisionById, statusById, resolvedStatusById, revisionFloor);
      resolvedStatusById = trimmed.resolvedStatusById;
      revisionFloor = trimmed.revisionFloor;
    }
    return {
      observedById: observedById ?? state.observedById,
      statusById,
      activeSessionIds,
      resolvedStatusById,
      statusSnapshotAtByDirectory,
      revision,
      revisionById,
      revisionFloor,
    };
  });

  const orderingScope = mode === 'authoritative' ? orderingKnown : orderingActive;
  reconcileSessionActivitySnapshot(orderingActive, orderingScope);
  reconcileSessionActivityTiming(
    orderingActive,
    (sessionId) => mode === 'authoritative' && orderingKnown.has(sessionId),
  );
};
