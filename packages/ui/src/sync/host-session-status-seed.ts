import { hostTurnStart, type SessionTurnStart, type SyncEvent } from '@/lib/opencode/events';
import { opencodeClient } from '@/lib/opencode/client';
import type { HostSessionStatusSnapshot } from '@/lib/opencode/session-status';
import { getRuntimeEndpointGeneration, getRuntimeKey } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyGlobalSessionStatusEvents, hasBackgroundWork, useGlobalSessionStatusStore } from './global-session-status';
import { readHostBlockingRequestsSnapshot } from './global-blocking-requests';
import { applyHostTurnStarts, getSessionTimingRevision, hasSessionTimingChangedSince, needsHostTurnStarts } from './session-activity-timing';
import { seedSessionContextFromHost, sessionContextRevision } from './session-live-work';


export const HOST_STATUS_SEED_MAX_AGE_MS = 30 * 60_000;

type SeedDependencies = {
  isKnown: (sessionId: string) => boolean;
  resolveDirectory: (sessionId: string) => string | null;
};

export const buildHostStatusSeedEvents = (
  snapshot: HostSessionStatusSnapshot,
  deps: SeedDependencies,
  maxAgeMs = HOST_STATUS_SEED_MAX_AGE_MS,
): Map<string, SyncEvent[]> => {
  const eventsByDirectory = new Map<string, SyncEvent[]>();
  for (const [sessionId, entry] of Object.entries(snapshot.sessions)) {
    if (entry.status !== 'busy' && entry.status !== 'retry') continue;
    if (snapshot.serverTime - entry.lastUpdateAt > maxAgeMs) continue;
    if (deps.isKnown(sessionId)) continue;
    const directory = deps.resolveDirectory(sessionId);
    if (!directory) continue;
    const events = eventsByDirectory.get(directory) ?? [];
    events.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    eventsByDirectory.set(directory, events);
  }
  return eventsByDirectory;
};

export const buildHostTurnStarts = (
  snapshot: HostSessionStatusSnapshot,
  isHeldHere: (sessionId: string) => boolean,
): Map<string, SessionTurnStart> => {
  const starts = new Map<string, SessionTurnStart>();
  for (const [sessionId, entry] of Object.entries(snapshot.sessions)) {
    if (entry.turnStartedAt === undefined) continue;
    const running = entry.status === 'busy' || entry.status === 'retry';
    if (!running && !isHeldHere(sessionId)) continue;
    starts.set(sessionId, hostTurnStart(entry.turnStartedAt, snapshot.serverTime));
  }
  return starts;
};

const isHeldHere = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => (
  !activeSessionIds.has(sessionId) && hasBackgroundWork(sessionId, activeSessionIds)
);

let inFlight: { runtimeKey: string; generation: number; promise: Promise<void> } | null = null;

export const seedGlobalSessionStatusFromHost = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const generation = getRuntimeEndpointGeneration();
  if (inFlight?.runtimeKey === runtimeKey && inFlight.generation === generation) return inFlight.promise;
  const isCurrent = () => getRuntimeKey() === runtimeKey && getRuntimeEndpointGeneration() === generation;
  const baselineRevision = getSessionTimingRevision();
  const requestedAt = Date.now();
  const contextSince = sessionContextRevision();
  const operation = (async () => {
    const snapshot = await readHostBlockingRequestsSnapshot(async () => {
      const response = await opencodeClient.getHostSessionStatusSnapshot();
      return isCurrent() ? response : null;
    }, (sessionId) => {
      const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
      return session ? resolveGlobalSessionDirectory(session) : null;
    });
    if (!snapshot || !isCurrent()) return;
    const answeredAt = Date.now();
    const status = useGlobalSessionStatusStore.getState();
    const entities = useGlobalSessionsStore.getState().entityById;
    const changed = new Set(Object.keys(snapshot.sessions).filter((sessionId) => hasSessionTimingChangedSince(sessionId, baselineRevision)));
    const events = buildHostStatusSeedEvents(snapshot, {
      isKnown: (sessionId) => status.statusById.has(sessionId) || status.observedById.has(sessionId),
      resolveDirectory: (sessionId) => {
        const session = entities.get(sessionId);
        return session ? resolveGlobalSessionDirectory(session) : null;
      },
    });
    for (const [directory, payloads] of events) {
      applyGlobalSessionStatusEvents(directory, payloads);
    }
    const { activeSessionIds } = useGlobalSessionStatusStore.getState();
    const held = new Set(Object.keys(snapshot.sessions).filter((sessionId) => isHeldHere(sessionId, activeSessionIds)));
    const starts = buildHostTurnStarts(snapshot, (sessionId) => held.has(sessionId));
    for (const sessionId of changed) starts.delete(sessionId);
    applyHostTurnStarts(starts, held, { requestedAt, answeredAt });
    if (snapshot.context) seedSessionContextFromHost(new Map(Object.entries(snapshot.context)), contextSince);
  })().finally(() => {
    if (inFlight?.promise === operation) inFlight = null;
  });
  inFlight = { runtimeKey, generation, promise: operation };
  return operation;
};

const TURN_START_REQUEST_DELAY_MS = 300;
let turnStartRequest: ReturnType<typeof setTimeout> | null = null;

export const requestHostTurnStarts = (): void => {
  if (turnStartRequest !== null) return;
  turnStartRequest = setTimeout(() => {
    turnStartRequest = null;
    if (needsHostTurnStarts()) void seedGlobalSessionStatusFromHost();
  }, TURN_START_REQUEST_DELAY_MS);
};
