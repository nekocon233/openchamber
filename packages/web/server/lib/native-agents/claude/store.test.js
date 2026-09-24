import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeRegistry } from '../registry.js';
import { createClaudeSessionStore } from './store.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const DIRECTORY = '/work/project';
const TERMINAL_UUID = '11111111-1111-4111-8111-111111111111';
const OPENCHAMBER_UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const TASK_TOOL_USE = 'toolu_01VAnMEDHHeuo92ZtfbaNtwQ';
const REWIND_UUID = '33333333-3333-4333-8333-333333333333';
const PROMPT_1 = '44444444-4444-4444-8444-444444444441';
const PROMPT_2 = '44444444-4444-4444-8444-444444444442';
const PROMPT_3 = '44444444-4444-4444-8444-444444444443';
// A conversation chain as getSessionMessages returns it: prompts, replies,
// and a tool result, which is a user entry too.
const rewindChain = [
  { type: 'user', uuid: PROMPT_1 },
  { type: 'assistant', uuid: 'reply-1' },
  { type: 'user', uuid: PROMPT_2 },
  { type: 'assistant', uuid: 'reply-2' },
  { type: 'user', uuid: 'tool-result-2' },
  { type: 'user', uuid: PROMPT_3 },
  { type: 'assistant', uuid: 'reply-3' },
];
const AGENT_ID = 'a6f8a95b426077fd7';

