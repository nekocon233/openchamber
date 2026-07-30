import { create } from 'zustand';
import type { Event, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  observeSessionActivityEvent,
  reconcileSessionActivitySnapshot,
  removeSessionOrdering,
} from './session-ordering';

// Shared live status index for every directory. Events update it incrementally
// and directory snapshots reconcile it without requiring each row to scan all
// child stores. Recent idle resolutions are retained as bounded tombstones so
// delayed child-store publications cannot revive stale activity.

type ActiveStatusType = 'busy' | 'retry';
type ResolvedStatusType = ActiveStatusType | 'idle';

const OPTIMISTIC_STATUS_GRACE_MS = 10_000;
const MAX_STATUS_HISTORY_ENTRIES = 2_000;

type GlobalSessionStatusEntry = {
  status: SessionStatus;
  directory: string;
  optimisticUntil?: number;
};

type GlobalSessionStatusState = {
  statusById: Map<string, GlobalSessionStatusEntry>;
  resolvedStatusById: Map<string, ResolvedStatusType>;
  statusSnapshotAtByDirectory: Map<string, number>;
  revision: number;
  revisionById: Map<string, number>;
  revisionFloor: number;
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => ({
  statusById: new Map(),
  resolvedStatusById: new Map(),
  statusSnapshotAtByDirectory: new Map(),
  revision: 0,
  revisionById: new Map(),
  revisionFloor: 0,
}));

export const resetGlobalSessionStatuses = (): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const revision = state.revision + 1;
    return {
      statusById: new Map(),
      resolvedStatusById: new Map(),
      statusSnapshotAtByDirectory: new Map(),
      revision,
      revisionById: new Map(),
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

const normalizeStatusType = (type: unknown): ResolvedStatusType => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

const statusesEqual = (left: SessionStatus, right: SessionStatus): boolean => (
  left.type === right.type && JSON.stringify(left) === JSON.stringify(right)
);

export const resolveSessionStatusType = (
  globalStatus: ResolvedStatusType | undefined,
  childStatus: ResolvedStatusType | undefined,
): ResolvedStatusType => globalStatus ?? childStatus ?? 'idle';

const normalizeDirectory = (directory: string): string => (
  normalizeProjectPath(directory) ?? directory
);

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

    return { statusById, resolvedStatusById, revision, revisionById, revisionFloor };
  });
};

const removeStatus = (sessionId: string): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const revision = state.revision + 1;
    const statusById = new Map(state.statusById);
    let resolvedStatusById = new Map(state.resolvedStatusById);
    const revisionById = new Map(state.revisionById);
    statusById.delete(sessionId);
    resolvedStatusById.delete(sessionId);
    revisionById.delete(sessionId);
    revisionById.set(sessionId, revision);
    const trimmed = trimStatusHistory(
      revisionById,
      statusById,
      resolvedStatusById,
      state.revisionFloor,
    );
    resolvedStatusById = trimmed.resolvedStatusById;
    return {
      statusById,
      resolvedStatusById,
      revision,
      revisionById,
      revisionFloor: trimmed.revisionFloor,
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

export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  switch (payload.type) {
    case 'session.status': {
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) return;
      const type = normalizeStatusType(props.status?.type);
      setStatus(
        props.sessionID,
        normalizeDirectory(directory),
        type === 'idle' ? { type: 'idle' } : { ...(props.status ?? {}), type } as SessionStatus,
      );
      observeSessionActivityEvent(props.sessionID, type === 'idle' ? 'settled' : 'active');
      return;
    }
    case 'session.idle':
    case 'session.error': {
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setStatus(props.sessionID, normalizeDirectory(directory), { type: 'idle' });
        observeSessionActivityEvent(props.sessionID, 'settled');
      }
      return;
    }
    case 'session.updated': {
      const props = payload.properties as {
        sessionID?: string;
        info?: { id?: string; time?: { archived?: number | null } };
      } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (sessionId && props?.info?.time?.archived) {
        removeStatus(sessionId);
        removeSessionOrdering(sessionId);
      }
      return;
    }
    case 'session.deleted': {
      const props = payload.properties as { sessionID?: string; info?: { id?: string } } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (sessionId) {
        removeStatus(sessionId);
        removeSessionOrdering(sessionId);
      }
      return;
    }
    default:
      return;
  }
};

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
    const next = new Map(state.statusById);
    const touchedIds = new Set<string>();
    let resolvedStatusById = state.resolvedStatusById;
    const now = Date.now();
    const statusSnapshotAtByDirectory = mode === 'authoritative'
      ? new Map(state.statusSnapshotAtByDirectory).set(directory, now)
      : state.statusSnapshotAtByDirectory;

    const setResolvedStatus = (sessionId: string, status: ResolvedStatusType) => {
      if (resolvedStatusById.get(sessionId) === status) return;
      if (resolvedStatusById === state.resolvedStatusById) {
        resolvedStatusById = new Map(resolvedStatusById);
      }
      resolvedStatusById.set(sessionId, status);
    };
    const canApply = (sessionId: string): boolean => (
      (state.revisionById.get(sessionId) ?? state.revisionFloor) <= baselineRevision
    );
    const isOptimisticallyProtected = (sessionId: string): boolean => (
      (next.get(sessionId)?.optimisticUntil ?? 0) > now
    );
    const markOrdering = (sessionId: string, type: ResolvedStatusType) => {
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
      touchedIds.add(sessionId);
      setResolvedStatus(sessionId, type);
      markOrdering(sessionId, type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
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
      return statusSnapshotAtByDirectory === state.statusSnapshotAtByDirectory
        ? state
        : { statusSnapshotAtByDirectory };
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
      statusById,
      resolvedStatusById,
      statusSnapshotAtByDirectory,
      revision,
      revisionById,
      revisionFloor,
    };
  });

  const orderingScope = mode === 'authoritative' ? orderingKnown : orderingActive;
  reconcileSessionActivitySnapshot(orderingActive, orderingScope);
};
