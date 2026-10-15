import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { JsonRpcError } from './codex/rpc.js';
import { sessionNotFoundError } from './errors.js';
import { registerNativeAgentRoutes } from './routes.js';
import { createNativeAgentsRuntime } from './runtime.js';
import { createSnapshotStore } from './snapshots.js';
import { createChatgptStore } from './claude/chatgpt-store.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./claude/fixtures/${name}`, import.meta.url), 'utf8'));

const DIRECTORY = '/work/project';
const SESSION_UUID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const SESSION_ID = `ncl_${SESSION_UUID}`;
// The recorded session spawned one subagent with this Task call.
const TASK_TOOL_USE = 'toolu_01VAnMEDHHeuo92ZtfbaNtwQ';
const CHILD_ID = `${SESSION_ID}_t_${TASK_TOOL_USE}`;

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// One scripted reply per prompt: the reply streams, then waits for `finish`
// before the turn's result, so a test can look at the running turn.
const scriptedTurn = (apiMessageId) => [
  { type: 'stream_event', event: { type: 'message_start', message: { id: apiMessageId, model: 'claude-haiku-4-5-20251001', content: [], usage: null } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } },
];
const scriptedTurnEnd = (apiMessageId) => [
  { type: 'assistant', uuid: `${apiMessageId}-entry`, timestamp: '2026-09-24T10:00:01.000Z', message: { id: apiMessageId, model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
  { type: 'stream_event', event: { type: 'message_stop' } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Done.', terminal_reason: 'completed', queued_turn_count: 0 },
];

const createRuntime = ({ childFrames = [], snapshotGit, childEnv = () => ({}) } = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-native-runtime-'));
  directories.push(dataDir);
  const info = { sessionId: SESSION_UUID, summary: 'Terminal work', lastModified: 2000, fileSize: 10, createdAt: 1000 };
  const transcripts = new Map([[SESSION_UUID, info]]);
  const events = [];
  const turns = { started: 0, finish: deferred(), listings: 0, failListing: false, stoppedTasks: [], interrupts: 0 };
  // The options of every query the runtime opens, as the CLI receives them.
  const queries = [];
  const sdk = {
    listSessions: async () => Array.from(transcripts.values()),
    getSessionInfo: async (sessionId) => transcripts.get(sessionId),
    renameSession: async (sessionId, title) => {
      transcripts.set(sessionId, { ...transcripts.get(sessionId), customTitle: title });
    },
    deleteSession: async (sessionId) => {
      transcripts.delete(sessionId);
    },
    forkSession: async () => {
      const sessionId = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1189';
      transcripts.set(sessionId, { ...info, sessionId });
      return { sessionId };
    },
    getSessionMessages: async (sessionId) => (sessionId === SESSION_UUID && transcripts.has(SESSION_UUID) ? fixture('haiku-tools.session-messages.json') : []),
    listSubagents: async (sessionId) => (sessionId === SESSION_UUID ? ['agent-1'] : []),
    getSubagentMessages: async () => [{ type: 'user', uuid: 'sub-1', parent_tool_use_id: TASK_TOOL_USE, message: { role: 'user', content: 'Count lines' } }],
    query: ({ prompt, options }) => {
      queries.push(options);
      const input = prompt[Symbol.asyncIterator]();
      async function* run() {
        while (true) {
          const next = await input.next();
          if (next.done) return;
          turns.started += 1;
          const apiMessageId = `msg_scripted_${turns.started}`;
          for (const frame of scriptedTurn(apiMessageId)) yield frame;
          yield* childFrames;
          await turns.finish.promise;
          const uuid = options.sessionId ?? options.resume;
          transcripts.set(uuid, { sessionId: uuid, summary: 'Scripted', lastModified: 3000, fileSize: 20, createdAt: 2500 });
          for (const frame of scriptedTurnEnd(apiMessageId)) yield frame;
        }
      }
      return Object.assign(run(), {
        interrupt: async () => { turns.interrupts += 1; },
        stopTask: async (taskId) => { turns.stoppedTasks.push(taskId); },
        setModel: async () => {},
        applyFlagSettings: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => {
          turns.listings += 1;
          if (turns.failListing) throw new Error('claude cannot list commands');
          return [{ name: 'compact', description: 'Free up context', argumentHint: '' }];
        },
      });
    },
  };
  const runtime = createNativeAgentsRuntime({
    dataDir,
    snapshots: createSnapshotStore({ dataDir, git: snapshotGit }),
    // No codex binary: the Codex backend fails on its own.
    resolveExecutable: async (cli) => (cli === 'claude' ? '/usr/bin/claude' : null),
    buildChildEnv: childEnv,
    clientVersion: 'test',
    publishNativeEvent: (event) => events.push(event),
    loadSdk: async () => sdk,
  });
  return Object.assign(runtime, { dataDir, events, turns, queries });
};

const waitFor = async (condition) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition never became true');
};

const promptRequest = (messageID) => ({
  directory: DIRECTORY,
  messageID,
  parts: [{ type: 'text', text: 'Say done' }],
  model: { providerID: 'claude-native', modelID: 'haiku' },
  agent: 'build',
});

describe('native agents runtime', () => {
  it('captures ChatGPT effort for each resumed query and rejects changing it during a turn', async () => {
    const runtime = createRuntime({ snapshotGit: async () => '' });
    const store = createChatgptStore({ dataDir: runtime.dataDir });
    await store.transaction((document) => { document.accounts = [{
      id: SESSION_UUID, clientId: 'test-client', subject: 'test-user', email: '', revision: 1, welcomed: true,
      credentials: { accessToken: 'fake-access', refreshToken: 'fake-refresh', idToken: 'fake-id', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] },
      models: [{ slug: 'gpt-fixture', display_name: 'GPT', visibility: 'list', supported_reasoning_levels: [{ effort: 'max' }, { effort: 'none' }] }],
    }]; });
    const session = await runtime.createSession({ backend: 'claude', directory: DIRECTORY });
    const model = { providerID: 'claude-native', modelID: `chatgpt:${SESSION_UUID}:${Buffer.from('gpt-fixture').toString('base64url')}` };
    const prompt = { ...promptRequest('ncl_u_4b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f'), model };
    try {
      await runtime.prompt(session.id, { ...prompt, variant: 'max' });
      await waitFor(() => runtime.turns.started === 1);
      expect(runtime.queries[0]).not.toHaveProperty('effort');
      await expect(runtime.prompt(session.id, { ...prompt, variant: 'none' })).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_BUSY' });
      runtime.turns.finish.resolve();
      await waitFor(async () => Object.keys(await runtime.statuses(DIRECTORY)).length === 0);
      await runtime.prompt(session.id, { ...prompt, messageID: 'ncl_u_83d065d3-e4a6-4ccc-a739-45b0c75254e1', variant: 'none' });
      await waitFor(async () => runtime.queries.length === 2 && Object.keys(await runtime.statuses(DIRECTORY)).length === 0);
      await runtime.prompt(session.id, { ...prompt, messageID: 'ncl_u_2b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f' });
      await waitFor(() => runtime.queries.length === 3);
      expect(runtime.queries.every((options) => options.effort === undefined)).toBe(true);
      expect(runtime.queries.slice(1).map((options) => options.resume)).toEqual([session.id.slice(4), session.id.slice(4)]);
      await expect(runtime.prompt(session.id, { ...prompt, variant: 'ultra' })).rejects.toMatchObject({ code: 'CHATGPT_UNSUPPORTED_EFFORT' });
    } finally { runtime.turns.finish.resolve(); await runtime.shutdown(); }
  });

  it('lists each backend on its own, so one failing does not hide the other', async () => {
    const runtime = createRuntime();
    const result = await runtime.listSessions(DIRECTORY);
    expect(result.backends.claude).toMatchObject({ status: 'ok', sessions: [expect.objectContaining({ id: SESSION_ID })] });
    expect(result.backends.codex).toMatchObject({ status: 'error' });
    expect(result.backends.codex.message).toMatch(/codex CLI was not found/);
    await runtime.shutdown();
  });

  it('pages history newest first with message-id cursors', async () => {
    const runtime = createRuntime();
    const all = await runtime.loadMessages(SESSION_ID, DIRECTORY, { limit: 100 });
    expect(all.complete).toBe(true);
    expect(all.cursor).toBeNull();

    const newest = await runtime.loadMessages(SESSION_ID, DIRECTORY, { limit: 2 });
    expect(newest.records.map((record) => record.info.id)).toEqual(all.records.slice(-2).map((record) => record.info.id));
    expect(newest.complete).toBe(false);
    expect(newest.cursor).toBe(newest.records[0].info.id);

    const older = await runtime.loadMessages(SESSION_ID, DIRECTORY, { limit: 2, before: newest.cursor });
    expect(older.records.map((record) => record.info.id)).toEqual(all.records.slice(-4, -2).map((record) => record.info.id));

    await expect(runtime.loadMessages(SESSION_ID, DIRECTORY, { limit: 2, before: 'ncl_u_unknown' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(runtime.loadMessages('ncl_22222222-2222-4222-8222-222222222222', DIRECTORY, { limit: 2 }))
      .rejects.toMatchObject({ status: 404, code: 'NATIVE_SESSION_NOT_FOUND' });
    await runtime.shutdown();
  });

  it('lists a new session before its first turn, and runs a prompt through its CLI', async () => {
    const runtime = createRuntime();
    const session = await runtime.createSession({ backend: 'claude', directory: DIRECTORY, title: 'Fresh' });
    expect(session).toMatchObject({ id: expect.stringMatching(/^ncl_[0-9a-f-]{36}$/), title: 'Fresh', directory: DIRECTORY });
    expect(runtime.events[0].payload).toMatchObject({ type: 'session.created', properties: { info: { id: session.id } } });
    const listed = async () => (await runtime.listSessions(DIRECTORY)).backends.claude.sessions.map((entry) => entry.id);
    expect(await listed()).toContain(session.id);
    expect(await runtime.loadMessages(session.id, DIRECTORY, { limit: 10 })).toMatchObject({ records: [], complete: true });
    expect(await runtime.sessionExists(session.id, DIRECTORY)).toBe(true);

    const messageID = 'ncl_u_1b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f';
    await runtime.prompt(session.id, promptRequest(messageID));
    await waitFor(() => runtime.turns.started === 1);
    expect(await runtime.statuses(DIRECTORY)).toEqual({ [session.id]: { type: 'busy' } });

    // History read mid-turn: the transcript has nothing yet, the live turn has
    // the prompt and the streaming reply.
    const running = await runtime.loadMessages(session.id, DIRECTORY, { limit: 10 });
    expect(running.records.map((record) => [record.info.role, record.parts.map((part) => part.text)])).toEqual([
      ['user', ['Say done']],
      ['assistant', ['Done.']],
    ]);
    expect(running.records[0].info).toMatchObject({ id: messageID, model: { providerID: 'claude-native', modelID: 'haiku' } });

    runtime.turns.finish.resolve();
    await waitFor(async () => Object.keys(await runtime.statuses(DIRECTORY)).length === 0);
    // The finished turn confirms the session, writes its title to the new
    // transcript, and announces its fresh record.
    await waitFor(() => runtime.events.some((event) => event.payload.type === 'session.updated'));
    const types = runtime.events.map((event) => event.payload.type);
    expect(types).toContain('message.part.delta');
    expect(types.indexOf('session.idle')).toBeLessThan(types.indexOf('session.updated'));
    const updated = runtime.events.find((event) => event.payload.type === 'session.updated').payload.properties.info;
    expect(updated).toMatchObject({ id: session.id, title: 'Fresh', time: { updated: 3000 } });
    expect(await listed()).toContain(session.id);
    await runtime.shutdown();
  });

  it('opens a live child before the CLI has indexed its transcript', async () => {
    const tool = 'tool-child-live';
    const runtime = createRuntime({ childFrames: [
      { type: 'assistant', uuid: 'parent-task-entry', message: { id: 'parent-task', model: 'claude-haiku-4-5', content: [{
        type: 'tool_use', id: tool, name: 'Agent', input: { description: 'Research', subagent_type: 'general-purpose', prompt: 'Check the source' },
      }] } },
      { type: 'system', subtype: 'task_started', task_id: 'child-task', tool_use_id: tool },
      { type: 'user', uuid: 'child-prompt', parent_tool_use_id: tool, message: { role: 'user', content: 'Check the source' } },
      { type: 'assistant', uuid: 'child-reply-entry', parent_tool_use_id: tool, message: { id: 'child-reply', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Checking the source.' }] } },
    ] });
    const session = await runtime.createSession({ backend: 'claude', directory: DIRECTORY });
    const childId = `${session.id}_t_${tool}`;
    try {
      await runtime.prompt(session.id, promptRequest('ncl_u_83d065d3-e4a6-4ccc-a739-45b0c75254e1'));
      await waitFor(() => runtime.events.some((event) => event.payload.type === 'message.part.updated'
        && event.payload.properties.part.sessionID === childId && event.payload.properties.part.text === 'Checking the source.'));
      expect(await runtime.getSession(childId, DIRECTORY)).toMatchObject({ id: childId, parentID: session.id, title: 'Research' });
      expect(await runtime.statuses(DIRECTORY)).toEqual({ [session.id]: { type: 'busy' }, [childId]: { type: 'busy' } });
      const history = await runtime.loadMessages(childId, DIRECTORY, { limit: 10 });
      expect(history.records.map((record) => [record.info.role, record.parts[0].text])).toEqual([
        ['user', 'Check the source'], ['assistant', 'Checking the source.'],
      ]);
      expect(history.complete).toBe(true);
    } finally {
      runtime.turns.finish.resolve();
      await waitFor(() => runtime.events.some((event) => event.payload.type === 'session.updated'
        && event.payload.properties.info.id === session.id));
      await runtime.shutdown();
    }
  });

  it('runs a Claude alias with the window the catalog reports, and keeps the alias on the message', async () => {
    const runtime = createRuntime();
    const session = await runtime.createSession({ backend: 'claude', directory: DIRECTORY, title: 'Wide' });
    const messageID = 'ncl_u_4b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f';
    await runtime.prompt(session.id, { ...promptRequest(messageID), model: { providerID: 'claude-native', modelID: 'opus' } });
    await waitFor(() => runtime.turns.started === 1);
    expect(runtime.queries.map((options) => options.model)).toEqual(['opus[1m]']);
    const running = await runtime.loadMessages(session.id, DIRECTORY, { limit: 10 });
    expect(running.records[0].info).toMatchObject({ id: messageID, model: { providerID: 'claude-native', modelID: 'opus' } });

    runtime.turns.finish.resolve();
    await waitFor(async () => Object.keys(await runtime.statuses(DIRECTORY)).length === 0);
    await runtime.shutdown();
  });

  it('keeps a session on the CLI it started with', async () => {
    const runtime = createRuntime();
    await expect(runtime.prompt(SESSION_ID, {
      ...promptRequest('ncl_u_2b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f'),
      model: { providerID: 'codex-native', modelID: 'gpt-5.5' },
    })).rejects.toMatchObject({ status: 409, code: 'NATIVE_BACKEND_MISMATCH' });
    await expect(runtime.prompt(SESSION_ID, {
      ...promptRequest('ncl_u_3b0e1c52-2f1f-4c3a-9d8e-0a7b6c5d4e3f'),
      model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
    })).rejects.toMatchObject({ status: 409 });
    expect(runtime.turns.started).toBe(0);
    await runtime.shutdown();
  });

  it('archives and deletes a Claude session together with its subagent sessions', async () => {
    const runtime = createRuntime();
    const archived = await runtime.updateSession(SESSION_ID, DIRECTORY, { archived: true });
    const announced = runtime.events.filter((event) => event.payload.type === 'session.updated').map((event) => event.payload.properties.info);
    expect(announced.map((info) => [info.id, Boolean(info.time.archived)])).toEqual([[CHILD_ID, true], [SESSION_ID, true]]);
    expect(archived.time.archived).toEqual(expect.any(Number));

    await runtime.updateSession(SESSION_ID, DIRECTORY, { archived: false });
    expect(await runtime.deleteSession(SESSION_ID, DIRECTORY)).toEqual({ deleted: true });
    const deleted = runtime.events.filter((event) => event.payload.type === 'session.deleted').map((event) => event.payload.properties.sessionID);
    expect(deleted).toEqual([CHILD_ID, SESSION_ID]);
    await expect(runtime.updateSession(CHILD_ID, DIRECTORY, { archived: true })).rejects.toMatchObject({ status: 400 });
    await runtime.shutdown();
  });

  it('keeps the command list of a directory for a while, and asks again after a failure', async () => {
    const runtime = createRuntime();
    await expect(runtime.commands('codex', DIRECTORY)).rejects.toMatchObject({ code: 'NATIVE_CLI_MISSING' });
    const first = await runtime.commands('claude', DIRECTORY);
    expect(first.commands.map((command) => command.name)).toEqual(['compact']);
    await runtime.commands('claude', DIRECTORY);
    expect(runtime.turns.listings).toBe(1);

    runtime.turns.failListing = true;
    await expect(runtime.commands('claude', '/work/other')).rejects.toThrow('cannot list');
    runtime.turns.failListing = false;
    expect((await runtime.commands('claude', '/work/other')).commands).toHaveLength(1);
    expect(runtime.turns.listings).toBe(3);
    await runtime.shutdown();
  });

  it('reports which CLIs are installed', async () => {
    const runtime = createRuntime();
    expect(await runtime.capabilities()).toMatchObject({
      supported: true,
      backends: { claude: { cli: true }, codex: { cli: false } },
      registry: { reset: false },
    });
    await runtime.shutdown();
  });
});

// Claude Code as far as reverts see it: each prompt appends a user entry and
// a reply to the session's chain when its turn is written; a prompt that
// says `write <file> <text>` writes that file first, the way an agent edits
// the work tree. A query resumed at an entry drops everything after it when
// it writes its first turn, as the CLI does. Set `hold` to pause turns before
// they are written; an interrupt ends a held turn as aborted. Set `exitGate`
// to keep a closed query's process from exiting (`exiting` says it is
// waiting), and `failStart` to make the next query fail to start.
const createTranscriptSdk = (directory) => {
  const chains = new Map();
  const infos = new Map();
  const state = { queries: [], hold: null, exitGate: null, exiting: false, failStart: false, renames: [], deletes: [], stoppedTasks: [] };
  let clock = Date.parse('2026-09-24T10:00:00.000Z');
  const stamp = () => new Date((clock += 1000)).toISOString();
  const remember = (uuid, chain) => {
    chains.set(uuid, chain);
    infos.set(uuid, { sessionId: uuid, summary: 'Scripted', lastModified: clock, fileSize: chain.length, createdAt: 1000 });
  };
  const sdk = {
    listSessions: async () => [],
    getSessionInfo: async (uuid) => infos.get(uuid),
    getSessionMessages: async (uuid) => chains.get(uuid) ?? [],
    listSubagents: async () => [],
    getSubagentMessages: async () => [],
    importSessionToStore: async () => {},
    renameSession: async (uuid, title) => {
      state.renames.push([uuid, title]);
      infos.set(uuid, { ...infos.get(uuid), customTitle: title });
    },
    deleteSession: async (uuid) => {
      if (!infos.has(uuid)) throw new Error(`Session ${uuid} not found`);
      state.deletes.push({ uuid, queriesOpen: state.queries.filter((query) => query.uuid === uuid && !query.exited).length });
      infos.delete(uuid);
      chains.delete(uuid);
    },
    forkSession: async (uuid, { upToMessageId }) => {
      const chain = chains.get(uuid);
      const forkedUuid = '77777777-7777-4777-8777-777777777777';
      // Without a message the SDK copies the whole transcript.
      remember(forkedUuid, upToMessageId === undefined ? chain : chain.slice(0, chain.findIndex((entry) => entry.uuid === upToMessageId) + 1));
      return { sessionId: forkedUuid };
    },
    query: ({ prompt, options }) => {
      if (state.failStart) {
        state.failStart = false;
        throw new Error('claude could not start');
      }
      const uuid = options.sessionId ?? options.resume;
      const record = { options, uuid, aborted: false, exited: false, texts: [], contents: [] };
      state.queries.push(record);
      const input = prompt[Symbol.asyncIterator]();
      let rewindAt = options.resumeSessionAt ?? null;
      async function* run() {
        while (true) {
          const next = await input.next();
          if (next.done) {
            state.exiting = true;
            await state.exitGate?.promise;
            state.exiting = false;
            record.exited = true;
            return;
          }
          const text = next.value.message.content.map((block) => block.text).join('');
          record.texts.push(text);
          record.contents.push(next.value.message.content);
          const apiMessageId = `msg_${next.value.uuid.slice(0, 8)}`;
          for (const frame of scriptedTurn(apiMessageId)) yield frame;
          const [verb, file, content] = text.split(' ');
          if (verb === 'write') fs.writeFileSync(path.join(directory, file), content);
          // `background` leaves a background task running after the turn.
          if (verb === 'background') {
            yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bwait', task_type: 'local_bash', description: 'Wait for the job' }] };
          }
          if (state.hold) await state.hold.promise;
          let chain = chains.get(uuid) ?? [];
          if (rewindAt !== null) {
            chain = chain.slice(0, chain.findIndex((entry) => entry.uuid === rewindAt) + 1);
            rewindAt = null;
          }
          remember(uuid, [
            ...chain,
            { type: 'user', uuid: next.value.uuid, timestamp: stamp(), message: { role: 'user', content: text } },
            { type: 'assistant', uuid: `${apiMessageId}-entry`, timestamp: stamp(), message: { id: apiMessageId, model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Done.' }] } },
          ]);
          if (record.aborted) {
            yield { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', queued_turn_count: 0 };
            continue;
          }
          for (const frame of scriptedTurnEnd(apiMessageId).slice(1)) yield frame;
        }
      }
      return Object.assign(run(), {
        interrupt: async () => {
          record.aborted = true;
          state.hold?.resolve();
        },
        stopTask: async (taskId) => {
          state.stoppedTasks.push(taskId);
        },
        setModel: async () => {},
        applyFlagSettings: async () => {},
        setPermissionMode: async () => {},
      });
    },
  };
  // A session typed in a terminal: a transcript OpenChamber never registered.
  const seedTerminalSession = (uuid) => remember(uuid, [
    { type: 'user', uuid: '99999999-2f1f-4c3a-9d8e-0a7b6c5d4e3f', timestamp: stamp(), message: { role: 'user', content: 'from the terminal' } },
  ]);
  return { sdk, state, chains, seedTerminalSession };
};

const createRevertRuntime = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-native-runtime-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-native-project-')));
  directories.push(dataDir, project);
  execFileSync('git', ['init', '--quiet'], { cwd: project });
  const events = [];
  const transcript = createTranscriptSdk(project);
  const runtime = createNativeAgentsRuntime({
    dataDir,
    resolveExecutable: async (cli) => (cli === 'claude' ? '/usr/bin/claude' : null),
    buildChildEnv: () => ({}),
    clientVersion: 'test',
    publishNativeEvent: (event) => events.push(event),
    loadSdk: async () => transcript.sdk,
  });
  const registryFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'native-agents', 'registry.json'), 'utf8'));
  const read = (file) => (fs.existsSync(path.join(project, file)) ? fs.readFileSync(path.join(project, file), 'utf8') : null);
  return Object.assign(runtime, { events, project, registryFile, read, ...transcript });
};

const promptId = (n) => `ncl_u_${String(n).repeat(8)}-2f1f-4c3a-9d8e-0a7b6c5d4e3f`;

// Sends a prompt and waits until its turn is written and its end snapshot taken.
const runPrompt = async (runtime, sessionId, n, text) => {
  await runtime.prompt(sessionId, { ...promptRequest(promptId(n)), directory: runtime.project, parts: [{ type: 'text', text }] });
  await waitFor(async () => Object.keys(await runtime.statuses(runtime.project)).length === 0);
  await waitFor(() => (runtime.registryFile().turns[sessionId] ?? []).every((turn) => turn.after !== undefined));
};

const messageIds = async (runtime, sessionId) => (await runtime.loadMessages(sessionId, runtime.project, { limit: 50 }))
  .records.map((record) => record.info.id);

describe('managed chat directories', () => {
  it('lists the directories of native sessions created in managed chats, by configured or real root', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-native-chats-')));
    directories.push(base);
    const realRoot = path.join(base, 'real-chats');
    const chatDir = path.join(realRoot, '2026-09-29', 'session-a');
    const projectDir = path.join(base, 'project');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    // The configured root links to where the chats really live.
    const linkedRoot = path.join(base, 'chats');
    fs.symlinkSync(realRoot, linkedRoot);
    const linkedChatDir = path.join(linkedRoot, '2026-09-29', 'session-a');
    const runtime = createNativeAgentsRuntime({
      dataDir: path.join(base, 'data'),
      resolveExecutable: async () => '/usr/bin/claude',
      buildChildEnv: () => ({}),
      clientVersion: 'test',
      publishNativeEvent: () => {},
      loadSdk: async () => createTranscriptSdk(projectDir).sdk,
      managedChatsRoots: [linkedRoot],
    });
    await runtime.createSession({ backend: 'claude', directory: linkedChatDir });
    await runtime.createSession({ backend: 'claude', directory: chatDir });
    await runtime.createSession({ backend: 'claude', directory: projectDir });

    expect((await runtime.managedChatDirectories()).sort()).toEqual([chatDir, linkedChatDir].sort());
    await runtime.shutdown();
  });
});

describe('native reverts through the runtime', () => {
  it('reverts files at once, unreverts, and rewinds the conversation with the next prompt', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runPrompt(runtime, id, 1, 'write a.txt one');
    await runPrompt(runtime, id, 2, 'write b.txt two');

    const reverted = await runtime.revert(id, promptId(2), runtime.project);
    expect(reverted).toMatchObject({ filesRestored: 1, conversationOnly: false, session: { id, revert: { messageID: promptId(2) } } });
    expect([runtime.read('a.txt'), runtime.read('b.txt')]).toEqual(['one', null]);
    expect(runtime.events.at(-1).payload).toMatchObject({ type: 'session.updated', properties: { info: { revert: { messageID: promptId(2) } } } });
    // Until the next prompt the reverted messages stay; the UI hides them.
    expect(await messageIds(runtime, id)).toContain(promptId(2));

    expect(await runtime.unrevert(id, runtime.project)).not.toHaveProperty('revert');
    expect(runtime.read('b.txt')).toBe('two');
    await runtime.revert(id, promptId(2), runtime.project);

    // The next prompt resumes at the reply before the reverted prompt.
    runtime.state.hold = deferred();
    await runtime.prompt(id, { ...promptRequest(promptId(3)), directory: runtime.project, parts: [{ type: 'text', text: 'write c.txt three' }] });
    expect(runtime.state.queries.at(-1).options).toMatchObject({ resume: id.slice(4), resumeSessionAt: `msg_${promptId(1).slice(6, 14)}-entry` });
    expect((await runtime.getSession(id, runtime.project)).revert).toBeUndefined();
    expect(await runtime.unrevert(id, runtime.project)).toBeDefined();
    expect(runtime.read('b.txt')).toBeNull();

    // Mid-turn the transcript still holds the reverted prompt; history stops before it.
    const midTurn = await messageIds(runtime, id);
    expect(midTurn).not.toContain(promptId(2));
    expect(midTurn).toContain(promptId(3));

    runtime.state.hold.resolve();
    runtime.state.hold = null;
    await waitFor(() => runtime.registryFile().reverts[id] === undefined);
    expect(runtime.registryFile().turns[id].map((turn) => turn.messageId)).toEqual([promptId(1), promptId(3)]);
    expect((await messageIds(runtime, id)).filter((messageId) => messageId.startsWith('ncl_u_'))).toEqual([promptId(1), promptId(3)]);
    expect([runtime.read('a.txt'), runtime.read('b.txt'), runtime.read('c.txt')]).toEqual(['one', null, 'three']);
    await runtime.shutdown();
  });

  it('leaves the reverted messages out while a prompt is handed over, and keeps the revert when it never arrives', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runPrompt(runtime, id, 1, 'write a.txt one');
    await runPrompt(runtime, id, 2, 'write b.txt two');
    const send = (n, text) => runtime.prompt(id, { ...promptRequest(promptId(n)), directory: runtime.project, parts: [{ type: 'text', text }] });

    // The CLI never takes the prompt: the revert can still be undone.
    await runtime.revert(id, promptId(2), runtime.project);
    runtime.state.failStart = true;
    await expect(send(3, 'say three')).rejects.toThrow('claude could not start');
    expect((await runtime.getSession(id, runtime.project)).revert).toEqual({ messageID: promptId(2) });
    expect(runtime.events.at(-1).payload).toMatchObject({ type: 'session.updated', properties: { info: { revert: { messageID: promptId(2) } } } });
    await runtime.unrevert(id, runtime.project);
    expect(runtime.read('b.txt')).toBe('two');

    // The open query is slow to exit; history leaves the reverted prompt out meanwhile.
    await runPrompt(runtime, id, 4, 'say four');
    await runtime.revert(id, promptId(4), runtime.project);
    runtime.state.exitGate = deferred();
    const handing = send(5, 'say five');
    await waitFor(() => runtime.state.exiting);
    expect(await messageIds(runtime, id)).not.toContain(promptId(4));
    expect((await runtime.getSession(id, runtime.project)).revert).toBeUndefined();
    runtime.state.exitGate.resolve();
    await handing;
    await waitFor(() => runtime.registryFile().reverts[id] === undefined);
    expect((await messageIds(runtime, id)).filter((messageId) => messageId.startsWith('ncl_u_'))).toEqual([promptId(1), promptId(2), promptId(5)]);
    await runtime.shutdown();
  });

  it('the Stop control stops the background tasks a finished turn left running', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runPrompt(runtime, id, 1, 'write a.txt one');
    expect(await runtime.abort(id)).toBe(false);

    await runPrompt(runtime, id, 2, 'background wait');
    expect(await runtime.backgroundTasks()).toMatchObject({ [id]: { tasks: [{ id: 'bwait' }] } });
    expect(await runtime.abort(id)).toBe(true);
    expect(runtime.state.stoppedTasks).toEqual(['bwait']);
    expect(runtime.state.queries.at(-1).aborted).toBe(false);
    await runtime.shutdown();
  });

  it('stops a running turn before reverting it, and refuses the first prompt', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runPrompt(runtime, id, 1, 'write a.txt one');
    runtime.state.hold = deferred();
    await runtime.prompt(id, { ...promptRequest(promptId(2)), directory: runtime.project, parts: [{ type: 'text', text: 'write a.txt two' }] });
    await waitFor(() => runtime.read('a.txt') === 'two');

    expect(await runtime.revert(id, promptId(2), runtime.project)).toMatchObject({ filesRestored: 1 });
    expect(runtime.state.queries.at(-1).aborted).toBe(true);
    expect(runtime.read('a.txt')).toBe('one');
    await expect(runtime.revert(id, promptId(1), runtime.project)).rejects.toMatchObject({ status: 409, code: 'NATIVE_REVERT_FIRST_MESSAGE' });
    await runtime.shutdown();
  });

  it('forks the conversation before a prompt, and forks the first prompt into an empty session', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runPrompt(runtime, id, 1, 'say one');
    await runPrompt(runtime, id, 2, 'say two');

    const forked = await runtime.fork(id, promptId(2), runtime.project);
    expect(forked.id).toBe('ncl_77777777-7777-4777-8777-777777777777');
    expect(runtime.events.at(-1).payload).toMatchObject({ type: 'session.created', properties: { info: { id: forked.id } } });
    expect((await messageIds(runtime, forked.id)).filter((messageId) => messageId.startsWith('ncl_u_'))).toEqual([promptId(1)]);
    expect((await runtime.listSessions(runtime.project)).backends.claude.sessions.map((session) => session.id)).toContain(forked.id);

    const empty = await runtime.fork(id, promptId(1), runtime.project);
    expect(empty.id).not.toBe(id);
    expect(await messageIds(runtime, empty.id)).toEqual([]);
    await runtime.shutdown();
  });

  it("sends a feature's instructions to the CLI after the user's text", async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runtime.prompt(id, {
      ...promptRequest(promptId(1)),
      directory: runtime.project,
      parts: [{ type: 'text', text: 'what is this file?' }],
      instructions: 'Answer the side question only.',
    });
    await waitFor(() => runtime.state.queries[0]?.contents.length === 1);
    expect(runtime.state.queries[0].contents[0]).toEqual([
      { type: 'text', text: 'what is this file?' },
      { type: 'text', text: '<openchamber-instructions>\nAnswer the side question only.\n</openchamber-instructions>' },
    ]);
    await waitFor(async () => Object.keys(await runtime.statuses(runtime.project)).length === 0);
    await runtime.shutdown();
  });

  it('forks the whole conversation when no message is given', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runPrompt(runtime, id, 1, 'say one');
    await runPrompt(runtime, id, 2, 'say two');

    const forked = await runtime.fork(id, null, runtime.project);
    expect((await messageIds(runtime, forked.id)).filter((messageId) => messageId.startsWith('ncl_u_'))).toEqual([promptId(1), promptId(2)]);
    await runtime.shutdown();
  });
});

