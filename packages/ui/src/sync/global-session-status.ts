import { create } from 'zustand';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';

// Live busy/retry status for sessions across all directories. The global event
// stream (`/api/global/event/ws`) carries status events for every directory;
// this store preserves those events independently of child-store lifecycle so
// cross-project consumers can reconcile status consistently.
//
// `statusById` keeps only non-idle entries. `resolvedStatusById` also retains a
// bounded history of explicit idle tombstones so recent idle events override a
// stale child store without accumulating every session ever observed. Active
// entries carry their directory so a polled snapshot can reconcile a slice.

type ActiveStatusType = 'busy' | 'retry';

const OPTIMISTIC_STATUS_GRACE_MS = 10_000;
const MAX_STATUS_HISTORY_ENTRIES = 2_000;

type GlobalSessionStatusEntry = {
  status: ActiveStatusType;
  directory: string;
  optimisticUntil?: number;
};

type GlobalSessionStatusState = {
  statusById: Map<string, GlobalSessionStatusEntry>;
  resolvedStatusById: Map<string, ActiveStatusType | 'idle'>;
  revision: number;
  revisionById: Map<string, number>;
  revisionFloor: number;
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => ({
  statusById: new Map(),
  resolvedStatusById: new Map(),
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

const normalizeStatusType = (type: unknown): ActiveStatusType | 'idle' =>
  type === 'busy' ? 'busy' : type === 'retry' ? 'retry' : 'idle';

export const resolveSessionStatusType = (
  globalStatus: ActiveStatusType | 'idle' | undefined,
  childStatus: ActiveStatusType | 'idle' | undefined,
): ActiveStatusType | 'idle' => globalStatus ?? childStatus ?? 'idle';

// Both write paths normalize the directory key, so a polled snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string =>
  normalizeProjectPath(directory) ?? directory;

const trimStatusHistory = (
  revisionById: Map<string, number>,
  activeStatusById: Map<string, GlobalSessionStatusEntry>,
  initialResolvedStatusById: Map<string, ActiveStatusType | 'idle'>,
  initialRevisionFloor: number,
): {
  resolvedStatusById: Map<string, ActiveStatusType | 'idle'>;
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
  status: ActiveStatusType | 'idle',
  options?: { optimistic?: boolean },
): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const revision = state.revision + 1;
    const revisionById = new Map(state.revisionById);
    revisionById.delete(sessionId);
    revisionById.set(sessionId, revision);
    let resolvedStatusById = state.resolvedStatusById;
    if (resolvedStatusById.get(sessionId) !== status) {
      resolvedStatusById = new Map(resolvedStatusById);
      resolvedStatusById.set(sessionId, status);
    }

    let statusById = state.statusById;
    const current = state.statusById.get(sessionId);
    if (status === 'idle') {
      if (current) {
        statusById = new Map(state.statusById);
        statusById.delete(sessionId);
      }
    } else {
      const optimisticUntil = options?.optimistic ? Date.now() + OPTIMISTIC_STATUS_GRACE_MS : undefined;
      if (
        !current
        || current.status !== status
        || current.directory !== directory
        || current.optimisticUntil !== optimisticUntil
      ) {
        statusById = new Map(state.statusById);
        statusById.set(sessionId, { status, directory, optimisticUntil });
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
    const trimmed = trimStatusHistory(revisionById, statusById, resolvedStatusById, state.revisionFloor);
    resolvedStatusById = trimmed.resolvedStatusById;
    const revisionFloor = trimmed.revisionFloor;
    return { statusById, resolvedStatusById, revision, revisionById, revisionFloor };
  });
};

export const setGlobalSessionStatus = (
  sessionId: string,
  directory: string | null | undefined,
  status: ActiveStatusType | 'idle',
  options?: { optimistic?: boolean },
): void => {
  if (!sessionId) return;
  setStatus(sessionId, normalizeDirectory(directory ?? ''), status, options);
};

// Event-driven path: called by the sync dispatcher for all status-bearing
// events. Mirrors the child reducer's semantics (`session.idle` /
// `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  switch (payload.type) {
    case 'session.status': {
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) return;
      setGlobalSessionStatus(props.sessionID, directory, normalizeStatusType(props.status?.type));
      return;
    }
    case 'session.idle':
    case 'session.error': {
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setGlobalSessionStatus(props.sessionID, directory, 'idle');
      }
      return;
    }
    case 'session.updated': {
      const props = payload.properties as { sessionID?: string; info?: { id?: string; time?: { archived?: number | null } } };
      const sessionId = props.sessionID ?? props.info?.id;
      if (sessionId && props.info?.time?.archived) removeStatus(sessionId);
      return;
    }
    case 'session.deleted': {
      const props = payload.properties as { sessionID?: string; info?: { id?: string } };
      const sessionId = props.sessionID ?? props.info?.id;
      if (sessionId) removeStatus(sessionId);
      return;
    }
    default:
      return;
  }
};

// Polled path for `/session/status?directory=X`. Authoritative snapshots clear
// missing entries by directory/session ID; monotonic snapshots only promote
// active entries. Revision baselines keep either mode from replacing newer
// event or optimistic state.
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
  baselineRevision = Number.POSITIVE_INFINITY,
  mode: 'monotonic' | 'authoritative' = 'authoritative',
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  useGlobalSessionStatusStore.setState((state) => {
    let statusChanged = false;
    const next = new Map(state.statusById);
    const touchedIds = new Set<string>();
    let resolvedStatusById = state.resolvedStatusById;
    const now = Date.now();

    const setResolvedStatus = (sessionId: string, status: ActiveStatusType | 'idle') => {
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
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          statusChanged = true;
        }
        continue;
      }
      if (
        !current
        || current.status !== type
        || current.directory !== directory
        || current.optimisticUntil !== undefined
      ) {
        next.set(sessionId, { status: type, directory });
        statusChanged = true;
      }
    }

    if (mode === 'authoritative') {
      for (const sessionId of known) {
        if (canApply(sessionId) && !isOptimisticallyProtected(sessionId)) {
          touchedIds.add(sessionId);
          if (!(sessionId in raw)) setResolvedStatus(sessionId, 'idle');
        }
      }
    }
    if (touchedIds.size === 0) return state;

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
      revision,
      revisionById,
      revisionFloor,
    };
  });
};
