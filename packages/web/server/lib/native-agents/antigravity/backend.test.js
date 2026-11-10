import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeEventPublisher } from '../publisher.js';
import { createNativeRegistry } from '../registry.js';
import { createAntigravityBackend } from './backend.js';
import { prepareAgyContextSettings } from './context-settings.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const setup = async ({ decorateSession = async (session) => session, onInteraction = async () => undefined, commandPrefix = [], quotaFailure = '', prepareContextSettings } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-test-'));
  let conversationId = null;
  let unauthenticated = false;
  const directory = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const executable = path.join(root, 'agy');
  fs.copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
  fs.chmodSync(executable, 0o755);
  const events = [];
  const registry = createNativeRegistry({ filePath: path.join(root, 'registry.json') });
  const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) });
  const resolveCommand = vi.fn(async () => ({ executable, argsPrefix: commandPrefix }));
  const backend = createAntigravityBackend({
    resolveExecutable: async () => executable,
    resolveCommand,
    buildEnv: () => ({ ...process.env, AGY_FIXTURE_HOME: home, AGY_FIXTURE_QUOTA_FAILURE: quotaFailure, AGY_FIXTURE_UNAUTHENTICATED: unauthenticated ? '1' : '0', ...(conversationId ? { AGY_FIXTURE_CONVERSATION_ID: conversationId } : {}) }),
    registry,
    publisher,
    readGlobalInstructions: async () => 'GLOBAL FIXTURE RULES',
    decorateSession,
    onInteraction,
    home,
    prepareContextSettings,
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => backend.shutdown());
  const prompt = async (session, text, modelID = 'gemini-test-high', agent = 'build', variant = undefined) => {
    const messageID = `nag_u_${randomUUID()}`;
    await backend.prompt(session.id, {
      directory,
      messageID,
      parts: [{ type: 'text', text }],
      model: { providerID: 'antigravity-native', modelID },
      agent,
      variant,
    });
    await backend.whenIdle(session.id);
    return messageID;
  };
  return { backend, directory, home, events, registry, prompt, resolveCommand, setConversationId: (value) => { conversationId = value; }, setUnauthenticated: () => { unauthenticated = true; } };
};

