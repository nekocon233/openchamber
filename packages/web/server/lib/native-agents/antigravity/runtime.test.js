import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createNativeAgentsRuntime } from '../runtime.js';
import { registerNativeAgentRoutes } from '../routes.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const setup = async ({ checklist = false, memory = null, skillGate = false } = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-runtime-')));
  let unauthenticated = false;
  const directory = path.join(root, 'project');
  const home = path.join(root, 'home');
  const fixtureHome = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(fixtureHome, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const executable = path.join(root, 'agy');
  fs.copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
  fs.chmodSync(executable, 0o755);
  const events = [];
  const requestsFile = path.join(root, 'requests.jsonl');
  const skillsFile = path.join(root, 'skills.tsv');
  const skillProbesFile = path.join(root, 'skill-probes.jsonl');
  const skillGateFile = path.join(root, 'release-skills');
  fs.writeFileSync(skillsFile, 'fixture-skill\tFixture skill\n');
  const runtime = createNativeAgentsRuntime({
    dataDir: root,
    memory,
    resolveExecutable: async (cli) => cli === 'agy' ? executable : cli === 'node' && checklist ? process.execPath : null,
    resolveAntigravityCommand: async () => ({ executable, argsPrefix: [] }),
    buildChildEnv: () => ({ ...process.env, HOME: home, AGY_FIXTURE_HOME: fixtureHome, AGY_FIXTURE_REQUESTS: requestsFile,
      AGY_FIXTURE_SKILLS: skillsFile, AGY_FIXTURE_SKILL_PROBES: skillProbesFile, AGY_FIXTURE_SKILL_GATE: skillGate ? skillGateFile : '', ...(unauthenticated ? { AGY_FIXTURE_UNAUTHENTICATED: '1' } : {}) }),
    clientVersion: 'test',
    publishNativeEvent: (event) => events.push(event),
    readGlobalInstructions: async () => 'RUNTIME RULES',
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => runtime.shutdown());
  if (skillGate) cleanups.push(() => fs.writeFileSync(skillGateFile, 'release'));
  const session = await runtime.createSession({ backend: 'antigravity', directory, title: 'Runtime agy' });
  return { runtime, session, directory, events, fixtureHome, requestsFile, skillsFile, skillProbesFile, skillGateFile, setUnauthenticated: () => { unauthenticated = true; } };
};

const prompt = async (runtime, session, directory, text = 'runtime') => {
  const messageID = `nag_u_${randomUUID()}`;
  await runtime.prompt(session.id, {
    directory, messageID, parts: [{ type: 'text', text }],
    model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build',
  });
  await vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
  return messageID;
};

describe('Antigravity native runtime', () => {
  it('shows the attached PR as a reference and keeps an identical example in the user prompt', async () => {
    const { runtime, session, directory, events, requestsFile } = await setup();
    const reference = { kind: 'change-request', provider: 'github', number: 7, title: 'Fixture change',
      url: 'https://github.com/example/project/pull/7' };
    const context = 'Source control change request context (JSON)\n' + JSON.stringify({
      identity: { provider: reference.provider, instance: 'github.com' },
      changeRequest: { ...reference, body: 'Fixture description' },
      files: [{ path: 'example.js', patch: '+ changed' }],
    }, null, 2);
    const text = ` \n\n${context}\nCompare this example with ${reference.url}.`;
    const additionalText = 'Keep the other text part.';
    const messageID = `nag_u_${randomUUID()}`;
    await runtime.prompt(session.id, { directory, messageID, parts: [{ type: 'text', text },
      { type: 'text', text: additionalText }, { type: 'text', text: context }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' });
    await vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
    const referenceEvent = events.find(({ payload }) => payload.type === 'message.part.updated'
      && payload.properties.part.messageID === messageID
      && payload.properties.part.metadata?.openchamberContext?.url === reference.url);
    expect(referenceEvent).toBeDefined();
    expect(JSON.parse(fs.readFileSync(requestsFile, 'utf8').trim()).text).toContain(`${text}\n\n${additionalText}\n\n${context}`);
    await runtime.shutdown();

    const page = await runtime.loadMessages(session.id, directory, { limit: 20 });
    const saved = page.records.find(({ info }) => info.id === messageID);
    expect(saved.parts).toHaveLength(2);
    expect(saved.parts[0].text).toBe(`${text.trimStart()}\n\n${additionalText}`);
    expect(saved.parts[0].metadata).toBeUndefined();
    expect(saved.parts[1]).toMatchObject({ id: referenceEvent.payload.properties.part.id,
      type: 'text', text: context, metadata: { openchamberContext: reference } });
  });

  it('delivers embedded images and existing image paths through the native prompt route', async () => {
    const { runtime, session, directory, requestsFile } = await setup();
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW/0AAAAASUVORK5CYII=', 'base64');
    const existing = path.join(directory, 'existing.png');
    fs.writeFileSync(existing, image);
    const app = express();
    app.use(express.json());
    registerNativeAgentRoutes(app, { runtime });
    const endpoint = `/api/native/sessions/${session.id}/prompt`;
    const payload = {
      directory, messageID: `nag_u_${randomUUID()}`,
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build',
      parts: [
        { type: 'text', text: 'Compare the two images.' },
        { type: 'file', filename: 'uploaded.png', mime: 'image/png', url: `data:image/png;base64,${image.toString('base64')}` },
        { type: 'file', filename: 'existing.png', mime: 'image/png', url: pathToFileURL(existing).href },
      ],
    };
    await request(app).post(endpoint).send(payload).expect(200, { accepted: true });
    await vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
    const delivered = JSON.parse(fs.readFileSync(requestsFile, 'utf8').trim());
    const stagedPath = delivered.visible.match(/Attached image: ([^\r\n]+uploaded\.png)/)?.[1];
    expect(stagedPath).toBeTruthy();
    cleanups.unshift(() => fs.rmSync(path.dirname(stagedPath), { recursive: true, force: true }));
    expect(fs.readFileSync(stagedPath)).toEqual(image);
    expect(delivered.visible).toContain(`Attached image: ${existing}`);
    expect(delivered.visible).not.toContain('data:image');
    await request(app).post(endpoint).send(payload).expect(200, { accepted: true });
    expect(fs.readFileSync(requestsFile, 'utf8').trim().split('\n')).toHaveLength(1);
    await runtime.shutdown();
    const history = await runtime.loadMessages(session.id, directory, { limit: 20 });
    expect(history.records.find(({ info }) => info.id === payload.messageID).parts[0].text).toContain(stagedPath);
  });

  it('compacts a unified Antigravity session and resumes ordinary prompts on the same source', async () => {
    const { runtime, directory, requestsFile } = await setup();
    const selection = { model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build' };
    const session = await runtime.createSession({ backend: 'antigravity', kind: 'unified', directory, selection });
    const say = async (text) => {
      await runtime.prompt(session.id, { ...selection, directory, messageID: `ncv_u_${randomUUID()}`, parts: [{ type: 'text', text }] });
      await vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
    };
    await say('before compacting');
    const app = express();
    app.use(express.json());
    registerNativeAgentRoutes(app, { runtime });
    const endpoint = `/api/native/sessions/${session.id}/compact`;
    await request(app).post(endpoint).send({ ...selection, directory, instructions: 'summarize' }).expect(400);
    await request(app).post(endpoint).send({ ...selection, directory }).expect(200, { accepted: true });
    await vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
    const history = await runtime.loadMessages(session.id, directory, { limit: 20 });
    expect(history.records.filter(({ info }) => info.role === 'compaction').map(({ info }) => info))
      .toEqual([expect.objectContaining({ status: 'completed', reason: 'manual', summary: 'Fixture compacted context.' })]);
    await say('after compacting');
    const launches = fs.readFileSync(requestsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(launches.map(({ conversationId }) => conversationId)).toEqual(Array(3).fill(launches[0].conversationId));
    expect(launches.map(({ slashCommands }) => slashCommands)).toEqual([false, true, false]);
    expect(launches[1].text).toBe('/compact');
  });

  it('validates source-bound stops through HTTP and rejects a stale source before interrupting', async () => {
    const { runtime, directory } = await setup();
    const conversation = await runtime.createSession({ backend: 'antigravity', kind: 'unified', directory,
      selection: { model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build' } });
    await runtime.prompt(conversation.id, { directory, messageID: `ncv_u_${randomUUID()}`, agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: 'stop-me' }] });
    const source = (await runtime.getSession(conversation.id, directory)).metadata.openchamber.native.sourceSessionID;
    const app = express();
    app.use(express.json());
    registerNativeAgentRoutes(app, { runtime });
    const route = `/api/native/sessions/${conversation.id}/abort-source`;
    await request(app).post(route).send({}).expect(400);
    await request(app).post(route).send({ expectedSourceSessionId: 'nag_changed' }).expect(409)
      .expect((response) => expect(response.body.code).toBe('NATIVE_CONVERSATION_SOURCE_CHANGED'));
    expect((await runtime.statuses(directory))[conversation.id]).toEqual({ type: 'busy' });
    await request(app).post(route).send({ expectedSourceSessionId: source }).expect(200, { aborted: true });
    expect(await runtime.statuses(directory)).toEqual({});
  });

  it('cancels a standalone prompt stopped while skill discovery is still pending', async () => {
    const { runtime, session, directory, requestsFile, skillProbesFile, skillGateFile } = await setup({ skillGate: true });
    const sending = runtime.prompt(session.id, { directory, messageID: `nag_u_${randomUUID()}`, agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: '/fixture-skill' }] })
      .then(() => ({ sent: true }), (error) => ({ error }));
    await vi.waitFor(() => expect(fs.existsSync(skillProbesFile)).toBe(true));
    expect(await runtime.abort(session.id)).toBe(true);
    fs.writeFileSync(skillGateFile, 'release');
    expect(await sending).toMatchObject({ error: { name: 'AbortError' } });
    expect(fs.existsSync(requestsFile)).toBe(false);
    expect(await runtime.statuses(directory)).toEqual({});
  });

  it('discovers skills through HTTP, expands a send and rejects removed skills before native admission', async () => {
    const { runtime, session, directory, fixtureHome, requestsFile, skillsFile, skillProbesFile } = await setup();
    fs.writeFileSync(path.join(fixtureHome, 'settings.json'), JSON.stringify({ modelProvider: 'gemini', model: 'saved-custom-model' }));
    const app = express();
    registerNativeAgentRoutes(app, { runtime });
    await request(app).get('/api/native/commands').query({ backend: 'antigravity', directory }).expect(200)
      .expect((response) => expect(response.body.commands[0].name).toBe('fixture-skill'));
    await prompt(runtime, session, directory, '/fixture-skill argument');
    const sends = fs.readFileSync(requestsFile, 'utf8').trim().split('\n').map(JSON.parse);
    expect(sends[0].text).toContain('Use the "fixture-skill" skill.');
    expect(sends[0].text).toContain('argument');
    expect(sends[0].text).toContain('RUNTIME RULES');
    expect(fs.readFileSync(skillProbesFile, 'utf8').trim().split('\n').map(JSON.parse).every((probe) => probe.cwd === directory)).toBe(true);
    fs.writeFileSync(skillsFile, '');
    await expect(runtime.prompt(session.id, { directory, messageID: `nag_u_${randomUUID()}`, agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: '/fixture-skill' }] })).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_COMMAND_UNSUPPORTED' });
    expect(fs.readFileSync(requestsFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('injects hidden managed memory and checkpoints only the final reply once', async () => {
    const memory = { enabled: async () => true, context: vi.fn(async () => ({ text: 'Shared memory index' })),
      checkpoint: vi.fn(async () => {}), release: vi.fn() };
    const { runtime, session, directory, requestsFile } = await setup({ memory });
    await prompt(runtime, session, directory, 'history-recovery');
    expect(memory.context).toHaveBeenCalledWith({ backend: 'antigravity', sessionId: session.id, directory, delivery: 'managed' });
    expect(memory.checkpoint).toHaveBeenCalledTimes(1);
    expect(memory.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ backend: 'antigravity', sessionId: session.id,
      directory, delivery: 'managed', status: 'completed', summary: 'Complete final answer\n' }));
    expect(fs.readFileSync(requestsFile, 'utf8')).toContain('Shared memory index');
    const history = await runtime.loadMessages(session.id, directory, { limit: 20 });
    expect(JSON.stringify(history.records)).not.toContain('Shared memory index');
    expect(memory.checkpoint).toHaveBeenCalledTimes(1);
    await expect(runtime.prompt(session.id, { directory, messageID: `nag_u_${randomUUID()}`, model: { providerID: 'antigravity-native', modelID: 'invalid-model' },
      agent: 'build', parts: [{ type: 'text', text: 'must not send' }] })).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_ERROR' });
    expect(memory.release).toHaveBeenCalledWith(session.id);
  });

  it('captures the final response even when history appends an earlier child report', async () => {
    const memory = { enabled: async () => true, context: async () => ({ text: '' }), checkpoint: vi.fn(async () => {}), release: vi.fn() };
    const { runtime, session, directory } = await setup({ memory });
    await prompt(runtime, session, directory, 'retained-agent-content');
    expect(memory.checkpoint).toHaveBeenCalledTimes(1);
    expect(memory.checkpoint.mock.calls[0][0]).toMatchObject({ summary: 'Report received.\n', status: 'completed' });
  });

  it('keeps managed AGY memory off in enterprise mode while ordinary standalone chat remains available', async () => {
    const memory = { enabled: async () => true, context: vi.fn(async () => ({ text: 'private handoff' })),
      checkpoint: vi.fn(async () => {}), release: vi.fn() };
    const { runtime, session, directory } = await setup({ memory });
    const previous = process.env.OPENCHAMBER_ENTERPRISE_MODE;
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      await prompt(runtime, session, directory, 'ordinary standalone chat');
      expect(memory.context).not.toHaveBeenCalled();
      expect(memory.checkpoint).not.toHaveBeenCalled();
      expect(memory.release).toHaveBeenCalledWith(session.id);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      else process.env.OPENCHAMBER_ENTERPRISE_MODE = previous;
    }
  });

  it('keeps replies readable when shared memory is unavailable and checkpoints stops as interrupted', async () => {
    const memory = { enabled: async () => true, context: vi.fn(async () => { throw new Error('memory read failed'); }),
      checkpoint: vi.fn(async () => { throw new Error('memory write failed'); }), release: vi.fn() };
    const { runtime, session, directory } = await setup({ memory });
    await prompt(runtime, session, directory, 'plain reply');
    expect(memory.release).toHaveBeenCalledWith(session.id);
    expect((await runtime.loadMessages(session.id, directory, { limit: 20 })).records.at(-1).parts[0].text).toBe('Reply to plain reply\n');
    await runtime.prompt(session.id, { directory, messageID: `nag_u_${randomUUID()}`, agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: 'stop-me' }] });
    await runtime.abort(session.id, directory);
    expect(memory.checkpoint.mock.calls.at(-1)[0].status).toBe('interrupted');
  });

  it('registers the checklist independently, publishes changes and restores them over HTTP after shutdown', async () => {
    const { runtime, session, directory, events } = await setup({ checklist: true });
    expect((await runtime.capabilities()).backends.antigravity.tasks.checklist).toBe(true);
    expect(await runtime.checklist(session.id, directory)).toEqual({ state: 'unavailable', reason: 'source_unknown' });
    await prompt(runtime, session, directory, 'checklist-pending');
    expect(await runtime.checklist(session.id, directory)).toMatchObject({ state: 'ready', complete: true, items: [{ status: 'pending' }] });
    expect(events.some((event) => event.payload.type === 'session.checklist.updated' && event.payload.properties.snapshot.items[0]?.id === 'verify')).toBe(true);
    await prompt(runtime, session, directory, 'checklist-completed');
    await runtime.shutdown();
    const app = express();
    registerNativeAgentRoutes(app, { runtime });
    const restored = await request(app).get(`/api/native/sessions/${session.id}/checklist`).query({ directory }).expect(200);
    expect(restored.body).toMatchObject({ state: 'ready', items: [{ id: 'verify', status: 'completed' }] });
    await request(app).get(`/api/native/sessions/${session.id}/checklist`).query({ directory: '/another-project' }).expect(404);
  });
  it('exposes saved tasks and output without claiming activity or accepting per-task stop', async () => {
    const { runtime, session, directory, events } = await setup();
    await prompt(runtime, session, directory, 'background-task');
    expect((await runtime.capabilities()).backends.antigravity.tasks).toEqual({ checklist: false, background: true, output: true, stop: false });
    const snapshot = await runtime.sessionTasks(session.id, directory);
    expect(snapshot).toMatchObject({ state: 'history', tasks: [{ status: 'completed', active: false, canStop: false, outputAvailable: true }] });
    expect(await runtime.taskOutput(session.id, directory, snapshot.tasks[0].id, snapshot.generation)).toEqual({ state: 'ready', text: 'Complete saved background output\n', truncated: false });
    expect((await runtime.backgroundTasks())[session.id]).toBeUndefined();
    expect(events.some((event) => event.payload.type === 'session.tasks.updated' && event.payload.properties.snapshot.state === 'history')).toBe(true);
    await expect(runtime.stopTask(session.id, directory, snapshot.tasks[0].id, snapshot.generation)).rejects.toMatchObject({ code: 'NATIVE_TASK_STOP_UNAVAILABLE' });

    const app = express();
    app.use(express.json());
    registerNativeAgentRoutes(app, { runtime });
    const listed = await request(app).get(`/api/native/sessions/${session.id}/tasks`).query({ directory }).expect(200);
    const taskId = encodeURIComponent(listed.body.tasks[0].id);
    const output = await request(app).get(`/api/native/sessions/${session.id}/tasks/${taskId}/output`)
      .query({ directory, generation: listed.body.generation }).expect(200);
    expect(output.body).toEqual({ state: 'ready', text: 'Complete saved background output\n', truncated: false });
    await request(app).post(`/api/native/sessions/${session.id}/tasks/${taskId}/stop`)
      .send({ directory, generation: listed.body.generation }).expect(501);
  });

  it('keeps a skipped question when live records overlay complete native history', async () => {
    const { runtime, session, directory } = await setup();
    await prompt(runtime, session, directory, 'history-recovery');
    const page = await runtime.loadMessages(session.id, directory, { limit: 20 });
    expect(page.records.at(-1).parts[0].text).toBe('Complete final answer\n');
    expect(page.records.flatMap((record) => record.parts).filter((part) => part.type === 'tool')).toMatchObject([
      { tool: 'ask_question', state: { status: 'completed', output: 'A1: User Skipped' } },
    ]);
  });

  it('creates, prompts, reads and archives an independent native session', async () => {
    const { runtime, session, directory } = await setup();
    const messageId = await prompt(runtime, session, directory);
    const page = await runtime.loadMessages(session.id, directory, { limit: 20 });
    expect(page.records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    expect(page.records[0].info.id).toBe(messageId);
    expect(page.records[1].parts[0].text).toBe('Reply to runtime\n');
    const capabilities = await runtime.capabilities();
    expect(capabilities.backends.antigravity).toMatchObject({
      cli: true,
      actions: { revert: false, delete: false, fork: false, compact: true },
    });
    expect((await runtime.catalog()).backends.antigravity.models).toMatchObject([
      { id: 'gemini-test', efforts: ['low', 'high'] },
    ]);
    expect((await runtime.listSessions(directory)).backends.antigravity.sessions.map((record) => record.id)).toContain(session.id);
    const updated = await runtime.updateSession(session.id, directory, { title: 'Renamed agy', archived: true });
    expect(updated.title).toBe('Renamed agy');
    expect(updated.time.archived).toEqual(expect.any(Number));
    expect((await runtime.getSession(session.id, directory)).title).toBe('Renamed agy');
  });

  it('reports authentication separately from other catalog failures', async () => {
    const { runtime, setUnauthenticated } = await setup();
    setUnauthenticated();
    expect((await runtime.catalog()).backends.antigravity).toMatchObject({
      status: 'error', reason: 'unauthenticated',
    });
  });

  it('accepts unified conversations and rejects unsupported standalone mutations', async () => {
    const { runtime, session, directory } = await setup();
    const conversation = await runtime.createSession({
      kind: 'unified', backend: 'antigravity', directory,
      selection: { model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' },
    });
    expect(conversation.id).toMatch(/^ncv_/);
    const messageID = `ncv_u_${randomUUID()}`;
    await runtime.prompt(conversation.id, {
      directory, messageID, parts: [{ type: 'text', text: 'unified hello' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, variant: 'high', agent: 'build',
    });
    await vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
    const page = await runtime.loadMessages(conversation.id, directory, { limit: 20 });
    expect(page.records[0].info.id).toBe(messageID);
    expect(page.records[1].info.parentID).toBe(messageID);
    expect((await runtime.getSession(conversation.id, directory)).metadata.openchamber.native).toMatchObject({
      backend: 'antigravity', actions: { revert: true, fork: true, delete: false, compact: true },
    });
    const selection = { model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' };
    await expect(runtime.compact(session.id, { directory, ...selection, instructions: 'summarize' })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    await expect(runtime.revert(session.id, 'nag_u_any', directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    await expect(runtime.unrevert(session.id, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    await expect(runtime.fork(session.id, null, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    await expect(runtime.deleteSession(session.id, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    expect((await runtime.commands('antigravity', directory)).commands[0].name).toBe('fixture-skill');
  });
});