describe('native session management', () => {
  it('renames a Claude session in the registry until its transcript exists, then in the transcript', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project, title: 'Fresh' });
    expect((await runtime.updateSession(id, runtime.project, { title: 'Draft name' })).title).toBe('Draft name');
    expect(runtime.state.renames).toEqual([]);

    await runPrompt(runtime, id, 1, 'say one');
    await waitFor(() => runtime.state.renames.length === 1);
    expect(runtime.state.renames[0]).toEqual([id.slice(4), 'Draft name']);

    const renamed = await runtime.updateSession(id, runtime.project, { title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');
    expect(runtime.events.at(-1).payload).toMatchObject({ type: 'session.updated', properties: { info: { id, title: 'Renamed' } } });
    await runtime.shutdown();
  });

  it('archives and restores a Claude session, adopting one typed in a terminal', async () => {
    const runtime = createRevertRuntime();
    const uuid = '55555555-1111-4111-8111-111111111111';
    runtime.seedTerminalSession(uuid);
    const id = `ncl_${uuid}`;

    const archived = await runtime.updateSession(id, runtime.project, { archived: true });
    expect(archived.time.archived).toEqual(expect.any(Number));
    expect(runtime.registryFile().sessions[id]).toMatchObject({ origin: 'adopted', archivedAt: archived.time.archived, confirmedAt: expect.any(Number) });
    const listed = (await runtime.listSessions(runtime.project)).backends.claude.sessions.find((session) => session.id === id);
    expect(listed.time.archived).toBe(archived.time.archived);

    const restored = await runtime.updateSession(id, runtime.project, { archived: false });
    expect(restored.time.archived).toBeUndefined();
    await runtime.shutdown();
  });

  it('deletes a Claude session only after its CLI process exited, and keeps subagent sessions with their parent', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    // The session's query stays open after the turn.
    await runPrompt(runtime, id, 1, 'say one');

    await expect(runtime.deleteSession(`${id}_t_toolu_1`, runtime.project)).rejects.toMatchObject({ status: 400 });
    expect(await runtime.deleteSession(id, runtime.project)).toEqual({ deleted: true });

    expect(runtime.state.deletes).toEqual([{ uuid: id.slice(4), queriesOpen: 0 }]);
    expect(runtime.registryFile().sessions[id]).toBeUndefined();
    expect(runtime.events.at(-1).payload).toMatchObject({ type: 'session.deleted', properties: { sessionID: id, info: { id } } });
    await expect(runtime.getSession(id, runtime.project)).rejects.toMatchObject({ status: 404 });
    await runtime.shutdown();
  });

  it('keeps OpenChamber metadata for a session, adopting one typed in a terminal, and never lets a client rewrite the native marker', async () => {
    const runtime = createRevertRuntime();
    const uuid = '66666666-1111-4111-8111-111111111111';
    runtime.seedTerminalSession(uuid);
    const id = `ncl_${uuid}`;

    const linked = await runtime.updateSession(id, runtime.project, {
      metadata: { external: 'keep', openchamber: { btwSessionID: 'ncl_fork', native: { backend: 'codex' } } },
    });
    expect(linked.metadata).toEqual({ external: 'keep', openchamber: { btwSessionID: 'ncl_fork', native: { backend: 'claude' } } });
    expect(runtime.registryFile().sessions[id]).toMatchObject({ origin: 'adopted', metadata: { external: 'keep', openchamber: { btwSessionID: 'ncl_fork' } } });
    expect(runtime.registryFile().sessions[id].metadata.openchamber.native).toBeUndefined();
    const listed = (await runtime.listSessions(runtime.project)).backends.claude.sessions.find((session) => session.id === id);
    expect(listed.metadata.openchamber.btwSessionID).toBe('ncl_fork');

    // The session assist writes next to it.
    const assist = { recap: 'Fixed the build', suggestion: 'Run the tests', forMessageID: 'ncl_a_1', generatedAt: 5 };
    const assisted = await runtime.setSessionAssist(id, runtime.project, assist);
    expect(assisted.metadata.openchamber).toEqual({ btwSessionID: 'ncl_fork', assist, native: { backend: 'claude' } });
    expect(runtime.events.at(-1).payload).toMatchObject({ type: 'session.updated', properties: { info: { id, metadata: { openchamber: { assist } } } } });
    await runtime.shutdown();
  });

  it('deletes a session that never had a turn from the registry alone', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    expect(await runtime.deleteSession(id, runtime.project)).toEqual({ deleted: true });
    expect(runtime.state.deletes).toEqual([]);
    expect((await runtime.listSessions(runtime.project)).backends.claude.sessions.map((session) => session.id)).not.toContain(id);
    await runtime.shutdown();
  });
});

