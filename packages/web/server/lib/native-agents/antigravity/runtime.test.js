import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeAgentsRuntime } from '../runtime.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const setup = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-runtime-'));
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
  const runtime = createNativeAgentsRuntime({
    dataDir: root,
    resolveExecutable: async (cli) => cli === 'agy' ? executable : null,
    buildChildEnv: () => ({ ...process.env, AGY_FIXTURE_HOME: fixtureHome, ...(unauthenticated ? { AGY_FIXTURE_UNAUTHENTICATED: '1' } : {}) }),
    clientVersion: 'test',
    publishNativeEvent: (event) => events.push(event),
    readGlobalInstructions: async () => 'RUNTIME RULES',
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => runtime.shutdown());
  const session = await runtime.createSession({ backend: 'antigravity', directory, title: 'Runtime agy' });
  return { runtime, session, directory, events, setUnauthenticated: () => { unauthenticated = true; } };
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
      actions: { revert: false, delete: false, fork: false, compact: false },
    });
    expect((await runtime.catalog()).backends.antigravity.models).toHaveLength(2);
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

  it('rejects unified conversations and unsupported native mutations', async () => {
    const { runtime, session, directory } = await setup();
    await expect(runtime.createSession({
      kind: 'unified', backend: 'antigravity', directory,
      selection: { model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' },
    })).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNIFIED_UNSUPPORTED' });
    const selection = { model: { providerID: 'antigravity-native', modelID: 'gemini-test-high' }, agent: 'build' };
    await expect(runtime.compact(session.id, { directory, ...selection })).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    await expect(runtime.revert(session.id, 'nag_u_any', directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    await expect(runtime.unrevert(session.id, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    await expect(runtime.fork(session.id, null, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    await expect(runtime.deleteSession(session.id, directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_UNSUPPORTED' });
    expect((await runtime.commands('antigravity', directory)).commands).toEqual([]);
  });
});
