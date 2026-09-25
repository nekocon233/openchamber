import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNativeRegistry } from '../registry.js';
import { JsonRpcError } from './rpc.js';
import { createCodexSessionStore } from './store.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const DIRECTORY = '/work/project';
const THREAD_ID = '01a0d2a6-b55b-7162-a837-c62053537e00';
const CHILD_THREAD = '01a0d2a6-c000-7000-8000-000000000001';

const thread = (id, extra = {}) => ({
  id,
  cwd: DIRECTORY,
  name: null,
  preview: `preview ${id}`,
  model: 'gpt-5.5',
  originator: 'codex-tui',
  createdAt: 1790240535,
  updatedAt: 1790240555,
  ...extra,
});

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const createHarness = (handlers) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-codex-store-'));
  directories.push(dir);
  const calls = [];
  const appServer = {
    request: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler(params);
    },
  };
  const registry = createNativeRegistry({ filePath: path.join(dir, 'registry.json') });
  return { store: createCodexSessionStore({ appServer, registry }), calls };
};

describe('Codex session store', () => {
  it('returns the thread’s own directory when resuming by id from another project', async () => {
    const { store } = createHarness({ 'thread/read': async () => ({ thread: thread(THREAD_ID, { cwd: '/work/actual-project' }) }) });
    expect((await store.getSession(`ncx_${THREAD_ID}`, '/work/previous-project')).directory).toBe('/work/actual-project');
  });

  it('refuses a thread without a working directory instead of assigning the caller’s project', async () => {
    const { store } = createHarness({ 'thread/read': async () => ({ thread: thread(THREAD_ID, { cwd: null }) }) });
    await expect(store.getSession(`ncx_${THREAD_ID}`, DIRECTORY)).rejects.toThrow('working directory');
  });

  it('lists interactive threads for the directory and hides the old plugin threads', async () => {
    const { store, calls } = createHarness({
      'thread/list': async ({ archived }) => ({
        data: archived
          ? [thread('01a0d2a6-0000-7000-8000-00000000000a', { name: 'Old' })]
          : [thread(THREAD_ID, { preview: 'First line\nsecond line' }), thread('01a0d2a6-0000-7000-8000-00000000000b', { originator: 'openchamber_codex' })],
        nextCursor: null,
      }),
    });
    const sessions = await store.listRootSessions(DIRECTORY);
    expect(sessions.map((session) => [session.id, session.title, session.time.archived])).toEqual([
      [`ncx_${THREAD_ID}`, 'First line', undefined],
      ['ncx_01a0d2a6-0000-7000-8000-00000000000a', 'Old', 1790240555000],
    ]);
    expect(calls[0].params).toMatchObject({ cwd: DIRECTORY, sourceKinds: ['cli', 'vscode'] });
  });

  it('projects a thread and returns the subagent threads its collab calls name', async () => {
    const turns = fixture('gpt55-tools.turns.json').data;
    turns[0].items.push({
      type: 'collabAgentToolCall',
      id: 'collab-1',
      tool: 'spawnAgent',
      prompt: 'Look around',
      receiverThreadIds: [CHILD_THREAD],
      status: 'completed',
    });
    const { store } = createHarness({
      'thread/read': async ({ threadId }) => ({ thread: thread(threadId, threadId === CHILD_THREAD ? { parentThreadId: THREAD_ID } : {}) }),
      'thread/turns/list': async () => ({ data: turns, nextCursor: null }),
    });
    const history = await store.loadHistory(`ncx_${THREAD_ID}`, DIRECTORY);
    expect(history.records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    const task = history.records[1].parts.find((part) => part.type === 'tool' && part.tool === 'task');
    expect(task.state.metadata).toEqual({ sessionId: `ncx_${CHILD_THREAD}` });
    expect(history.childSessions).toEqual([expect.objectContaining({ id: `ncx_${CHILD_THREAD}`, parentID: `ncx_${THREAD_ID}` })]);
  });

  it('rewinds before the turn a message starts, and refuses a message steered into a turn', async () => {
    const user = (id, clientId = null) => ({ type: 'userMessage', id, clientId, content: [{ type: 'text', text: id }] });
    const reply = (id) => ({ type: 'agentMessage', id, text: 'ok' });
    const turns = [
      { id: 'turn-1', status: 'completed', items: [user('item-1', 'ncx_u_5b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f'), reply('r-1')] },
      { id: 'turn-2', status: 'completed', items: [user('item-2'), reply('r-2'), user('item-3', 'ncx_u_6c1f2d63-3a2a-4d5b-8e9f-1b2c3d4e5f60'), reply('r-3')] },
      { id: 'turn-3', status: 'completed', items: [user('item-4'), reply('r-4')] },
    ];
    const { store } = createHarness({ 'thread/turns/list': async () => ({ data: turns, nextCursor: null }) });
    const sessionId = `ncx_${THREAD_ID}`;
    const typedElsewhere = (itemId) => `ncx_u_${THREAD_ID.replaceAll('-', '')}_${itemId}`;

    expect(await store.rewindTarget(sessionId, typedElsewhere('item-2'))).toEqual({
      beforeTurnId: 'turn-2',
      messageIds: [typedElsewhere('item-2'), 'ncx_u_6c1f2d63-3a2a-4d5b-8e9f-1b2c3d4e5f60', typedElsewhere('item-4')],
    });
    expect((await store.rewindTarget(sessionId, 'ncx_u_5b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f')).beforeTurnId).toBe('turn-1');
    await expect(store.rewindTarget(sessionId, 'ncx_u_6c1f2d63-3a2a-4d5b-8e9f-1b2c3d4e5f60')).rejects.toMatchObject({ code: 'NATIVE_REVERT_MID_TURN', status: 409 });
    await expect(store.rewindTarget(sessionId, 'ncx_u_7d2f3e74-4b3b-4e6c-9f0a-2c3d4e5f6071')).rejects.toMatchObject({ code: 'NATIVE_MESSAGE_NOT_FOUND', status: 404 });
  });

  it('forks before a turn and names the fork after its source, keeping the fork mark', async () => {
    const FORK_THREAD = '01a0d2a6-f000-7000-8000-000000000009';
    const longPreview = `Refactor ${'the parser '.repeat(15)}`.trim();
    const { store, calls } = createHarness({
      'thread/read': async ({ threadId }) => ({ thread: thread(threadId, { preview: longPreview }) }),
      'thread/fork': async () => ({ thread: { id: FORK_THREAD } }),
      'thread/name/set': async () => ({}),
    });

    expect(await store.fork(`ncx_${THREAD_ID}`, DIRECTORY, 'turn-2')).toBe(FORK_THREAD);

    expect(calls.find((call) => call.method === 'thread/fork').params).toEqual({
      threadId: THREAD_ID,
      beforeTurnId: 'turn-2',
      cwd: DIRECTORY,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      excludeTurns: true,
    });
    const { name } = calls.find((call) => call.method === 'thread/name/set').params;
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith('… (fork)')).toBe(true);
    expect(name.startsWith('Refactor the parser')).toBe(true);
  });

  it('reads the archive state from where Codex keeps the rollout', async () => {
    const { store } = createHarness({
      'thread/read': async ({ threadId }) => ({
        thread: thread(threadId, threadId === THREAD_ID
          ? { path: '/home/me/.codex/archived_sessions/rollout-2026-09-24T21-54-16-x.jsonl' }
          : { path: '/home/me/.codex/sessions/2026/09/24/rollout-2026-09-24T21-54-16-y.jsonl' }),
      }),
    });
    expect((await store.getSession(`ncx_${THREAD_ID}`, DIRECTORY)).time.archived).toBe(1790240555000);
    expect((await store.getSession(`ncx_${CHILD_THREAD}`, DIRECTORY)).time.archived).toBeUndefined();
  });

  it('renames, archives and deletes threads, and says why Codex keeps a fork source', async () => {
    const { store, calls } = createHarness({
      'thread/name/set': async () => ({}),
      'thread/archive': async () => ({}),
      'thread/unarchive': async () => ({ thread: thread(THREAD_ID) }),
      'thread/delete': async ({ threadId }) => {
        if (threadId === CHILD_THREAD) throw new JsonRpcError(`no rollout found for thread id ${threadId}`, -32600);
        return {};
      },
    });
    await store.rename(`ncx_${THREAD_ID}`, 'Named');
    await store.setArchived(`ncx_${THREAD_ID}`, true);
    await store.setArchived(`ncx_${THREAD_ID}`, false);
    expect(await store.deleteThread(`ncx_${THREAD_ID}`)).toBe(true);
    expect(await store.deleteThread(`ncx_${CHILD_THREAD}`)).toBe(false);
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['thread/name/set', { threadId: THREAD_ID, name: 'Named' }],
      ['thread/archive', { threadId: THREAD_ID }],
      ['thread/unarchive', { threadId: THREAD_ID }],
      ['thread/delete', { threadId: THREAD_ID }],
      ['thread/delete', { threadId: CHILD_THREAD }],
    ]);

    const referenced = createHarness({
      'thread/delete': async ({ threadId }) => {
        throw new JsonRpcError(`cannot delete thread ${threadId}: forked history still references it`, -32600);
      },
    });
    await expect(referenced.store.deleteThread(`ncx_${THREAD_ID}`)).rejects.toMatchObject({ status: 409, code: 'NATIVE_DELETE_FORK_SOURCE' });
    await expect(store.rename('ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188', 'x')).rejects.toMatchObject({ status: 400 });
  });

  it('reports a missing thread as absent but a broken connection as a failure', async () => {
    const missing = createHarness({
      'thread/read': async () => {
        throw new JsonRpcError(`thread not loaded: ${THREAD_ID}`, -32600);
      },
    });
    expect(await missing.store.loadHistory(`ncx_${THREAD_ID}`, DIRECTORY)).toBeNull();
    expect(await missing.store.sessionExists(`ncx_${THREAD_ID}`)).toBe(false);

    const broken = createHarness({
      'thread/read': async () => {
        throw new JsonRpcError('Codex app-server connection is closed', -32000);
      },
    });
    await expect(broken.store.loadHistory(`ncx_${THREAD_ID}`, DIRECTORY)).rejects.toThrow('connection is closed');
    await expect(broken.store.sessionExists(`ncx_${THREAD_ID}`)).rejects.toThrow();
  });
});