describe('native compaction', () => {
  it('sends /compact to Claude Code without a user message of its own, and refuses instructions for Codex', async () => {
    const runtime = createRevertRuntime();
    const { id } = await runtime.createSession({ backend: 'claude', directory: runtime.project });
    await runPrompt(runtime, id, 1, 'say one');
    const before = runtime.events.length;
    await runtime.compact(id, { directory: runtime.project, model: { providerID: 'claude-native', modelID: 'haiku' }, agent: 'build', instructions: 'keep the plan' });
    await waitFor(async () => Object.keys(await runtime.statuses(runtime.project)).length === 0);

    expect(runtime.state.queries.at(-1).texts.at(-1)).toBe('/compact keep the plan');
    const userMessages = runtime.events.slice(before)
      .filter((event) => event.payload.type === 'message.updated' && event.payload.properties.info.role === 'user');
    expect(userMessages.filter((event) => !event.payload.properties.info.id.endsWith('_u'))).toEqual([]);

    await expect(runtime.compact('ncx_01a0d2a6-b55b-7162-a837-c62053537e00', {
      directory: runtime.project,
      model: { providerID: 'codex-native', modelID: 'gpt-5.5' },
      agent: 'build',
      instructions: 'keep the plan',
    })).rejects.toMatchObject({ status: 400 });
    await expect(runtime.compact(id, { directory: runtime.project, model: { providerID: 'codex-native', modelID: 'gpt-5.5' }, agent: 'build' }))
      .rejects.toMatchObject({ status: 409, code: 'NATIVE_BACKEND_MISMATCH' });
    await runtime.shutdown();
  });
});

