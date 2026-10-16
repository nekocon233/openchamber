import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeChecklistSource, claudeConfigDir, createClaudeChecklists, readClaudeTaskList, todosFromTodoWrite } from './tasks.js';

const UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const setup = (files = {}, listId = UUID) => {
  const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-checklist-')));
  directories.push(configDir);
  const directory = path.join(configDir, 'tasks', listId);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  return { configDir, listId, directory };
};
const task = (id, extra = {}) => JSON.stringify({ id, subject: `Task ${id}`, status: 'pending', ...extra });
const todoRecord = (todos) => [{ parts: [{ type: 'tool', tool: 'todowrite', state: { status: 'completed', input: { todos } } }] }];
const makeOwner = (options = {}) => {
  const events = [];
  const owner = createClaudeChecklists({ publisher: { checklist: (...args) => events.push(args) }, ...options });
  return { owner, events };
};
const bind = (owner, input, sessionId = 'one') => {
  const source = claudeChecklistSource({ env: { CLAUDE_CONFIG_DIR: input.configDir, CLAUDE_CODE_TASK_LIST_ID: input.listId }, sessionUuid: UUID, directory: '/work' });
  owner.bind(sessionId, '/work', source);
  return source;
};
const item = (id, status = 'pending') => ({ id, subject: `Task ${id}`, status, blocks: [], blockedBy: [] });
const readOf = (items, extra = {}) => async () => ({ exists: true, complete: true, unreadable: 0, items, ...extra });
const idsOf = (snapshot) => snapshot.items.map((entry) => `${entry.id}:${entry.status}`);
const projections = (initial = {}) => {
  const stored = new Map(Object.entries(initial));
  return {
    stored,
    readProjection: async (identity) => stored.get(identity) ?? null,
    writeProjection: async (identity, projection) => { stored.set(identity, projection); },
  };
};

describe('Claude checklist reader', () => {
  it('keeps optional details, numeric order, and partial errors instead of empty success', async () => {
    const input = setup({
      '10.json': task('10'),
      '2.json': task('2', { status: 'completed', description: 'details', activeForm: 'Testing', owner: 'worker', blocks: ['10'], blockedBy: ['1'] }),
      '1.json': task('1', { status: 'in_progress' }),
      '3.json': '{bad',
      '4.json': task('wrong'),
      '.lock': '',
    });
    const result = await readClaudeTaskList(input);
    expect(result).toMatchObject({ exists: true, complete: false, unreadable: 2 });
    expect(result.items.map((item) => item.id)).toEqual(['1', '2', '10']);
    expect(result.items[1]).toEqual({ id: '2', subject: 'Task 2', status: 'completed', description: 'details', activeForm: 'Testing', owner: 'worker', blocks: ['10'], blockedBy: ['1'] });
  });

  it('distinguishes missing, empty, and whole-directory failures', async () => {
    const input = setup();
    expect(await readClaudeTaskList(input)).toEqual({ exists: true, complete: true, unreadable: 0, items: [] });
    expect(await readClaudeTaskList({ ...input, listId: 'missing' })).toEqual({ exists: false, complete: true, unreadable: 0, items: [] });
    fs.rmSync(input.directory, { recursive: true });
    fs.writeFileSync(input.directory, 'not a directory');
    await expect(readClaudeTaskList(input)).rejects.toThrow('not a directory');
    await expect(readClaudeTaskList({ ...input, listId: '../escape' })).rejects.toThrow();
  });

  it('rejects links, non-files, oversize files and unsafe list roots', async () => {
    const input = setup({ '1.json': task('1'), '2.json': ' '.repeat(64 * 1024 + 1) });
    fs.symlinkSync(path.join(input.directory, '1.json'), path.join(input.directory, '3.json'));
    fs.mkdirSync(path.join(input.directory, '4.json'));
    expect(await readClaudeTaskList(input)).toMatchObject({ complete: false, unreadable: 3, items: [{ id: '1' }] });
    fs.renameSync(input.directory, `${input.directory}-real`);
    fs.symlinkSync(`${input.directory}-real`, input.directory);
    await expect(readClaudeTaskList(input)).rejects.toThrow('not a directory');
  });

  it('bounds total bytes and entries without cutting the 1000-item fixture', async () => {
    const input = setup(Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`${index}.json`, task(String(index))])));
    expect(await readClaudeTaskList(input)).toMatchObject({ complete: true, unreadable: 0, items: expect.any(Array) });
    expect((await readClaudeTaskList(input)).items).toHaveLength(1000);
    for (let index = 0; index < 300; index += 1) fs.writeFileSync(path.join(input.directory, `${index}.json`), task(String(index), { description: 'x'.repeat(32_000) }));
    const limited = await readClaudeTaskList(input);
    expect(limited.complete).toBe(false);
    expect(limited.unreadable).toBeGreaterThan(0);
  });

  it('uses only captured config/list identity and preserves TodoWrite activeForm', () => {
    const source = claudeChecklistSource({ env: { CLAUDE_CONFIG_DIR: '/custom', CLAUDE_CODE_TASK_LIST_ID: 'shared', API_KEY: 'test-secret' }, sessionUuid: UUID, directory: '/work' });
    expect(source).toMatchObject({ configDir: '/custom', listId: 'shared' });
    expect(source.identity).not.toContain('/custom');
    expect(JSON.stringify(source)).not.toContain('test-secret');
    expect(claudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
    expect(claudeChecklistSource({ env: { CLAUDE_CODE_TASK_LIST_ID: '../escape' }, sessionUuid: UUID, directory: '/work' })).toBeNull();
    expect(todosFromTodoWrite({ todos: [{ content: 'Plan', status: 'pending', activeForm: 'Planning' }] })).toEqual([{ id: 'todo-1', subject: 'Plan', status: 'pending', activeForm: 'Planning', blocks: [], blockedBy: [] }]);
    expect(todosFromTodoWrite({ todos: 'bad' })).toBeNull();
  });
});

