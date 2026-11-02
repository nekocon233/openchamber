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

const setup = async ({ unified = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agy-decisions-runtime-'));
  const directory = path.join(root, 'project');
  const home = path.join(root, 'home');
  const fixtureHome = path.join(home, '.gemini', 'antigravity-cli');
  const requestPath = path.join(root, 'requests.jsonl');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(fixtureHome, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const executable = path.join(root, 'agy');
  fs.copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
  fs.chmodSync(executable, 0o755);
  const events = [];
  const createRuntime = () => {
    const runtime = createNativeAgentsRuntime({
      dataDir: root,
      resolveExecutable: async (cli) => cli === 'agy' ? executable : null,
      resolveAntigravityCommand: async () => ({ executable, argsPrefix: [] }),
      buildChildEnv: () => ({ ...process.env, AGY_FIXTURE_HOME: fixtureHome, AGY_FIXTURE_REQUESTS: requestPath }),
      clientVersion: 'test',
      publishNativeEvent: (event) => events.push(event),
      readGlobalInstructions: async () => '',
    });
    cleanups.push(() => runtime.shutdown());
    return runtime;
  };
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let runtime = createRuntime();
  const selection = { model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, variant: 'high', agent: 'plan' };
  const createRequest = { backend: 'antigravity', directory, title: 'Decision runtime fixture' };
  if (unified) Object.assign(createRequest, { kind: 'unified', selection });
  const session = await runtime.createSession(createRequest);
  const requests = () => fs.existsSync(requestPath)
    ? fs.readFileSync(requestPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const idle = () => vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
  const history = () => runtime.loadMessages(session.id, directory, { limit: 50 });
  const prompt = async (text, agent = 'plan') => {
    const messageID = `${unified ? 'ncv' : 'nag'}_u_${randomUUID()}`;
    await runtime.prompt(session.id, {
      ...selection, directory, agent, messageID, parts: [{ type: 'text', text }],
    });
    await idle();
  };
  const waiting = async (text, agent = 'plan') => {
    await prompt(text, agent);
    let question;
    await vi.waitFor(async () => {
      [question] = await runtime.questions(directory);
      expect(question).toBeDefined();
    });
    return question;
  };
  const restart = async () => {
    await runtime.shutdown();
    runtime = createRuntime();
    return runtime;
  };
  return { get runtime() { return runtime; }, session, directory, events, selection, requests, idle, history, waiting, restart };
};

const toolParts = (page) => page.records.flatMap((record) => record.parts).filter((part) => part.type === 'tool');

describe('Antigravity decisions through the native runtime', () => {
  it('continues an approved unified plan on its source while preserving the next selected model', async () => {
    const harness = await setup({ unified: true });
    const question = await harness.waiting('decision-plan');
    expect(question.sessionID).toBe(harness.session.id);
    await harness.restart();
    expect((await harness.runtime.questions(harness.directory))[0].id).toBe(question.id);
    const current = await harness.runtime.getSession(harness.session.id, harness.directory);
    const next = { model: { providerID: 'codex-native', modelID: 'gpt-test' }, agent: 'plan', variant: 'max' };
    await harness.runtime.selectModel(harness.session.id, harness.directory, next, current.metadata.openchamber.native.revision);
    await harness.runtime.replyQuestion(question.id, [['build']]);
    await harness.idle();
    const updated = await harness.runtime.getSession(harness.session.id, harness.directory);
    expect(updated.model).toMatchObject({ providerID: 'codex-native', id: 'gpt-test', variant: 'max' });
    expect(updated.agent).toBe('plan');
    expect(updated.metadata.openchamber.native.backend).toBe('antigravity');
    const users = (await harness.history()).records.filter((record) => record.info.role === 'user');
    expect(users.map((record) => record.info.agent)).toEqual(['plan', 'build']);
    expect(users[1].info.id).toMatch(/^ncv_u_/);
    expect(harness.requests()).toHaveLength(2);
    expect(harness.requests()[1]).toMatchObject({ mode: 'accept-edits', model: 'gemini-test', effort: 'high' });
    expect(harness.requests()[1].text).toContain('# Fixture implementation plan');
    await harness.restart();
    expect((await harness.history()).records.filter((record) => record.info.role === 'user').map((record) => record.info.id))
      .toEqual(users.map((record) => record.info.id));
    expect(await harness.runtime.questions(harness.directory)).toEqual([]);
    expect(harness.requests()).toHaveLength(2);
  });

  it('projects unified custom and multiple answers into the same question history', async () => {
    const harness = await setup({ unified: true });
    const question = await harness.waiting('decision-questions', 'build');
    expect(question.sessionID).toBe(harness.session.id);
    const answers = [['Only the parser'], ['Lint', 'Unit tests']];
    await harness.runtime.replyQuestion(question.id, answers);
    await harness.idle();
    const page = await harness.history();
    expect(page.records.filter((record) => record.info.role === 'user')).toHaveLength(2);
    expect(toolParts(page).find((part) => part.tool === 'question')?.state.metadata.questionAnswers).toEqual(answers);
    expect(toolParts(page).find((part) => part.tool === 'ask_question')?.state.output).toContain('User Skipped');
    expect(harness.requests()[1].visible).toBe('');
    expect(harness.requests()[1].text).toContain('Only the parser');
    expect(page.records.filter((record) => record.info.role === 'user')[1].parts).toEqual([]);
    await harness.restart();
    const restored = await harness.history();
    expect(restored.records.filter((record) => record.info.role === 'user')[1].parts).toEqual([]);
    expect(toolParts(restored).find((part) => part.tool === 'question')?.state.metadata.questionAnswers).toEqual(answers);
    expect(await harness.runtime.questions(harness.directory)).toEqual([]);
  });

  it('keeps a durable open decision when its native index is temporarily missing', async () => {
    const harness = await setup();
    const question = await harness.waiting('decision-plan');
    await harness.restart();
    const index = path.join(path.dirname(harness.directory), 'home', '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    fs.renameSync(index, `${index}.unavailable`);
    await expect(harness.runtime.questions(harness.directory)).rejects.toMatchObject({ code: 'NATIVE_ANTIGRAVITY_HISTORY_UNAVAILABLE' });
    expect(harness.runtime.hasPendingPlanDecision(harness.session.id)).toBe(true);
    fs.renameSync(`${index}.unavailable`, index);
    expect((await harness.runtime.questions(harness.directory))[0].id).toBe(question.id);
  });
  it.each(['plan', 'build'])('preserves a skipped native ask and answers through the same conversation in %s mode', async (agent) => {
    const harness = await setup();
    const { session, directory, selection, requests, idle, history, events } = harness;
    const question = await harness.waiting('decision-questions', agent);
    expect(question.kind).toBeUndefined();
    expect(question.sessionID).toBe(session.id);
    expect(question.questions).toMatchObject([
      { question: 'Which scope should change?', multiple: false },
      { question: 'Which checks should run?', multiple: true },
    ]);
    expect(toolParts(await history())).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'ask_question', state: expect.objectContaining({ output: 'A1: User Skipped\nA2: User Skipped' }) }),
      expect.objectContaining({ tool: 'question', callID: question.tool.callID }),
    ]));
    expect(events.some((event) => event.payload.type === 'question.asked' && event.payload.properties.id === question.id)).toBe(true);
    const answers = [['Current file'], ['Lint', 'Unit tests']];
    await harness.runtime.replyQuestion(question.id, answers);
    await idle();
    expect(await harness.runtime.questions(directory)).toEqual([]);
    const sent = requests();
    expect(sent).toHaveLength(2);
    expect(sent.map(({ conversationId, resumed, cwd, model, mode, effort }) => ({ conversationId, resumed, cwd, model, mode, effort })))
      .toEqual([0, 1].map(() => ({
        conversationId: session.id.slice(4), resumed: session.id.slice(4), cwd: directory,
        model: selection.model.modelID, mode: agent === 'plan' ? 'plan' : 'accept-edits', effort: 'high',
      })));
    expect(sent[1].visible).toBe('');
    expect(sent[1].text).toContain('1. Which scope should change?\n- Current file');
    expect(sent[1].text).toContain('2. Which checks should run?\n- Lint\n- Unit tests');
    const page = await history();
    expect(page.records.filter((record) => record.info.role === 'user').map((record) => record.info.agent)).toEqual([agent, agent]);
    expect(page.records.filter((record) => record.info.role === 'user')[1].parts).toEqual([]);
    expect(toolParts(page).find((part) => part.callID === question.tool.callID)?.state.metadata.questionAnswers).toEqual(answers);
    expect(toolParts(page).find((part) => part.tool === 'ask_question')?.state.output).toContain('User Skipped');
  });

  it('approves a plan through hidden instructions and restores its answer after a runtime restart', async () => {
    const harness = await setup();
    const { session, directory, requests, idle, history } = harness;
    const question = await harness.waiting('decision-plan');
    expect(question.kind).toBe('antigravity-plan-exit');
    expect(question.questions[0].question).toBe('# Fixture implementation plan\n\n1. Preserve the API.\n2. Update the tests.');
    await harness.runtime.replyQuestion(question.id, [['build']]);
    await expect(harness.runtime.replyQuestion(question.id, [['build']])).rejects.toMatchObject({ code: 'NATIVE_QUESTION_NOT_FOUND' });
    await idle();
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toMatchObject({
      conversationId: session.id.slice(4), resumed: session.id.slice(4), mode: 'accept-edits', model: 'gemini-test', effort: 'high',
      visible: '',
    });
    expect(requests()[1].text).toContain('# Fixture implementation plan');
    await harness.restart();
    const page = await history();
    const users = page.records.filter((record) => record.info.role === 'user');
    expect(users.map((record) => record.info.agent)).toEqual(['plan', 'build']);
    expect(users[1].info.model).toMatchObject({ providerID: 'antigravity-native', modelID: 'gemini-test', variant: 'high' });
    expect(users[1].parts).toEqual([]);
    expect(toolParts(page).find((part) => part.tool === 'question' && part.state.metadata?.nativeQuestionKind === 'antigravity-plan-exit')?.state.metadata)
      .toMatchObject({ questionAnswers: [['build']], questionStatus: 'answered' });
    expect(await harness.runtime.questions(directory)).toEqual([]);
    expect(requests()).toHaveLength(2);
  });

  it('keeps planning without sending another prompt or reopening the settled question', async () => {
    const harness = await setup();
    const question = await harness.waiting('decision-plan');
    await harness.runtime.replyQuestion(question.id, [['plan']]);
    expect(harness.requests()).toHaveLength(1);
    expect(await harness.runtime.questions(harness.directory)).toEqual([]);
    const page = await harness.history();
    expect(page.records.filter((record) => record.info.role === 'user').map((record) => record.info.agent)).toEqual(['plan']);
    expect(toolParts(page).find((part) => part.tool === 'question' && part.state.metadata?.nativeQuestionKind === 'antigravity-plan-exit')?.state.metadata.questionAnswers)
      .toEqual([['plan']]);
    expect(await harness.runtime.questions(harness.directory)).toEqual([]);
  });

  it('restores an open decision with the same request after the server restarts without replaying a prompt', async () => {
    const harness = await setup();
    const question = await harness.waiting('decision-plan');
    await harness.restart();
    expect(await harness.runtime.questions(harness.directory)).toEqual([question]);
    expect(harness.requests()).toHaveLength(1);
    expect(harness.runtime.hasPendingPlanDecision(harness.session.id)).toBe(true);
    await harness.runtime.replyQuestion(question.id, [['plan']]);
    expect(await harness.runtime.questions(harness.directory)).toEqual([]);
    expect(harness.requests()).toHaveLength(1);
  });
});
