import { useCallback } from 'react';
import { create } from 'zustand';
import { isConversationRole, type Message } from '@/lib/opencode/model';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import type { ChildStoreManager } from './child-store';
import { countSyncPerformance } from './performance-diagnostics';
import { getSyncChildStoresIfMounted } from './sync-refs';
import type { State } from './types';

// Per-session turn timing behind the sidebar activity readout.
//
// The OpenCode status contract carries no timestamps — `SessionStatus` is a
// bare `busy | retry | idle` union — so how long the current turn has been
// running has to be measured on the client. This module owns that measurement
// and is driven from the same two write paths as `global-session-status`, the
// index rows actually render their live state from, so a row can never count a
// turn that index calls idle.
//
// The measurement is the fallback. Messages carry the boundaries the status
// contract omits: the newest user message's `time.created` is where the turn
// began, the newest finished assistant step's `time.completed` is where it
// ended, the same pair the work status panel's Elapsed row reads. Whenever a
// directory store holds a tracked session's messages, those values replace the
// measured ones, which is what keeps a turn that started before this page load
// from counting from zero. They are read here rather than by the rows: the
// sidebar mounts a counter for a handful of sessions at most, and each row
// holding a message subscription of its own is exactly the fan-out this avoids.
//
// Two maps with deliberately different lifetimes:
//
// - `startedAt` — sessions observed active right now. Persisted, so reloading
//   the page resumes the same count instead of restarting it at zero.
// - `settledMs` — how long the turn that just finished took. In memory only:
//   rows show it while the session is unread, and unread state itself does not
//   survive a reload, so persisting it would outlive its only consumer.
//
// A persisted start is a lookup table, never a claim of activity. Nothing in
// the protocol marks where a turn begins: the server calls `SessionStatus.set`
// with `busy` at every step of the agent loop and publishes an event each time,
// so a busy event means "still running", not "just started" — it cannot be read
// as a turn boundary, and reading it that way reset every counter on reload,
// because after a refresh one of those repeats almost always beats the first
// status snapshot.
//
// Turn *ends* are marked: `session.idle` and `session.error` events fire once,
// live, and retire the persisted record.
//
// That leaves the case the status stream cannot answer: a turn that ended, and
// another that began, entirely while the tab was gone. The messages answer it
// whenever their records are in a directory store; when they are not, two
// bounds stand in for the evidence the client cannot have:
//
// - a liveness stamp beside the start, refreshed while the session is observed
//   active and stamped precisely as the page hides, compared against this page's
//   navigation start — how long the app was actually absent;
// - an adoption window after load, after which unclaimed records are discarded,
//   which backstops a runtime whose event stream is down and where snapshots are
//   therefore the only signal.
//
// Nothing else may drop a persisted start. Status snapshots legitimately arrive
// before they can see a session as busy — bootstrap fetches status and sessions
// in parallel, directory scopes resolve at different times — and treating one
// of those as "the turn ended" destroyed the start moments before the real busy
// snapshot arrived, which is exactly the reload-resets-to-zero bug. Absence of
// evidence is not evidence here; only the two bounds above expire a record.

type SessionActivityPhase = 'active' | 'settled';

export type SessionActivityTimingMutation =
  | { type: 'observe'; sessionId: string; phase: SessionActivityPhase }
  | { type: 'remove'; sessionId: string };

type ActivityTimingDraft = {
  startedAt: Map<string, number> | null;
  settledMs: Map<string, number> | null;
};

/**
 * Where a turn began, and where it ended once it is over, as the server
 * stamped it in the session's own messages.
 */
type SessionActivityTurn = {
  startedAt: number;
  /** Null while the newest step still streams, and on records with no completion stamp. */
  completedAt: number | null;
};

type SessionActivityTimingState = {
  startedAt: ReadonlyMap<string, number>;
  settledMs: ReadonlyMap<string, number>;
  /** Turn boundaries read from each tracked session's messages, where a store holds them. */
  authoritativeTurns: ReadonlyMap<string, SessionActivityTurn>;
};

/** Persisted per session: when this turn began, and when it was last alive. */
type PersistedStart = { start: number; seen: number };

