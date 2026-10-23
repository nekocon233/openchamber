import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { encodeDeepseekSessionId, newNativeClientUserMessageId } from '../ids.js';
import { createNativeEventPublisher } from '../publisher.js';
import { createQuestionRegistry } from '../questions.js';
import { createNativeRegistry } from '../registry.js';
import { createNativeReverts } from '../revert.js';
import { spawnCliProcess } from '../process.js';
import { createDeepseekBackend } from './backend.js';
import { createDeepseekTransport } from './transport.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = async (messages = 2, options = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-dsh-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  let transport;
  const questions = createQuestionRegistry({ publish: () => {} });
  const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
  const registry = createNativeRegistry({ filePath: path.join(directory, 'registry.json') });
  const reverts = createNativeReverts({ registry, snapshots: { repositoryRoot: async () => null } });
  const backend = createDeepseekBackend({
    reverts, ...options,
    decorateSession: async (session) => (await reverts.pending(session.id))?.phase === 'pending' ? { ...session, revert: { messageID: (await reverts.pending(session.id)).messageId } } : session,
    resolveExecutable: async () => process.execPath,
    buildEnv: () => ({ ...process.env, DSH_TEST_DIRECTORY: directory, DSH_TEST_MESSAGES: String(messages) }),
    registry,
    questions, publisher, readGlobalInstructions: async () => null,
    createTransport: (options) => { transport = createDeepseekTransport({ ...options, enterpriseMode: () => false,
      spawnProcess: (executable, args, options) => spawnCliProcess(executable, [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), ...args], options),
    }); return transport; },
  });
  cleanups.push(() => backend.shutdown());
  return { backend, directory, events, questions, registry, fixture: (method, args = {}) => transport.request(`fixture/${method}`, args, z.json()) };
};