describe('native task runtime without process launches', () => {
  it('reads snapshots without opening queries and leaves Codex unsupported', async () => {
    const runtime = createRuntime({ snapshotGit: async () => '' });
    const session = await runtime.createSession({ backend: 'claude', directory: DIRECTORY });
    expect(await runtime.checklist(session.id, DIRECTORY)).toEqual({ state: 'unavailable', reason: 'source_unknown' });
    expect(await runtime.sessionTasks(session.id, DIRECTORY)).toMatchObject({ state: 'inactive', generation: null, tasks: [], omitted: 0 });
    expect(await runtime.taskOutput(session.id, DIRECTORY, 'a', 'closed')).toEqual({ state: 'unavailable', reason: 'query_closed' });
    await expect(runtime.stopTask(session.id, DIRECTORY, 'a', 'closed')).rejects.toMatchObject({ code: 'NATIVE_TASK_QUERY_CLOSED' });
    const codexId = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';
    expect(await runtime.checklist(codexId, DIRECTORY)).toEqual({ state: 'unavailable', reason: 'unsupported' });
    expect(await runtime.sessionTasks(codexId, DIRECTORY)).toMatchObject({ state: 'unsupported', generation: null });
    expect(runtime.queries).toHaveLength(0);
    expect((await runtime.capabilities()).backends.claude.tasks).toEqual({ checklist: true, background: true, output: true, stop: true });
    expect((await runtime.capabilities()).backends.codex.tasks).toEqual({ plan: true, todos: true });
    await runtime.shutdown();
  });

  it('reads a Codex plan and its observed steps, and neither from Claude', async () => {
    const runtime = createRuntime({ snapshotGit: async () => '' });
    const session = await runtime.createSession({ backend: 'claude', directory: DIRECTORY });
    const codexId = 'ncx_01a0d2a6-b55b-7162-a837-c62053537e00';
    expect(await runtime.plan(session.id, DIRECTORY)).toEqual({ state: 'unavailable', reason: 'unsupported' });
    expect(await runtime.codexTodos(session.id, DIRECTORY)).toMatchObject({ state: 'unsupported', generation: null, todos: [] });
    // A thread this process holds no notification for is not a thread without
    // steps: Codex stores none, so nothing could read them back.
    expect(await runtime.codexTodos(codexId, DIRECTORY)).toMatchObject({ state: 'unknown', generation: null, todos: [] });
    await runtime.shutdown();
  });

  it('scopes operations by session/directory/generation without changing session Stop', async () => {
    const runtime = createRuntime({ snapshotGit: async () => '', childFrames: [
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'one' }, { task_id: 'b', task_type: 'local_bash', description: 'two' }] },
    ] });
    const first = await runtime.createSession({ backend: 'claude', directory: DIRECTORY });
    const second = await runtime.createSession({ backend: 'claude', directory: DIRECTORY });
    await runtime.prompt(first.id, promptRequest('ncl_u_a22f0a7a-a88c-4093-a5e3-6653ff44f6d3'));
    await runtime.prompt(second.id, promptRequest('ncl_u_b22f0a7a-a88c-4093-a5e3-6653ff44f6d3'));
    await waitFor(async () => (await runtime.sessionTasks(first.id, DIRECTORY)).state === 'active' && (await runtime.sessionTasks(second.id, DIRECTORY)).state === 'active');
    const snapshot = await runtime.sessionTasks(first.id, DIRECTORY);
    await expect(runtime.stopTask(second.id, DIRECTORY, 'a', snapshot.generation)).rejects.toMatchObject({ code: 'NATIVE_TASK_GENERATION_MISMATCH' });
    await expect(runtime.stopTask(first.id, '/foreign', 'a', snapshot.generation)).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    expect(await runtime.stopTask(first.id, DIRECTORY, 'a', snapshot.generation)).toEqual({ accepted: true });
    expect(runtime.turns.stoppedTasks).toEqual(['a']);
    expect(runtime.turns.interrupts).toBe(0);
    expect((await runtime.backgroundTasks())[first.id].tasks).toHaveLength(2);
    await runtime.abort(first.id);
    expect(runtime.turns.interrupts).toBe(1);
    runtime.turns.finish.resolve();
    await waitFor(() => runtime.events.some((event) => event.payload.type === 'session.idle'));
    await runtime.shutdown();
    expect(await runtime.sessionTasks(first.id, DIRECTORY)).toMatchObject({ state: 'inactive', generation: null, tasks: [], omitted: 0 });
  });

  it('captures actual connection env for checklists and never retargets to a changed environment', async () => {
    const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-checklist-')));
    directories.push(configDir);
    fs.mkdirSync(path.join(configDir, 'tasks', 'original'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'tasks', 'original', '1.json'), JSON.stringify({ id: '1', subject: 'original', status: 'pending' }));
    let listId = 'original';
    const runtime = createRuntime({ snapshotGit: async () => '', childEnv: () => ({ CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_TASK_LIST_ID: listId }) });
    const session = await runtime.createSession({ backend: 'claude', directory: DIRECTORY });
    await runtime.prompt(session.id, promptRequest('ncl_u_a22f0a7a-a88c-4093-a5e3-6653ff44f6d3'));
    listId = 'different';
    const snapshot = await runtime.checklist(session.id, DIRECTORY);
    expect(snapshot).toMatchObject({ state: 'ready', source: 'files', complete: true, items: [{ subject: 'original' }] });
    expect(snapshot.identity).not.toContain(configDir);
    await expect(runtime.checklist(session.id, '/foreign')).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    const sessionRecord = await runtime.getSession(session.id, DIRECTORY);
    expect(JSON.stringify(sessionRecord)).not.toContain(configDir);
    runtime.turns.finish.resolve();
    await runtime.shutdown();
    const restarted = createNativeAgentsRuntime({
      dataDir: runtime.dataDir,
      resolveExecutable: async () => null,
      buildChildEnv: () => ({ CLAUDE_CONFIG_DIR: '/different', CLAUDE_CODE_TASK_LIST_ID: 'changed' }),
      clientVersion: 'test', publishNativeEvent: () => {},
      loadSdk: async () => { throw new Error('Checklist reads must not start or read a query'); },
      snapshots: createSnapshotStore({ dataDir: runtime.dataDir, git: async () => '' }),
    });
    expect(await restarted.checklist(session.id, DIRECTORY)).toMatchObject({ identity: snapshot.identity, items: [{ subject: 'original' }] });
    expect(await restarted.sessionTasks(session.id, DIRECTORY)).toMatchObject({ state: 'inactive', generation: null });
    await restarted.shutdown();
  });
});