// The raw transcript entries that carry structured tool results, as
// importSessionToStore hands them over.
const rawToolResultEntries = () => fixture('haiku-tools.live-frames.json')
  .filter((frame) => frame.type === 'user' && frame.tool_use_result !== undefined)
  .map((frame) => ({ type: 'user', uuid: frame.uuid, toolUseResult: frame.tool_use_result }));

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const createHarness = async ({ importFails = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-claude-store-'));
  directories.push(dir);
  const registry = createNativeRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.registerSession(`ncl_${OPENCHAMBER_UUID}`, {
    backend: 'claude', nativeId: OPENCHAMBER_UUID, directory: DIRECTORY, origin: 'openchamber', createdAt: 1, title: 'Named in OpenChamber',
  });
  const calls = { getSessionMessages: 0, imports: [], forks: [] };
  const infos = new Map([
    [TERMINAL_UUID, { sessionId: TERMINAL_UUID, summary: 'Terminal work', lastModified: 2000, fileSize: 10, createdAt: 1000, customTitle: 'Terminal work' }],
    [OPENCHAMBER_UUID, { sessionId: OPENCHAMBER_UUID, summary: 'Tool workflow', lastModified: 3000, fileSize: 24802, createdAt: 2500 }],
  ]);
  const subagentMessages = [{
    type: 'user',
    uuid: 'sub-1',
    parent_tool_use_id: TASK_TOOL_USE,
    parent_agent_id: null,
    timestamp: '2026-09-24T09:00:49.252Z',
    message: { role: 'user', content: 'Run wc -l notes.txt' },
  }];
  const sdk = {
    listSessions: async ({ includeProgrammatic }) => (includeProgrammatic === false ? [infos.get(TERMINAL_UUID)] : [...infos.values()]),
    getSessionInfo: async (sessionId) => infos.get(sessionId),
    getSessionMessages: async (sessionId) => {
      calls.getSessionMessages += 1;
      if (sessionId === REWIND_UUID) return rewindChain;
      return sessionId === OPENCHAMBER_UUID ? fixture('haiku-tools.session-messages.json') : [];
    },
    forkSession: async (sessionId, options) => {
      calls.forks.push({ sessionId, options });
      return { sessionId: '55555555-5555-4555-8555-555555555555' };
    },
    listSubagents: async (sessionId) => (sessionId === OPENCHAMBER_UUID ? [AGENT_ID] : []),
    getSubagentMessages: async () => subagentMessages,
    importSessionToStore: async (sessionId, target, options) => {
      calls.imports.push({ sessionId, options });
      if (importFails) throw new Error('transcript unreadable');
      await target.append({ projectKey: 'work-project', sessionId }, rawToolResultEntries());
    },
  };
  const store = createClaudeSessionStore({ loadSdk: async () => sdk, registry });
  return { store, infos, calls, registry };
};

describe('Claude session store', () => {
  it('lists terminal sessions and the SDK sessions OpenChamber registered, titled by their transcripts', async () => {
    const { store } = await createHarness();
    const sessions = await store.listRootSessions(DIRECTORY);
    // The registry title only stands in until a transcript exists.
    expect(sessions.map((session) => [session.id, session.title])).toEqual([
      [`ncl_${TERMINAL_UUID}`, 'Terminal work'],
      [`ncl_${OPENCHAMBER_UUID}`, 'Tool workflow'],
    ]);
    expect(sessions[0]).toMatchObject({ directory: DIRECTORY, time: { created: 1000, updated: 2000 } });
  });

  it('returns a session history with the subagent sessions it links to', async () => {
    const { store } = await createHarness();
    const history = await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY);
    const task = history.records.flatMap((record) => record.parts).find((part) => part.type === 'tool' && part.tool === 'task');
    const childId = `ncl_${OPENCHAMBER_UUID}_t_${TASK_TOOL_USE}`;
    expect(task.state.metadata.sessionId).toBe(childId);
    expect(history.childSessions).toEqual([expect.objectContaining({
      id: childId,
      parentID: `ncl_${OPENCHAMBER_UUID}`,
      title: 'Count lines in notes.txt',
      directory: DIRECTORY,
    })]);

    const child = await store.loadHistory(childId, DIRECTORY);
    expect(child.records[0].info).toMatchObject({ role: 'user', sessionID: childId });
    expect(child.records[0].parts[0].text).toBe('Run wc -l notes.txt');
  });

  it('gives subagent sessions the archive flag of their parent, which archiving changes without the transcript', async () => {
    const { store, registry } = await createHarness();
    const childId = `ncl_${OPENCHAMBER_UUID}_t_${TASK_TOOL_USE}`;
    expect((await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY)).childSessions[0].time.archived).toBeUndefined();
    await registry.updateSession(`ncl_${OPENCHAMBER_UUID}`, { archivedAt: 7000 });
    expect((await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY)).childSessions[0].time.archived).toBe(7000);
    expect((await store.getSession(childId, DIRECTORY)).time.archived).toBe(7000);
  });

  it('reuses a projection until the transcript changes', async () => {
    const { store, infos, calls } = await createHarness();
    await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY);
    await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY);
    expect(calls.getSessionMessages).toBe(1);
    infos.set(OPENCHAMBER_UUID, { ...infos.get(OPENCHAMBER_UUID), lastModified: 4000 });
    await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY);
    expect(calls.getSessionMessages).toBe(2);
  });

  it('restores the edit diffs a history read drops from the raw transcript', async () => {
    const { store, calls } = await createHarness();
    const history = await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY);
    const parts = history.records.flatMap((record) => record.parts).filter((part) => part.type === 'tool');
    const write = parts.find((part) => part.tool === 'write');
    const edit = parts.find((part) => part.tool === 'edit');

    expect(write.state.metadata.files).toEqual([expect.objectContaining({ filePath: '/work/project/hello.txt', type: 'add' })]);
    expect(edit.state.metadata.files).toEqual([expect.objectContaining({ filePath: '/work/project/hello.txt', type: 'update' })]);
    expect(edit.state.metadata.diff).toMatch(/^--- \/work\/project\/hello\.txt\n\+\+\+ \/work\/project\/hello\.txt\n@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(calls.imports).toEqual([{ sessionId: OPENCHAMBER_UUID, options: { dir: DIRECTORY, includeSubagents: false } }]);
  });

  it('keeps the history without diffs when the raw transcript cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = await createHarness({ importFails: true });
    const history = await store.loadHistory(`ncl_${OPENCHAMBER_UUID}`, DIRECTORY);
    const edit = history.records.flatMap((record) => record.parts).find((part) => part.type === 'tool' && part.tool === 'edit');

    expect(edit.state.status).toBe('completed');
    expect(edit.state.metadata.files).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the raw transcript only for conversations that edit files', async () => {
    const { store, calls } = await createHarness();
    await store.loadHistory(`ncl_${TERMINAL_UUID}`, DIRECTORY);
    await store.loadHistory(`ncl_${OPENCHAMBER_UUID}_t_${TASK_TOOL_USE}`, DIRECTORY);

    expect(calls.imports).toEqual([]);
  });

  it('rewinds to the chain entry before a prompt and names the user entries it drops', async () => {
    const { store, calls } = await createHarness();
    const sessionId = `ncl_${REWIND_UUID}`;
    expect(await store.rewindTarget(sessionId, DIRECTORY, `ncl_u_${PROMPT_2}`)).toEqual({
      resumeAt: 'reply-1',
      messageIds: [`ncl_u_${PROMPT_2}`, 'ncl_u_tool-result-2', `ncl_u_${PROMPT_3}`],
    });
    expect((await store.rewindTarget(sessionId, DIRECTORY, `ncl_u_${PROMPT_1}`)).resumeAt).toBeNull();
    await expect(store.rewindTarget(sessionId, DIRECTORY, 'ncl_u_66666666-6666-4666-8666-666666666666')).rejects.toMatchObject({ code: 'NATIVE_MESSAGE_NOT_FOUND' });
    await expect(store.rewindTarget(sessionId, DIRECTORY, `ncl_k_${PROMPT_2}`)).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    await expect(store.rewindTarget(`${sessionId}_t_toolu_1`, DIRECTORY, `ncl_u_${PROMPT_2}`)).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });

    expect(await store.chainHolds(sessionId, DIRECTORY, `ncl_u_${PROMPT_3}`)).toBe(true);
    expect(await store.chainHolds(sessionId, DIRECTORY, 'ncl_u_66666666-6666-4666-8666-666666666666')).toBe(false);

    expect(await store.fork(sessionId, DIRECTORY, 'reply-1')).toBe('55555555-5555-4555-8555-555555555555');
    expect(calls.forks).toEqual([{ sessionId: REWIND_UUID, options: { dir: DIRECTORY, upToMessageId: 'reply-1' } }]);
  });

  it('reports sessions that do not exist', async () => {
    const { store } = await createHarness();
    expect(await store.loadHistory('ncl_22222222-2222-4222-8222-222222222222', DIRECTORY)).toBeNull();
    expect(await store.sessionExists(`ncl_${TERMINAL_UUID}`, DIRECTORY)).toBe(true);
    expect(await store.sessionExists('ncl_22222222-2222-4222-8222-222222222222', DIRECTORY)).toBe(false);
    expect(await store.loadHistory(`ncl_${OPENCHAMBER_UUID}_t_toolu_unknown`, DIRECTORY)).toBeNull();
  });
});