/** Finished turns worth remembering at once; each row only needs its own. */
const SETTLED_LIMIT = 200;
/** A turn running longer than this is treated as a stale record, not a turn. */
const MAX_TURN_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long the app may have been gone and still have its counters resumed,
 * measured from the liveness stamp to this page's navigation start — not to
 * "now". Bootstrap latency belongs to this page, not to the absence, and this
 * client has seen 20-second startups; charging those to the gap would refuse
 * a legitimate resume on exactly the slowest machines.
 */
const MAX_AWAY_MS = 30_000;
/** Refresh the persisted stamp at most this often during a long turn. */
const LIVENESS_PERSIST_INTERVAL_MS = 15_000;
/**
 * How long after page load a persisted record may still be adopted. Past this
 * point the app has certainly seen live status, so a record nothing claimed
 * describes a turn that is over — and a turn starting later is a new one that
 * must count from zero.
 */
const RESTORE_ADOPTION_WINDOW_MS = 90_000;
// One key, not one per runtime. These records live for seconds and are keyed by
// instance-unique session IDs, so runtime scoping bought nothing while adding a
// real failure mode: the runtime key is derived from injected globals and is not
// guaranteed stable across early startup, and a read under a key the previous
// page did not write to looks exactly like "no turn was running".
const STORAGE_KEY = 'oc.session-activity.v1';

const EMPTY_RESTORED: ReadonlyMap<string, PersistedStart> = new Map();
const EMPTY_TURNS: ReadonlyMap<string, SessionActivityTurn> = new Map();

export const useSessionActivityTimingStore = create<SessionActivityTimingState>(() => ({
  startedAt: new Map(),
  settledMs: new Map(),
  authoritativeTurns: EMPTY_TURNS,
}));
useSessionActivityTimingStore.subscribe(() => countSyncPerformance('timingPublications'));

/** Last moment each live start was observed active, for the liveness stamp. */
const liveSeen = new Map<string, number>();
let lastPersistAt = 0;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let restoredStarts: Map<string, PersistedStart> | null = null;

/** Epoch ms of this page's navigation start; the reference for "how long gone". */
const readPageLoadAt = (): number => {
  if (typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)) {
    return performance.timeOrigin;
  }
  return Date.now();
};

let pageLoadAt = readPageLoadAt();

const isResumable = (entry: PersistedStart, now: number): boolean => (
  entry.start <= now
  && now - entry.start <= MAX_TURN_AGE_MS
  && entry.seen <= now
  // Negative when this page wrote the stamp itself, which is trivially fresh.
  && pageLoadAt - entry.seen <= MAX_AWAY_MS
);

const parseEntry = (value: unknown): PersistedStart | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { start, seen } = value as { start?: unknown; seen?: unknown };
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof seen !== 'number' || !Number.isFinite(seen)) return null;
  return { start, seen };
};

const readRestoredStarts = (): Map<string, PersistedStart> => {
  const restored = new Map<string, PersistedStart>();
  let raw: string | null = null;
  try {
    raw = getSafeStorage().getItem(STORAGE_KEY);
  } catch {
    return restored;
  }
  if (!raw) return restored;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed payload is a failed read, not authoritative "no turns were
    // running": live status re-seeds every counter from now either way.
    return restored;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return restored;

  const now = Date.now();
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = parseEntry(value);
    // Rejects stale turns, quiet stamps, and clock-skewed futures rather than
    // rendering a counter that reads days long or negative.
    if (entry && isResumable(entry, now)) restored.set(sessionId, entry);
  }
  return restored;
};

const getRestoredStarts = (): Map<string, PersistedStart> => {
  restoredStarts ??= readRestoredStarts();
  return restoredStarts;
};

/**
 * Restored records still eligible to be adopted. Past the adoption window they
 * are dropped for good, so a turn that starts later counts from zero instead of
 * inheriting the start of whatever ran before the reload.
 */
