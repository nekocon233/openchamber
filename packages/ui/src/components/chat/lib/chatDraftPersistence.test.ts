import { describe, expect, test } from 'bun:test';

import { ChatDraftPersistence } from './chatDraftPersistence';

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
};

describe('device-local composer draft persistence', () => {
  test('persists and restores independently per runtime and session', () => {
    const storage = createMemoryStorage();
    const first = new ChatDraftPersistence({ storage, now: () => 10 });
    first.persist('runtime-a', 'session-one', {
      text: 'local draft',
      confirmedMentions: ['src/a.ts'],
    });

    expect(first.readLocal('runtime-b', 'session-one')).toEqual({ text: '', confirmedMentions: [] });
    expect(first.readLocal('runtime-a', 'session-two')).toEqual({ text: '', confirmedMentions: [] });
    expect(new ChatDraftPersistence({ storage }).readLocal('runtime-a', 'session-one')).toEqual({
      text: 'local draft',
      confirmedMentions: ['src/a.ts'],
    });
  });

  test('never invokes fetch or a host RuntimeAPI', () => {
    const storage = createMemoryStorage();
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('unexpected host request');
    }) as typeof fetch;
    try {
      const persistence = new ChatDraftPersistence({ storage });
      persistence.stage('runtime-a', null, { text: 'new session draft', confirmedMentions: [] });
      persistence.persist('runtime-a', null, { text: 'new session draft', confirmedMentions: [] });
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('clears a submitted value without erasing a newer edit', () => {
    const storage = createMemoryStorage();
    const persistence = new ChatDraftPersistence({ storage });
    const submitted = { text: 'first version', confirmedMentions: [] };
    const submission = persistence.persistForSubmission('runtime-a', 'session-one', submitted);

    persistence.stage('runtime-a', 'session-one', { text: 'newer version', confirmedMentions: [] });
    persistence.persist('runtime-a', 'session-one', { text: 'newer version', confirmedMentions: [] });
    persistence.clearAfterSubmission('runtime-a', 'session-one', submitted, submission.generation);

    expect(persistence.readLocal('runtime-a', 'session-one').text).toBe('newer version');
  });

  test('clears the matching local draft after confirmed submission', () => {
    const storage = createMemoryStorage();
    const persistence = new ChatDraftPersistence({ storage });
    const submitted = { text: 'send this', confirmedMentions: ['src/a.ts'] };
    const submission = persistence.persistForSubmission('runtime-a', 'session-one', submitted);

    persistence.clearAfterSubmission('runtime-a', 'session-one', submitted, submission.generation);

    expect(new ChatDraftPersistence({ storage }).readLocal('runtime-a', 'session-one')).toEqual({
      text: '',
      confirmedMentions: [],
    });
  });

  test('keeps the submitted value durable when a send outcome is ambiguous', () => {
    const storage = createMemoryStorage();
    const persistence = new ChatDraftPersistence({ storage });
    persistence.persistForSubmission('runtime-a', 'session-one', {
      text: 'retryable local draft',
      confirmedMentions: [],
    });

    expect(new ChatDraftPersistence({ storage }).readLocal('runtime-a', 'session-one').text).toBe('retryable local draft');
  });

  test('migrates the old runtime cache locally and removes obsolete host outboxes', () => {
    const storage = createMemoryStorage();
    const runtime = encodeURIComponent('runtime-a');
    const scope = encodeURIComponent('session:session-one');
    storage.setItem(`oc.chatDraft.v1:${runtime}:${scope}`, JSON.stringify({
      version: 1,
      text: 'migrated local draft',
      confirmedMentions: ['src/a.ts'],
      pending: true,
      blocked: true,
      pendingMutationId: 'old-mutation',
      serverRevision: 2,
      scopeToken: 'a'.repeat(64),
      updatedAt: 10,
    }));
    storage.setItem(`oc.chatDraftClear.v1:${runtime}:${scope}`, '{}');
    storage.setItem(`oc.chatDraftSubmissionClear.v1:${runtime}:${scope}`, '{}');

    const persistence = new ChatDraftPersistence({ storage });

    expect(persistence.readLocal('runtime-a', 'session-one')).toEqual({
      text: 'migrated local draft',
      confirmedMentions: ['src/a.ts'],
    });
    expect(storage.getItem(`oc.chatDraft.v1:${runtime}:${scope}`)).toBeNull();
    expect(storage.getItem(`oc.chatDraftClear.v1:${runtime}:${scope}`)).toBeNull();
    expect(storage.getItem(`oc.chatDraftSubmissionClear.v1:${runtime}:${scope}`)).toBeNull();
  });

  test('disable removes only the selected runtime scope', () => {
    const storage = createMemoryStorage();
    const persistence = new ChatDraftPersistence({ storage });
    persistence.persist('runtime-a', 'session-one', { text: 'a', confirmedMentions: [] });
    persistence.persist('runtime-b', 'session-one', { text: 'b', confirmedMentions: [] });

    persistence.disable('runtime-a', 'session-one');

    expect(persistence.readLocal('runtime-a', 'session-one').text).toBe('');
    expect(persistence.readLocal('runtime-b', 'session-one').text).toBe('b');
  });

  test('a passive stale lane cannot overwrite a newer same-device draft', () => {
    const storage = createMemoryStorage();
    const stale = new ChatDraftPersistence({ storage });
    expect(stale.readLocal('runtime-a', 'session-one').text).toBe('');
    const current = new ChatDraftPersistence({ storage });
    current.stage('runtime-a', 'session-one', { text: 'newer', confirmedMentions: [] });
    current.persist('runtime-a', 'session-one', { text: 'newer', confirmedMentions: [] });

    stale.persist('runtime-a', 'session-one', { text: '', confirmedMentions: [] });

    expect(new ChatDraftPersistence({ storage }).readLocal('runtime-a', 'session-one').text).toBe('newer');
  });

  test('notifies a remounted composer when a matching submission is cleared', () => {
    const storage = createMemoryStorage();
    const persistence = new ChatDraftPersistence({ storage });
    const value = { text: 'submitted', confirmedMentions: [] };
    const submission = persistence.persistForSubmission('runtime-a', 'session-one', value);
    const updates: string[] = [];
    const unwatch = persistence.watch('runtime-a', 'session-one', (next) => updates.push(next.text));

    persistence.clearAfterSubmission('runtime-a', 'session-one', value, submission.generation);
    unwatch();

    expect(updates).toEqual(['']);
  });

  test('moves a new-session submission into its materialized session scope', () => {
    const storage = createMemoryStorage();
    const persistence = new ChatDraftPersistence({ storage });
    const value = { text: 'new session prompt', confirmedMentions: [] };
    const submission = persistence.persistForSubmission('runtime-a', null, value);

    const generation = persistence.moveSubmission(
      'runtime-a',
      null,
      'session-created',
      value,
      submission.generation,
    );

    expect(generation).not.toBeNull();
    expect(persistence.readLocal('runtime-a', null).text).toBe('');
    expect(persistence.readLocal('runtime-a', 'session-created').text).toBe(value.text);
    persistence.clearAfterSubmission('runtime-a', 'session-created', value, generation!);
    expect(persistence.readLocal('runtime-a', 'session-created').text).toBe('');
  });

  test('retains the old cache when migration cannot be durably persisted', () => {
    const storage = createMemoryStorage();
    const runtime = encodeURIComponent('runtime-a');
    const scope = encodeURIComponent('session:session-one');
    const oldKey = `oc.chatDraft.v1:${runtime}:${scope}`;
    storage.setItem(oldKey, JSON.stringify({
      version: 1,
      text: 'keep migration source',
      confirmedMentions: [],
      updatedAt: 10,
    }));
    const persistence = new ChatDraftPersistence({
      storage,
      verifyStorageWrite: () => false,
    });

    expect(persistence.readLocal('runtime-a', 'session-one').text).toBe('keep migration source');
    expect(storage.getItem(oldKey)).not.toBeNull();
  });
});
