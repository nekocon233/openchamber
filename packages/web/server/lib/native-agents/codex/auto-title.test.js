import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createCodexAutoTitles } from './auto-title.js';
import { createCodexSessionStore } from './store.js';

const THREAD = '01a0d2a6-b55b-7162-a837-c62053537e00';
const SESSION = 'ncx_' + THREAD;
const DIRECTORY = '/work/project';
const TURN = 'first-turn';
const entry = { backend: 'codex', origin: 'openchamber', directory: DIRECTORY };
const user = (text) => ({ type: 'userMessage', id: 'user', content: [{ type: 'text', text }] });
const answer = (text, phase = 'final_answer') => ({ type: 'agentMessage', id: 'answer', text, phase });

const fixture = ({ generateText = async () => ({ text: '修复登录超时' }), beforeWrite = async () => {}, publish = async () => {} } = {}) => {
  const state = {
    thread: { id: THREAD, name: null, preview: '请修复登录超时', cwd: DIRECTORY, createdAt: 1, updatedAt: 2 },
    turn: { id: TURN, status: 'completed', items: [user('请修复登录超时'), answer('已修复登录请求的超时处理。')] },
    revert: null,
    readError: null,
  };
  const calls = [];
  const generated = [];
  const published = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (state.readError && method !== 'thread/name/set') throw state.readError;
    if (method === 'thread/read') return { thread: { ...state.thread } };
    if (method === 'thread/turns/list') return { data: state.turn ? [{ ...state.turn, items: params.itemsView === 'full' ? state.turn.items : [] }] : [], nextCursor: null };
    if (method === 'thread/name/set') {
      await beforeWrite(params.name);
      state.thread.name = params.name;
      return {};
    }
    throw new Error('Unexpected request: ' + method);
  };
  const store = createCodexSessionStore({ appServer: { request } });
  const titles = createCodexAutoTitles({
    store,
    pendingRevert: async () => state.revert,
    generateText: async (input) => { generated.push(input); return generateText(input); },
    publishSession: async () => {
      await publish();
      published.push((await store.getSession(SESSION, DIRECTORY)).title);
    },
  });
  const run = (initialSession = Promise.resolve(entry)) => titles.generate({ sessionId: SESSION, directory: DIRECTORY, turnId: TURN, initialSession });
  return { state, calls, generated, published, store, titles, run };
};