const getAdoptableStarts = (now: number): ReadonlyMap<string, PersistedStart> => {
  if (now - pageLoadAt > RESTORE_ADOPTION_WINDOW_MS) {
    restoredStarts?.clear();
    return EMPTY_RESTORED;
  }
  return getRestoredStarts();
};

// Live starts merged over restored-but-unconfirmed ones, so a reload landing
// before the first authoritative snapshot does not drop the starts that
// snapshot is about to confirm. Restored entries whose stamp has gone quiet are
// dropped here, which is the only way they leave storage.
const persistStarts = (startedAt: ReadonlyMap<string, number>, now: number): void => {
  const payload: Record<string, PersistedStart> = {};
  for (const [sessionId, entry] of getRestoredStarts()) {
    if (isResumable(entry, now)) payload[sessionId] = entry;
  }
  for (const [sessionId, start] of startedAt) {
    payload[sessionId] = { start, seen: liveSeen.get(sessionId) ?? now };
  }

  lastPersistAt = now;
  try {
    const storage = getSafeStorage();
    if (Object.keys(payload).length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage is unavailable or full; counters simply restart after a reload.
  }
};

// The most accurate liveness stamp available: the page is going away and every
// running turn was still running as of now. Writes are immediate (not deferred)
// so this cannot lose the race against a deferred flush on the same event.
const stampLiveness = (): void => {
  const { startedAt } = useSessionActivityTimingStore.getState();
  if (startedAt.size === 0) return;
  const now = Date.now();
  for (const sessionId of startedAt.keys()) liveSeen.set(sessionId, now);
  persistStarts(startedAt, now);
};

let lifecycleHooked = false;

const ensureLivenessStampOnHide = (): void => {
  if (lifecycleHooked || typeof window === 'undefined') return;
  lifecycleHooked = true;
  try {
    // `pagehide` covers unload and bfcache entry; `visibilitychange`/`freeze`
    // cover backgrounding and are the reliable ones in WKWebView. No
    // `beforeunload` — it would cost bfcache for a stamp the others already
    // wrote.
    window.addEventListener('pagehide', stampLiveness, { capture: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') stampLiveness();
      });
      document.addEventListener('freeze', stampLiveness);
    }
  } catch {
    // Restricted environments can reject listeners; the periodic stamp refresh
    // still bounds how quiet a running turn's record can get.
  }
};

// ---------------------------------------------------------------------------
// Authoritative turn boundaries
// ---------------------------------------------------------------------------

/**
 * The turn these messages describe, or null when they cannot describe one:
 * empty, still missing the prompt (a history that never loaded, a native CLI
 * transcript without stamps), or holding a stamp that is not a number.
 */
export const readSessionActivityTurn = (
  messages: readonly Message[] | undefined,
): SessionActivityTurn | null => {
  if (!messages || messages.length === 0) return null;

  let promptIndex = -1;
  let startedAt: number | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    promptIndex = index;
    startedAt = message.time.created;
    break;
  }
  if (startedAt === null || !Number.isFinite(startedAt)) return null;

  // Only the newest conversation record can be this turn's end. OpenCode
  // interleaves plumbing roles after the last step (`synthetic`, `shell`,
  // `idle`, the `*-switched` notices), and those never carry one.
  for (let index = messages.length - 1; index > promptIndex; index -= 1) {
    const message = messages[index];
    if (!isConversationRole(message.role)) continue;
    if (message.role !== 'assistant') return { startedAt, completedAt: null };
    const completedAt = message.time.completed;
    return {
      startedAt,
      completedAt: completedAt !== undefined && Number.isFinite(completedAt) && completedAt >= startedAt
        ? completedAt
        : null,
    };
  }
  return { startedAt, completedAt: null };
};

/**
 * Publish freshly read boundaries in one store update, so a pass that touched
 * several sessions re-renders each of them once. `null` drops an entry, which
 * is what a removed or evicted history leaves behind.
 */
