import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Message } from '@/lib/opencode/model';
import { createRuntimeOpencodeClient } from '@/lib/opencode/client';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { ChildStoreManager } from './child-store';
import { applyGlobalSessionStatusSnapshot } from './global-session-status';
import { setSyncRefs } from './sync-refs';
import {
  applySessionActivityTimingMutations,
  observeSessionActivityTiming,
  readSessionActivityTurn,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
  resetSessionActivityTiming,
  resolveSessionActivityStartedAt,
  resolveSessionSettledDurationMs,
  useSessionActivityTimingStore,
  watchSessionActivityTurns,
} from './session-activity-timing';

const STORAGE_KEY = 'oc.session-activity.v1';

const startedAt = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().startedAt.get(sessionId);

const settledMs = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().settledMs.get(sessionId);

const turnOf = (sessionId: string) => useSessionActivityTimingStore.getState().authoritativeTurns.get(sessionId);

/** The start a running row renders, with every layer in front of it. */
const displayedStartedAt = (sessionId: string): number | undefined =>
  resolveSessionActivityStartedAt(startedAt(sessionId), turnOf(sessionId));

const readMeasuredStart = (sessionId: string): number => {
  const measured = startedAt(sessionId);
  if (measured === undefined) throw new Error('Expected a measured start');
  return measured;
};

type PersistedStart = { start: number; seen: number };

const readPersisted = (): Record<string, PersistedStart> | null => {
  const raw = getSafeStorage().getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, PersistedStart>) : null;
};

/**
 * Seed a previous page session's record, then simulate the reload.
 * `loadedAgoMs` places this page's navigation start in the past, which is how a
 * slow bootstrap or an expired adoption window is expressed.
 */
const seedReload = (payload: unknown, loadedAgoMs = 0): void => {
  getSafeStorage().setItem(STORAGE_KEY, JSON.stringify(payload));
  resetSessionActivityTiming({ pageLoadAt: Date.now() - loadedAgoMs });
};

/** A status snapshot: which sessions it reports busy, and which it covers. */
const snapshot = (activeIds: string[], coveredIds: string[] = activeIds): void => {
  const covered = new Set(coveredIds);
  reconcileSessionActivityTiming(new Set(activeIds), (sessionId) => covered.has(sessionId));
};

/** A record for a turn that began `ageMs` ago and was alive until the reload. */
const runningUntilReload = (ageMs: number, loadedAgoMs = 0, quietFor = 1_000): PersistedStart => ({
  start: Date.now() - ageMs,
  seen: Date.now() - loadedAgoMs - quietFor,
});

const cleanups: Array<() => void> = [];

/** One session's message records, as the directory store holds them. */
const TURN_SESSION = 'ses_turn';

const userMessage = (id: string, created: number): Message => ({
  id,
  sessionID: TURN_SESSION,
  role: 'user',
  time: { created },
});

const assistantMessage = (id: string, time: { created: number; completed?: number }): Message => ({
  id,
  sessionID: TURN_SESSION,
  role: 'assistant',
  time,
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude',
});

const syntheticMessage = (id: string, created: number): Message => ({
  id,
  sessionID: TURN_SESSION,
  role: 'synthetic',
  time: { created },
  text: 'noted',
});

/** A directory store with the turn watch attached, torn down after the test. */
const watchFixture = () => {
  const stores = new ChildStoreManager();
  const store = stores.ensureChild('/repo', { bootstrap: false });
  const unwatch = watchSessionActivityTurns(stores);
  cleanups.push(() => {
    unwatch();
    stores.disposeAll();
  });
  return { stores, store };
};

beforeEach(() => {
  getSafeStorage().removeItem(STORAGE_KEY);
  resetSessionActivityTiming();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  getSafeStorage().removeItem(STORAGE_KEY);
  resetSessionActivityTiming();
});

