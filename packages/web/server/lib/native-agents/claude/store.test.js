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

describe('Claude history before the last compaction', () => {
  const SESSION_UUID = '66666666-6666-4666-8666-666666666666';
  const SESSION_ID = `ncl_${SESSION_UUID}`;
  const U1 = '77777777-7777-4777-8777-777777777771';
  const U2 = '77777777-7777-4777-8777-777777777772';
  const U3 = '77777777-7777-4777-8777-777777777773';
  const U4 = '77777777-7777-4777-8777-777777777774';
  const U5 = '77777777-7777-4777-8777-777777777775';
  const at = (minute) => new Date(Date.UTC(2026, 8, 25, 1, minute)).toISOString();
  const prompt = (uuid, minute, text) => ({ type: 'user', uuid, timestamp: at(minute), message: { role: 'user', content: text } });
  const reply = (uuid, minute, id, text) => ({
    type: 'assistant',
    uuid,
    timestamp: at(minute),
    message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });
  const summary = (uuid, minute, text) => ({ type: 'user', uuid, timestamp: at(minute), isCompactSummary: true, is_meta: true, message: { role: 'user', content: text } });
  // A compaction as the raw transcript records it (the CLI can name an entry it
  // writes after the boundary as its logical parent), and as a history read returns it.
  const rawBoundary = (uuid, minute, logicalParentUuid) => ({
    type: 'system', subtype: 'compact_boundary', uuid, timestamp: at(minute), parentUuid: null, logicalParentUuid, compactMetadata: { trigger: 'auto' },
  });
  const readBoundary = (uuid, minute) => ({ type: 'system', uuid, timestamp: at(minute), message: undefined, parent_tool_use_id: null, parent_agent_id: null });

  const u1 = prompt(U1, 1, 'first question');
  const a1 = reply('a1', 2, 'msg_1', 'first answer');
  const u2 = prompt(U2, 3, 'second question');
  const a2 = reply('a2', 4, 'msg_2', 'second answer');
  const s1 = summary('s1', 5, 'summary one');
  const u3 = prompt(U3, 7, 'third question');
  const a3 = reply('a3', 8, 'msg_3', 'third answer');
  const s2 = summary('s2', 9, 'summary two');
  const u4 = prompt(U4, 11, 'fourth question');
  const a4 = reply('a4', 12, 'msg_4', 'fourth answer');

  const createCompactedHarness = ({ importFails = false } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-claude-compacted-'));
    directories.push(dir);
    const state = {
      raw: [u1, a1, u2, a2, rawBoundary('b1', 5, 's1'), s1, u3, a3, rawBoundary('b2', 9, 's2'), s2, u4, a4],
      // A history read of the whole transcript, and of a cut where a
      // compaction started, keyed by the last entry the cut keeps.
      current: [readBoundary('b2', 9), s2, u4, a4],
      segments: {
        // The first compaction carried the second exchange over.
        a3: [readBoundary('b1', 5), s1, u2, a2, u3, a3],
        a2: [u1, a1, u2, a2],
      },
      info: { sessionId: SESSION_UUID, summary: 'Long work', lastModified: 1000, fileSize: 2000, createdAt: 500 },
    };
    const calls = { imports: 0, cuts: [] };
    const sdk = {
      getSessionInfo: async () => state.info,
      listSubagents: async () => [],
      getSessionMessages: async (_sessionId, options = {}) => {
        if (!options.sessionStore) return state.current;
        const cut = await options.sessionStore.load({ projectKey: 'work-project', sessionId: SESSION_UUID });
        const last = cut.at(-1).uuid;
        calls.cuts.push(last);
        return state.segments[last] ?? [];
      },
      importSessionToStore: async (sessionId, target) => {
        calls.imports += 1;
        if (importFails) throw new Error('transcript unreadable');
        await target.append({ projectKey: 'work-project', sessionId }, state.raw);
      },
    };
    const registry = createNativeRegistry({ filePath: path.join(dir, 'registry.json') });
    return { store: createClaudeSessionStore({ loadSdk: async () => sdk, registry }), state, calls };
  };

  const conversationOf = (records) => records.map((record) => {
    if (record.parts.some((part) => part.type === 'compaction')) return 'compaction';
    const text = record.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
    return record.info.summary === true ? `summary: ${text}` : `${record.info.role}: ${text}`;
  });

  it('shows the conversation before each compaction, a carried-over message once, and a marker at each compaction', async () => {
    const { store } = createCompactedHarness();
    const history = await store.loadHistory(SESSION_ID, DIRECTORY);
    expect(conversationOf(history.records)).toEqual([
      'user: first question', 'assistant: first answer',
      'user: second question', 'assistant: second answer',
      'compaction', 'summary: summary one',
      'user: third question', 'assistant: third answer',
      'compaction', 'summary: summary two',
      'user: fourth question', 'assistant: fourth answer',
    ]);
    expect(new Set(history.records.map((record) => record.info.id)).size).toBe(history.records.length);
  });

  it('reads the earlier segments again only once another compaction is the last one', async () => {
    const { store, state, calls } = createCompactedHarness();
    await store.loadHistory(SESSION_ID, DIRECTORY);
    expect(calls).toEqual({ imports: 1, cuts: ['a3', 'a2'] });

    const u5 = prompt(U5, 13, 'fifth question');
    state.current = [...state.current, u5];
    state.info = { ...state.info, lastModified: 2000, fileSize: 2100 };
    const grown = conversationOf((await store.loadHistory(SESSION_ID, DIRECTORY)).records);
    expect(calls.imports).toBe(1);
    expect([grown[0], grown.at(-1)]).toEqual(['user: first question', 'user: fifth question']);

    state.raw = [...state.raw, u5, rawBoundary('b3', 14, 's3')];
    state.segments[U5] = [readBoundary('b2', 9), s2, u4, a4, u5];
    state.current = [readBoundary('b3', 14), summary('s3', 14, 'summary three')];
    state.info = { ...state.info, lastModified: 3000, fileSize: 2400 };
    const compacted = conversationOf((await store.loadHistory(SESSION_ID, DIRECTORY)).records);
    expect(calls.imports).toBe(2);
    expect(compacted.filter((entry) => entry === 'compaction')).toHaveLength(3);
    expect(compacted.slice(-3)).toEqual(['user: fifth question', 'compaction', 'summary: summary three']);
  });

  it('shows the chain after the last compaction alone when the transcript cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = createCompactedHarness({ importFails: true });
    const history = await store.loadHistory(SESSION_ID, DIRECTORY);
    expect(conversationOf(history.records)).toEqual(['compaction', 'summary: summary two', 'user: fourth question', 'assistant: fourth answer']);
  });

  it('refuses to revert or fork from a message before the last compaction, which the CLI cannot resume at', async () => {
    const { store } = createCompactedHarness();
    await expect(store.rewindTarget(SESSION_ID, DIRECTORY, `ncl_u_${U3}`)).rejects.toMatchObject({ code: 'NATIVE_REWIND_BEFORE_COMPACTION' });
    await expect(store.rewindTarget(SESSION_ID, DIRECTORY, 'ncl_u_88888888-8888-4888-8888-888888888888')).rejects.toMatchObject({ code: 'NATIVE_MESSAGE_NOT_FOUND' });
    expect(await store.rewindTarget(SESSION_ID, DIRECTORY, `ncl_u_${U4}`)).toMatchObject({ resumeAt: 's2' });
  });
});