const publishTurns = (turns: ReadonlyMap<string, SessionActivityTurn | null>): void => {
  if (turns.size === 0) return;
  const state = useSessionActivityTimingStore.getState();
  let next: Map<string, SessionActivityTurn> | null = null;
  for (const [sessionId, turn] of turns) {
    const current = state.authoritativeTurns.get(sessionId);
    if (turn === null) {
      if (current === undefined) continue;
      next ??= new Map(state.authoritativeTurns);
      next.delete(sessionId);
      continue;
    }
    if (current && current.startedAt === turn.startedAt && current.completedAt === turn.completedAt) continue;
    next ??= new Map(state.authoritativeTurns);
    next.set(sessionId, turn);
  }
  if (next) useSessionActivityTimingStore.setState({ authoritativeTurns: next });
};

/** The turn a store already holds this session's messages for, or null when none does. */
const readStoredTurn = (stores: ChildStoreManager, sessionId: string): SessionActivityTurn | null => {
  for (const store of stores.children.values()) {
    const messages = store.getState().message[sessionId];
    if (messages) return readSessionActivityTurn(messages);
  }
  return null;
};

/**
 * Watch every directory store's message records, so the rows that show a
 * counter read the boundaries their session's messages carry.
 *
 * The subscriptions are per store rather than per session: a row does not know
 * which store holds its session, and the store count is bounded by the
 * manager's own limit. Only a changed message record enters the pass below;
 * streamed tokens and tool output touch parts, never records, so a long reply
 * costs one reference compare per store per flush.
 */
export const watchSessionActivityTurns = (stores: ChildStoreManager): (() => void) => {
  const unsubscribes = new Map<string, () => void>();

  const readChangedTurns = (state: State, previous: State): void => {
    if (state.message === previous.message) return;
    const { startedAt, settledMs } = useSessionActivityTimingStore.getState();
    const turns = new Map<string, SessionActivityTurn | null>();
    const readChanged = (sessionId: string): void => {
      if (turns.has(sessionId) || state.message[sessionId] === previous.message[sessionId]) return;
      turns.set(sessionId, readSessionActivityTurn(state.message[sessionId]));
    };
    // Only sessions whose rows can show a counter: a running turn, or the one
    // that just finished. A record change for any other session is dismissed
    // without reading its messages.
    for (const sessionId of startedAt.keys()) readChanged(sessionId);
    for (const sessionId of settledMs.keys()) readChanged(sessionId);
    publishTurns(turns);
  };

  const refreshTrackedTurns = (): void => {
    const { startedAt, settledMs } = useSessionActivityTimingStore.getState();
    const turns = new Map<string, SessionActivityTurn | null>();
    for (const sessionId of startedAt.keys()) turns.set(sessionId, readStoredTurn(stores, sessionId));
    for (const sessionId of settledMs.keys()) {
      if (!turns.has(sessionId)) turns.set(sessionId, readStoredTurn(stores, sessionId));
    }
    publishTurns(turns);
  };

  const attach = (): void => {
    for (const [directory, unsubscribe] of unsubscribes) {
      if (stores.getChild(directory)) continue;
      unsubscribe();
      unsubscribes.delete(directory);
    }
    let appeared = false;
    for (const [directory, store] of stores.children) {
      if (unsubscribes.has(directory)) continue;
      unsubscribes.set(directory, store.subscribe((state, previous) => readChangedTurns(state, previous)));
      appeared = true;
    }
    // A store that just appeared may already hold a running turn's messages.
    if (appeared) refreshTrackedTurns();
  };

  const unsubscribeRegistry = stores.subscribeRegistry(attach);
  attach();
  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of unsubscribes.values()) unsubscribe();
    unsubscribes.clear();
  };
};

let turnWatcher: { stores: ChildStoreManager; dispose: () => void } | null = null;

/**
 * Read the boundaries of the sessions a transition touched, and keep the store
 * watcher attached to the current runtime's stores. Called after the transition
 * published its maps, so an attach that follows reads the new set.
 */
const syncTrackedTurns = (sessionIds: Iterable<string>): void => {
  const stores = getSyncChildStoresIfMounted();
  if (!stores) return;
  if (turnWatcher?.stores !== stores) {
    turnWatcher?.dispose();
    // Attaching reads every tracked session, the ones this pass touched included.
    turnWatcher = { stores, dispose: watchSessionActivityTurns(stores) };
    return;
  }
  const turns = new Map<string, SessionActivityTurn | null>();
  for (const sessionId of sessionIds) turns.set(sessionId, readStoredTurn(stores, sessionId));
  publishTurns(turns);
};

