import { describe, expect, test } from 'bun:test';

import { nativeCapabilitiesSchema } from './schemas';
import { nativeChecklistSnapshotSchema, nativeTaskOutputSchema, nativeTaskSnapshotSchema } from './task-schemas';

const task = {
  id: 'task-1', type: 'local_bash', description: 'Build the app',
  active: false, ambient: false, status: 'completed', canStop: false, outputAvailable: true,
};

describe('native task contracts', () => {
  test('keeps historical Antigravity tasks read-only and never treats history as running', () => {
    const saved = { state: 'history', generation: 'agy-history:conversation', revision: 10, tasks: [task], omitted: 0 };
    expect(nativeTaskSnapshotSchema.parse(saved)).toMatchObject({ state: 'history', tasks: [{ status: 'completed', active: false }] });
    for (const change of [{ active: true }, { canStop: true }, { status: 'running' }]) {
      expect(nativeTaskSnapshotSchema.safeParse({ ...saved, tasks: [{ ...task, ...change }] }).success).toBe(false);
    }
  });

  test('accepts older hosts without claiming they support the task interfaces', () => {
    const capabilities = nativeCapabilitiesSchema.parse({
      supported: true, backends: { claude: { cli: true }, codex: { cli: false } }, registry: { reset: false },
    });
    expect(capabilities.backends.claude.tasks).toBeUndefined();
  });

  test('preserves checklist provenance, partial coverage and optional detail', () => {
    const snapshot = nativeChecklistSnapshotSchema.parse({
      state: 'ready', identity: 'shared-list', source: 'files', revision: 3, observedAt: 50,
      complete: false, unreadable: 1,
      items: [{
        id: '1', subject: 'Run checks', status: 'in_progress', description: 'Use focused tests',
        owner: 'worker', activeForm: 'Running checks', blocks: ['3'], blockedBy: ['2'],
      }],
    });
    expect(snapshot).toMatchObject({
      state: 'ready', identity: 'shared-list', complete: false, unreadable: 1,
      items: [{ owner: 'worker', blocks: ['3'], blockedBy: ['2'] }],
    });
  });

  test('requires coverage and rejects malformed checklist states', () => {
    const snapshot = {
      state: 'ready', identity: 'list-1', source: 'files', revision: 1, observedAt: 50,
      complete: true, unreadable: 0, items: [],
    };
    expect(nativeChecklistSnapshotSchema.safeParse({ ...snapshot, complete: undefined }).success).toBe(false);
    expect(nativeChecklistSnapshotSchema.safeParse({ ...snapshot, revision: -1 }).success).toBe(false);
    expect(nativeChecklistSnapshotSchema.safeParse({ ...snapshot, unreadable: 1 }).success).toBe(false);
    expect(nativeChecklistSnapshotSchema.safeParse({
      ...snapshot, items: [{ id: '1', subject: 'Work', status: 'running' }],
    }).success).toBe(false);
  });

  test('keeps execution membership and outcome as independent facts', () => {
    const snapshot = nativeTaskSnapshotSchema.parse({
      state: 'active', generation: 'query-1', revision: 3, omitted: 0,
      tasks: [task, { ...task, id: 'watcher', active: true, ambient: true, status: 'running' }],
    });
    expect(snapshot.tasks[0]).toMatchObject({ active: false, status: 'completed' });
    expect(snapshot.tasks[1]).toMatchObject({ active: true, ambient: true });
    expect(nativeTaskSnapshotSchema.safeParse({ ...snapshot, tasks: [{ ...task, status: 'success' }] }).success).toBe(false);
  });

  test('requires process identity for a live task snapshot and clears records when inactive', () => {
    const inactive = { state: 'inactive', generation: null, revision: 5, tasks: [], omitted: 0 };
    expect(nativeTaskSnapshotSchema.parse(inactive)).toEqual(inactive);
    expect(nativeTaskSnapshotSchema.safeParse({ ...inactive, tasks: [task] }).success).toBe(false);
    expect(nativeTaskSnapshotSchema.safeParse({ ...inactive, state: 'active' }).success).toBe(false);
    expect(nativeTaskSnapshotSchema.parse({ ...inactive, state: 'unknown', generation: 'query-1' }))
      .toMatchObject({ state: 'unknown', generation: 'query-1', tasks: [] });
  });

  test('does not equate missing output with an empty successful read', () => {
    expect(nativeTaskOutputSchema.parse({ state: 'ready', text: '', truncated: false }))
      .toEqual({ state: 'ready', text: '', truncated: false });
    expect(nativeTaskOutputSchema.parse({ state: 'unavailable', reason: 'not_recorded' }))
      .toEqual({ state: 'unavailable', reason: 'not_recorded' });
    expect(nativeTaskOutputSchema.safeParse({ state: 'ready', text: 'partial' }).success).toBe(false);
  });
});
