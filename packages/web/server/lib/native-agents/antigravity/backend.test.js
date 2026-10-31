import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeEventPublisher } from '../publisher.js';
import { createNativeRegistry } from '../registry.js';
import { createAntigravityBackend } from './backend.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const setup = async ({ decorateSession = async (session) => session } = {}) => {
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
  const backend = createAntigravityBackend({
    resolveExecutable: async () => executable,
    buildEnv: () => ({ ...process.env, AGY_FIXTURE_HOME: home, AGY_FIXTURE_UNAUTHENTICATED: unauthenticated ? '1' : '0', ...(conversationId ? { AGY_FIXTURE_CONVERSATION_ID: conversationId } : {}) }),
    registry,
    publisher,
    readGlobalInstructions: async () => 'GLOBAL FIXTURE RULES',
    decorateSession,
    home,
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
  return { backend, directory, events, registry, prompt, setConversationId: (value) => { conversationId = value; }, setUnauthenticated: () => { unauthenticated = true; } };
};

describe('Antigravity CLI adapter', () => {
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
    const { backend, directory, prompt } = await setup();
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
    expect(history.records[1].info.tokens).toMatchObject({ total: 14, input: 10, output: 4, reasoning: 1, cache: { read: 2, write: 0 } });
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

  it('never treats an explicit stop after commentary as sticky-error recovery', async () => {
    const { backend, directory } = await setup();
    const session = await backend.createSession({ directory });
    await backend.prompt(session.id, {
      directory, messageID: `nag_u_${randomUUID()}`, agent: 'build',
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      parts: [{ type: 'text', text: 'stop-after-commentary' }],
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