describe('Claude checklist publication', () => {
  it('shares a single read and revision for a list, skips no-op publications', async () => {
    const input = setup({ '1.json': task('1') });
    let reads = 0;
    const { owner, events } = makeOwner({ readFiles: async (source) => { reads += 1; return readClaudeTaskList(source); } });
    bind(owner, input);
    bind(owner, input, 'two');
    const [a, b] = await Promise.all([owner.read('one'), owner.read('two')]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ state: 'ready', source: 'files', revision: 1 });
    expect(reads).toBe(1);
    expect(events.map(([dir, id]) => [dir, id])).toEqual([['/work', 'one'], ['/work', 'two']]);
    expect(await owner.read('one')).toEqual(a);
    expect(events).toHaveLength(2);
  });

  it('uses only confirmed TodoWrite-only history when files never existed', async () => {
    const input = setup();
    fs.rmSync(input.directory, { recursive: true });
    const { owner } = makeOwner();
    bind(owner, input);
    const history = async () => todoRecord([{ content: 'Legacy', status: 'pending' }]);
    expect(await owner.read('one', history)).toMatchObject({ source: 'history', items: [{ subject: 'Legacy' }] });
    fs.mkdirSync(input.directory);
    expect(await owner.read('one', history)).toMatchObject({ source: 'files', items: [] });
    fs.rmSync(input.directory, { recursive: true });
    expect(await owner.read('one', history)).toMatchObject({ source: 'files', items: [] });
    bind(owner, { ...input, listId: 'modern' }, 'modern');
    expect(await owner.read('modern', async () => [...await history(), { parts: [{ type: 'tool', tool: 'TaskCreate' }] }])).toMatchObject({ source: 'files', items: [] });
  });

  it('propagates read failures and never uses history to hide them', async () => {
    const { owner } = makeOwner({ readFiles: async () => { throw new Error('denied'); } });
    bind(owner, setup());
    let historyReads = 0;
    await expect(owner.read('one', async () => { historyReads += 1; return []; })).rejects.toThrow('denied');
    expect(historyReads).toBe(0);
  });

  it('keeps a newer TodoWrite over an in-flight file read and isolates child lists', async () => {
    const gate = Promise.withResolvers();
    const { owner } = makeOwner({ readFiles: () => gate.promise });
    bind(owner, setup());
    owner.bind('child', '/work', { identity: 'todo:child', todoOnly: true });
    const reading = owner.read('one');
    owner.todoWrite('one', todosFromTodoWrite({ todos: [{ content: 'Parent', status: 'pending' }] }));
    owner.todoWrite('child', todosFromTodoWrite({ todos: [{ content: 'Child', status: 'completed' }] }));
    gate.resolve({ exists: false, complete: true, unreadable: 0, items: [] });
    expect(await reading).toMatchObject({ items: [{ subject: 'Parent' }] });
    expect(await owner.read('child')).toMatchObject({ items: [{ subject: 'Child' }] });
  });

  it('isolates TodoWrite per session even when their file lists share one identity', async () => {
    const input = setup();
    fs.rmSync(input.directory, { recursive: true });
    const { owner, events } = makeOwner();
    bind(owner, input, 'one');
    bind(owner, input, 'two');
    owner.todoWrite('one', todosFromTodoWrite({ todos: [{ content: 'Own list', status: 'pending' }] }));
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe('one');
    expect(await owner.read('two')).toMatchObject({ source: 'files', items: [] });
    expect(await owner.read('one')).toMatchObject({ source: 'history', items: [{ subject: 'Own list' }] });
    fs.mkdirSync(input.directory);
    expect(await owner.read('one')).toMatchObject({ source: 'files', items: [] });
    owner.todoWrite('one', todosFromTodoWrite({ todos: [{ content: 'Stale', status: 'pending' }] }));
    expect(await owner.read('one')).toMatchObject({ source: 'files', items: [] });
  });

  it('performs a trailing authoritative read after a mutation overtakes a read', async () => {
    const gate = Promise.withResolvers();
    let reads = 0;
    const { owner } = makeOwner({ readFiles: async () => ++reads === 1 ? gate.promise : { exists: true, complete: true, unreadable: 0, items: [{ id: 'new', subject: 'new', status: 'pending', blocks: [], blockedBy: [] }] } });
    bind(owner, setup());
    const first = owner.read('one');
    const changed = owner.changed('one');
    gate.resolve({ exists: true, complete: true, unreadable: 0, items: [] });
    await first;
    expect(await changed).toMatchObject({ items: [{ id: 'new' }] });
    expect(reads).toBe(2);
  });
});

