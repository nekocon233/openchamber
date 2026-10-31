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
  const session = await runtime.createSession({ backend: 'antigravity', directory, title: 'Decision runtime fixture' });
  const selection = { model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, variant: 'high', agent: 'plan' };
  const requests = () => fs.existsSync(requestPath)
    ? fs.readFileSync(requestPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const idle = () => vi.waitFor(async () => expect(await runtime.statuses(directory)).toEqual({}));
  const history = () => runtime.loadMessages(session.id, directory, { limit: 50 });
  const prompt = async (text, agent = 'plan') => {
    const messageID = `nag_u_${randomUUID()}`;
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
    expect(sent[1].visible).toContain('1. Which scope should change?\n- Current file');
    expect(sent[1].visible).toContain('2. Which checks should run?\n- Lint\n- Unit tests');
    const page = await history();
    expect(page.records.filter((record) => record.info.role === 'user').map((record) => record.info.agent)).toEqual([agent, agent]);
    expect(toolParts(page).find((part) => part.callID === question.tool.callID)?.state.metadata.questionAnswers).toEqual(answers);
    expect(toolParts(page).find((part) => part.tool === 'ask_question')?.state.output).toContain('User Skipped');
  });

  it('approves a plan with one recorded Build prompt and restores its answer after a runtime restart', async () => {
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
      visible: 'Implement the plan.',
    });
    expect(requests()[1].text).toContain('# Fixture implementation plan');
    await harness.restart();
    const page = await history();
    const users = page.records.filter((record) => record.info.role === 'user');
    expect(users.map((record) => record.info.agent)).toEqual(['plan', 'build']);
    expect(users[1].info.model).toMatchObject({ providerID: 'antigravity-native', modelID: 'gemini-test', variant: 'high' });
    expect(users[1].parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual(['Implement the plan.']);
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