describe('DeepSeek Harness Web adapter', () => {
  it('reads all statistics pages without publishing or retaining chat followers', async () => {
    const { backend, directory, events, fixture } = await setup(260);
    const sessions = await backend.listStatisticsSessions();
    expect(sessions).toHaveLength(1);
    const snapshot = await backend.loadStatistics(sessions[0].id, directory, { nativeId: sessions[0].nativeId });
    expect(snapshot.records.filter((record) => record.info.role === 'user')).toHaveLength(260);
    expect(snapshot.records.filter((record) => record.info.role === 'assistant')).toHaveLength(260);
    expect(snapshot.complete).toBe(true);
    expect(events).toHaveLength(0);
    expect(await fixture('stream-count')).toBe(0);
  });
  it('configures the server through official settings and credentials without returning a key', async () => {
    const { backend, fixture } = await setup();
    const configuration = await backend.configuration.read();
    expect(configuration).toMatchObject({ revision: 0, modelIDs: ['test-model'], credential: { configured: false, writable: true } });
    const saved = await backend.configuration.save({ revision: 0, baseURL: 'https://gateway.test/anthropic', modelIDs: ['test-model', 'another-model'], apiKey: 'fixture-api-key' });
    expect(saved).toMatchObject({ status: 'saved', configuration: { revision: 1, credential: { configured: true } } });
    expect(JSON.stringify(saved)).not.toContain('fixture-api-key');
    const state = await fixture('configuration');
    expect(state.value).toMatchObject({ reasoningEffort: 'high', models: [{ id: 'test-model', name: 'Test model', contextWindow: 1_000_000, maxTokens: 64000, inputModalities: ['text'] }, { id: 'another-model' }] });
    await backend.configuration.save({ revision: 1, baseURL: null, modelIDs: ['test-model'] });
    expect(await fixture('configuration')).toMatchObject({ keyWrites: 1, hasKey: true });
    expect((await backend.configuration.read()).baseURL).toBeNull();
  });

  it('rejects missing keys, invalid endpoints, concurrent stale writes and read-only credentials before mutation', async () => {
    const { backend, fixture } = await setup();
    const input = { revision: 0, baseURL: null, modelIDs: ['test-model'] };
    await expect(backend.configuration.save(input)).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_KEY_REQUIRED' });
    expect(() => backend.configuration.save({ ...input, apiKey: 'fixture-api-key', baseURL: 'https://user:secret@gateway.test' })).toThrow();
    const concurrent = await Promise.allSettled([
      backend.configuration.save({ ...input, apiKey: 'fixture-api-key' }),
      backend.configuration.save({ ...input, apiKey: 'fixture-second-key' }),
    ]);
    expect(concurrent[0].status).toBe('fulfilled');
    expect(concurrent[1]).toMatchObject({ status: 'rejected', reason: { code: 'NATIVE_DEEPSEEK_SETTINGS_CONFLICT', status: 409 } });
    expect(await fixture('configuration')).toMatchObject({ settingsWrites: 1, keyWrites: 1 });
    await fixture('settings-options', { keyWritable: false });
    await expect(backend.configuration.save({ ...input, revision: 1, apiKey: 'fixture-third-key' })).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_SETTINGS_READ_ONLY' });
    expect(await fixture('configuration')).toMatchObject({ settingsWrites: 1, keyWrites: 1 });
    await backend.configuration.save({ ...input, revision: 1 });
    expect((await backend.configuration.read()).credential).toEqual({ configured: true, writable: false });
  });

  it('returns durable settings after a credential failure and permits a retry with that revision', async () => {
    const { backend, fixture } = await setup();
    await fixture('settings-options', { rejectKey: true });
    const input = { revision: 0, baseURL: 'https://new.test/anthropic', modelIDs: ['test-model'], apiKey: 'fixture-rejected-key' };
    const result = await backend.configuration.save(input);
    expect(result).toMatchObject({ status: 'credential-error', configuration: { revision: 1, baseURL: input.baseURL, credential: { configured: false } } });
    expect(JSON.stringify(result)).not.toContain(input.apiKey);
    await fixture('settings-options', { rejectKey: false });
    expect(await backend.configuration.save({ ...input, revision: 1 })).toMatchObject({ status: 'saved', configuration: { credential: { configured: true } } });
    await fixture('settings-options', { rejectSettings: true });
    await expect(backend.configuration.save({ ...input, revision: 2, apiKey: 'fixture-unused-key' })).rejects.toMatchObject({ code: 'NATIVE_BACKEND_ERROR' });
    expect(await fixture('configuration')).toMatchObject({ revision: 2, settingsWrites: 2, keyWrites: 1 });
  });

  it('shares one follower across concurrent history opens', async () => {
    const { backend, directory, fixture } = await setup();
    const id = encodeDeepseekSessionId('session-existing');
    await Promise.all(Array.from({ length: 4 }, () => backend.loadMessages(id, directory, { limit: 50 })));
    expect(await fixture('stream-count')).toBe(1);
  });

  it('reopens live history after a socket disconnect without replacing its process or transcript', async () => {
    const { backend, directory, fixture } = await setup();
    const id = encodeDeepseekSessionId('session-existing');
    const before = await backend.loadMessages(id, directory, { limit: 50 });
    const pid = await fixture('process-id');
    await fixture('disconnect');
    await expect.poll(async () => {
      await backend.loadMessages(id, directory, { limit: 50 });
      return fixture('stream-count');
    }).toBe(1);
    const after = await backend.loadMessages(id, directory, { limit: 50 });
    expect(after).toEqual(before);
    expect(await fixture('process-id')).toBe(pid);
  });

  it('restores current plan/model selections from sequenced projections and ignores older frames', async () => {
    const { backend, directory, fixture } = await setup();
    const id = encodeDeepseekSessionId('session-existing');
    await backend.listRootSessions(directory);
    await fixture('selection', { sessionId: 'session-existing', plan: true, seq: 20 });
    await expect.poll(async () => (await backend.getSession(id, directory)).agent).toBe('plan');
    expect((await backend.getSession(id, directory)).model).toEqual({ providerID: 'deepseek-native', id: 'deepseek-official/test-model', variant: 'high' });
    await fixture('selection', { sessionId: 'session-existing', plan: false, seq: 10 });
    expect((await backend.getSession(id, directory)).agent).toBe('plan');
    await fixture('selection', { sessionId: 'session-existing', plan: false, seq: 30 });
    await expect.poll(async () => (await backend.getSession(id, directory)).agent).toBe('build');
  });
  it('authenticates against the real HTTP and WebSocket gates and reads native history', async () => {
    const { backend, directory } = await setup();
    expect((await backend.catalog())[0]).toMatchObject({
      id: 'deepseek-official/test-model', name: 'Test model', efforts: ['high'],
      contextWindow: 1_000_000, outputLimit: 64_000,
    });
    const sessions = await backend.listRootSessions(directory);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('Existing DSH session');
    const page = await backend.loadMessages(sessions[0].id, directory, { limit: 50 });
    expect(page.complete).toBe(true);
    expect(page.records.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(page.records[1].parts[0].text).toBe('reply 0');
  });

  it('reads history that contains a DSH compaction checkpoint', async () => {
    const { backend, directory, fixture } = await setup();
    const id = encodeDeepseekSessionId('session-existing');
    await fixture('append', { sessionId: 'session-existing', type: 'compaction/start', data: { compactionId: 'compact-1', turn: 2 } });
    await fixture('append', { sessionId: 'session-existing', type: 'compaction/summary', data: {
      compactionId: 'compact-1',
      summary: [{ type: 'text', text: '## Checkpoint' }, { type: 'text', text: 'Carry on' }],
      rawOutput: [{ type: 'reasoning', text: '' }, { type: 'text', text: '## Checkpoint' }],
      llmStreamCall: true,
      shadowedRange: { start: 1, end: 4 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 481811,
      provider: 'deepseek-official',
      model: 'test-model',
      maxTokens: 65536,
      usage: { inputTokens: 546124, outputTokens: 3557, totalTokens: 549681 },
    } });
    await fixture('append', { sessionId: 'session-existing', type: 'compaction/end', data: { compactionId: 'compact-1', turn: 2 } });
    const page = await backend.loadMessages(id, directory, { limit: 50 });
    expect(page.records.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'compaction']);
    expect(page.records[4].info).toMatchObject({ status: 'completed', summary: '## Checkpoint\nCarry on' });
  });

  it('skips an unreadable session event, keeps the rest of the history and reports it once', async () => {
    const { backend, directory, fixture, events } = await setup();
    const id = encodeDeepseekSessionId('session-existing');
    await fixture('append', { sessionId: 'session-existing', type: 'compaction/summary', data: { compactionId: 'compact-bad', summary: [{ type: 'text', text: 42 }] } });
    await fixture('append', { sessionId: 'session-existing', type: 'compaction/summary', data: { compactionId: 'compact-bad-2', summary: [{ type: 'text', text: 43 }] } });
    const page = await backend.loadMessages(id, directory, { limit: 50 });
    expect(page.records.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const reported = events.filter((event) => event.payload.type === 'session.error' && event.payload.properties.sessionID === id);
    expect(reported).toHaveLength(1);
    expect(reported[0].payload.properties.error.data.message).toContain('cannot read');
  });

  it('uses the durable request id for duplicate admission and cancels only the selected session', async () => {
    const { backend, directory } = await setup();
    const first = await backend.createSession(directory);
    const second = await backend.createSession(directory);
    const request = (id) => ({ directory, messageID: newNativeClientUserMessageId(id), parts: [{ type: 'text', text: 'hold' }],
      model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' });
    const firstRequest = request(first.id);
    await backend.prompt(first.id, firstRequest);
    await backend.prompt(first.id, firstRequest);
    await backend.prompt(second.id, request(second.id));
    const page = await backend.loadMessages(first.id, directory, { limit: 50 });
    expect(page.records.filter((record) => record.info.id === firstRequest.messageID)).toHaveLength(1);
    expect(await backend.abort(first.id)).toBe(true);
    expect(backend.busySessionIds(directory)).toContain(second.id);
    expect(backend.busySessionIds(directory)).not.toContain(first.id);
  });

  it('marks a lost admission reply as unknown and reconciles the original request id', async () => {
    const { backend, directory } = await setup();
    const created = await backend.createSession(directory);
    const messageID = newNativeClientUserMessageId(created.id);
    const prompt = { directory, messageID, parts: [{ type: 'text', text: 'drop-response' }],
      model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' };
    await expect(backend.prompt(created.id, prompt)).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    await expect.poll(async () => (await backend.loadMessages(created.id, directory, { limit: 50 })).records.some((record) => record.info.id === messageID)).toBe(true);
    await backend.prompt(created.id, prompt);
    expect((await backend.loadMessages(created.id, directory, { limit: 50 })).records.filter((record) => record.info.id === messageID)).toHaveLength(1);
  });

  it('does not dispatch a cancelled continuation', async () => {
    const { backend, directory } = await setup();
    const created = await backend.createSession(directory);
    const controller = new AbortController();
    controller.abort();
    await expect(backend.prompt(created.id, { directory, messageID: newNativeClientUserMessageId(created.id), parts: [{ type: 'text', text: 'Cancelled' }],
      model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect((await backend.loadMessages(created.id, directory, { limit: 50 })).records).toEqual([]);
  });

  it('stages local and inline files and echoes the shared optimistic part identities', async () => {
    const { backend, directory } = await setup();
    const file = path.join(directory, '报告.txt');
    await writeFile(file, 'Local attachment');
    const created = await backend.createSession(directory);
    const messageID = newNativeClientUserMessageId(created.id);
    await backend.prompt(created.id, { directory, messageID, parts: [
      { type: 'text', text: 'Read these files' },
      { type: 'file', mime: 'text/plain', url: pathToFileURL(file).href, filename: '报告.txt' },
      { type: 'file', mime: 'application/pdf', url: 'data:application/pdf;base64,cGRm', filename: 'document.pdf' },
    ], model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' });
    const page = await backend.loadMessages(created.id, directory, { limit: 50 });
    const user = page.records.find((record) => record.info.id === messageID);
    expect(user.parts.map((part) => part.id)).toEqual([`${messageID}_p0`, `${messageID}_f0`, `${messageID}_f1`]);
    expect(user.parts.map((part) => part.type)).toEqual(['text', 'file', 'file']);
    expect(user.parts[1].filename).toBe('报告.txt');
  });

  it('pages older messages without duplicating the cursor and preserves native rename and archive', async () => {
    const { backend, directory } = await setup(150);
    const id = encodeDeepseekSessionId('session-existing');
    const latest = await backend.loadMessages(id, directory, { limit: 10 });
    const older = await backend.loadMessages(id, directory, { limit: 10, before: latest.cursor });
    expect(latest.complete).toBe(false);
    expect(older.records).toHaveLength(10);
    expect(older.records.some((record) => record.info.id === latest.cursor)).toBe(false);
    await backend.rename(id, directory, 'Renamed');
    expect((await backend.getSession(id, directory)).title).toBe('Renamed');
    await backend.setArchived(id, directory, true);
    expect((await backend.getSession(id, directory)).time.archived).toBeDefined();
    await backend.setArchived(id, directory, false);
    expect((await backend.getSession(id, directory)).time.archived).toBeUndefined();
  });

  it('forks an old user message after its history follower has been evicted', async () => {
    const { backend, directory } = await setup(150);
    const id = encodeDeepseekSessionId('session-existing');
    let page = await backend.loadMessages(id, directory, { limit: 50 });
    while (!page.complete) page = await backend.loadMessages(id, directory, { limit: 50, before: page.cursor });
    const firstUser = page.records.find((record) => record.info.role === 'user');
    expect(firstUser).toBeDefined();
    for (let index = 0; index < 13; index += 1) {
      const created = await backend.createSession(directory);
      await backend.loadMessages(created.id, directory, { limit: 50 });
    }
    const fork = await backend.fork(id, firstUser.info.id, directory);
    expect(fork.id).not.toBe(id);
    expect((await backend.loadMessages(fork.id, directory, { limit: 50 })).records).toEqual([]);
  });

  it('refuses a different workspace and keeps discovery from changing permissions', async () => {
    const { backend, directory } = await setup();
    const id = encodeDeepseekSessionId('session-existing');
    await expect(backend.getSession(id, path.dirname(directory))).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    expect(await backend.commands(null, directory)).toEqual({ commands: [] });
    expect((await backend.commands(id, directory)).commands.map((command) => command.name)).toEqual(['plan', 'compact']);
    await expect(backend.executeCommand(id, directory, '/permission danger-full-access')).rejects.toMatchObject({ status: 501 });
  });

  it('stages a committed assistant until the remaining live chunks drain', async () => {
    const { backend, directory, fixture, events } = await setup();
    const id = encodeDeepseekSessionId('session-existing');
    await backend.loadMessages(id, directory, { limit: 50 });
    await fixture('stream', { sessionId: 'session-existing' });
    await expect.poll(() => events.filter((event) => event.payload.type === 'message.updated' && event.payload.properties.info.time.completed !== undefined).length).toBeGreaterThan(0);
    const page = await backend.loadMessages(id, directory, { limit: 50 });
    const record = page.records.at(-1);
    expect(record.parts[0].text).toBe('Hello world');
    expect(page.records.filter((item) => item.info.id === record.info.id)).toHaveLength(1);
  });

  it('automatically allows tool approval and preserves question ids, choices and free text', async () => {
    const { backend, directory, fixture, questions } = await setup();
    await backend.listRootSessions(directory);
    await fixture('approval', { sessionId: 'session-existing' });
    await expect.poll(async () => (await fixture('answers')).length).toBe(1);
    expect(await fixture('answers')).toEqual([{ kind: 'result', value: 'allowed-once' }]);
    expect(questions.list(directory)).toHaveLength(0);
    await fixture('question', { sessionId: 'session-existing' });
    await expect.poll(() => questions.list(directory).length).toBe(1);
    await questions.reply(questions.list(directory)[0].id, [['A', 'B', 'Custom answer']]);
    await expect.poll(async () => (await fixture('answers')).length).toBe(2);
    expect((await fixture('answers'))[1]).toEqual({ kind: 'result', value: { answers: [{ id: 'choice-id', selected: ['A', 'B'], custom: 'Custom answer' }] } });
  });

  it('delivers a continued timed-question answer through the native question API', async () => {
    const { backend, directory, fixture, questions } = await setup();
    await backend.listRootSessions(directory);
    await fixture('timed-question', { sessionId: 'session-existing' });
    await expect.poll(() => questions.list(directory).length).toBe(1);
    await questions.reply(questions.list(directory)[0].id, [['Yes']]);
    await expect.poll(async () => (await fixture('answers')).length).toBe(1);
    expect(await fixture('answers')).toEqual([{ answers: [{ id: 'late-id', selected: ['Yes'] }] }]);
  });

  it('keeps the same question retryable when DSH refuses delivery', async () => {
    const { backend, directory, fixture, questions } = await setup();
    await backend.listRootSessions(directory);
    await fixture('timed-question', { sessionId: 'session-existing' });
    await expect.poll(() => questions.list(directory).length).toBe(1);
    const id = questions.list(directory)[0].id;
    await fixture('fail-answer');
    await expect(questions.reply(id, [['Yes']])).rejects.toMatchObject({ code: 'NATIVE_BACKEND_ERROR' });
    expect(questions.list(directory).map((question) => question.id)).toEqual([id]);
    await questions.reply(id, [['Yes']]);
    expect(questions.list(directory)).toEqual([]);
    expect(await fixture('answers')).toEqual([{ answers: [{ id: 'late-id', selected: ['Yes'] }] }]);
  });
});

it('reverts and restores a native conversation, then commits a fork behind the same logical identity', async () => {
  const { backend, directory, registry, events } = await setup(3);
  const id = encodeDeepseekSessionId('session-existing');
  const before = await backend.loadMessages(id, directory, { limit: 50 });
  const target = before.records[2].info.id;
  const reverted = await backend.revert(id, target, directory);
  expect(reverted).toMatchObject({ conversationOnly: true, session: { id, revert: { messageID: target } } });
  expect((await backend.unrevert(id, directory)).revert).toBeUndefined();
  expect((await backend.loadMessages(id, directory, { limit: 50 })).records.map((row) => row.info.id)).toEqual(before.records.map((row) => row.info.id));
  await backend.revert(id, target, directory);
  const messageID = newNativeClientUserMessageId(id);
  await backend.prompt(id, { directory, messageID, parts: [{ type: 'text', text: 'Continue differently' }],
    model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' });
  const after = await backend.loadMessages(id, directory, { limit: 50 });
  expect(after.records.slice(0, 2).map((row) => row.info.id)).toEqual(before.records.slice(0, 2).map((row) => row.info.id));
  expect(after.records.some((row) => row.info.id === target)).toBe(false);
  expect(after.records.some((row) => row.info.id === messageID)).toBe(true);
  expect((await registry.getSession(id)).deepseekHistory.active).not.toBe('session-existing');
  expect((await backend.listRootSessions(directory)).map((row) => row.id)).toEqual([id]);
  expect((await backend.getSession(id, directory)).title).toBe('Existing DSH session');
  expect(await registry.pendingRevert(id)).toBeNull();
  expect(events.some((event) => event.payload.type === 'session.revert.committed')).toBe(true);
});

it('blocks redo and further sends while fork prompt admission is unknown, then reconciles its durable identity', async () => {
  const { backend, directory } = await setup(2);
  const id = encodeDeepseekSessionId('session-existing');
  const before = await backend.loadMessages(id, directory, { limit: 50 });
  await backend.revert(id, before.records[0].info.id, directory);
  const request = { directory, messageID: newNativeClientUserMessageId(id), parts: [{ type: 'text', text: 'drop-response' }],
    model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' };
  await expect(backend.prompt(id, request)).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
  await expect(backend.unrevert(id, directory)).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
  await expect.poll(async () => (await backend.loadMessages(id, directory, { limit: 50 })).records.some((row) => row.info.id === request.messageID)).toBe(true);
  await backend.prompt(id, { ...request, messageID: newNativeClientUserMessageId(id), parts: [{ type: 'text', text: 'Now continue' }] });
  expect((await backend.listRootSessions(directory)).map((row) => row.id)).toEqual([id]);
});

it('captures interrupted managed progress from channel closure without reloading history', async () => {
  const checkpoints = [];
  const { backend, directory } = await setup(0, { memory: {
    enabled: async () => true, checkpoint: async (value) => checkpoints.push(value), release: () => {},
  } });
  const created = await backend.createSession(directory);
  await backend.prompt(created.id, { directory, messageID: newNativeClientUserMessageId(created.id), parts: [{ type: 'text', text: 'hold' }],
    model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' });
  await expect.poll(() => backend.liveRecords(created.id).some((row) => row.info.role === 'user')).toBe(true);
  await backend.shutdown();
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]).toMatchObject({ backend: 'deepseek', sessionId: created.id, status: 'interrupted', summary: '' });
});

it('does not erase a logical session when a list begun on its old branch finishes after a rewind commit', async () => {
  const { backend, directory, fixture } = await setup(2);
  const id = encodeDeepseekSessionId('session-existing');
  const page = await backend.loadMessages(id, directory, { limit: 50 });
  await fixture('list-lag', { delay: 150 });
  const listing = backend.listRootSessions(directory);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await backend.revert(id, page.records[2].info.id, directory);
  await backend.prompt(id, { directory, messageID: newNativeClientUserMessageId(id), parts: [{ type: 'text', text: 'Different continuation' }],
    model: { providerID: 'deepseek-native', modelID: 'deepseek-official/test-model' }, agent: 'build' });
  expect((await listing).map((session) => session.id)).toEqual([id]);
});

it('adopts a cold native session before cancelling and reverting without creating a duplicate', async () => {
  const { backend, directory, fixture } = await setup(2);
  const id = encodeDeepseekSessionId('session-existing');
  const page = await backend.loadMessages(id, directory, { limit: 50 });
  await fixture('cold', { sessionId: 'session-existing' });
  await backend.listRootSessions(directory);
  expect(await backend.revert(id, page.records[2].info.id, directory)).toMatchObject({ session: { id }, conversationOnly: true });
  expect((await backend.listRootSessions(directory)).map((session) => session.id)).toEqual([id]);
});