describe('Claude checklist current plan', () => {
  // The list is what the CLI wrote; the projection only decides what a plan
  // the user has left still shows.
  const makeList = (items) => {
    let current = items;
    const { owner } = makeOwner({ ...projections(), readFiles: async () => ({
      exists: true, complete: true, unreadable: 0, items: current,
    }) });
    return { owner, set: (next) => { current = next; } };
  };

  it('retires finished tasks when the list gains one, and keeps the unfinished ones', async () => {
    const { owner, set } = makeList([item('1', 'completed'), item('2', 'pending')]);
    bind(owner, setup());
    expect(idsOf(await owner.read('one'))).toEqual(['1:completed', '2:pending']);

    set([item('1', 'completed'), item('2', 'pending'), item('3', 'pending')]);
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);
  });

  it('keeps a task that finished, and one that arrived already finished with it', async () => {
    const { owner, set } = makeList([item('1', 'pending')]);
    bind(owner, setup());
    await owner.read('one');

    set([item('1', 'completed')]);
    expect(idsOf(await owner.read('one'))).toEqual(['1:completed']);

    // Task 2 is what this batch added, so the task that finished before it
    // retires and the new one stays whatever it already reports.
    set([item('1', 'completed'), item('2', 'completed')]);
    expect(idsOf(await owner.read('one'))).toEqual(['2:completed']);
    expect(idsOf(await owner.read('one'))).toEqual(['2:completed']);
  });

  it('retires again only when the plan after that gains another task', async () => {
    const { owner, set } = makeList([item('1', 'completed'), item('2', 'pending')]);
    bind(owner, setup());
    await owner.read('one');

    set([item('1', 'completed'), item('2', 'completed'), item('3', 'pending')]);
    expect(idsOf(await owner.read('one'))).toEqual(['3:pending']);

    set([item('1', 'completed'), item('2', 'completed'), item('3', 'completed'), item('4', 'pending')]);
    expect(idsOf(await owner.read('one'))).toEqual(['4:pending']);
  });

  it('shows a retired task again when it runs once more', async () => {
    const { owner, set } = makeList([item('1', 'completed'), item('2', 'pending')]);
    bind(owner, setup());
    await owner.read('one');
    set([item('1', 'completed'), item('2', 'pending'), item('3', 'pending')]);
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);

    set([item('1', 'in_progress'), item('2', 'pending'), item('3', 'pending')]);
    expect(idsOf(await owner.read('one'))).toEqual(['1:in_progress', '2:pending', '3:pending']);
  });

  it('reads a list with no baseline as one, retiring nothing it did not see arrive', async () => {
    const { owner } = makeList([item('1', 'completed'), item('2', 'completed')]);
    bind(owner, setup());
    expect(idsOf(await owner.read('one'))).toEqual(['1:completed', '2:completed']);
  });

  it('retires on the first read when the tool named the task it created', async () => {
    const { owner } = makeList([item('1', 'completed'), item('2', 'completed'), item('3', 'pending')]);
    bind(owner, setup());
    await owner.created('one', '3');
    expect(idsOf(await owner.read('one'))).toEqual(['3:pending']);
  });

  it('keeps a partial read from retiring or moving the baseline', async () => {
    let complete = true;
    let current = [item('1', 'completed')];
    const { owner } = makeOwner({
      ...projections(),
      readFiles: async () => ({ exists: true, complete, unreadable: complete ? 0 : 1, items: current }),
    });
    bind(owner, setup());
    await owner.read('one');

    // A partial read shows a task the baseline does not hold yet, and retires
    // nothing: it cannot say what else the list contains.
    complete = false;
    current = [item('1', 'completed'), item('2', 'pending')];
    expect(idsOf(await owner.read('one'))).toEqual(['1:completed', '2:pending']);

    // The complete read that follows reads the same list as a new one, so the
    // baseline stayed where the partial read left it.
    complete = true;
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending']);

    current = [item('1', 'completed'), item('2', 'pending'), item('3', 'pending')];
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);
  });

  it('reopens a retired task a partial read shows running again', async () => {
    let complete = true;
    let current = [item('1', 'completed'), item('2', 'pending')];
    const { owner } = makeOwner({
      ...projections(),
      readFiles: async () => ({ exists: true, complete, unreadable: 0, items: current }),
    });
    bind(owner, setup());
    await owner.read('one');
    current = [item('1', 'completed'), item('2', 'pending'), item('3', 'pending')];
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);

    complete = false;
    current = [item('1', 'in_progress'), item('2', 'pending')];
    expect(idsOf(await owner.read('one'))).toEqual(['1:in_progress', '2:pending']);
  });

  it('keeps the previous list when the projection cannot be saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stored = new Map();
    let failing = false;
    let current = [item('1', 'completed'), item('2', 'pending')];
    const { owner } = makeOwner({
      readFiles: async () => ({ exists: true, complete: true, unreadable: 0, items: current }),
      readProjection: async (identity) => stored.get(identity) ?? null,
      writeProjection: async (identity, projection) => {
        if (failing) throw new Error('disk full');
        stored.set(identity, projection);
      },
    });
    bind(owner, setup());
    await owner.read('one');

    failing = true;
    current = [item('1', 'completed'), item('2', 'pending'), item('3', 'pending')];
    expect(idsOf(await owner.read('one'))).toEqual(['1:completed', '2:pending', '3:pending']);

    failing = false;
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);
  });

  it('keeps the projection when the task directory is missing', async () => {
    let current = [item('1', 'completed'), item('2', 'pending')];
    let exists = true;
    const { owner } = makeOwner({
      ...projections(),
      readFiles: async () => (exists
        ? { exists: true, complete: true, unreadable: 0, items: current }
        : { exists: false, complete: true, unreadable: 0, items: [] }),
    });
    bind(owner, setup());
    await owner.read('one');
    current = [item('1', 'completed'), item('2', 'pending'), item('3', 'pending')];
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);

    exists = false;
    expect(idsOf(await owner.read('one'))).toEqual([]);
    exists = true;
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);
  });

  it('shares one projection between the sessions bound to a list, and keeps it across a rebind', async () => {
    const input = setup();
    const { owner, set } = makeList([item('1', 'completed'), item('2', 'pending')]);
    bind(owner, input, 'one');
    bind(owner, input, 'two');
    await owner.read('one');
    set([item('1', 'completed'), item('2', 'pending'), item('3', 'pending')]);
    await owner.read('two');
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);

    owner.forget('one');
    owner.forget('two');
    bind(owner, input, 'one');
    expect(idsOf(await owner.read('one'))).toEqual(['2:pending', '3:pending']);
  });

  it('does not project a TodoWrite-only list', async () => {
    const { owner } = makeOwner({ readFiles: async () => ({ exists: false, complete: true, unreadable: 0, items: [] }) });
    owner.bind('child', '/work', { identity: 'todo:child', todoOnly: true });
    owner.todoWrite('child', todosFromTodoWrite({ todos: [{ content: 'Legacy', status: 'completed' }] }));
    expect(idsOf(await owner.read('child'))).toEqual(['todo-1:completed']);
    await expect(owner.created('child', 'todo-2')).resolves.toMatchObject({ state: 'unavailable' });
  });
});
