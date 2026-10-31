import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeAgentError } from '../errors.js';
import { createNativeInteractions } from '../interactions.js';
import { createQuestionRegistry } from '../questions.js';
import { createNativeRegistry } from '../registry.js';
import { createAntigravityDecisions } from './decisions.js';

const DIRECTORY = '/workspace/project';
const SESSION = 'nag_01a0d2a6-b55b-7162-a837-c62053537e00';
const PROPOSAL = {
  sessionId: SESSION, directory: DIRECTORY, userStep: 0, callID: 'native-question-2', revision: 'revision-one',
  tool: { messageID: 'native-assistant-1', callID: 'native-question-2' },
  questions: [
    { question: 'Which checks should run?', header: 'Checks', multiple: true, options: [{ label: 'Unit', description: '' }, { label: 'Build', description: '' }] },
    { question: 'What should stay compatible?', header: 'Compatibility', options: [{ label: 'API', description: '' }] },
  ],
  send: { modelID: 'gemini-model', variant: 'high', agent: 'plan' },
};
const PLAN = {
  ...PROPOSAL, callID: 'native-plan-2', kind: 'antigravity-plan-exit', plan: 'Add a test, then fix the parser.',
  tool: { messageID: 'native-assistant-1', callID: 'native-plan-2' },
  questions: [{ question: 'Add a test, then fix the parser.', header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }], multiple: false }],
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const roots = [];
const engines = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.shutdown()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const harness = async (proposal = PROPOSAL) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-decisions-'));
  roots.push(root);
  const registryPath = path.join(root, 'registry.json');
  const registry = createNativeRegistry({ filePath: registryPath });
  await registry.registerSession(SESSION, { backend: 'antigravity', nativeId: SESSION.slice(4), directory: DIRECTORY, origin: 'openchamber', createdAt: 1 });
  const source = { proposal, error: null, wait: null, reads: 0 };
  const deliveries = [];
  const failures = [];
  const events = [];
  const interactionPath = path.join(root, 'native-agents', 'interactions', `${SESSION}.json`);
  const readAnswers = async () => JSON.parse(await fs.readFile(interactionPath, 'utf8')).answers;
  const controls = { prompt: async () => {}, save: null };
  const create = (storage = registry) => {
    const questions = createQuestionRegistry({ publish: (_directory, event) => events.push(event) });
    const engine = createAntigravityDecisions({
      registry: { ...storage, updateSession: (sessionId, patch) => controls.save ? controls.save(sessionId, patch) : storage.updateSession(sessionId, patch) },
      interactions: createNativeInteractions({ dataDir: root, now: () => 3 }), questions,
      loadProposal: async () => {
        source.reads += 1;
        if (source.wait) await source.wait;
        if (source.error) throw source.error;
        return source.proposal;
      },
      prompt: async (sessionId, request, signal) => {
        // Production prompt admission re-enters this hook. It must not wait
        // on the lane currently delivering the same generated message.
        await engine.beforePrompt(sessionId, request.messageID);
        const state = (await storage.getSession(sessionId)).antigravityInteraction;
        deliveries.push({ sessionId, request, state, answers: await readAnswers() });
        await controls.prompt(signal, request);
      },
      failed: (context, error) => failures.push({ context, error }),
    });
    engines.push(engine);
    return { engine, questions };
  };
  const owner = create();
  await owner.engine.propose(proposal);
  return { ...owner, registry, registryPath, root, source, controls, deliveries, failures, events, create, readAnswers, interactionPath };
};