describe('session activity timing', () => {
  test('starts a turn on the first active observation and keeps it stable', () => {
    observeSessionActivityTiming('ses_a', 'active');
    const first = startedAt('ses_a');
    expect(first).toBeGreaterThan(0);

    // Repeated busy/retry status events must not restart the counter.
    observeSessionActivityTiming('ses_a', 'active');
    expect(startedAt('ses_a')).toBe(first);
  });

  test('settling converts the start into a duration', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBeGreaterThanOrEqual(0);
  });

  test('a new turn clears the previous settled duration', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');
    expect(settledMs('ses_a')).toBeDefined();

    observeSessionActivityTiming('ses_a', 'active');
    expect(settledMs('ses_a')).toBe(undefined);
    expect(startedAt('ses_a')).toBeDefined();
  });

  test('settling a session that was never observed active yields no duration', () => {
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBe(undefined);
  });

  test('snapshot reconciliation starts covered actives and settles the rest', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_b', 'active');

    snapshot(['ses_a'], ['ses_a', 'ses_b', 'ses_c']);

    expect(startedAt('ses_a')).toBeDefined();
    expect(startedAt('ses_b')).toBe(undefined);
    expect(settledMs('ses_b')).toBeGreaterThanOrEqual(0);
    // Never active, never covered by a start: nothing to report.
    expect(settledMs('ses_c')).toBe(undefined);
  });

  test('a session outside the snapshot scope keeps running', () => {
    observeSessionActivityTiming('ses_other_directory', 'active');
    const start = startedAt('ses_other_directory');

    snapshot([], ['ses_a']);

    expect(startedAt('ses_other_directory')).toBe(start);
  });

  test('persists the start and a liveness stamp for a running turn', () => {
    observeSessionActivityTiming('ses_a', 'active');

    const persisted = readPersisted();
    expect(persisted?.ses_a.start).toBe(startedAt('ses_a') as number);
    expect(persisted?.ses_a.seen).toBeGreaterThanOrEqual(persisted?.ses_a.start as number);
  });

  test('clears the persisted record when the turn ends', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');

    expect(readPersisted()).toBeNull();
  });

  test('resumes a persisted start when a status snapshot reports the session active', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  // Regression: the server re-publishes `session.status: busy` at every step of
  // the agent loop, so after a reload one of those repeats normally arrives
  // before the first status snapshot. Reading a busy event as "a turn just
  // started" therefore reset the counter on almost every refresh.
  test('resumes when a repeated busy event arrives before the first snapshot', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('the turn after a resumed one still counts from zero', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    // Reload lands mid-turn: the snapshot resumes it…
    snapshot(['ses_a'], ['ses_a']);
    expect(startedAt('ses_a')).toBe(record.start);

    // …it finishes, which retires the record, so the next turn starts fresh.
    observeSessionActivityTiming('ses_a', 'settled');
    const before = Date.now();
    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('a live idle event retires the persisted record', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    // The turn ended while the tab was gone; the event arrives on reconnect.
    observeSessionActivityTiming('ses_a', 'settled');
    // A later snapshot must not resurrect the retired start.
    const before = Date.now();
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  // The absence is measured from navigation start, not from "now", so a slow
  // bootstrap on a slow machine cannot spend the whole allowance before the
  // first status snapshot arrives.
  test('resumes even when bootstrap takes most of a minute', () => {
    const loadedAgoMs = 45_000;
    const record = runningUntilReload(300_000, loadedAgoMs);
    seedReload({ ses_a: record }, loadedAgoMs);

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('does not adopt a record once the adoption window has passed', () => {
    const loadedAgoMs = 5 * 60_000;
    const record = runningUntilReload(300_000, loadedAgoMs);
    seedReload({ ses_a: record }, loadedAgoMs);

    // A turn starting this long after load is a new turn, not the one that was
    // running before the reload.
    const before = Date.now();
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  // Regression: bootstrap fetches status and sessions in parallel, so a
  // snapshot can legitimately cover a session before it can see it busy.
  // Treating that as "the turn ended" used to destroy the persisted start
  // moments before the real busy snapshot arrived, resetting the counter to 0s.
  test('an early snapshot that cannot see the session busy does not lose the start', () => {
    const record = runningUntilReload(120_000);
    seedReload({ ses_a: record });

    applyGlobalSessionStatusSnapshot('/repo', {}, ['ses_a']);
    applyGlobalSessionStatusSnapshot('/repo', { ses_a: { type: 'busy' } }, ['ses_a']);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('resumes through a snapshot that arrives before the session list loads', () => {
    const record = runningUntilReload(120_000);
    seedReload({ ses_a: record });

    applyGlobalSessionStatusSnapshot('/repo', { ses_a: { type: 'busy' } }, []);

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('does not resume a record whose liveness stamp has gone quiet', () => {
    const before = Date.now();
    seedReload({ ses_a: { start: before - 300_000, seen: before - 240_000 } });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('does not resume a turn older than the maximum turn age', () => {
    const before = Date.now();
    seedReload({ ses_a: { start: before - 48 * 60 * 60 * 1000, seen: before - 1_000 } });

    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('ignores malformed persisted payloads', () => {
    getSafeStorage().setItem(STORAGE_KEY, 'not json');
    resetSessionActivityTiming();

    const before = Date.now();
    snapshot(['ses_a'], ['ses_a']);

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('ignores entries of the wrong shape or dated in the future', () => {
    const before = Date.now();
    seedReload({
      ses_a: before - 5_000,
      ses_b: { start: 'nope', seen: before },
      ses_c: { start: before + 60_000, seen: before },
      ses_d: { start: before - 5_000, seen: before + 60_000 },
    });

    for (const sessionId of ['ses_a', 'ses_b', 'ses_c', 'ses_d']) {
      snapshot([sessionId]);
      expect(startedAt(sessionId)).toBeGreaterThanOrEqual(before);
    }
  });

  test('a quiet record ages out of storage on the next write', () => {
    const before = Date.now();
    seedReload({ ses_quiet: { start: before - 300_000, seen: before - 240_000 } });

    observeSessionActivityTiming('ses_a', 'active');

    expect(readPersisted()?.ses_quiet).toBe(undefined);
    expect(readPersisted()?.ses_a.start).toBeDefined();
  });

  test('deleting a session clears live, settled, and persisted timing', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_b', 'active');
    observeSessionActivityTiming('ses_b', 'settled');

    removeSessionActivityTiming('ses_a');
    removeSessionActivityTiming('ses_b');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_b')).toBe(undefined);
    expect(readPersisted()).toBeNull();
  });

  test('unrelated sessions keep their map references across a no-op update', () => {
    observeSessionActivityTiming('ses_a', 'active');
    const before = useSessionActivityTimingStore.getState();

    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_unknown', 'settled');

    const after = useSessionActivityTimingStore.getState();
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.settledMs).toBe(before.settledMs);
  });
});

describe('session activity turn boundaries', () => {
  test('reads the newest prompt and the newest finished step', () => {
    expect(readSessionActivityTurn([
      userMessage('u1', 1_000),
      assistantMessage('a1', { created: 1_100, completed: 1_400 }),
      userMessage('u2', 2_000),
      assistantMessage('a2', { created: 2_100, completed: 2_900 }),
    ])).toEqual({ startedAt: 2_000, completedAt: 2_900 });
  });

  test('a step still streaming leaves the end unknown', () => {
    expect(readSessionActivityTurn([
      userMessage('u1', 1_000),
      assistantMessage('a1', { created: 1_100, completed: 1_400 }),
      userMessage('u2', 2_000),
      assistantMessage('a2', { created: 2_100 }),
    ])).toEqual({ startedAt: 2_000, completedAt: null });
  });

  // OpenCode writes `synthetic`, `shell`, `idle` and the `*-switched` notices
  // around the conversation, so "the last message" is not the last step.
  test('plumbing roles after the last step do not hide its end', () => {
    expect(readSessionActivityTurn([
      userMessage('u1', 1_000),
      assistantMessage('a1', { created: 1_100, completed: 1_400 }),
      syntheticMessage('s1', 1_500),
    ])).toEqual({ startedAt: 1_000, completedAt: 1_400 });
  });

  test('records without a prompt describe no turn', () => {
    expect(readSessionActivityTurn([assistantMessage('a1', { created: 1_100, completed: 1_400 })])).toBe(null);
    expect(readSessionActivityTurn([])).toBe(null);
    expect(readSessionActivityTurn(undefined)).toBe(null);
  });

  test('an end stamped before its prompt is not a duration', () => {
    expect(readSessionActivityTurn([
      userMessage('u1', 2_000),
      assistantMessage('a1', { created: 1_100, completed: 1_400 }),
    ])).toEqual({ startedAt: 2_000, completedAt: null });
  });
});

describe('session activity readouts', () => {
  test('the measured counter stands when no messages carry boundaries', () => {
    expect(resolveSessionActivityStartedAt(500, undefined)).toBe(500);
    expect(resolveSessionSettledDurationMs(400, undefined)).toBe(400);
  });

  test('a start in the messages replaces the measured one', () => {
    expect(resolveSessionActivityStartedAt(500, { startedAt: 100, completedAt: null })).toBe(100);
  });

  test('a finished turn reads as its own span', () => {
    expect(resolveSessionSettledDurationMs(400, { startedAt: 100, completedAt: 900 })).toBe(800);
  });

  test('an unfinished or impossible span falls back to the measured duration', () => {
    expect(resolveSessionSettledDurationMs(400, { startedAt: 100, completedAt: null })).toBe(400);
    expect(resolveSessionSettledDurationMs(400, { startedAt: 100, completedAt: 50 })).toBe(400);
  });

  // The messages never put a counter on a row that has none: what the row
  // shows is still decided by the observed start or settle.
  test('no measured record means no readout, whatever the messages hold', () => {
    expect(resolveSessionActivityStartedAt(undefined, { startedAt: 100, completedAt: null })).toBe(undefined);
    expect(resolveSessionSettledDurationMs(undefined, { startedAt: 100, completedAt: 900 })).toBe(undefined);
  });
});

describe('session activity turn watch', () => {
  test('a store that loads the messages replaces the counters the rows show', () => {
    const { store } = watchFixture();
    observeSessionActivityTiming(TURN_SESSION, 'active');
    const measured = readMeasuredStart(TURN_SESSION);

    // The turn began long before this page first saw the session busy.
    const promptAt = measured - 600_000;
    store.setState({
      message: {
        [TURN_SESSION]: [
          userMessage('u1', promptAt),
          assistantMessage('a1', { created: promptAt + 1_000, completed: promptAt + 60_000 }),
        ],
      },
    });

    expect(turnOf(TURN_SESSION)).toEqual({ startedAt: promptAt, completedAt: promptAt + 60_000 });
    expect(displayedStartedAt(TURN_SESSION)).toBe(promptAt);
  });

  test('the finished turn reads as the span between the two stamps', () => {
    const { store } = watchFixture();
    observeSessionActivityTiming(TURN_SESSION, 'active');
    store.setState({
      message: {
        [TURN_SESSION]: [
          userMessage('u1', 1_000),
          assistantMessage('a1', { created: 1_100, completed: 61_000 }),
        ],
      },
    });
    observeSessionActivityTiming(TURN_SESSION, 'settled');

    expect(resolveSessionSettledDurationMs(settledMs(TURN_SESSION), turnOf(TURN_SESSION))).toBe(60_000);
  });

  test('sessions whose messages never load keep the measured counters', () => {
    watchFixture();
    observeSessionActivityTiming(TURN_SESSION, 'active');

    expect(turnOf(TURN_SESSION)).toBe(undefined);
    expect(displayedStartedAt(TURN_SESSION)).toBe(readMeasuredStart(TURN_SESSION));
  });

  test('a record change that moves no boundary republishes nothing', () => {
    const { store } = watchFixture();
    observeSessionActivityTiming(TURN_SESSION, 'active');
    const records = [userMessage('u1', 1_000), assistantMessage('a1', { created: 1_100, completed: 1_400 })];
    store.setState({ message: { [TURN_SESSION]: records } });
    const published = useSessionActivityTimingStore.getState().authoritativeTurns;

    store.setState({ message: { [TURN_SESSION]: [...records, syntheticMessage('s1', 1_500)] } });

    expect(useSessionActivityTimingStore.getState().authoritativeTurns).toBe(published);
  });

  // Streamed tokens and tool output touch parts, never records: a long reply
  // must not walk this path once per flush.
  test('part updates do not touch the boundaries at all', () => {
    const { store } = watchFixture();
    observeSessionActivityTiming(TURN_SESSION, 'active');
    store.setState({
      message: { [TURN_SESSION]: [userMessage('u1', 1_000), assistantMessage('a1', { created: 1_100 })] },
    });
    const published = useSessionActivityTimingStore.getState().authoritativeTurns;

    store.setState({ part: { a1: [{ id: 'p1', messageID: 'a1', sessionID: TURN_SESSION, type: 'text', text: 'hi' }] } });

    expect(useSessionActivityTimingStore.getState().authoritativeTurns).toBe(published);
  });

  test('a history that leaves the store drops its boundaries', () => {
    const { store } = watchFixture();
    observeSessionActivityTiming(TURN_SESSION, 'active');
    store.setState({ message: { [TURN_SESSION]: [userMessage('u1', 1_000)] } });
    expect(turnOf(TURN_SESSION)).toBeDefined();

    store.setState({ message: {} });

    expect(turnOf(TURN_SESSION)).toBe(undefined);
    expect(displayedStartedAt(TURN_SESSION)).toBe(readMeasuredStart(TURN_SESSION));
  });

  test('deleting a session drops its boundaries', () => {
    const { store } = watchFixture();
    observeSessionActivityTiming(TURN_SESSION, 'active');
    store.setState({ message: { [TURN_SESSION]: [userMessage('u1', 1_000)] } });
    expect(turnOf(TURN_SESSION)).toBeDefined();

    removeSessionActivityTiming(TURN_SESSION);

    expect(turnOf(TURN_SESSION)).toBe(undefined);
  });

  test('an unwatched store reports nothing', () => {
    const stores = new ChildStoreManager();
    const store = stores.ensureChild('/repo', { bootstrap: false });
    const unwatch = watchSessionActivityTurns(stores);
    cleanups.push(() => stores.disposeAll());
    observeSessionActivityTiming(TURN_SESSION, 'active');

    unwatch();
    store.setState({ message: { [TURN_SESSION]: [userMessage('u1', 1_000)] } });

    expect(turnOf(TURN_SESSION)).toBe(undefined);
  });

  // The settled window is what tells a row how long the turn that just ended
  // took, so a session leaving it has nothing left to describe.
  test('a session trimmed out of the settled window loses its boundaries', () => {
    const { store } = watchFixture();
    const mutations: Array<{ type: 'observe'; sessionId: string; phase: 'active' | 'settled' }> = [];
    const messages: Record<string, Message[]> = {};
    for (let index = 0; index < 220; index += 1) {
      const sessionId = `ses_window_${index}`;
      mutations.push({ type: 'observe', sessionId, phase: 'active' });
      messages[sessionId] = [{ ...userMessage('u1', 1_000), sessionID: sessionId }];
    }
    applySessionActivityTimingMutations(mutations);
    store.setState({ message: messages });
    expect(turnOf('ses_window_219')).toBeDefined();

    applySessionActivityTimingMutations(mutations.map(({ sessionId }) => ({ type: 'observe', sessionId, phase: 'settled' })));

    expect(turnOf('ses_window_0')).toBe(undefined);
    expect(turnOf('ses_window_219')).toBeDefined();
  });
});

describe('session activity turns on the runtime stores', () => {
  test('a status transition reads the boundaries its directory store holds', () => {
    const stores = new ChildStoreManager();
    const store = stores.ensureChild('/repo', { bootstrap: false });
    const sdk = createRuntimeOpencodeClient({ baseUrl: 'http://localhost' });
    setSyncRefs(sdk, stores, '/repo');
    cleanups.push(() => {
      stores.disposeAll();
      setSyncRefs(sdk, new ChildStoreManager(), '/repo');
    });
    store.setState({
      message: {
        [TURN_SESSION]: [
          userMessage('u1', 1_000),
          assistantMessage('a1', { created: 1_100, completed: 41_000 }),
        ],
      },
    });

    observeSessionActivityTiming(TURN_SESSION, 'active');

    expect(turnOf(TURN_SESSION)).toEqual({ startedAt: 1_000, completedAt: 41_000 });
    expect(displayedStartedAt(TURN_SESSION)).toBe(1_000);
  });
});