/** Forget the boundaries of sessions whose timing records are gone. */
const dropTurns = (sessionIds: Iterable<string>): void => {
  const turns = new Map<string, SessionActivityTurn | null>();
  for (const sessionId of sessionIds) turns.set(sessionId, null);
  publishTurns(turns);
};

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Drop the oldest settled durations, reporting which sessions left the map. */
const trimSettled = (settled: Map<string, number>): string[] | null => {
  let dropped: string[] | null = null;
  while (settled.size > SETTLED_LIMIT) {
    const oldest = settled.keys().next();
    if (oldest.done) break;
    settled.delete(oldest.value);
    (dropped ??= []).push(oldest.value);
  }
  return dropped;
};

/**
 * What ends a turn in this pass. An event names its session outright; a snapshot
 * only answers whether it covers a given one — deliberately the cheaper
 * question, since the settle loop walks running turns rather than session lists.
 * An `event` idle is a live, one-shot "this turn is over"; a snapshot omitting a
 * session is not, because it may simply not see it yet.
 */
type SettleInput =
  | { source: 'event'; sessionId: string }
  | { source: 'snapshot'; isCovered: (sessionId: string) => boolean };

const applyTransitions = (
  activeSessionIds: ReadonlySet<string>,
  settle: SettleInput | null,
): void => {
  const now = Date.now();
  const restored = getAdoptableStarts(now);
  const state = useSessionActivityTimingStore.getState();

  const next: { started: Map<string, number> | null; settled: Map<string, number> | null } = {
    started: null,
    settled: null,
  };
  let sawActive = false;
  let restoredChanged = false;
  /** Sessions whose boundaries are worth reading again once this pass lands. */
  const touched = new Set<string>();

  const draftStarted = (): Map<string, number> => (next.started ??= new Map(state.startedAt));
  const draftSettled = (): Map<string, number> => (next.settled ??= new Map(state.settledMs));

  for (const sessionId of activeSessionIds) {
    sawActive = true;
    liveSeen.set(sessionId, now);
    if ((next.started ?? state.startedAt).has(sessionId)) continue;
    // Busy carries no turn boundary from either source: the server re-publishes
    // `session.status: busy` on every step of the agent loop, so a busy event
    // means "still running", not "just started". Both paths therefore prefer a
    // persisted start when one survives; only the bounds below expire it.
    draftStarted().set(sessionId, restored.get(sessionId)?.start ?? now);
    if ((next.settled ?? state.settledMs).has(sessionId)) draftSettled().delete(sessionId);
    touched.add(sessionId);
  }

  const settleTurn = (sessionId: string, start: number): void => {
    draftStarted().delete(sessionId);
    liveSeen.delete(sessionId);
    draftSettled().set(sessionId, Math.max(0, now - start));
    touched.add(sessionId);
  };

  if (settle === null) {
    // Nothing ends this pass.
  } else if (settle.source === 'event') {
    // An idle/error event is a live, unambiguous end of turn, so it also retires
    // the persisted record. A snapshot's silence is not: it may simply not see
    // the session yet.
    if (getRestoredStarts().delete(settle.sessionId)) restoredChanged = true;
    const start = state.startedAt.get(settle.sessionId);
    // Only a turn watched from its start yields a duration.
    if (start !== undefined) settleTurn(settle.sessionId, start);
  } else {
    // Walk the running turns, not everything the snapshot covers. Only a live
    // start can settle, and there are a handful of those against a directory's
    // hundreds of sessions — asking "does this snapshot cover that one?" keeps
    // the pass proportional to the work instead of to the session list, and
    // allocates nothing per poll.
    for (const [sessionId, start] of state.startedAt) {
      if (activeSessionIds.has(sessionId)) continue;
      if (!settle.isCovered(sessionId)) continue;
      settleTurn(sessionId, start);
    }
  }

  const trimmedSettled = next.settled ? trimSettled(next.settled) : null;

  if (next.started || next.settled) {
    useSessionActivityTimingStore.setState({
      startedAt: next.started ?? state.startedAt,
      settledMs: next.settled ?? state.settledMs,
    });
  }

  // Published after the maps above, so a fresh attach reads this pass's set.
  if (trimmedSettled) dropTurns(trimmedSettled);
  if (touched.size > 0) syncTrackedTurns(touched);

  if (next.started) {
    if (next.started.size > 0) ensureLivenessStampOnHide();
    persistStarts(next.started, now);
    return;
  }
  if (restoredChanged) {
    persistStarts(state.startedAt, now);
    return;
  }
  // Nothing structural changed, but a long-running turn still needs its stamp
  // refreshed so a reload can tell it apart from one that ended unobserved.
  if (sawActive && state.startedAt.size > 0 && now - lastPersistAt >= LIVENESS_PERSIST_INTERVAL_MS) {
    persistStarts(state.startedAt, now);
  }
};

