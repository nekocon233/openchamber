import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeAgentsRuntime } from '../runtime.js';

const runtimes = [];
afterEach(async () => {
  for (const { runtime, root } of runtimes.splice(0)) {
    await runtime.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const createHarness = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-codex-plan-'));
  const directory = path.join(root, 'project');
  fs.mkdirSync(directory);
  const executable = path.join(root, 'codex');
  fs.copyFileSync(new URL('./fixtures/plan-server.mjs', import.meta.url), executable);
  fs.chmodSync(executable, 0o755);
  const events = [];
  const captures = [];
  const restored = [];
  const runtime = createNativeAgentsRuntime({
    dataDir: root,
    resolveExecutable: async () => executable,
    buildChildEnv: () => ({ PATH: process.env.PATH }),
    clientVersion: 'test',
    publishNativeEvent: (event) => events.push(event),
    snapshots: {
      repositoryRoot: async () => directory,
      capture: async () => { const id = `snapshot-${captures.length}`; captures.push(id); return id; },
      changedFiles: async () => ['changed.txt'],
      restoreFiles: async (...args) => restored.push(args),
    },
  });
  runtimes.push({ runtime, root });
  const session = await runtime.createSession({ backend: 'codex', directory, title: 'Plan test' });
  const selection = { model: { providerID: 'codex-native', modelID: 'gpt-5.5' }, variant: 'high-fast', agent: 'plan' };
  const prompt = (text = 'Plan a change', agent = 'plan') => runtime.prompt(session.id, {
    ...selection, directory, messageID: `ncx_u_${randomUUID()}`, parts: [{ type: 'text', text }], agent,
  });
  const requests = () => fs.readFileSync(path.join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const sends = () => requests().filter(request => request.method === 'turn/start').map(request => request.params);
  const registry = () => JSON.parse(fs.readFileSync(path.join(root, 'native-agents', 'registry.json'), 'utf8'));
  const idle = () => vi.waitFor(async () => {
    expect(runtime.hasPendingPlanDecision(session.id)).toBe(false);
    expect(await runtime.statuses(directory)).toEqual({});
  });
  await prompt();
  let question;
  await vi.waitFor(async () => {
    [question] = await runtime.questions(directory);
    expect(question?.kind).toBe('codex-plan-exit');
  });
  return { runtime, root, directory, session, selection, question, prompt, sends, registry, idle, captures, restored, events };
};

describe('Codex plan decisions through the native runtime', () => {
  it('continues with an ordinary recorded prompt and preserves file-revert snapshots', async () => {
    const { runtime, directory, session, question, sends, registry, idle, captures, restored, events } = await createHarness();
    expect(await runtime.statuses(directory)).toEqual({});
    expect(await runtime.questions(directory)).toEqual([question]);
    runtime.replyQuestion(question.id, [['build']]);
    expect(() => runtime.replyQuestion(question.id, [['build']])).toThrow('No pending native question');
    await idle();
    const starts = sends();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({
      cwd: directory, model: 'gpt-5.5', effort: 'high', serviceTier: 'priority',
      collaborationMode: { mode: 'default' }, input: [{ type: 'text', text: 'Implement the plan.' }],
    });
    const records = (await runtime.loadMessages(session.id, directory, { limit: 20 })).records;
    const users = records.filter(record => record.info.role === 'user');
    expect(users.map(record => record.info.agent)).toEqual(['plan', 'build']);
    expect(users[1].info.model).toMatchObject({ providerID: 'codex-native', modelID: 'gpt-5.5', variant: 'high-fast' });
    expect(users[1].info.id).toMatch(/^ncx_u_plan_/);
    expect(users[1].parts[0]).toMatchObject({
      text: 'Implement the plan.', metadata: { openchamberOrigin: 'codex-plan-approval' },
    });
    const liveApproval = events.find(event => event.payload.type === 'message.part.updated'
      && event.payload.properties.part.messageID === users[1].info.id);
    expect(liveApproval.payload.properties.part).toMatchObject({
      text: 'Implement the plan.', metadata: { openchamberOrigin: 'codex-plan-approval' },
    });
    await vi.waitFor(() => expect(registry().turns[session.id].every(turn => turn.after)).toBe(true));
    expect(captures).toHaveLength(4);
    expect(registry().sends[session.id].map(send => send.agent)).toEqual(['plan', 'build']);
    expect(await runtime.revert(session.id, users[1].info.id, directory)).toMatchObject({ filesRestored: 1, conversationOnly: false });
    expect(restored).toEqual([[directory, 'snapshot-2', ['changed.txt']]]);
  });

  it('keeps a manually submitted matching prompt visible', async () => {
    const { runtime, directory, session, question, prompt, idle } = await createHarness();
    runtime.replyQuestion(question.id, [['build']]);
    await idle();
    await prompt('Implement the plan.', 'build');
    await idle();
    await vi.waitFor(async () => {
      const { records } = await runtime.loadMessages(session.id, directory, { limit: 20 });
      const users = records.filter(record => record.info.role === 'user');
      expect(users).toHaveLength(3);
      expect(users[1].parts[0].metadata).toEqual({ openchamberOrigin: 'codex-plan-approval' });
      expect(users[2].info.id).toMatch(/^ncx_u_[0-9a-f-]+$/);
      expect(users[2].parts[0].text).toBe('Implement the plan.');
      expect(users[2].parts[0].metadata).toBeUndefined();
    });
  });

  it('revises in plan mode and lets the user decline the new proposal', async () => {
    const { runtime, directory, session, question, sends, idle } = await createHarness();
    runtime.replyQuestion(question.id, [['Include invalid-input tests.']]);
    let revision;
    await vi.waitFor(async () => {
      [revision] = await runtime.questions(directory);
      expect(revision?.questions[0].question).toContain('revision 2');
    });
    expect(sends()[1]).toMatchObject({ collaborationMode: { mode: 'plan' }, input: [{ type: 'text', text: 'Include invalid-input tests.' }] });
    runtime.replyQuestion(revision.id, [['plan']]);
    await idle();
    expect(sends()).toHaveLength(2);
    expect((await runtime.loadMessages(session.id, directory, { limit: 20 })).records.filter(record => record.info.role === 'user').map(record => record.info.agent))
      .toEqual(['plan', 'plan']);
  });

  it.each(['abort', 'prompt', 'archive', 'delete', 'revert', 'compact', 'shutdown'])('invalidates a pending decision on %s', async (action) => {
    const { runtime, directory, session, question, prompt, sends, selection } = await createHarness();
    if (action === 'abort') expect(await runtime.abort(session.id)).toBe(true);
    else if (action === 'prompt') await prompt('Another task', 'build');
    else if (action === 'archive') await runtime.updateSession(session.id, directory, { archived: true });
    else if (action === 'delete') await runtime.deleteSession(session.id, directory);
    else if (action === 'revert') await runtime.revert(session.id, sends()[0].clientUserMessageId, directory);
    else if (action === 'compact') await runtime.compact(session.id, { ...selection, directory });
    else await runtime.shutdown();
    expect(await runtime.questions(directory)).toEqual([]);
    expect(runtime.hasPendingPlanDecision(session.id)).toBe(false);
    expect(() => runtime.replyQuestion(question.id, [['build']])).toThrow('No pending native question');
    expect(sends()).toHaveLength(action === 'prompt' ? 2 : 1);
  });

  it('reports execution-start failure and leaves the recorded session in plan mode', async () => {
    const { runtime, directory, session, question, events, sends, idle } = await createHarness();
    fs.writeFileSync(path.join(directory, 'fail-build'), '');
    runtime.replyQuestion(question.id, [['build']]);
    await idle();
    expect(events.filter(event => event.payload.type === 'session.error')).toHaveLength(1);
    expect(events.find(event => event.payload.type === 'session.error').payload.properties.error.data.message).toBe('Scripted execution start failed');
    const users = (await runtime.loadMessages(session.id, directory, { limit: 20 })).records.filter(record => record.info.role === 'user');
    expect(users.map(record => record.info.agent)).toEqual(['plan']);
    expect(sends()).toHaveLength(2);
  });
});
