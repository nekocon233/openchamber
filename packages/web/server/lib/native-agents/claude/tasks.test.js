import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