/**
 * Event-driven path: one session changed phase, live. Busy repeats throughout a
 * turn and carries no boundary; idle/error fire once and end it, which is why
 * only settling here retires the persisted record.
 */
export const observeSessionActivityTiming = (
  sessionId: string,
  phase: SessionActivityPhase,
): void => {
  applySessionActivityTimingMutations([{ type: 'observe', sessionId, phase }]);
};

export const applySessionActivityTimingMutations = (
  mutations: readonly SessionActivityTimingMutation[],
): void => {
  if (mutations.length === 0) return;
  const now = Date.now();
  const restored = getAdoptableStarts(now);
  const state = useSessionActivityTimingStore.getState();
  const next: ActivityTimingDraft = { startedAt: null, settledMs: null };
  let restoredChanged = false;
  let sawActive = false;
  const touched = new Set<string>();
  const dropped = new Set<string>();
  const currentStarted = (): ReadonlyMap<string, number> => next.startedAt ?? state.startedAt;
  const currentSettled = (): ReadonlyMap<string, number> => next.settledMs ?? state.settledMs;
  const draftStarted = (): Map<string, number> => (next.startedAt ??= new Map(state.startedAt));
  const draftSettled = (): Map<string, number> => (next.settledMs ??= new Map(state.settledMs));

  for (const mutation of mutations) {
    if (mutation.type === 'remove') {
      if (getRestoredStarts().delete(mutation.sessionId)) restoredChanged = true;
      liveSeen.delete(mutation.sessionId);
      if (currentStarted().has(mutation.sessionId)) draftStarted().delete(mutation.sessionId);
      if (currentSettled().has(mutation.sessionId)) draftSettled().delete(mutation.sessionId);
      dropped.add(mutation.sessionId);
      continue;
    }

    if (mutation.phase === 'active') {
      sawActive = true;
      liveSeen.set(mutation.sessionId, now);
      if (!currentStarted().has(mutation.sessionId)) {
        draftStarted().set(mutation.sessionId, restored.get(mutation.sessionId)?.start ?? now);
        touched.add(mutation.sessionId);
      }
      if (currentSettled().has(mutation.sessionId)) draftSettled().delete(mutation.sessionId);
      continue;
    }

    if (getRestoredStarts().delete(mutation.sessionId)) restoredChanged = true;
    const start = currentStarted().get(mutation.sessionId);
    if (start === undefined) continue;
    draftStarted().delete(mutation.sessionId);
    liveSeen.delete(mutation.sessionId);
    draftSettled().set(mutation.sessionId, Math.max(0, now - start));
    touched.add(mutation.sessionId);
  }

  const trimmedSettled = next.settledMs ? trimSettled(next.settledMs) : null;

  if (next.startedAt || next.settledMs) {
    useSessionActivityTimingStore.setState({
      startedAt: next.startedAt ?? state.startedAt,
      settledMs: next.settledMs ?? state.settledMs,
    });
  }

  // Published after the maps above, so a fresh attach reads this pass's set.
  if (trimmedSettled) for (const sessionId of trimmedSettled) dropped.add(sessionId);
  if (dropped.size > 0) dropTurns(dropped);
  if (touched.size > 0) syncTrackedTurns(touched);

  if (next.startedAt) {
    if (next.startedAt.size > 0) ensureLivenessStampOnHide();
    persistStarts(next.startedAt, now);
  } else if (restoredChanged) {
    persistStarts(state.startedAt, now);
  } else if (sawActive && state.startedAt.size > 0 && now - lastPersistAt >= LIVENESS_PERSIST_INTERVAL_MS) {
    persistStarts(state.startedAt, now);
  }
};