describe('automatic Codex titles', () => {
  it('accepts the CLI canonical path for a directory opened through a symlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-title-directory-'));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'project');
    const alias = path.join(root, 'alias');
    await fs.mkdir(directory);
    await fs.symlink(directory, alias, 'junction');
    const { store, state } = fixture();
    state.thread.cwd = await fs.realpath(directory);
    expect(await store.initialTitleTurn(SESSION, alias, TURN, 'full')).toMatchObject({ id: TURN });
    expect(await store.renameInitialTurn(SESSION, alias, TURN, 'Title', new AbortController().signal)).toBe(true);
    expect(state.thread.name).toBe('Title');
  });

  it('generates from the first successful reply, persists the CLI name and publishes it', async () => {
    const { run, state, generated, published, calls, store } = fixture();
    state.turn.items.splice(1, 0,
      { type: 'commandExecution', id: 'tool', aggregatedOutput: 'private tool output' },
      answer('Progress text', 'commentary'),
      user('<openchamber-instructions>private instructions</openchamber-instructions>'));
    expect(await run()).toBe(true);
    expect(JSON.parse(generated[0].prompt)).toEqual({ user: '请修复登录超时', assistant: '已修复登录请求的超时处理。' });
    expect(generated[0]).toMatchObject({ preferredProviderID: 'codex-native', restrictToPreferredProvider: true, maxOutputTokens: 128, timeoutMs: 60_000 });
    expect((await store.getSession(SESSION, DIRECTORY)).title).toBe('修复登录超时');
    expect(published).toEqual(['修复登录超时']);
    expect(calls.filter((call) => call.method === 'thread/turns/list').map((call) => call.params)).toEqual([
      { threadId: THREAD, sortDirection: 'asc', limit: 1, itemsView: 'full' },
      { threadId: THREAD, sortDirection: 'asc', limit: 1, itemsView: 'notLoaded' },
    ]);
    expect(await run()).toBe(false);
    expect(generated).toHaveLength(1);
  });

  it.each([
    { name: 'My own title' },
    { path: '/home/.codex/archived_sessions/thread.jsonl' },
    { parentThreadId: 'parent' },
    { cwd: '/other/project' },
  ])('keeps a named, archived, child or moved thread unchanged', async (patch) => {
    const { run, state, generated } = fixture();
    Object.assign(state.thread, patch);
    expect(await run()).toBe(false);
    expect(generated).toHaveLength(0);
  });

  it.each([
    null,
    { ...entry, origin: 'adopted' },
    { ...entry, backend: 'claude' },
    { ...entry, title: 'Initial custom title' },
  ])('skips ineligible session records before requesting history', async (initial) => {
    const { run, calls } = fixture();
    expect(await run(Promise.resolve(initial))).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each(['failed', 'interrupted', 'inProgress'])('does not title a %s first turn', async (status) => {
    const { run, state, generated } = fixture();
    state.turn.status = status;
    expect(await run()).toBe(false);
    expect(generated).toHaveLength(0);
  });

  it('does not title a later turn or an empty first reply', async () => {
    const { run, state, generated } = fixture();
    state.turn.id = 'different-first-turn';
    expect(await run()).toBe(false);
    state.turn.id = TURN;
    state.turn.items = [user('Question'), answer('progress only', 'commentary')];
    expect(await run()).toBe(false);
    expect(generated).toHaveLength(0);
  });

  it('deduplicates the same completion and bounds retained input', async () => {
    const result = Promise.withResolvers();
    const { run, state, generated } = fixture({ generateText: () => result.promise });
    state.turn.items = [user('x'.repeat(100_000)), answer('y'.repeat(100_000))];
    const first = run();
    const repeated = run();
    await vi.waitFor(() => expect(generated).toHaveLength(1));
    const context = JSON.parse(generated[0].prompt);
    expect(context.user.length).toBeLessThanOrEqual(4000);
    expect(context.assistant.length).toBeLessThanOrEqual(8000);
    result.resolve({ text: 'A short title' });
    expect(await Promise.all([first, repeated])).toEqual([true, true]);
  });

  it.each(['rename', 'archive', 'delete', 'revert', 'move'])('rechecks %s changes before writing', async (change) => {
    const result = Promise.withResolvers();
    const { run, state, generated, published } = fixture({ generateText: () => result.promise });
    const done = run();
    await vi.waitFor(() => expect(generated).toHaveLength(1));
    if (change === 'rename') state.thread.name = 'Manual title';
    if (change === 'archive') state.thread.path = '/home/.codex/archived_sessions/thread.jsonl';
    if (change === 'delete') state.turn = null;
    if (change === 'revert') state.revert = { phase: 'pending' };
    if (change === 'move') state.thread.cwd = '/other';
    result.resolve({ text: 'Late AI title' });
    expect(await done).toBe(false);
    expect(published).toEqual([]);
  });

  it('cancels before the initial session refresh finishes', async () => {
    const initial = Promise.withResolvers();
    const { run, titles, calls } = fixture();
    const done = run(initial.promise);
    await titles.cancel(SESSION);
    initial.resolve(entry);
    expect(await done).toBe(false);
    expect(calls).toEqual([]);
  });

  it('lets manual rename finish without waiting for a canceled model response', async () => {
    const result = Promise.withResolvers();
    const { run, titles, store, generated, state } = fixture({ generateText: () => result.promise });
    const done = run();
    await vi.waitFor(() => expect(generated).toHaveLength(1));
    await titles.cancel(SESSION);
    expect(generated[0].signal.aborted).toBe(true);
    await store.rename(SESSION, 'Manual title');
    result.resolve({ text: 'Late AI title' });
    expect(await done).toBe(false);
    expect(state.thread.name).toBe('Manual title');
  });

  it('orders manual rename after an automatic write already in flight', async () => {
    const saved = Promise.withResolvers();
    const { run, titles, store, calls, state, published } = fixture({ beforeWrite: (title) => title === '修复登录超时' ? saved.promise : Promise.resolve() });
    const done = run();
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'thread/name/set')).toBe(true));
    const manual = titles.cancel(SESSION).then(() => store.rename(SESSION, 'Manual title'));
    saved.resolve();
    await Promise.all([done, manual]);
    expect(state.thread.name).toBe('Manual title');
    expect(published).toEqual([]);
  });

  it('preserves a manual write that started before automatic generation', async () => {
    const saved = Promise.withResolvers();
    const { run, store, generated, state, published } = fixture({ beforeWrite: (title) => title === 'Manual title' ? saved.promise : Promise.resolve() });
    const manual = store.rename(SESSION, 'Manual title');
    const done = run();
    await vi.waitFor(() => expect(generated).toHaveLength(1));
    saved.resolve();
    await manual;
    expect(await done).toBe(false);
    expect(state.thread.name).toBe('Manual title');
    expect(published).toEqual([]);
  });

  it('finishes an automatic publication before a manual rename can publish', async () => {
    const publication = Promise.withResolvers();
    let publishing = false;
    const { run, titles, store, state, published } = fixture({ publish: async () => { publishing = true; await publication.promise; } });
    const done = run();
    await vi.waitFor(() => expect(publishing).toBe(true));
    const manual = titles.cancel(SESSION).then(() => store.rename(SESSION, 'Manual title'));
    publication.resolve();
    await Promise.all([done, manual]);
    expect(published).toEqual(['修复登录超时']);
    expect(state.thread.name).toBe('Manual title');
  });

  it('preserves the preview on generation, parsing, read and write failures', async () => {
    for (const fail of ['generation', 'empty', 'read', 'write']) {
      const setup = fixture({
        generateText: async () => {
          if (fail === 'generation') throw new Error('Model unavailable');
          return { text: fail === 'empty' ? '' : 'Title' };
        },
        beforeWrite: async () => { if (fail === 'write') throw new Error('Write failed'); },
      });
      if (fail === 'read') setup.state.readError = new Error('CLI unavailable');
      await expect(setup.run()).rejects.toThrow();
      expect(setup.state.thread.name).toBeNull();
      expect(setup.published).toEqual([]);
    }
  });

  it('aborts outstanding work on shutdown and refuses later completions', async () => {
    const result = Promise.withResolvers();
    const { run, titles, generated, published } = fixture({ generateText: () => result.promise });
    const done = run();
    await vi.waitFor(() => expect(generated).toHaveLength(1));
    await titles.stop();
    result.resolve({ text: 'Late title' });
    expect(await done).toBe(false);
    expect(await run()).toBe(false);
    expect(published).toEqual([]);
  });
});