describe('native interaction cleanup without process launches', () => {
  it('publishes native deletion even when saved question cleanup fails', async () => {
    const runtime = createRuntime({ snapshotGit: async () => '' });
    const file = path.join(runtime.dataDir, 'native-agents', 'interactions', `${SESSION_ID}.json`);
    fs.mkdirSync(file, { recursive: true });
    fs.writeFileSync(path.join(file, 'unreadable-entry'), 'fixture');
    await expect(runtime.deleteSession(SESSION_ID, DIRECTORY)).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_CLEANUP_FAILED' });
    expect(runtime.events.some((event) => event.payload.type === 'session.deleted' && event.payload.properties.info.id === SESSION_ID)).toBe(true);
    await runtime.shutdown();
  });

  it('publishes the surviving fork and names it if supplemental answers cannot be copied', async () => {
    const runtime = createRuntime({ snapshotGit: async () => '' });
    const file = path.join(runtime.dataDir, 'native-agents', 'interactions', `${SESSION_ID}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{invalid');
    await expect(runtime.fork(SESSION_ID, null, DIRECTORY)).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_FORK_INCOMPLETE' });
    expect(runtime.events.some((event) => event.payload.type === 'session.created' && event.payload.properties.info.id === 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1189')).toBe(true);
    await runtime.shutdown();
  });
});

describe('native agents routes', () => {
  const createApp = (runtime, isLocalManagementRequest = () => false) => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerNativeAgentRoutes(app, { runtime, isLocalManagementRequest });
    return app;
  };

  it('restricts hook enrollment to local management and takes the port from the receiving server', async () => {
    const calls = [];
    const memorySharing = {
      status: async (directory) => { calls.push(['status', directory]); return { enabled: true, backends: [], progress: [], sources: [] }; },
      connect: async (...args) => { calls.push(['connect', ...args]); return { installed: true }; },
      disconnect: async (backend) => { calls.push(['disconnect', backend]); return { installed: false }; },
      importSource: async (...args) => { calls.push(['import', ...args]); return { imported: true, memoryId: 'm' }; },
    };
    const remote = createApp({ memorySharing });
    const local = createApp({ memorySharing }, () => true);
    const base = '/api/native/memory';
    const status = await request(remote).get(base).query({ directory: DIRECTORY }).expect(200);
    expect(status.body.canManage).toBe(false);
    await request(remote).post(`${base}/codex/connect`).send({ port: 1 }).expect(403);
    await request(remote).delete(`${base}/codex`).expect(403);
    await request(local).post(`${base}/codex/connect`).send({ port: 1 }).expect(200);
    await request(local).delete(`${base}/codex`).expect(200);
    await request(remote).post(`${base}/import`).send({ sourceId: 'known-source', directory: DIRECTORY }).expect(200);
    await request(remote).post(`${base}/import`).send({ file: '/private/memory.md', directory: DIRECTORY }).expect(400);
    expect(calls).toEqual([
      ['status', DIRECTORY], ['connect', 'codex', expect.any(Number)], ['disconnect', 'codex'],
      ['import', 'known-source', DIRECTORY],
    ]);
    expect(calls[1][2]).not.toBe(1);
  });

  it('allows ChatGPT authorization only from the local management boundary', async () => {
    const runtime = createRuntime();
    const remote = createApp(runtime);
    const local = createApp(runtime, () => true);
    const base = '/api/native/claude/chatgpt';
    await request(remote).get(`${base}/accounts`).expect(200, { accounts: [], localLogin: false });
    await request(remote).post(`${base}/authorize`).send({ completionMessage: 'Return to the app.' }).expect(403);
    const started = await request(local).post(`${base}/authorize`).send({ completionMessage: 'Return to the app.' }).expect(200);
    expect(started.body.url).toMatch(/^https:\/\/auth.openai.com\/api\/accounts\/authorize/);
    await request(remote).delete(`${base}/authorize/${started.body.attemptId}`).expect(403);
    await request(local).delete(`${base}/authorize/${started.body.attemptId}`).expect(200, { cancelled: true });
    await request(local).get(`${base}/authorize/${started.body.attemptId}`).expect(200, { status: 'cancelled', accountId: null });
    await runtime.shutdown();
  });

  it('manages Claude connections without returning credentials and validates before writes', async () => {
    const runtime = createRuntime();
    const app = createApp(runtime);
    const endpoint = '/api/native/claude/connections';
    const draft = {
      name: 'Kimi', baseURL: 'https://example.test/anthropic', auth: 'api-key', apiKey: 'test-only-key',
      models: [{ id: SESSION_UUID, name: 'Kimi', modelID: 'kimi-for-coding', contextWindow: 262144, outputLimit: 32000, input: { image: false, pdf: false }, efforts: [] }],
    };
    const created = await request(app).post(endpoint).send(draft).expect(200);
    expect(created.body.hasKey).toBe(true);
    expect(created.body).not.toHaveProperty('apiKey');
    await request(app).get(endpoint).expect(200, [created.body]);
    await request(app).post(endpoint).send({ ...draft, models: [] }).expect(400);
    const updated = await request(app).patch(`${endpoint}/${created.body.id}`).send({ ...draft, name: 'Changed', apiKey: undefined }).expect(200);
    expect(updated.body.revision).toBe(2);
    const catalog = await request(app).get('/api/native/catalog').expect(200);
    const model = catalog.body.backends.claude.models.find((entry) => entry.name === 'Changed / Kimi');
    expect((await runtime.claudeConnections.resolve(model.id)).env.ANTHROPIC_API_KEY).toBe('test-only-key');
    await request(app).delete(`${endpoint}/${created.body.id}`).expect(200, { deleted: true });
    await expect(runtime.claudeConnections.resolve(model.id)).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_UNAVAILABLE' });
    await request(app).get(endpoint).expect(200, []);
    await runtime.shutdown();
  });

  it('routes Codex commands separately from prompts and rejects arbitrary RPC and incomplete reviews', async () => {
    const calls = [];
    const app = createApp({ codexCommand: async (input) => { calls.push(input); return { kind: 'output', entries: [], notices: [] }; } });
    await request(app).post('/api/native/codex/command').send({ name: 'skills', directory: DIRECTORY }).expect(200);
    await request(app).post('/api/native/codex/command').send({ name: 'account/logout', directory: DIRECTORY }).expect(400);
    await request(app).post('/api/native/codex/command').send({ name: 'review', directory: DIRECTORY }).expect(400);
    await request(app).post('/api/native/codex/command').send({ name: 'stop', directory: DIRECTORY }).expect(400);
    expect(calls).toEqual([{ name: 'skills', directory: DIRECTORY }]);
  });

  it('serves status before the session-id route and requires a directory', async () => {
    const calls = [];
    const app = createApp({
      statuses: async (directory) => {
        calls.push(directory);
        return { [SESSION_ID]: { type: 'busy' } };
      },
      getSession: async () => {
        throw new Error('status must not reach the session route');
      },
    });
    await request(app).get('/api/native/sessions/status').query({ directory: DIRECTORY }).expect(200, { [SESSION_ID]: { type: 'busy' } });
    expect(calls).toEqual([DIRECTORY]);
    const missing = await request(app).get('/api/native/sessions/status').expect(400);
    expect(missing.body.code).toBe('NATIVE_INVALID_REQUEST');
  });

  it('lists the managed chat directories that hold native sessions', async () => {
    const app = createApp({ managedChatDirectories: async () => ['/chats/2026-09-29/session-a'] });
    await request(app).get('/api/native/chat-directories').expect(200, { directories: ['/chats/2026-09-29/session-a'] });
  });

  it('serves every session\'s background tasks before the session-id route', async () => {
    const snapshot = { [SESSION_ID]: { directory: DIRECTORY, tasks: [{ id: 'bwait', type: 'local_bash', description: 'Wait for the job' }] } };
    const app = createApp({
      backgroundTasks: async () => snapshot,
      getSession: async () => {
        throw new Error('background tasks must not reach the session route');
      },
    });
    await request(app).get('/api/native/sessions/background').expect(200, snapshot);
  });

  it('serves native task routes with identity only and validates generation before runtime calls', async () => {
    const calls = [];
    const inactive = { state: 'inactive', generation: null, revision: 3, tasks: [], omitted: 0 };
    const inactiveTodos = { state: 'inactive', generation: 'query-1', revision: 2, todos: [] };
    const app = createApp({
      checklist: async (...args) => { calls.push(['checklist', ...args]); return { state: 'unavailable', reason: 'source_unknown' }; },
      sessionTasks: async (...args) => { calls.push(['tasks', ...args]); return inactive; },
      plan: async (...args) => { calls.push(['plan', ...args]); return { state: 'empty' }; },
      codexTodos: async (...args) => { calls.push(['todos', ...args]); return inactiveTodos; },
      taskOutput: async (...args) => { calls.push(['output', ...args]); return { state: 'ready', text: '', truncated: false }; },
      stopTask: async (...args) => { calls.push(['stop', ...args]); return { accepted: true }; },
    });
    const base = `/api/native/sessions/${SESSION_ID}`;
    await request(app).get(`${base}/checklist`).query({ directory: DIRECTORY }).expect(200);
    await request(app).get(`${base}/tasks`).query({ directory: DIRECTORY }).expect(200, inactive);
    await request(app).get(`${base}/plan`).query({ directory: DIRECTORY }).expect(200, { state: 'empty' });
    await request(app).get(`${base}/todos`).query({ directory: DIRECTORY }).expect(200, inactiveTodos);
    await request(app).get(`${base}/plan`).expect(400);
    await request(app).get(`${base}/todos`).expect(400);
    await request(app).get(`${base}/tasks/a/output`).query({ directory: DIRECTORY, generation: 'current' }).expect(200, { state: 'ready', text: '', truncated: false });
    await request(app).post(`${base}/tasks/a/stop`).send({ directory: DIRECTORY, generation: 'current' }).expect(200, { accepted: true });
    await request(app).get(`${base}/tasks/a/output`).query({ directory: DIRECTORY }).expect(400);
    await request(app).get(`${base}/tasks/a/output`).query({ directory: DIRECTORY, generation: 'current', path: '/private/log' }).expect(400);
    await request(app).post(`${base}/tasks/a/stop`).send({ directory: DIRECTORY, generation: 'current', path: '/private/log' }).expect(400);
    await request(app).post(`${base}/tasks/a/stop`).send({ generation: 'current' }).expect(400);
    expect(calls).toEqual([
      ['checklist', SESSION_ID, DIRECTORY], ['tasks', SESSION_ID, DIRECTORY],
      ['plan', SESSION_ID, DIRECTORY], ['todos', SESSION_ID, DIRECTORY],
      ['output', SESSION_ID, DIRECTORY, 'a', 'current'], ['stop', SESSION_ID, DIRECTORY, 'a', 'current'],
    ]);
  });

  it('maps runtime failures to stable status codes', async () => {
    const app = createApp({
      getSession: async (sessionId) => {
        throw sessionNotFoundError(sessionId);
      },
      loadMessages: async () => {
        throw new JsonRpcError('Codex app-server connection is closed', -32000);
      },
    });
    const notFound = await request(app).get(`/api/native/sessions/${SESSION_ID}`).query({ directory: DIRECTORY }).expect(404);
    expect(notFound.body.code).toBe('NATIVE_SESSION_NOT_FOUND');
    const backend = await request(app).get(`/api/native/sessions/${SESSION_ID}/messages`).query({ directory: DIRECTORY }).expect(502);
    expect(backend.body.code).toBe('NATIVE_BACKEND_ERROR');
  });

  it('validates writes before they reach the runtime', async () => {
    const calls = [];
    const app = createApp({
      createSession: async (input) => {
        calls.push(['create', input]);
        return { id: 'ncl_x' };
      },
      prompt: async (sessionId, input) => {
        calls.push(['prompt', sessionId, input]);
      },
      abort: async () => true,
      replyQuestion: (requestId, answers) => {
        calls.push(['reply', requestId, answers]);
      },
      rejectQuestion: (requestId) => {
        throw Object.assign(new Error('gone'), { requestId });
      },
    });
    await request(app).post('/api/native/sessions').send({ backend: 'opencode', directory: DIRECTORY }).expect(400);
    await request(app).post('/api/native/sessions').send({ backend: 'claude', directory: DIRECTORY }).expect(200, { id: 'ncl_x' });
    await request(app).post(`/api/native/sessions/${SESSION_ID}/prompt`).send({ directory: DIRECTORY, messageID: 'ncl_u_x', parts: [], model: { providerID: 'claude-native', modelID: 'haiku' }, agent: 'build' }).expect(400);
    await request(app).post(`/api/native/sessions/${SESSION_ID}/prompt`).send(promptRequest('ncl_u_x')).expect(200, { accepted: true });
    await request(app).post(`/api/native/sessions/${SESSION_ID}/prompt`).send({ ...promptRequest('ncl_u_y'), instructions: 'Answer the side question only.' }).expect(200, { accepted: true });
    await request(app).post(`/api/native/sessions/${SESSION_ID}/abort`).send({}).expect(200, { aborted: true });
    await request(app).post('/api/native/questions/ncq_1/reply').send({ answers: [['blue']] }).expect(200, { replied: true });
    await request(app).post('/api/native/questions/ncq_1/reply').send({ answers: 'blue' }).expect(400);
    await request(app).post('/api/native/questions/ncq_1/reject').send({}).expect(500);
    expect(calls).toEqual([
      ['create', { backend: 'claude', directory: DIRECTORY }],
      ['prompt', SESSION_ID, { ...promptRequest('ncl_u_x'), variant: undefined, instructions: undefined }],
      ['prompt', SESSION_ID, { ...promptRequest('ncl_u_y'), variant: undefined, instructions: 'Answer the side question only.' }],
      ['reply', 'ncq_1', [['blue']]],
    ]);
  });

  it('validates revert, unrevert and fork before they reach the runtime', async () => {
    const calls = [];
    const app = createApp({
      revert: async (...args) => {
        calls.push(['revert', ...args]);
        return { session: { id: SESSION_ID }, filesRestored: 2, conversationOnly: false };
      },
      unrevert: async (...args) => {
        calls.push(['unrevert', ...args]);
        return { id: SESSION_ID };
      },
      fork: async (...args) => {
        calls.push(['fork', ...args]);
        return { id: 'ncl_fork' };
      },
    });
    const base = `/api/native/sessions/${SESSION_ID}`;
    await request(app).post(`${base}/revert`).send({ directory: DIRECTORY }).expect(400);
    await request(app).post(`${base}/revert`).send({ directory: DIRECTORY, messageID: 'ncl_u_x' })
      .expect(200, { session: { id: SESSION_ID }, filesRestored: 2, conversationOnly: false });
    await request(app).post(`${base}/unrevert`).send({}).expect(400);
    await request(app).post(`${base}/unrevert`).send({ directory: DIRECTORY }).expect(200, { id: SESSION_ID });
    await request(app).post(`${base}/fork`).send({ messageID: 'ncl_u_x' }).expect(400);
    await request(app).post(`${base}/fork`).send({ directory: DIRECTORY, messageID: 'ncl_u_x' }).expect(200, { id: 'ncl_fork' });
    await request(app).post(`${base}/fork`).send({ directory: DIRECTORY }).expect(200, { id: 'ncl_fork' });
    expect(calls).toEqual([
      ['revert', SESSION_ID, 'ncl_u_x', DIRECTORY],
      ['unrevert', SESSION_ID, DIRECTORY],
      ['fork', SESSION_ID, 'ncl_u_x', DIRECTORY],
      ['fork', SESSION_ID, null, DIRECTORY],
    ]);
  });

  it('validates session changes and deletes before they reach the runtime', async () => {
    const calls = [];
    const app = createApp({
      updateSession: async (...args) => {
        calls.push(['update', ...args]);
        return { id: SESSION_ID };
      },
      deleteSession: async (...args) => {
        calls.push(['delete', ...args]);
        return { deleted: true };
      },
    });
    const route = `/api/native/sessions/${SESSION_ID}`;
    await request(app).patch(route).send({ directory: DIRECTORY }).expect(400);
    await request(app).patch(route).send({ directory: DIRECTORY, title: '   ' }).expect(400);
    await request(app).patch(route).send({ directory: DIRECTORY, title: '  Renamed ' }).expect(200, { id: SESSION_ID });
    await request(app).patch(route).send({ directory: DIRECTORY, archived: true }).expect(200);
    await request(app).patch(route).send({ directory: DIRECTORY, metadata: { openchamber: { blob: 'x'.repeat(70_000) } } }).expect(400);
    await request(app).patch(route).send({ directory: DIRECTORY, metadata: { openchamber: { btwSessionID: 'ncl_fork' } } }).expect(200);
    await request(app).delete(route).expect(400);
    await request(app).delete(route).query({ directory: DIRECTORY }).expect(200, { deleted: true });
    expect(calls).toEqual([
      ['update', SESSION_ID, DIRECTORY, { title: 'Renamed' }],
      ['update', SESSION_ID, DIRECTORY, { archived: true }],
      ['update', SESSION_ID, DIRECTORY, { metadata: { openchamber: { btwSessionID: 'ncl_fork' } } }],
      ['delete', SESSION_ID, DIRECTORY],
    ]);
  });

  it('lists commands for a backend and directory', async () => {
    const app = createApp({ commands: async (backend, directory) => ({ commands: [{ name: `${backend}:${directory}`, description: '', argumentHint: '' }] }) });
    await request(app).get('/api/native/commands').query({ backend: 'opencode', directory: DIRECTORY }).expect(400);
    await request(app).get('/api/native/commands').query({ backend: 'claude', directory: DIRECTORY })
      .expect(200, { commands: [{ name: `claude:${DIRECTORY}`, description: '', argumentHint: '' }] });
  });

  it('validates compaction requests before they reach the runtime', async () => {
    const calls = [];
    const app = createApp({
      compact: async (...args) => {
        calls.push(args);
      },
    });
    const route = `/api/native/sessions/${SESSION_ID}/compact`;
    const body = { directory: DIRECTORY, model: { providerID: 'claude-native', modelID: 'haiku' }, agent: 'build' };
    await request(app).post(route).send({ ...body, agent: 'review' }).expect(400);
    await request(app).post(route).send(body).expect(200, { accepted: true });
    await request(app).post(route).send({ ...body, instructions: '  keep the plan ' }).expect(200);
    expect(calls).toEqual([
      [SESSION_ID, body],
      [SESSION_ID, { ...body, instructions: 'keep the plan' }],
    ]);
  });

  it('passes paging parameters through with a bounded limit', async () => {
    const pages = [];
    const app = createApp({
      loadMessages: async (sessionId, directory, page) => {
        pages.push({ sessionId, directory, page });
        return { records: [], cursor: null, complete: true, childSessions: [] };
      },
    });
    await request(app).get(`/api/native/sessions/${SESSION_ID}/messages`).query({ directory: DIRECTORY, limit: '30', before: 'ncl_u_x' }).expect(200);
    await request(app).get(`/api/native/sessions/${SESSION_ID}/messages`).query({ directory: DIRECTORY, limit: '99999' }).expect(200);
    expect(pages).toEqual([
      { sessionId: SESSION_ID, directory: DIRECTORY, page: { limit: 30, before: 'ncl_u_x' } },
      { sessionId: SESSION_ID, directory: DIRECTORY, page: { limit: 50, before: undefined } },
    ]);
  });
});