/**
 * Authoritative path: a `/session/status` snapshot for one directory. Sessions
 * the snapshot covers but does not report active stop their live counters —
 * that is what recovers a turn whose end event this client missed — but their
 * persisted records survive, because a snapshot that cannot yet see a session
 * looks identical to one whose turn is over.
 */
export const reconcileSessionActivityTiming = (
  activeSessionIds: ReadonlySet<string>,
  isCoveredBySnapshot: (sessionId: string) => boolean,
): void => {
  applyTransitions(activeSessionIds, { source: 'snapshot', isCovered: isCoveredBySnapshot });
};

export const removeSessionActivityTiming = (sessionId: string): void => {
  applySessionActivityTimingMutations([{ type: 'remove', sessionId }]);
};

/**
 * Drops in-memory state and the cached restored-start snapshot — i.e. treats
 * what follows as a fresh page load. Called on a runtime switch, where the
 * previous instance's turns are no longer ours, and by tests. `pageLoadAt`
 * overrides the navigation-start reference so tests can place a load in the
 * past (slow bootstrap, expired window).
 */
export const resetSessionActivityTiming = (options: { pageLoadAt?: number } = {}): void => {
  restoredStarts = null;
  liveSeen.clear();
  lastPersistAt = 0;
  pageLoadAt = options.pageLoadAt ?? Date.now();
  turnWatcher?.dispose();
  turnWatcher = null;
  useSessionActivityTimingStore.setState({
    startedAt: new Map(),
    settledMs: new Map(),
    authoritativeTurns: EMPTY_TURNS,
  });
};

// ---------------------------------------------------------------------------
// Leaf subscriptions
// ---------------------------------------------------------------------------

/**
 * The counter a running row renders: the start its messages carry when they
 * carry one, otherwise the client's measurement. `undefined` means the row has
 * no counter at all, which is what keeps a session whose messages never loaded
 * reading exactly as it did before.
 */
export const resolveSessionActivityStartedAt = (
  measuredStartedAt: number | undefined,
  turn: SessionActivityTurn | undefined,
): number | undefined => (
  measuredStartedAt === undefined ? undefined : turn?.startedAt ?? measuredStartedAt
);

/**
 * The readout a settled row renders: the finished turn's own span when the
 * messages give both ends, otherwise the measured one.
 */
export const resolveSessionSettledDurationMs = (
  measuredSettledMs: number | undefined,
  turn: SessionActivityTurn | undefined,
): number | undefined => {
  if (measuredSettledMs === undefined) return undefined;
  if (!turn || turn.completedAt === null || turn.completedAt < turn.startedAt) return measuredSettledMs;
  return turn.completedAt - turn.startedAt;
};

export const useSessionActivityStartedAt = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => (
    resolveSessionActivityStartedAt(state.startedAt.get(sessionId), state.authoritativeTurns.get(sessionId))
  ), [sessionId]))
);

export const useSessionSettledDurationMs = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => (
    resolveSessionSettledDurationMs(state.settledMs.get(sessionId), state.authoritativeTurns.get(sessionId))
  ), [sessionId]))
);

/**
 * Whether a duration exists to render, without subscribing the caller to the
 * value itself — a row uses this to decide between the counter and its normal
 * metadata, and must not re-render every tick to do so.
 */
export const useHasSessionActivityDuration = (sessionId: string, running: boolean): boolean => (
  useSessionActivityTimingStore(useCallback((state) => (
    running ? state.startedAt.has(sessionId) : state.settledMs.has(sessionId)
  ), [running, sessionId]))
);