describe('Antigravity CLI adapter', () => {
  it('keeps the process-local budget after external sync and refreshes changed routes on an idle admission', async () => {
    const { backend, directory, home, prompt } = await setup();
    const settingsFile = path.join(home, 'settings.json');
    const data = { modelProvider: 'gemini', model: 'magpie/default', customModelsConfig: { customModels: {
      'magpie/default': { modelName: 'provider/first', maxTokens: 1000000 },
      other: { modelName: 'provider/other', maxTokens: 32000 },
    } } };
    fs.writeFileSync(settingsFile, JSON.stringify(data));
    const session = await backend.createSession({ directory });
    await prompt(session, 'mode-probe');
    const result = () => JSON.parse(backend.liveRecords(session.id).at(-1).parts[0].text);
    const first = result();
    expect(first.contextBudgets).toEqual({ 'magpie/default': 1000000, other: 32000 });
    expect(fs.existsSync(first.settingsFile)).toBe(true);
    delete data.customModelsConfig.customModels['magpie/default'].maxTokens;
    fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2));
    const synced = fs.readFileSync(settingsFile, 'utf8');
    await prompt(session, 'mode-probe');
    expect(result().pid).toBe(first.pid);
    expect(result().settingsFile).toBe(first.settingsFile);
    expect(result().contextBudgets['magpie/default']).toBe(1000000);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(synced);
    data.customModelsConfig.customModels['magpie/default'].modelName = 'provider/second';
    fs.writeFileSync(settingsFile, JSON.stringify(data));
    await prompt(session, 'mode-probe');
    const next = result();
    expect(next.pid).not.toBe(first.pid);
    expect(next.resumed).toBe(session.id.slice(4));
    expect(fs.existsSync(first.settingsFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(next.settingsFile, 'utf8')).customModelsConfig.customModels['magpie/default'])
      .toEqual({ modelName: 'provider/second', maxTokens: 1000000 });
    await backend.closeSession(session.id);
    expect(fs.existsSync(next.settingsFile)).toBe(false);
  });

  it('removes process settings when the CLI refuses startup before prompt dispatch', async () => {
    const files = [];
    const { backend, directory, home } = await setup({ prepareContextSettings: async (options) => {
      const context = await prepareAgyContextSettings(options);
      if (context) files.push(context.file);
      return context;
    } });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ modelProvider: 'gemini', model: 'custom',
      customModelsConfig: { customModels: { custom: { modelName: 'same-route' } } } }));
    const session = await backend.createSession({ directory });
    await expect(backend.prompt(session.id, { directory, messageID: 'never-dispatched', agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'invalid-model' }, parts: [{ type: 'text', text: 'must not run' }] }))
      .rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_ERROR' });
    expect(files).toHaveLength(1);
    await vi.waitFor(() => expect(fs.existsSync(files[0])).toBe(false));
    expect(backend.busySessionIds(directory)).toEqual([]);
  });

  it('publishes complete edits from path-only frames while the turn is still running', async () => {
    const { backend, directory, events } = await setup();
    const session = await backend.createSession({ directory });
    const reads = vi.spyOn(backend.store, 'completedGenerations');
    await backend.prompt(session.id, { directory, messageID: 'live-edit-user', agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: 'live-edits' }] });
    await vi.waitFor(() => expect(backend.liveRecords(session.id).flatMap((record) => record.parts)
      .filter((part) => part.tool === 'edit' && part.state.metadata?.diff)).toHaveLength(2));
    expect(backend.busySessionIds(directory)).toContain(session.id);
    expect(events.some((event) => event.payload.type === 'session.idle')).toBe(false);
    expect(reads).toHaveBeenCalledTimes(3);
    const edits = backend.liveRecords(session.id).flatMap((record) => record.parts).filter((part) => part.tool === 'edit');
    expect(edits[0].state.input).toMatchObject({ oldString: 'before-1', newString: 'after-1' });
    expect(edits[1].state.metadata).toMatchObject({ nativeDiffScope: 'replacement', diff: expect.stringContaining('+after-2') });
    const history = await backend.loadHistory(session.id, directory);
    const saved = history.records.flatMap((record) => record.parts).filter((part) => part.tool === 'edit');
    expect(edits.map((part) => part.id)).toEqual(saved.map((part) => part.id));
    expect(edits.map((part) => part.state.metadata.diff)).toEqual(saved.map((part) => part.state.metadata.diff));
    await backend.abort(session.id);
  });

  it('publishes saved thinking before the turn ends without settling a running tool or polling', async () => {
    const { backend, directory, home, events } = await setup();
    const session = await backend.createSession({ directory });
    const reads = vi.spyOn(backend.store, 'completedGenerations');
    await backend.prompt(session.id, { directory, messageID: 'live-thinking-user', agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: 'live-thinking' }] });
    await vi.waitFor(() => expect(backend.liveRecords(session.id).flatMap((record) => record.parts)
      .some((part) => part.type === 'tool' && part.state.status === 'running')).toBe(true));
    expect(backend.liveRecords(session.id).flatMap((record) => record.parts).filter((part) => part.type === 'reasoning')).toHaveLength(0);
    expect(reads).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(home, 'release-thinking'), 'release');
    await vi.waitFor(() => expect(backend.liveRecords(session.id).flatMap((record) => record.parts)
      .filter((part) => part.type === 'reasoning')).toHaveLength(1));
    const live = backend.liveRecords(session.id);
    expect(backend.busySessionIds(directory)).toContain(session.id);
    expect(events.some((event) => event.payload.type === 'session.idle')).toBe(false);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(live[1].parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool']);
    const history = await backend.loadHistory(session.id, directory);
    expect(live[1].parts[0].id).toBe(history.records[1].parts[0].id);
    expect(live[1].parts[0].text).toBe(history.records[1].parts[0].text);
    expect(live[1].parts.at(-1).state.status).toBe('completed');
    const published = events.filter((event) => event.payload.type === 'message.part.updated' && event.payload.properties.part.type === 'reasoning').length;
    await backend.loadHistory(session.id, directory);
    expect(events.filter((event) => event.payload.type === 'message.part.updated' && event.payload.properties.part.type === 'reasoning')).toHaveLength(published);
    await backend.abort(session.id);
  });

  it('repairs thinking on a running history read without replacing live tool state', async () => {
    const { backend, directory, home } = await setup();
    const session = await backend.createSession({ directory });
    await backend.prompt(session.id, { directory, messageID: 'history-thinking-user', agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: 'live-thinking' }] });
    await vi.waitFor(() => expect(backend.liveRecords(session.id).flatMap((record) => record.parts)
      .some((part) => part.type === 'tool' && part.state.status === 'running')).toBe(true));
    const log = path.join(home, 'brain', session.id.slice(4), '.system_generated', 'logs', 'transcript_full.jsonl');
    fs.appendFileSync(log, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE',
      thinking: 'Saved after the stream frame.', content: 'Working\n',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'wait for fixture' } }] }) + '\n');
    const read = vi.spyOn(backend.store, 'completedGenerations').mockImplementationOnce(() => { throw new Error('Temporary read failure'); });
    await backend.loadHistory(session.id, directory);
    expect(backend.liveRecords(session.id)[1].parts.at(-1).state.status).toBe('running');
    expect(backend.busySessionIds(directory)).toContain(session.id);
    read.mockRestore();
    await backend.loadHistory(session.id, directory);
    const parts = backend.liveRecords(session.id)[1].parts;
    expect(parts[0]).toMatchObject({ type: 'reasoning', text: 'Saved after the stream frame.' });
    expect(parts.at(-1).state.status).toBe('running');
    await backend.abort(session.id);
  });

  it('repairs delayed thinking when history is read for a running child', async () => {
    const { backend, directory, home, events } = await setup();
    const session = await backend.createSession({ directory });
    await backend.prompt(session.id, { directory, messageID: 'live-child-user', agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, parts: [{ type: 'text', text: 'live-child-thinking' }] });
    let childId;
    await vi.waitFor(async () => {
      childId = (await backend.loadHistory(session.id, directory)).childSessions[0]?.id;
      expect(childId && backend.busySessionIds(directory).includes(childId)).toBe(true);
    });
    expect(backend.liveRecords(childId).flatMap((record) => record.parts).some((part) => part.type === 'reasoning')).toBe(false);
    const log = path.join(home, 'brain', childId.slice(4), '.system_generated', 'logs', 'transcript_full.jsonl');
    fs.appendFileSync(log, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE',
      content: 'Evidence checked.', thinking: 'Delayed child thinking.' }) + '\n');
    await backend.loadHistory(childId, directory);
    expect(backend.liveRecords(childId)[1].parts[0]).toMatchObject({ type: 'reasoning', text: 'Delayed child thinking.' });
    expect(backend.busySessionIds(directory)).toContain(childId);
    expect(events.some((event) => event.payload.type === 'message.part.updated'
      && event.payload.properties.sessionID === childId && event.payload.properties.part.type === 'reasoning')).toBe(true);
    await backend.abort(session.id);
  });

  it.each(['retained-agent-content', 'retained-agent-no-child-frames'])('publishes retained thinking and child messages for %s with stable historical parts', async (text) => {
    const { backend, directory, prompt, events } = await setup();
    const session = await backend.createSession({ directory });
    const messageId = await prompt(session, text);
    // Read live state before a history request can trigger another recovery.
    const live = structuredClone(backend.liveRecords(session.id));
    const parts = live.flatMap((record) => record.parts);
    expect(parts.filter((part) => part.type === 'reasoning')).toHaveLength(3);
    const report = parts.find((part) => part.metadata?.nativeSubagentMessage);
    expect(report.text).toBe('# Fixture report\n\nThe evidence is complete.');
    expect(live.filter((record) => record.info.role === 'assistant').every((record) => record.info.parentID === messageId)).toBe(true);
    expect(parts.filter((part) => ['find_by_name', 'grep_search'].includes(part.tool)).map((part) => part.state.status)).toEqual(['error', 'error']);
    expect(JSON.stringify(live)).not.toContain('Hidden system notice');
    expect(JSON.stringify(live)).not.toContain('Hidden unrelated sender');
    expect(events.some((event) => event.payload.type === 'message.part.updated'
      && event.payload.properties.part.type === 'reasoning')).toBe(true);
    const history = await backend.loadHistory(session.id, directory);
    const identityAndContent = (records) => records.toSorted((left, right) => left.info.time.created - right.info.time.created).map((record) => ({
      id: record.info.id,
      parts: record.parts.map((part) => ({ id: part.id, type: part.type, text: part.text, metadata: part.metadata })),
    }));
    expect(identityAndContent(live)).toEqual(identityAndContent(history.records));
    const childId = report.metadata.nativeSubagentSessionID;
    expect(history.childSessions.map((child) => child.id)).toContain(childId);
    const childLive = structuredClone(backend.liveRecords(childId));
    expect(childLive.flatMap((record) => record.parts).filter((part) => part.type === 'reasoning')).toHaveLength(1);
    if (text === 'retained-agent-no-child-frames') {
      const texts = childLive.flatMap((record) => record.parts).filter((part) => part.type === 'text').map((part) => part.text);
      expect(texts).toContain('First progress.');
      expect(texts.filter((value) => value === 'Evidence checked.')).toHaveLength(1);
    }
    const child = await backend.loadHistory(childId, directory);
    expect(child.records[0].parts[0].text).toBe('Inspect fixture evidence.');
    expect(child.records[1].info.parentID).toBe(child.records[0].info.id);
    expect(child.records[1].parts.map((part) => part.type)).toEqual(['reasoning', 'text']);
    expect(identityAndContent(childLive)).toEqual(identityAndContent(child.records));
    await backend.closeSession(session.id);
    expect(identityAndContent((await backend.loadHistory(session.id, directory)).records)).toEqual(identityAndContent(history.records));
  });

  it.each(['retained-child-followup', 'retained-child-followup-result-only'])('recovers later parent tasks and reasoning for %s', async (text) => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'retained-agent-content');
    const report = backend.liveRecords(session.id).flatMap((record) => record.parts).find((part) => part.metadata?.nativeSubagentMessage);
    const childId = report.metadata.nativeSubagentSessionID;
    await prompt(session, text);
    const live = structuredClone(backend.liveRecords(childId));
    const users = live.filter((record) => record.info.role === 'user');
    expect(users.map((record) => record.parts[0].text)).toEqual(['Inspect fixture evidence.', 'Also inspect error cases.']);
    const reply = live.find((record) => record.parts.some((part) => part.type === 'text' && part.text === 'Error cases checked.'));
    expect(reply.info.parentID).toBe(users[1].info.id);
    expect(reply.parts.map((part) => part.type)).toEqual(['reasoning', 'text']);
    const history = await backend.loadHistory(childId, directory);
    const content = (records) => records.toSorted((left, right) => left.info.time.created - right.info.time.created)
      .map((record) => ({ id: record.info.id, parentID: record.info.parentID,
        parts: record.parts.map((part) => ({ id: part.id, type: part.type, text: part.text })) }));
    expect(content(live)).toEqual(content(history.records));
  });

  it('discovers only built-in models while preserving direct custom model prompts', async () => {
    const { backend, directory, prompt } = await setup();
    expect((await backend.catalog()).map((model) => model.id)).toEqual(['gemini-test']);
    const session = await backend.createSession({ directory });
    await prompt(session, 'mode-probe', 'magpie/antigravity/gemini-test');
    expect(JSON.parse(backend.liveRecords(session.id).at(-1).parts[0].text).model).toBe('magpie/antigravity/gemini-test');
  });

  it('retires an idle process and resumes the same saved conversation on a new process', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'mode-probe');
    const first = JSON.parse(backend.liveRecords(session.id).at(-1).parts[0].text);
    await backend.closeSession(session.id);
    expect(() => process.kill(first.pid, 0)).toThrow();
    await prompt(session, 'mode-probe');
    const second = JSON.parse(backend.liveRecords(session.id).at(-1).parts[0].text);
    expect(second.pid).not.toBe(first.pid);
    expect(second.resumed).toBe(session.id.slice(4));
    expect((await backend.loadHistory(session.id, directory)).records.filter((record) => record.info.role === 'user')).toHaveLength(2);
  });

  it('refuses to retire a running source and reports startup refusals as definite non-delivery', async () => {
    const { backend, directory } = await setup();
    const session = await backend.createSession({ directory });
    const request = { directory, messageID: `nag_u_${randomUUID()}`, parts: [{ type: 'text', text: 'stop-me' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build' };
    await backend.prompt(session.id, request);
    await expect(backend.closeSession(session.id)).rejects.toMatchObject({ code: 'NATIVE_SESSION_BUSY' });
    await backend.abort(session.id);
    await expect(backend.prompt(session.id, { ...request, model: { ...request.model, modelID: 'invalid-model' } }))
      .rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_ERROR' });
  });

  it('serializes first admissions after a restart before a process has been restored', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'hello');
    await backend.shutdown();
    const request = (text) => ({ directory, messageID: `nag_u_${randomUUID()}`, parts: [{ type: 'text', text }], model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'plan' });
    const first = backend.prompt(session.id, request('stop-me'));
    const second = backend.prompt(session.id, request('must not run'));
    await first;
    await expect(second).rejects.toMatchObject({ code: 'NATIVE_SESSION_BUSY' });
    await backend.abort(session.id);
    const history = await backend.loadHistory(session.id, directory);
    expect(JSON.stringify(history.records)).not.toContain('must not run');
  });

  it('does not let an older abort or idle waiter settle the next admitted turn', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let hold = true;
    const { backend, directory } = await setup({ decorateSession: async (session) => { if (hold) { hold = false; await gate; } return session; } });
    cleanups.push(() => release());
    const session = await backend.createSession({ directory });
    const request = (text) => ({ directory, messageID: `nag_u_${randomUUID()}`, parts: [{ type: 'text', text }], model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' });
    await backend.prompt(session.id, request('stop-after-commentary'));
    await vi.waitFor(() => expect(backend.liveRecords(session.id).some((record) => record.parts.some((part) => part.type === 'text' && part.text.includes('Waiting for completion')))).toBe(true));
    const oldStop = backend.abort(session.id);
    await vi.waitFor(() => expect(backend.busySessionIds(directory)).toEqual([]));
    await backend.prompt(session.id, request('stop-me'));
    let idle = false;
    const waiting = backend.whenIdle(session.id).then(() => { idle = true; });
    release();
    await oldStop;
    expect(backend.busySessionIds(directory)).toContain(session.id);
    expect(idle).toBe(false);
    await backend.abort(session.id);
    await waiting;
    expect(idle).toBe(true);
  });

  it('preserves a new stop request while the previous successful turn finishes publishing', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let hold = true;
    const { backend, directory } = await setup({ decorateSession: async (session) => { if (hold) { hold = false; await gate; } return session; } });
    cleanups.push(() => release());
    const session = await backend.createSession({ directory });
    const request = (text) => ({ directory, messageID: `nag_u_${randomUUID()}`, parts: [{ type: 'text', text }], model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' });
    await backend.prompt(session.id, request('hello'));
    await vi.waitFor(() => expect(backend.busySessionIds(directory)).toEqual([]));
    await backend.prompt(session.id, request('stop-after-commentary'));
    await vi.waitFor(async () => expect((await backend.loadHistory(session.id, directory)).records.filter((record) => record.info.role === 'user')).toHaveLength(2));
    const stop = backend.abort(session.id);
    release();
    await stop;
    expect(backend.liveRecords(session.id).at(-1).info.error?.name).toBe('MessageAbortedError');
  });

  it('keeps a late metadata failure with its finished turn instead of failing new work', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warning.mockRestore());
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let hold = true;
    const { backend, directory } = await setup({ decorateSession: async (session) => {
      if (hold) { hold = false; await gate; throw new Error('fixture metadata failure'); }
      return session;
    } });
    cleanups.push(() => release());
    const session = await backend.createSession({ directory });
    const request = (text) => ({ directory, messageID: `nag_u_${randomUUID()}`, parts: [{ type: 'text', text }], model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' });
    await backend.prompt(session.id, request('hello'));
    await vi.waitFor(() => expect(backend.busySessionIds(directory)).toEqual([]));
    await backend.prompt(session.id, request('stop-me'));
    release();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('[native-agents] Antigravity event handling failed:', 'fixture metadata failure'));
    expect(backend.busySessionIds(directory)).toContain(session.id);
    expect(backend.liveRecords(session.id).at(-1).info.error).toBeUndefined();
    await backend.abort(session.id);
  });

  it('switches native plan/build and effort on the same conversation, including after restart', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    for (const [agent, effort] of [['plan', 'high'], ['build', undefined], ['plan', 'low']]) {
      await prompt(session, 'mode-probe', 'gemini-test-high', agent, effort);
      const record = backend.liveRecords(session.id).at(-1);
      expect(record.info.agent).toBe(agent);
      expect(JSON.parse(record.parts[0].text)).toMatchObject({ mode: agent === 'plan' ? 'plan' : 'accept-edits', effort: effort ?? null, resumed: session.id.slice(4) });
      if (agent === 'build') await backend.shutdown();
    }
    expect((await backend.loadHistory(session.id, directory)).records.filter((record) => record.info.role === 'user').map((record) => record.info.agent)).toEqual(['plan', 'build', 'plan']);
  });

  it('keeps one model while changing effort, then restores the model and effort from history', async () => {
    const { backend, directory, prompt } = await setup();
    const [model] = await backend.catalog();
    const session = await backend.createSession({ directory });
    for (const effort of model.efforts) {
      await prompt(session, 'mode-probe', model.id, 'plan', effort);
      const record = backend.liveRecords(session.id).at(-1);
      expect(JSON.parse(record.parts[0].text)).toMatchObject({ model: model.id, effort, resumed: session.id.slice(4) });
      expect(record.info).toMatchObject({ modelID: model.id, variant: effort });
      await backend.shutdown();
    }
    const history = await backend.loadHistory(session.id, directory);
    expect(history.records.filter((record) => record.info.role === 'user').map((record) => record.info.model))
      .toEqual(model.efforts.map((variant) => ({ providerID: 'antigravity-native', modelID: model.id, variant })));
  });

  it('resolves an old concrete slug before launching a different effort without prior discovery', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'mode-probe', 'gemini-test-low', 'plan', 'high');
    expect(JSON.parse(backend.liveRecords(session.id).at(-1).parts[0].text))
      .toMatchObject({ model: 'gemini-test', effort: 'high', resumed: session.id.slice(4) });
    const history = await backend.loadHistory(session.id, directory);
    expect(history.records[0].info.model).toEqual({ providerID: 'antigravity-native', modelID: 'gemini-test-low', variant: 'high' });
  });

  it('keeps confirmed alias mappings after discovery failure without guessing other suffixes', async () => {
    const { backend, directory, prompt, setUnauthenticated } = await setup();
    await backend.catalog();
    setUnauthenticated();
    await expect(backend.catalog()).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNAUTHENTICATED' });
    const session = await backend.createSession({ directory });
    await prompt(session, 'mode-probe', 'gemini-test-low', 'plan', 'high');
    expect(JSON.parse(backend.liveRecords(session.id).at(-1).parts[0].text)).toMatchObject({ model: 'gemini-test', effort: 'high' });
    await expect(prompt(session, 'must not send', 'unknown-low', 'plan', 'high')).rejects.toThrow('conflicts');
    expect(JSON.stringify(await backend.loadHistory(session.id, directory))).not.toContain('must not send');
  });

  it('retains real failures even when the native log has a partial assistant reply', async () => {
    const { backend, directory, prompt, events } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'failure-after-response');
    expect(backend.liveRecords(session.id).at(-1).info.error.data.message).toBe('Authentication expired');
    expect(events.some((event) => event.payload.type === 'session.error')).toBe(true);
  });

  it('recovers skipped questions and uses only the complete final step from an aggregated result', async () => {
    const { backend, directory, prompt, events } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'history-recovery');
    const live = backend.liveRecords(session.id).filter((record) => record.info.role === 'assistant');
    expect(live.map((record) => record.parts.find((part) => part.type === 'text')?.text)).toEqual([
      'Choose the scope\n', 'Waiting for verification\n', 'Complete final answer\n',
    ]);
    const question = live.flatMap((record) => record.parts).find((part) => part.type === 'tool');
    expect(question).toMatchObject({ tool: 'ask_question', state: { output: 'A1: User Skipped', input: { question: 'Which files?' } } });
    expect(events.some((event) => event.payload.type === 'message.part.updated' && event.payload.properties.part.id === question.id)).toBe(true);
    const history = (await backend.loadHistory(session.id, directory)).records;
    expect(live.flatMap((record) => record.parts.map((part) => part.id))).toEqual(
      history.filter((record) => record.info.role === 'assistant').flatMap((record) => record.parts.map((part) => part.id)),
    );
  });

  it('keeps the live response when only a truncated preview was retained', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'preview-only-final');
    expect(backend.liveRecords(session.id).at(-1).parts[0].text).toBe('Waiting for verification\nComplete final answer\n');
  });

  it('reads quota through an independent CLI report without creating a conversation', async () => {
    const { backend, directory } = await setup();
    expect(await backend.quota()).toMatchObject({ ok: true, configured: true, usage: { models: { gemini: { windows: { weekly: { remainingPercent: 97 } } } } } });
    expect(await backend.listRootSessions(directory)).toEqual([]);
  });

  it('reads native quota with gateway settings while discovery and chat keep the shell wrapper', async () => {
    const gatewayModel = 'magpie/antigravity/gemini-test';
    const { backend, directory, home, prompt, resolveCommand } = await setup({ commandPrefix: ['--model', gatewayModel] });
    const settingsFile = path.join(home, 'settings.json');
    const settings = `${JSON.stringify({ modelProvider: 'gemini', model: gatewayModel })}\n`;
    fs.writeFileSync(settingsFile, settings);

    expect(await backend.quota()).toMatchObject({
      ok: true, configured: true,
      usage: { models: { gemini: { windows: { weekly: { remainingPercent: 97 } } }, 'claude-gpt': { windows: { '5h': { remainingPercent: 75 } } } } },
    });
    expect(resolveCommand).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(settings);
    expect(await backend.listRootSessions(directory)).toEqual([]);
    expect(fs.existsSync(path.join(home, 'brain'))).toBe(false);

    expect(await backend.catalog()).toHaveLength(1);
    const session = await backend.createSession({ directory });
    await prompt(session, 'mode-probe');
    expect(JSON.parse(backend.liveRecords(session.id).at(-1).parts[0].text).model).toBe(gatewayModel);
    expect(resolveCommand).toHaveBeenCalledOnce();
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(settings);
  });

  it.each([
    ['unsupported-settings', 'flag provided but not defined: -settings'],
    ['unauthenticated', 'Antigravity authentication failed. Run `agy` on the server and sign in, then retry.'],
    ['empty', 'Antigravity reported no quota data'],
  ])('reports native quota failure %s without invoking the shell wrapper', async (quotaFailure, error) => {
    const { backend, directory, resolveCommand } = await setup({ quotaFailure });
    expect(await backend.quota()).toMatchObject({ ok: false, configured: true, usage: null, error });
    expect(resolveCommand).not.toHaveBeenCalled();
    expect(await backend.listRootSessions(directory)).toEqual([]);
  });

  it('places a recovered final result on its native step and keeps preceding commentary intact', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'missing-final-frame');
    const live = backend.liveRecords(session.id).filter((record) => record.info.role === 'assistant');
    expect(live.map((record) => record.parts[0].text)).toEqual(['Checking the result\n', 'Final response without a stream frame\n']);
    const history = (await backend.loadHistory(session.id, directory)).records.filter((record) => record.info.role === 'assistant');
    expect(live.map((record) => record.info.id)).toEqual(history.map((record) => record.info.id));
    expect(live.at(-1).info.tokens).toMatchObject({ input: 14, output: 7 });
  });
  it('discovers models and completes live and persisted turns with stable user ids', async () => {
    const { backend, directory, prompt, registry } = await setup();
    expect(await backend.catalog()).toEqual([
      expect.objectContaining({ id: 'gemini-test', name: 'Gemini Test', efforts: ['low', 'high'], input: { image: false, pdf: false } }),
    ]);
    const session = await backend.createSession({ directory, title: 'Test conversation' });
    expect(session.id).toMatch(/^nag_[0-9a-f-]{36}$/);
    expect((await backend.loadHistory(session.id, directory)).records).toEqual([]);
    const firstMessage = await prompt(session, 'hello');
    const history = await backend.loadHistory(session.id, directory);
    expect(history.records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    expect(history.records[0].info.id).toBe(firstMessage);
    expect(history.records[0].parts[0].text).toBe('hello');
    expect(history.records[0].info.model).toMatchObject({ providerID: 'antigravity-native', modelID: 'gemini-test-high' });
    expect(history.records[1].parts[0].text).toBe('Reply to hello\n');
    expect(history.records[1].info.tokens).toMatchObject({ total: 16, input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 0 } });
    expect((await registry.sendRecords(session.id)).get(firstMessage).antigravity.measurements.records)
      .toEqual([expect.objectContaining({ messageID: history.records[1].info.id, tokens: history.records[1].info.tokens })]);
    expect(JSON.stringify(history)).not.toContain('GLOBAL FIXTURE RULES');
    expect(JSON.stringify(history)).not.toContain('Interactive question replies are unavailable');
    expect(await backend.sessionExists(session.id, directory)).toBe(true);
  });

  it('maps tools and resumes the same conversation after a model change', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'use a tool');
    await prompt(session, 'next', 'gemini-test-low');
    const history = await backend.loadHistory(session.id, directory);
    const users = history.records.filter((record) => record.info.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[1].info.model.modelID).toBe('gemini-test-low');
    const tool = history.records.flatMap((record) => record.parts).find((part) => part.type === 'tool');
    expect(tool).toMatchObject({ tool: 'bash', state: { status: 'completed', output: 'fixture\n' } });
    expect(history.records.filter((record) => record.info.role === 'assistant').at(-1).parts[0].text).toBe('Reply to next\n');
  });

  it('rejects a second turn, interrupts cleanly and accepts a later prompt', async () => {
    const { backend, directory, prompt } = await setup();
    const session = await backend.createSession({ directory });
    const pending = backend.prompt(session.id, {
      directory,
      messageID: `nag_u_${randomUUID()}`,
      parts: [{ type: 'text', text: 'stop-me' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      agent: 'build',
    });
    await expect(backend.prompt(session.id, {
      directory,
      messageID: `nag_u_${randomUUID()}`,
      parts: [{ type: 'text', text: 'should not run' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      agent: 'build',
    })).rejects.toMatchObject({ code: 'NATIVE_SESSION_BUSY' });
    await pending;
    expect(await backend.abort(session.id)).toBe(true);
    await backend.whenIdle(session.id);
    expect(backend.liveRecords(session.id).some((record) => record.info.error?.name === 'MessageAbortedError')).toBe(true);
    await prompt(session, 'after stop');
    expect((await backend.loadHistory(session.id, directory)).records.at(-1).parts[0].text).toBe('Reply to after stop\n');
  });

  it.each(['stop-after-commentary', 'stop-after-output-limit'])('keeps an explicit stop after %s from recovering as success', async (text) => {
    const { backend, directory } = await setup();
    const session = await backend.createSession({ directory });
    await backend.prompt(session.id, {
      directory, messageID: `nag_u_${randomUUID()}`, agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      parts: [{ type: 'text', text }],
    });
    await vi.waitFor(() => expect(backend.liveRecords(session.id).some((record) => record.parts.some((part) => part.type === 'text' && part.text.includes('Waiting for completion')))).toBe(true));
    await backend.abort(session.id);
    await backend.whenIdle(session.id);
    expect(backend.liveRecords(session.id).at(-1).info.error.name).toBe('MessageAbortedError');
  });

  it('uses the native final response to settle sticky stream errors without retrying', async () => {
    const { backend, directory, events, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'sticky');
    const history = await backend.loadHistory(session.id, directory);
    expect(history.records.at(-1).parts[0].text).toBe('Recovered response\n');
    expect(history.records.at(-1).info.error).toBeUndefined();
    expect(events.some((event) => event.payload.type === 'session.error' && event.payload.properties.error.data.message.includes('stream was interrupted'))).toBe(false);
    await prompt(session, 'after sticky');
    expect((await backend.loadHistory(session.id, directory)).records.at(-1).parts[0].text).toBe('Reply to after sticky\n');
  });

  it('saves a recovered output-limit turn before publishing its questions and restores it after restart', async () => {
    const proposals = [];
    const { backend, directory, registry, prompt, events } = await setup({ onInteraction: async (proposal) => {
      expect([...await registry.sendRecords(proposal.sessionId)].at(-1)[1].antigravity.completion.outcome).toBe('success');
      proposals.push(proposal);
    } });
    const session = await backend.createSession({ directory });
    const messageId = await prompt(session, 'decision-questions-output-limit', 'gemini-test', 'plan', 'high');
    const final = backend.liveRecords(session.id).find((record) => record.parts.some((part) => part.type === 'text' && part.text === 'Waiting for your answer.\n'));
    expect(final.info).toMatchObject({ parentID: messageId, finish: 'stop' });
    expect(final.info.error).toBeUndefined();
    expect((await registry.sendRecords(session.id)).get(messageId)).toMatchObject({ modelID: 'gemini-test', variant: 'high', agent: 'plan', antigravity: { completion: { outcome: 'success' } } });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].questions).toHaveLength(2);
    expect(events.some((event) => event.payload.type === 'session.error')).toBe(false);
    const before = await backend.loadHistory(session.id, directory);
    await backend.shutdown();
    const restored = await backend.loadHistory(session.id, directory);
    expect(restored.records.at(-1).info).toMatchObject({ id: before.records.at(-1).info.id, parentID: messageId, finish: 'stop' });
    expect(restored.interactionProposal.callID).toBe(before.interactionProposal.callID);
    expect(restored.records.flatMap((record) => record.parts).filter((part) => part.type === 'tool' && part.tool === 'question')).toHaveLength(1);
    expect(restored.records.filter((record) => record.info.role === 'user')).toHaveLength(1);
  });

  it('recovers the next turn when agy retains the earlier output-limit error without another error step', async () => {
    const { backend, directory, registry, prompt, events, home } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'decision-questions-output-limit', 'gemini-test', 'plan', 'high');
    const nextId = await prompt(session, 'decision-questions-stale-output-limit', 'gemini-test', 'plan', 'high');
    const transcript = fs.readFileSync(path.join(home, 'brain', session.id.slice(4), '.system_generated/logs/transcript_full.jsonl'), 'utf8');
    expect(transcript.split('\n').filter((line) => line.includes('"type":"ERROR_MESSAGE"'))).toHaveLength(1);
    expect(backend.liveRecords(session.id).at(-1).info).toMatchObject({ parentID: nextId, finish: 'stop' });
    expect(backend.liveRecords(session.id).at(-1).info.error).toBeUndefined();
    expect([...await registry.sendRecords(session.id)].map(([, send]) => send.antigravity.completion.outcome)).toEqual(['success', 'success']);
    const history = await backend.loadHistory(session.id, directory);
    expect(history.records.filter((record) => record.info.role === 'user')).toHaveLength(2);
    expect(history.interactionProposal.userStep).toBe((await registry.sendRecords(session.id)).get(nextId).antigravity.stepIndex);
    expect(events.some((event) => event.payload.type === 'session.error')).toBe(false);
  });

  it.each(['output-limit-no-final', 'output-limit-truncated-final', 'output-limit-unreadable-final', 'output-limit-unrecognized'])('retains an output-limit failure for %s', async (text) => {
    const { backend, directory, registry, prompt, events } = await setup();
    const session = await backend.createSession({ directory });
    const messageId = await prompt(session, text);
    expect(backend.liveRecords(session.id).at(-1).info.error.data.message).toContain('exceeded the output token limit');
    expect((await registry.sendRecords(session.id)).get(messageId).antigravity.completion.outcome).toBe('error');
    expect(events.some((event) => event.payload.type === 'session.error')).toBe(true);
  });

  it('withholds recovered questions when completion persistence fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warning.mockRestore());
    const proposals = [];
    const { backend, directory, registry, prompt } = await setup({ onInteraction: async (proposal) => { proposals.push(proposal); } });
    const recordSend = registry.recordSend.bind(registry);
    const save = vi.spyOn(registry, 'recordSend').mockImplementation((id, record) => record.antigravity?.completion
      ? Promise.reject(new Error('Fixture completion write failure')) : recordSend(id, record));
    cleanups.push(() => save.mockRestore());
    const session = await backend.createSession({ directory });
    const messageId = await prompt(session, 'decision-questions-output-limit', 'gemini-test', 'plan', 'high');
    expect((await registry.sendRecords(session.id)).get(messageId).antigravity.completion).toBeUndefined();
    expect(proposals).toEqual([]);
    expect((await backend.loadHistory(session.id, directory)).interactionProposal).toBeNull();
    expect(backend.busySessionIds(directory)).toEqual([]);
    expect(warning).toHaveBeenCalled();
  });

  it('reports an empty SUCCESS with denied actions and retains the cause after restart', async () => {
    const { backend, directory, events, prompt } = await setup();
    const session = await backend.createSession({ directory });
    const userId = await prompt(session, 'permission-denied', 'gemini-test-high', 'plan');
    const live = backend.liveRecords(session.id).at(-1);
    expect(live.info.error).toMatchObject({ name: 'UnknownError', data: { message: expect.stringContaining('permission: read_file') } });
    expect(live.info.error.data.message).toContain('Interactive permission approvals are unavailable');
    expect(live.info.error.data.message).not.toContain('aborted');
    expect(live.parts.find((part) => part.type === 'tool').state).toMatchObject({ status: 'error', error: live.info.error.data.message });
    expect(events.some((event) => event.payload.type === 'session.error' && event.payload.properties.error.data.message === live.info.error.data.message)).toBe(true);
    expect(backend.busySessionIds(directory)).toEqual([]);
    await backend.shutdown();
    const history = await backend.loadHistory(session.id, directory);
    expect(history.records.at(-1).info).toMatchObject({ id: live.info.id, parentID: userId, finish: 'error', error: live.info.error });
    expect(history.records.at(-1).parts.find((part) => part.type === 'tool').state.error).toBe(live.info.error.data.message);
    await prompt(session, 'after permission denial', 'gemini-test-high', 'plan');
    const continued = await backend.loadHistory(session.id, directory);
    expect(continued.records.at(-1).info.error).toBeUndefined();
    expect(continued.records.find((record) => record.info.id === live.info.id).info.error).toEqual(live.info.error);
    expect(continued.records.filter((record) => record.info.role === 'user')).toHaveLength(2);
  });

  it('retains a completed response when a denied action did not prevent an answer', async () => {
    const { backend, directory, events, prompt } = await setup();
    const session = await backend.createSession({ directory });
    await prompt(session, 'permission-denied-with-answer');
    expect(backend.liveRecords(session.id).at(-1).info.error).toBeUndefined();
    expect((await backend.loadHistory(session.id, directory)).records.at(-1).info.error).toBeUndefined();
    expect(events.some((event) => event.payload.type === 'session.error')).toBe(false);
  });

  it('still settles a denied turn when its diagnostic cannot be saved', async () => {
    const { backend, directory, registry, prompt } = await setup();
    const session = await backend.createSession({ directory });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recordSend = registry.recordSend.bind(registry);
    const save = vi.spyOn(registry, 'recordSend').mockImplementation((id, record) => record.antigravity?.denial
      ? Promise.reject(new Error('Fixture diagnostic write failure')) : recordSend(id, record));
    cleanups.push(() => { warning.mockRestore(); save.mockRestore(); });
    await prompt(session, 'permission-denied');
    const error = backend.liveRecords(session.id).at(-1).info.error;
    expect(error.data.message).toContain('permission: read_file');
    expect(error.data.message).toContain('details could not be saved');
    expect(backend.busySessionIds(directory)).toEqual([]);
    expect(warning).toHaveBeenCalled();
  });

  it('refuses to continue when agy restores a different conversation', async () => {
    const { backend, directory, prompt, setConversationId } = await setup();
    const session = await backend.createSession({ directory });
    setConversationId('01a0d2a6-b55b-7162-a837-c62053537e00');
    await expect(prompt(session, 'wrong conversation')).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_INVALID_RESUME' });
    expect(backend.busySessionIds(directory)).toEqual([]);
  });

  it('rejects unknown agents, unsupported effort, another directory and image prompts', async () => {
    const { backend, directory } = await setup();
    const session = await backend.createSession({ directory });
    await expect(backend.prompt(session.id, {
      directory,
      messageID: `nag_u_${randomUUID()}`,
      parts: [{ type: 'text', text: 'plan' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      agent: 'unrecognized',
    })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    for (const change of [{ variant: 'high-fast' }, { directory: path.join(directory, 'other') }]) {
      await expect(backend.prompt(session.id, {
        directory, messageID: `nag_u_${randomUUID()}`, parts: [{ type: 'text', text: 'probe' }],
        model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build', ...change,
      })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    }
    await expect(backend.prompt(session.id, {
      directory,
      messageID: `nag_u_${randomUUID()}`,
      parts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      agent: 'build',
    })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    expect(await vi.waitFor(() => backend.catalog().then((models) => models.length))).toBe(1);
  });
});
