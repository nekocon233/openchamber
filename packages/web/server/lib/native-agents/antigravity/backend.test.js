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

const setup = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-test-'));
  let conversationId = null;
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
    buildEnv: () => ({ ...process.env, AGY_FIXTURE_HOME: home, ...(conversationId ? { AGY_FIXTURE_CONVERSATION_ID: conversationId } : {}) }),
    registry,
    publisher,
    readGlobalInstructions: async () => 'GLOBAL FIXTURE RULES',
    decorateSession: async (session) => session,
    home,
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => backend.shutdown());
  const prompt = async (session, text, modelID = 'gemini-test-high') => {
    const messageID = `nag_u_${randomUUID()}`;
    await backend.prompt(session.id, {
      directory,
      messageID,
      parts: [{ type: 'text', text }],
      model: { providerID: 'antigravity-native', modelID },
      agent: 'build',
    });
    await backend.whenIdle(session.id);
    return messageID;
  };
  return { backend, directory, events, registry, prompt, setConversationId: (value) => { conversationId = value; } };
};

describe('Antigravity CLI adapter', () => {
  it('discovers models and completes live and persisted turns with stable user ids', async () => {
    const { backend, directory, prompt } = await setup();
    expect(await backend.catalog()).toEqual([
      expect.objectContaining({ id: 'gemini-test-high', input: { image: false, pdf: false } }),
      expect.objectContaining({ id: 'gemini-test-low' }),
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

  it('refuses to continue when agy restores a different conversation', async () => {
    const { backend, directory, prompt, setConversationId } = await setup();
    const session = await backend.createSession({ directory });
    setConversationId('01a0d2a6-b55b-7162-a837-c62053537e00');
    await expect(prompt(session, 'wrong conversation')).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_INVALID_RESUME' });
    expect(backend.busySessionIds(directory)).toEqual([]);
  });

  it('keeps plan mode and image prompts out of the native protocol', async () => {
    const { backend, directory } = await setup();
    const session = await backend.createSession({ directory });
    await expect(backend.prompt(session.id, {
      directory,
      messageID: `nag_u_${randomUUID()}`,
      parts: [{ type: 'text', text: 'plan' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      agent: 'plan',
    })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    await expect(backend.prompt(session.id, {
      directory,
      messageID: `nag_u_${randomUUID()}`,
      parts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==' }],
      model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' },
      agent: 'build',
    })).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    expect(await vi.waitFor(() => backend.catalog().then((models) => models.length))).toBe(2);
  });
});
