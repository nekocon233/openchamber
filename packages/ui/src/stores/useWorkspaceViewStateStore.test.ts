import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost' });
const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
const { useWorkspaceViewStateStore: views, readWorkspaceViewState: read, workspaceViewKey } = await import('./useWorkspaceViewStateStore');
const { useWorkspaceDraftStore: drafts } = await import('./useWorkspaceDraftStore');
const { flushDeferredSafeStorage } = await import('./utils/safeStorage');
const owner = (runtime: string, project: string) => {
  const key = workspaceViewKey(runtime, project);
  if (!key) throw new Error('Missing test owner');
  return key;
};
afterAll(() => {
  if (original) Object.defineProperty(globalThis, 'window', original);
  else Reflect.deleteProperty(globalThis, 'window');
  dom.happyDOM.cancelAsync();
});

test('each project and runtime retains its own columns without notifying an unchanged selection', () => {
  const a = owner('host-a', '/a'); const b = owner('host-a', '/b');
  views.getState().update('pullRequest', a, previous => ({ ...previous, tab: 'branch', people: 'created' }));
  const selection = read(views.getState(), 'pullRequest', a);
  views.getState().update('pullRequest', b, previous => ({ ...previous, people: 'any' }));
  expect(read(views.getState(), 'pullRequest', a)).toBe(selection);
  expect(read(views.getState(), 'pullRequest', owner('host-b', '/a')).people).toBe('reviewRequested');
  expect(workspaceViewKey('host-a', '/a/')).toBe(a);
});

test('columns, opened entries and unfinished text round trip through page hide and hydration', async () => {
  const a = owner('host-a', '/a');
  views.getState().update('knowledge', a, previous => ({ ...previous, tab: 'plans', query: 'design', searchOpen: true, entry: { section: 'plans', id: 'p1' } }));
  views.getState().update('ci', a, previous => ({ ...previous, filter: 'failure', query: 'lint', selectedRunId: '9001', loadedCount: 30 }));
  drafts.getState().write(a, 'Unfinished reply', '');
  dom.dispatchEvent(new dom.Event('pagehide'));
  await views.persist.rehydrate(); await drafts.persist.rehydrate();
  expect(read(views.getState(), 'pullRequest', a)).toMatchObject({ tab: 'branch', people: 'created' });
  expect(read(views.getState(), 'ci', a)).toEqual({ filter: 'failure', query: 'lint', selectedRunId: '9001', loadedCount: 30 });
  expect(read(views.getState(), 'knowledge', a)).toMatchObject({ tab: 'plans', query: 'design', entry: { section: 'plans', id: 'p1' } });
  expect(drafts.getState().drafts[a]?.value).toBe('Unfinished reply');
});

test('a malformed window does not erase valid projects or valid fields', async () => {
  flushDeferredSafeStorage();
  const a = owner('host-a', '/valid');
  dom.localStorage.setItem('openchamber.workspace-views.v1', JSON.stringify({ state: { snapshots: { knowledge: {
    [a]: { tab: 'todos', query: 42, entry: { section: 'todos', id: '1' } },
    invalid: { tab: 'plans' }, '[null,"/other"]': { tab: 'memory' },
  } } }, version: 0 }));
  await views.persist.rehydrate();
  expect(read(views.getState(), 'knowledge', a)).toMatchObject({ tab: 'todos', query: '', entry: { section: 'todos', id: '1' } });
  expect(Object.keys(views.getState().snapshots.knowledge)).toEqual([a]);
});

test('a save acknowledgement keeps newer typing and other drafts', () => {
  drafts.getState().write('note-a', 'First change', 'Original');
  drafts.getState().write('note-b', 'Other draft', 'Other');
  drafts.getState().write('note-a', 'Newer typing', 'Original');
  drafts.getState().acknowledge('note-a', 'First change');
  expect(drafts.getState().drafts['note-a']).toEqual({ base: 'First change', value: 'Newer typing' });
  expect(drafts.getState().drafts['note-b']?.value).toBe('Other draft');
  drafts.getState().acknowledge('note-a', 'Newer typing');
  expect(drafts.getState().drafts['note-a']).toBeUndefined();
});

test('unconfirmed creation survives reload alongside the next input and is never replayed', async () => {
  const key = owner('host-a', '/new-entry');
  drafts.getState().write(key, 'First note', '');
  const ticket = drafts.getState().stageInput(key, 'First note');
  drafts.getState().write(key, 'Second note', '');
  flushDeferredSafeStorage();
  await drafts.persist.rehydrate();
  expect(drafts.getState().drafts[key]?.value).toBe('Second note');
  expect(drafts.getState().pendingInputs[key]).toEqual([{ id: ticket, value: 'First note' }]);
  drafts.getState().restoreInput(key, ticket);
  expect(drafts.getState().drafts[key]?.value).toBe('First note');
  expect(drafts.getState().pendingInputs[key].map(input => input.value)).toEqual(['Second note']);
  const next = drafts.getState().stageInput(key, 'First note');
  drafts.getState().write(key, 'Third note', '');
  drafts.getState().confirmInput(key, next);
  expect(drafts.getState().drafts[key]?.value).toBe('Third note');
  expect(drafts.getState().pendingInputs[key].map(input => input.value)).toEqual(['Second note']);
});

test('late confirmation removes its recovered input without discarding later typing', () => {
  const key = owner('host-a', '/late-add');
  drafts.getState().write(key, 'Confirmed after reopen', '');
  const ticket = drafts.getState().stageInput(key, 'Confirmed after reopen');
  drafts.getState().restoreInput(key, ticket);
  drafts.getState().confirmInput(key, ticket);
  expect(drafts.getState().drafts[key]).toBeUndefined();
  drafts.getState().write(key, 'Original', '');
  const second = drafts.getState().stageInput(key, 'Original');
  drafts.getState().restoreInput(key, second);
  drafts.getState().write(key, 'New typing', '');
  drafts.getState().confirmInput(key, second);
  expect(drafts.getState().drafts[key]?.value).toBe('New typing');
});