describe('Antigravity application decisions', () => {
  it('stores exact multi-select/custom answers before continuing the same session with its captured configuration', async () => {
    const h = await harness();
    const [question] = h.questions.list(DIRECTORY);
    await h.engine.propose(PROPOSAL);
    expect(h.questions.list(DIRECTORY)).toEqual([question]);
    await h.questions.reply(question.id, [['Unit', 'A custom check'], ['Keep the older API.\nAlso keep CLI output.']]);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]).toMatchObject({
      sessionId: SESSION, state: { phase: 'dispatching', requestId: question.id },
      answers: [{ answers: [['Unit', 'A custom check'], ['Keep the older API.\nAlso keep CLI output.']], status: 'answered' }],
      request: {
        messageID: expect.stringMatching(/^nag_u_[0-9a-f-]{36}$/), directory: DIRECTORY,
        model: { providerID: 'antigravity-native', modelID: 'gemini-model' }, variant: 'high', agent: 'plan',
      },
    });
    expect(h.deliveries[0].request.parts[0].text).toContain('1. Which checks should run?\n- Unit\n- A custom check');
    expect(h.deliveries[0].request.parts[0].text).toContain('2. What should stay compatible?');
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('settled');
    expect(h.engine.has(SESSION)).toBe(false);
    expect(h.questions.list(DIRECTORY)).toEqual([]);
  });

  it('approves only the exact Build choice and binds the approved plan text', async () => {
    const h = await harness(PLAN);
    const [question] = h.questions.list(DIRECTORY);
    expect(question.kind).toBe('antigravity-plan-exit');
    await h.questions.reply(question.id, [['build']]);
    expect(h.deliveries[0].request).toMatchObject({
      agent: 'build', variant: 'high', model: { providerID: 'antigravity-native', modelID: PLAN.send.modelID },
      parts: [], instructions: expect.stringContaining(PLAN.plan),
    });
    expect(() => h.questions.reply(question.id, [['build']])).toThrow('No pending native question');
    await h.engine.propose(PLAN);
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect(h.deliveries).toHaveLength(1);
  });

  it('continues planning without sending a prompt when Plan is chosen', async () => {
    const h = await harness(PLAN);
    await h.questions.reply(h.questions.list(DIRECTORY)[0].id, [['plan']]);
    expect(h.deliveries).toEqual([]);
    expect((await h.readAnswers())[0]).toMatchObject({ answers: [['plan']], kind: 'antigravity-plan-exit' });
    await h.engine.shutdown();
    const reopened = h.create(createNativeRegistry({ filePath: h.registryPath }));
    await reopened.engine.restore(DIRECTORY);
    await reopened.engine.propose(PLAN);
    expect(reopened.questions.list(DIRECTORY)).toEqual([]);
  });

  it('delivers plan feedback as a new Plan message', async () => {
    const h = await harness(PLAN);
    await h.questions.reply(h.questions.list(DIRECTORY)[0].id, [['build after covering malformed input']]);
    expect(h.deliveries[0].request).toMatchObject({ agent: 'plan', parts: [{ type: 'text', text: 'build after covering malformed input' }] });
    expect(h.deliveries[0].request.instructions).toBeUndefined();
  });

  it('keeps ordinary answers in Build when the source turn used Build', async () => {
    const h = await harness({ ...PROPOSAL, send: { ...PROPOSAL.send, agent: 'build' } });
    await h.questions.reply(h.questions.list(DIRECTORY)[0].id, [['Unit'], ['API']]);
    expect(h.deliveries[0].request.agent).toBe('build');
  });

  it('persists a dismissed decision without sending or reviving its card', async () => {
    const h = await harness(PLAN);
    const id = h.questions.list(DIRECTORY)[0].id;
    await h.questions.reject(id);
    expect((await h.readAnswers())[0]).toMatchObject({ id, answers: [], status: 'dismissed' });
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('settled');
    await h.engine.propose(PLAN);
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect(h.deliveries).toEqual([]);
  });

  it.each([[], [[]], [['']], [['  ']], [['build', 'plan']], [['build'], ['plan']]].map((answers) => ({ answers })))('keeps invalid plan selections retryable: $answers', async ({ answers }) => {
    const h = await harness(PLAN);
    const [question] = h.questions.list(DIRECTORY);
    await expect(h.questions.reply(question.id, answers)).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    expect(h.questions.list(DIRECTORY)).toEqual([question]);
    expect(h.deliveries).toEqual([]);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('open');
  });

  it('refuses empty answers, repeated choices and multiple answers to a single-choice question', async () => {
    const h = await harness();
    const [question] = h.questions.list(DIRECTORY);
    for (const answers of [[[], ['API']], [['Unit', 'Unit'], ['API']], [['Unit'], ['API', 'Custom']]]) {
      await expect(h.questions.reply(question.id, answers)).rejects.toMatchObject({ code: 'NATIVE_INVALID_REQUEST' });
    }
    expect(h.deliveries).toEqual([]);
  });

  it('serializes duplicate approvals while delivery is in flight', async () => {
    const h = await harness(PLAN);
    const hold = deferred();
    h.controls.prompt = () => hold.promise;
    const id = h.questions.list(DIRECTORY)[0].id;
    const reply = h.questions.reply(id, [['build']]);
    await vi.waitFor(() => expect(h.deliveries).toHaveLength(1));
    expect(() => h.questions.reply(id, [['build']])).toThrow('being delivered');
    hold.resolve();
    await reply;
    expect(h.deliveries).toHaveLength(1);
  });

  it('acknowledges the current reply before offering a new question from an immediately completed follow-up', async () => {
    const h = await harness(PLAN);
    const id = h.questions.list(DIRECTORY)[0].id;
    let nextProposal;
    h.controls.prompt = async () => {
      h.source.proposal = { ...PLAN, userStep: 4, callID: 'next-plan', revision: 'next-revision' };
      nextProposal = h.engine.propose(h.source.proposal);
    };
    await h.questions.reply(id, [['build']]);
    await nextProposal;
    expect(h.deliveries).toHaveLength(1);
    const [next] = h.questions.list(DIRECTORY);
    expect(next.id).not.toBe(id);
    expect(h.engine.has(SESSION)).toBe(true);
    expect(h.events.filter((event) => event.properties.requestID === id)).toEqual([
      { type: 'question.replied', properties: { sessionID: SESSION, requestID: id, answers: [['build']] } },
    ]);
    expect((await h.readAnswers())[0]).toMatchObject({ id, status: 'answered', answers: [['build']] });
  });

  it('reopens a failed admission and reuses its stable generated message ID on explicit retry', async () => {
    const h = await harness(PLAN);
    h.controls.prompt = async () => { throw new NativeAgentError('Native session is busy', { code: 'NATIVE_SESSION_BUSY', status: 409 }); };
    const id = h.questions.list(DIRECTORY)[0].id;
    await expect(h.questions.reply(id, [['build']])).rejects.toMatchObject({ code: 'NATIVE_SESSION_BUSY' });
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('open');
    expect(h.questions.list(DIRECTORY)[0].id).toBe(id);
    h.controls.prompt = async () => {};
    await h.questions.reply(id, [['build']]);
    expect(h.deliveries).toHaveLength(2);
    expect(h.deliveries[1].request.messageID).toBe(h.deliveries[0].request.messageID);
    expect(h.failures).toHaveLength(1);
  });

  it('does not send when the human answer could not be saved', async () => {
    const h = await harness(PLAN);
    await fs.mkdir(h.interactionPath, { recursive: true });
    const id = h.questions.list(DIRECTORY)[0].id;
    await expect(h.questions.reply(id, [['build']])).rejects.toThrow();
    expect(h.deliveries).toEqual([]);
    expect(h.questions.list(DIRECTORY)[0].id).toBe(id);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('open');
  });

  it('does not send before its durable dispatching marker was saved', async () => {
    const h = await harness(PLAN);
    h.controls.save = async () => { throw new Error('Registry unavailable'); };
    const id = h.questions.list(DIRECTORY)[0].id;
    await expect(h.questions.reply(id, [['build']])).rejects.toThrow('Registry unavailable');
    expect(h.deliveries).toEqual([]);
    expect((await h.readAnswers())[0].answers).toEqual([['build']]);
    expect(h.questions.list(DIRECTORY)[0].id).toBe(id);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('open');
  });

  it('retains unknown dispatches across restarts without rebuilding a clickable request or replaying', async () => {
    const h = await harness(PLAN);
    h.controls.prompt = async () => { throw new NativeAgentError('Response lost', { code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN', status: 409 }); };
    const id = h.questions.list(DIRECTORY)[0].id;
    await expect(h.questions.reply(id, [['build']])).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ type: 'question.replied', properties: { requestID: id, answers: [['build']] } });
    expect(h.engine.has(SESSION)).toBe(true);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('dispatching');
    h.source.proposal = { ...PLAN, userStep: 4, callID: 'later-plan', revision: 'later-revision' };
    await h.engine.propose(h.source.proposal);
    await h.engine.propose(h.source.proposal);
    expect(h.failures).toHaveLength(1);
    await h.engine.shutdown();
    const reopened = h.create(createNativeRegistry({ filePath: h.registryPath }));
    await reopened.engine.restore(DIRECTORY);
    await reopened.engine.restore(DIRECTORY);
    await reopened.engine.propose(PLAN);
    expect(reopened.engine.has(SESSION)).toBe(true);
    expect(reopened.questions.list(DIRECTORY)).toEqual([]);
    expect(h.deliveries).toHaveLength(1);
    expect(h.failures).toHaveLength(2);
  });

  it('keeps dispatching durable when acceptance succeeded but final settlement could not be saved', async () => {
    const h = await harness(PLAN);
    h.controls.save = async (sessionId, patch) => {
      if (patch.antigravityInteraction.phase === 'settled') throw new Error('Disk unavailable');
      return h.registry.updateSession(sessionId, patch);
    };
    await expect(h.questions.reply(h.questions.list(DIRECTORY)[0].id, [['build']])).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect(h.engine.has(SESSION)).toBe(true);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('dispatching');
    expect(h.deliveries).toHaveLength(1);
  });

  it('withdraws an unsafe retry if its open-state rollback could not be saved', async () => {
    const h = await harness(PLAN);
    h.controls.prompt = async () => { throw new Error('Native admission failed'); };
    h.controls.save = async (sessionId, patch) => {
      if (patch.antigravityInteraction.phase === 'open') throw new Error('Disk unavailable');
      return h.registry.updateSession(sessionId, patch);
    };
    await expect(h.questions.reply(h.questions.list(DIRECTORY)[0].id, [['build']])).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect(h.engine.has(SESSION)).toBe(true);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('dispatching');
  });

  it('restores an open question with the same ID after shutdown without recording rejection', async () => {
    const h = await harness(PLAN);
    const [question] = h.questions.list(DIRECTORY);
    await h.engine.shutdown();
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('open');
    await expect(fs.stat(h.interactionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = h.create(createNativeRegistry({ filePath: h.registryPath }));
    await reopened.engine.restore(DIRECTORY);
    expect(reopened.questions.list(DIRECTORY)).toEqual([question]);
    await reopened.questions.reply(question.id, [['build']]);
    expect(h.deliveries).toHaveLength(1);
  });

  it('does not reread native history for repeated snapshots of the same live pending decision', async () => {
    const h = await harness(PLAN);
    for (let count = 0; count < 5; count += 1) await h.engine.restore(DIRECTORY);
    expect(h.source.reads).toBe(0);
    await h.engine.shutdown();
    const reopened = h.create(createNativeRegistry({ filePath: h.registryPath }));
    await reopened.engine.restore(DIRECTORY);
    expect(h.source.reads).toBe(1);
    await reopened.engine.restore(DIRECTORY);
    expect(h.source.reads).toBe(1);
    await reopened.questions.reply(reopened.questions.list(DIRECTORY)[0].id, [['build']]);
    expect(h.source.reads).toBe(2);
  });

  it('preserves pending metadata when authoritative restore fails', async () => {
    const h = await harness(PLAN);
    await h.engine.shutdown();
    h.source.error = new Error('Native transcript unavailable');
    const reopened = h.create();
    await expect(reopened.engine.restore(DIRECTORY)).rejects.toThrow('Native transcript unavailable');
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('open');
    expect(h.deliveries).toEqual([]);
  });

  it('refuses a late answer after the authoritative native source changed', async () => {
    const h = await harness(PLAN);
    const old = h.questions.list(DIRECTORY)[0];
    h.source.proposal = { ...PLAN, revision: 'revision-two', plan: 'Revised plan' };
    await expect(h.questions.reply(old.id, [['build']])).rejects.toMatchObject({ code: 'NATIVE_QUESTION_NOT_FOUND' });
    expect(h.deliveries).toEqual([]);
    await h.engine.propose(h.source.proposal);
    const current = h.questions.list(DIRECTORY)[0];
    expect(current.id).not.toBe(old.id);
    await h.questions.reply(current.id, [['build']]);
    expect(h.deliveries[0].request.instructions).toContain('Revised plan');
  });

  it('cancels before an in-flight source revalidation can approve and suppresses stale proposals', async () => {
    const h = await harness(PLAN);
    const hold = deferred();
    h.source.wait = hold.promise;
    const id = h.questions.list(DIRECTORY)[0].id;
    const reply = h.questions.reply(id, [['build']]);
    await Promise.resolve();
    const cancelled = h.engine.beforePrompt(SESSION, 'nag_u_manual-message');
    const rejected = expect(reply).rejects.toThrow();
    hold.resolve();
    await cancelled;
    await rejected;
    h.source.wait = null;
    await h.engine.propose(PLAN);
    expect(h.deliveries).toEqual([]);
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect(h.engine.has(SESSION)).toBe(false);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('settled');
  });

  it('allows a new native user turn after a manual message cancelled the previous decision', async () => {
    const h = await harness(PLAN);
    await h.engine.beforePrompt(SESSION, 'nag_u_manual-message');
    h.source.proposal = { ...PLAN, userStep: 4, callID: 'new-plan', revision: 'new-turn' };
    await h.engine.propose(h.source.proposal);
    expect(h.questions.list(DIRECTORY)).toHaveLength(1);
    expect(h.engine.has(SESSION)).toBe(true);
  });

  it('keeps a newer native user turn when an older proposal arrives late', async () => {
    const h = await harness(PLAN);
    h.source.proposal = { ...PLAN, userStep: 4, callID: 'new-plan', revision: 'new-turn' };
    await h.engine.propose(h.source.proposal);
    const [newer] = h.questions.list(DIRECTORY);
    await h.engine.propose(PLAN);
    expect(h.questions.list(DIRECTORY)).toEqual([newer]);
    await h.questions.reply(newer.id, [['build']]);
    expect(h.deliveries).toHaveLength(1);
  });

  it('revalidates competing revisions against the native source before replacing the card', async () => {
    const h = await harness(PLAN);
    h.source.proposal = { ...PLAN, revision: 'revision-two', plan: 'Authoritative plan' };
    await h.engine.propose(h.source.proposal);
    await h.engine.propose(PLAN);
    expect(h.questions.list(DIRECTORY)).toHaveLength(1);
    await h.questions.reply(h.questions.list(DIRECTORY)[0].id, [['build']]);
    expect(h.deliveries[0].request.instructions).toContain('Authoritative plan');
  });

  it('cancels a proposal that was still saving when a manual message arrived', async () => {
    const h = await harness(PLAN);
    await h.engine.beforePrompt(SESSION, 'nag_u_first-manual-message');
    h.source.proposal = { ...PLAN, userStep: 4, callID: 'new-plan', revision: 'new-turn' };
    const hold = deferred();
    h.controls.save = async (sessionId, patch) => {
      if (patch.antigravityInteraction.phase === 'open') await hold.promise;
      return h.registry.updateSession(sessionId, patch);
    };
    const proposed = h.engine.propose(h.source.proposal);
    await Promise.resolve();
    const cancelled = h.engine.beforePrompt(SESSION, 'nag_u_second-manual-message');
    hold.resolve();
    await proposed;
    await cancelled;
    expect(h.questions.list(DIRECTORY)).toEqual([]);
    expect(h.engine.has(SESSION)).toBe(false);
    expect((await h.registry.getSession(SESSION)).antigravityInteraction.phase).toBe('settled');
  });
});
