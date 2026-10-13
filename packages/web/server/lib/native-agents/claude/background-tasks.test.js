import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeTaskOutputRoot, createClaudeBackgroundTasks } from './background-tasks.js';

const UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const setup = ({ query = {}, nextRevision, openFile } = {}) => {
  const outputRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-task-output-')));
  directories.push(outputRoot);
  const events = [];
  const stopped = [];
  const reads = [];
  let revision = 0;
  const tasks = createClaudeBackgroundTasks({
    sessionUuid: UUID, outputRoot,
    query: { stopTask: async (taskId) => { stopped.push(taskId); }, readFile: async () => { throw new Error('Path-based reads must not be used'); }, ...query },
    openFile: openFile ?? (async (file, flags) => { reads.push([file, flags]); return fs.promises.open(file, flags); }),
    publish: (snapshot) => events.push(snapshot), nextRevision: nextRevision ?? (() => ++revision),
    childSessionForTool: (tool) => tool === 'child-tool' ? 'ncl_child' : null,
  });
  const outputFile = (id, contents = '') => {
    const directory = path.join(outputRoot, 'project', UUID, 'tasks');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${id}.output`);
    fs.writeFileSync(file, contents);
    return file;
  };
  return { tasks, events, stopped, reads, outputRoot, outputFile };
};
const member = (id, extra = {}) => ({ task_id: id, task_type: 'local_agent', description: `Task ${id}`, ...extra });
const level = (tasks, members) => tasks.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: members });
const edge = (tasks, subtype, data = {}) => tasks.observe({ type: 'system', subtype, task_id: 'a', ...data });

describe('Claude query background tasks', () => {
  it('starts unknown and never promotes edge events to membership', () => {
    const { tasks } = setup();
    expect(tasks.snapshot()).toMatchObject({ state: 'unknown', generation: expect.any(String), tasks: [] });
    edge(tasks, 'task_started', { tool_use_id: 'child-tool', description: 'Research' });
    expect(tasks.snapshot()).toMatchObject({ state: 'unknown', tasks: [{ id: 'a', status: 'running', active: false, canStop: false, childSessionId: 'ncl_child' }] });
    expect(tasks.activity()).toEqual([]);
    level(tasks, []);
    expect(tasks.snapshot().state).toBe('active');
  });

  it.each(['level-first', 'edge-first'])('keeps level membership separate from outcomes in %s order', (order) => {
    const { tasks } = setup();
    const started = () => edge(tasks, 'task_started', { description: 'Research', tool_use_id: 'child-tool' });
    if (order === 'edge-first') started();
    level(tasks, [member('a'), member('b')]);
    if (order === 'level-first') started();
    expect(tasks.snapshot().tasks[0].description).toBe('Research');
    edge(tasks, 'task_notification', { status: 'failed', summary: 'failed' });
    expect(tasks.snapshot().tasks[0]).toMatchObject({ id: 'a', status: 'failed', active: true, canStop: true });
    expect(tasks.activity().map((task) => task.id)).toEqual(['a', 'b']);
    level(tasks, [member('b')]);
    expect(tasks.snapshot().tasks[0]).toMatchObject({ status: 'failed', active: false, canStop: false });
    expect(tasks.activity().map((task) => task.id)).toEqual(['b']);
    edge(tasks, 'task_started');
    expect(tasks.snapshot().tasks[0].status).toBe('failed');
    level(tasks, []);
    expect(tasks.snapshot().tasks[1]).toMatchObject({ id: 'b', status: 'unknown', active: false });
  });

  it('skips duplicate revisions, preserves malformed sets, and excludes ambient from activity', () => {
    const { tasks, events } = setup();
    const set = [member('a'), member('watch', { ambient: true })];
    level(tasks, set);
    const before = tasks.snapshot();
    level(tasks, set);
    level(tasks, null);
    level(tasks, [member('a'), member('a')]);
    expect(tasks.snapshot()).toEqual(before);
    expect(events).toHaveLength(1);
    expect(tasks.activity()).toEqual([{ id: 'a', type: 'local_agent', description: 'Task a' }]);
    expect(before.tasks[1]).toMatchObject({ ambient: true, active: true, canStop: true });
    level(tasks, [member('a', { ambient: true }), member('watch', { ambient: true })]);
    expect(tasks.activity()).toEqual([]);
  });

  it('merges real progress and patch fields without fabricating times', () => {
    const { tasks } = setup();
    level(tasks, [member('a')]);
    edge(tasks, 'task_progress', { usage: { total_tokens: 10, tool_uses: 2, duration_ms: 42 }, summary: 'Reading', last_tool_name: 'Read' });
    edge(tasks, 'task_updated', { patch: { status: 'paused', description: 'Waiting', error: 'retry', end_time: 100 } });
    expect(tasks.snapshot().tasks[0]).toMatchObject({ status: 'paused', description: 'Waiting', summary: 'Reading', lastToolName: 'Read', endedAt: 100, usage: { totalTokens: 10, toolUses: 2, durationMs: 42 } });
    expect(tasks.snapshot().tasks[0].startedAt).toBeUndefined();
  });

  it('caps recent terminal records at 100 while keeping every live task', () => {
    const { tasks } = setup();
    level(tasks, Array.from({ length: 100 }, (_, index) => member(`live-${index}`)));
    for (let index = 0; index < 130; index += 1) edge(tasks, 'task_notification', { task_id: `done-${index}`, status: 'completed' });
    expect(tasks.snapshot()).toMatchObject({ omitted: 30 });
    expect(tasks.snapshot().tasks).toHaveLength(200);
    expect(tasks.activity()).toHaveLength(100);
    expect(tasks.snapshot().tasks.some((task) => task.id === 'done-0')).toBe(false);
  });

  it('bounds disappearance without an end edge but never invents successful outcomes', () => {
    const { tasks } = setup();
    for (let index = 0; index < 150; index += 1) level(tasks, [member(`missed-${index}`)]);
    level(tasks, []);
    expect(tasks.snapshot()).toMatchObject({ omitted: 50 });
    expect(tasks.snapshot().tasks).toHaveLength(100);
    expect(tasks.snapshot().tasks.every((task) => task.status === 'unknown' && !task.active)).toBe(true);
  });

  it('clears all records/output grants on close and advances revision across generations', () => {
    let revision = 0;
    const nextRevision = () => ++revision;
    const a = setup({ nextRevision });
    level(a.tasks, [member('a')]);
    const before = a.tasks.snapshot();
    a.tasks.close();
    expect(a.tasks.snapshot()).toMatchObject({ state: 'inactive', generation: null, tasks: [], omitted: 0 });
    expect(a.tasks.snapshot().revision).toBeGreaterThan(before.revision);
    const b = setup({ nextRevision });
    expect(b.tasks.snapshot().generation).not.toBe(before.generation);
    expect(b.tasks.snapshot().revision).toBeGreaterThan(a.tasks.snapshot().revision);
    edge(a.tasks, 'task_started');
    expect(a.tasks.snapshot().tasks).toEqual([]);
  });

  it('stops only the owned live task, validates generation, and coalesces concurrent stops', async () => {
    const gate = Promise.withResolvers();
    const calls = [];
    const { tasks } = setup({ query: { stopTask: async (task) => { calls.push(task); await gate.promise; } } });
    level(tasks, [member('a'), member('b')]);
    const { generation } = tasks.snapshot();
    await expect(tasks.stop('a', 'old')).rejects.toMatchObject({ code: 'NATIVE_TASK_GENERATION_MISMATCH' });
    await expect(tasks.stop('foreign', generation)).rejects.toMatchObject({ code: 'NATIVE_TASK_NOT_FOUND' });
    const first = tasks.stop('a', generation);
    const duplicate = tasks.stop('a', generation);
    gate.resolve();
    expect(await first).toEqual({ accepted: true });
    expect(await duplicate).toEqual({ accepted: true });
    expect(calls).toEqual(['a']);
    expect(tasks.activity()).toHaveLength(2);
    level(tasks, [member('b')]);
    await expect(tasks.stop('a', generation)).rejects.toMatchObject({ code: 'NATIVE_TASK_STOP_UNAVAILABLE' });
  });

  it('reports a failed stop on only that task and permits retry', async () => {
    let failures = 1;
    const { tasks } = setup({ query: { stopTask: async () => { if (failures-- > 0) throw new Error('private details'); } } });
    level(tasks, [member('a'), member('b')]);
    const { generation } = tasks.snapshot();
    await expect(tasks.stop('a', generation)).rejects.toMatchObject({ code: 'NATIVE_TASK_STOP_FAILED' });
    expect(tasks.snapshot().tasks[0].error).toBe('Could not stop this task');
    expect(tasks.snapshot().tasks[1].error).toBeUndefined();
    expect(await tasks.stop('a', generation)).toEqual({ accepted: true });
  });
});

describe('Claude task output authorization', () => {
  it('returns empty output and bounds UTF-8 bytes through a pinned file descriptor', async () => {
    const { tasks, outputFile, reads } = setup();
    level(tasks, [member('a')]);
    const { generation } = tasks.snapshot();
    expect(await tasks.output('a', generation)).toEqual({ state: 'unavailable', reason: 'not_recorded' });
    const file = outputFile('a');
    tasks.outputFromTool({ taskId: 'a', file });
    expect(await tasks.output('a', generation)).toEqual({ state: 'ready', text: '', truncated: false });
    fs.writeFileSync(file, '漢'.repeat(100_000));
    const result = await tasks.output('a', generation);
    expect(result.state).toBe('ready');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(256 * 1024);
    expect(reads[0][1] & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
  });

  it('rejects cross-task/session paths, traversal, arbitrary logs, and missing query methods', async () => {
    const { tasks, outputRoot, outputFile } = setup({ query: { stopTask: undefined, readFile: undefined } });
    level(tasks, [member('a')]);
    for (const file of [outputFile('other'), path.join(outputRoot, 'project', 'other-session', 'tasks', 'a.output'), '/etc/passwd', path.join(outputRoot, 'a.output')]) tasks.outputFromTool({ taskId: 'a', file });
    expect(tasks.snapshot().tasks[0]).toMatchObject({ canStop: false, outputAvailable: false });
    const { generation } = tasks.snapshot();
    expect(await tasks.output('a', generation)).toEqual({ state: 'unavailable', reason: 'not_recorded' });
    await expect(tasks.output('a', 'another-query')).rejects.toMatchObject({ code: 'NATIVE_TASK_GENERATION_MISMATCH' });
    await expect(tasks.output('unknown', generation)).rejects.toMatchObject({ code: 'NATIVE_TASK_NOT_FOUND' });
  });

  it.each(['file-link', 'directory-link', 'non-file', 'missing'])('rejects %s before SDK reads', async (kind) => {
    const { tasks, outputFile, reads } = setup();
    level(tasks, [member('a')]);
    const file = outputFile('a', 'private');
    tasks.outputFromTool({ taskId: 'a', file });
    if (kind === 'directory-link') {
      const parent = path.dirname(file);
      fs.renameSync(parent, `${parent}-real`);
      fs.symlinkSync(`${parent}-real`, parent);
    } else {
      fs.rmSync(file);
      if (kind === 'file-link') fs.symlinkSync(outputFile('secret', 'secret'), file);
      if (kind === 'non-file') fs.mkdirSync(file);
    }
    expect(await tasks.output('a', tasks.snapshot().generation)).toEqual({ state: 'unavailable', reason: 'unreadable' });
    expect(reads).toEqual([]);
  });

  it('discards an output read that overlaps query closure', async () => {
    const gate = Promise.withResolvers();
    const opened = Promise.withResolvers();
    const { tasks, outputFile } = setup({ openFile: async (file, flags) => {
      const handle = await fs.promises.open(file, flags);
      opened.resolve();
      await gate.promise;
      return handle;
    } });
    const file = outputFile('a', 'a');
    tasks.outputFromTool({ taskId: 'a', file });
    const pending = tasks.output('a', tasks.snapshot().generation);
    await opened.promise;
    tasks.close();
    gate.resolve();
    expect(await pending).toEqual({ state: 'unavailable', reason: 'query_closed' });
  });

  it('accepts only the trusted root alias in either CLI spelling', async () => {
    const base = fs.mkdtempSync('/tmp/oc-task-alias-');
    directories.push(base);
    const canonical = fs.realpathSync(base);
    const root = path.join(base, 'claude-root');
    const canonicalRoot = path.join(canonical, 'claude-root');
    const output = path.join(canonicalRoot, 'project', UUID, 'tasks', 'a.output');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, 'alias');
    for (const file of [output, path.join(root, 'project', UUID, 'tasks', 'a.output')]) {
      const tasks = createClaudeBackgroundTasks({ sessionUuid: UUID, outputRoot: root,
        query: { readFile: async (target) => ({ contents: fs.readFileSync(target, 'utf8'), absPath: target }) },
        publish: () => {}, nextRevision: () => 1,
      });
      tasks.outputFromTool({ taskId: 'a', file });
      expect(await tasks.output('a', tasks.snapshot().generation)).toEqual({ state: 'ready', text: 'alias', truncated: false });
    }
  });

  it.each(['symlink', 'regular-file'])('rejects %s replacement between path checks and opening', async (replacement) => {
    let foreign;
    const harness = setup({ openFile: async (file, flags) => {
      fs.renameSync(file, `${file}-original`);
      if (replacement === 'symlink') fs.symlinkSync(foreign, file);
      else fs.writeFileSync(file, 'foreign');
      return fs.promises.open(file, flags);
    } });
    foreign = harness.outputFile('foreign', 'private');
    harness.tasks.outputFromTool({ taskId: 'a', file: harness.outputFile('a', 'authorized') });
    expect(await harness.tasks.output('a', harness.tasks.snapshot().generation)).toEqual({ state: 'unavailable', reason: 'unreadable' });
  });

  it('a swap after opening cannot retarget the pinned descriptor', async () => {
    let foreign;
    const harness = setup({ openFile: async (file, flags) => {
      const handle = await fs.promises.open(file, flags);
      fs.renameSync(file, `${file}-original`);
      fs.symlinkSync(foreign, file);
      return handle;
    } });
    foreign = harness.outputFile('foreign', 'private');
    harness.tasks.outputFromTool({ taskId: 'a', file: harness.outputFile('a', 'authorized') });
    expect(await harness.tasks.output('a', harness.tasks.snapshot().generation)).toEqual({ state: 'unavailable', reason: 'unreadable' });
  });

  it('uses captured temp base without broadening to the entire temp directory', () => {
    expect(claudeTaskOutputRoot({ CLAUDE_CODE_TMPDIR: '/nonexistent/private' }, 'darwin')).toBe(`/nonexistent/private/claude-${process.getuid()}`);
    expect(claudeTaskOutputRoot({ TMPDIR: '/nonexistent/linux' }, 'linux')).toBe(`/nonexistent/linux/claude-${process.getuid()}`);
    expect(claudeTaskOutputRoot({ TEMP: '/nonexistent/windows' }, 'win32')).toBe('/nonexistent/windows/claude');
  });
});
