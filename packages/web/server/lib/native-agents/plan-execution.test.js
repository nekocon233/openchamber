import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { createNativePlanExecution, readNativePlanReference } from './plan-execution.js';
import { createNativeRegistry } from './registry.js';
import { createQuestionRegistry } from './questions.js';
import { NativeAgentError } from './errors.js';
import { NATIVE_BACKENDS } from './ids.js';
import { AGY_PLAN_QUESTION_PREFIX } from './antigravity/interaction-signals.js';

const cleanup = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
const provider = (backend) => `${backend}-native`;
const sessionId = (backend) => backend === 'deepseek'
  ? `ndh_${createHash('sha256').update(randomUUID()).digest('hex')}`
  : `${{ claude: 'ncl', codex: 'ncx', antigravity: 'nag' }[backend]}_${randomUUID()}`;
const choice = (backend, modelID = 'next') => ({ model: { providerID: provider(backend), modelID }, variant: 'high', expectedRevision: 3 });

const setup = async (backend = 'claude', existing = null, restore = false) => {
  const directory = existing?.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-plan-execution-'));
  if (!existing) cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const id = existing?.id ?? sessionId(backend);
  const registry = createNativeRegistry({ filePath: path.join(directory, 'registry.json') });
  if (!existing) await registry.registerSession(id, { backend, nativeId: id, directory, origin: 'openchamber', createdAt: 1 });
  const events = [];
  const calls = [];
  const sent = [];
  let refusal = null;
  let refusalOutcome = 'not-dispatched';
  let confirmed = 'unknown';
  let execution;
  const questions = createQuestionRegistry({
    publish: (_directory, event) => events.push(event),
    executePlan: (...args) => execution.execute(...args),
    onSettled: (request, outcome) => execution.settled(request, outcome),
  });
  const records = [{
    info: { id: 'assistant_plan', role: 'assistant', time: { created: 2 } },
    parts: [{ type: 'tool', tool: 'plan_exit', callID: 'plan_call', state: { input: { plan: '# Approved plan' } } }],
  }];
  execution = createNativePlanExecution({
    registry, questions,
    interactions: { record: async () => { calls.push('record'); } },
    sourceSelection: async () => choice(backend, 'current'),
    validate: async () => { calls.push('validate'); },
    readHistory: async () => records,
    yieldSource: async () => { calls.push('yield'); },
    prompt: async (source, request, signal, approval) => {
      await approval.onDispatched();
      calls.push('prompt');
      sent.push({ source, request, approval });
      signal.throwIfAborted();
      if (refusal) {
        if (refusalOutcome === 'not-dispatched') await approval.onRefused();
        throw refusal;
      }
    },
    confirm: async () => confirmed,
    failed: (_directory, _id, error) => { throw error; },
  });
  if (restore) await execution.restore(directory);
  else void questions.ask({
    directory, sessionID: id, kind: `${backend}-plan-exit`,
    tool: { messageID: 'assistant_plan', callID: 'plan_call' },
    questions: [{ question: '# Approved plan', header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }] }],
    onReply: async (outcome) => { calls.push(outcome.status); },
  });
  const request = questions.list(directory)[0];
  return { id, directory, registry, questions, execution, request, events, calls, sent,
    refuse: (error) => { refusal = error; refusalOutcome = 'not-dispatched'; },
    uncertain: (error) => { refusal = error; refusalOutcome = 'unknown'; },
    confirm: () => { confirmed = 'accepted'; }, notDispatched: () => { confirmed = 'not-dispatched'; } };
};

describe('native plan execution model', () => {
  it('recovers the referenced Antigravity question without its protocol marker', () => {
    const records = [{
      info: { id: 'assistant_plan', role: 'assistant', time: { created: 2 } },
      parts: [{ type: 'tool', tool: 'question', callID: 'agy_plan', state: { input: {
        questions: [{ question: `${AGY_PLAN_QUESTION_PREFIX}# Approved plan` }],
      } } }],
    }];
    expect(readNativePlanReference({ kind: 'antigravity-plan-exit', tool: { messageID: 'assistant_plan', callID: 'agy_plan' } }, records))
      .toEqual({ tool: { messageID: 'assistant_plan', callID: 'agy_plan' }, plan: '# Approved plan' });
    expect(() => readNativePlanReference({ kind: 'antigravity-plan-exit', tool: { messageID: 'assistant_plan', callID: 'missing_plan' } }, records))
      .toThrow('The original plan is unavailable');
  });

  it('keeps the native approval path when the selected model is unchanged', async () => {
    const context = await setup();
    expect(context.request.canSelectExecutionModel).toBe(true);
    await context.questions.reply(context.request.id, [['build']], choice('claude', 'current'));
    expect(context.calls).toEqual(['validate', 'record', 'replied']);
    expect(context.sent).toEqual([]);
  });

  for (const from of NATIVE_BACKENDS) for (const to of NATIVE_BACKENDS) {
    it(`yields ${from} before execution on ${to}`, async () => {
      const context = await setup(from);
      const result = await context.questions.reply(context.request.id, [['build']], choice(to));
      expect(context.calls).toEqual(['validate', 'record', 'transferred', 'yield', 'prompt']);
      expect(context.sent[0].request).toMatchObject({ model: choice(to).model, variant: 'high', agent: 'build', parts: [] });
      expect(context.sent[0].request.instructions).toContain('# Approved plan');
      expect(result.execution).toEqual(choice(to));
      expect((await context.registry.getSession(context.id)).planExecution.phase).toBe('settled');
      expect(context.questions.list(context.directory)).toEqual([]);
    });
  }

  it('retains a failed handoff for retry without letting the original CLI execute', async () => {
    const context = await setup();
    context.refuse(new NativeAgentError('Selected CLI unavailable', { code: 'NATIVE_UNAVAILABLE', status: 503 }));
    await expect(context.questions.reply(context.request.id, [['build']], choice('codex'))).rejects.toThrow('Selected CLI unavailable');
    expect(context.questions.get(context.request.id)).not.toBeNull();
    expect((await context.registry.getSession(context.id)).planExecution.phase).toBe('open');
    context.refuse(null);
    await context.questions.reply(context.request.id, [['build']], choice('codex'));
    expect(context.calls.filter((call) => call === 'transferred')).toHaveLength(1);
    expect(context.calls).not.toContain('replied');
    expect(context.sent[0].request.messageID).toBe(context.sent[1].request.messageID);
  });

  it('confirms an unknown delivery before settling, without sending it again', async () => {
    const context = await setup();
    context.uncertain(new Error('response lost'));
    await expect(context.questions.reply(context.request.id, [['build']], choice('codex'))).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    expect(context.questions.get(context.request.id).executionPending).toEqual(choice('codex'));
    await expect(context.questions.reply(context.request.id, [['build']], choice('codex'))).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    context.confirm();
    await context.questions.reply(context.request.id, [['build']], choice('codex'));
    expect(context.sent).toHaveLength(1);
  });

  it('reopens an unknown approval after its owner confirms rollback, keeping the next model editable', async () => {
    const context = await setup();
    context.uncertain(new Error('response lost'));
    await expect(context.questions.reply(context.request.id, [['build']], choice('codex'))).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    context.notDispatched();
    await expect(context.questions.reply(context.request.id, [['build']], choice('codex'))).rejects.toMatchObject({ code: 'NATIVE_PLAN_EXECUTION_RETRYABLE' });
    expect(context.questions.get(context.request.id).executionPending).toBeUndefined();
    expect((await context.registry.getSession(context.id)).planExecution.phase).toBe('open');
    context.refuse(null);
    await context.questions.reply(context.request.id, [['build']], choice('deepseek'));
    expect(context.sent).toHaveLength(2);
    expect(context.sent[1].request.model.providerID).toBe('deepseek-native');
  });

  it('restores a legacy rolled-back dispatch as an editable approval without sending it', async () => {
    const original = await setup();
    original.uncertain(new Error('response lost'));
    await expect(original.questions.reply(original.request.id, [['build']], choice('codex'))).rejects.toMatchObject({ code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN' });
    const restored = await setup('claude', original);
    restored.questions.withdraw(restored.request.id);
    restored.notDispatched();
    await restored.execution.restore(restored.directory);
    expect(restored.questions.get(original.request.id).executionPending).toBeUndefined();
    expect((await restored.registry.getSession(restored.id)).planExecution.phase).toBe('open');
    expect(restored.sent).toHaveLength(0);
  });

  it('restores a yielded approval from its native plan after a server restart', async () => {
    const original = await setup();
    original.refuse(new NativeAgentError('offline', { code: 'NATIVE_UNAVAILABLE', status: 503 }));
    await expect(original.questions.reply(original.request.id, [['build']], choice('codex'))).rejects.toThrow('offline');
    const restored = await setup('claude', original, true);
    expect(restored.request).toMatchObject({ id: original.request.id, questions: [{ question: '# Approved plan' }] });
    await restored.questions.reply(restored.request.id, [['build']], choice('codex'));
    expect(restored.calls).not.toContain('transferred');
    expect(restored.sent).toHaveLength(1);
  });

  it('keeps planning without applying a model choice after a failed transfer', async () => {
    const context = await setup();
    context.refuse(new NativeAgentError('offline', { code: 'NATIVE_UNAVAILABLE', status: 503 }));
    await expect(context.questions.reply(context.request.id, [['build']], choice('codex'))).rejects.toThrow('offline');
    await context.questions.reply(context.request.id, [['plan']]);
    expect(context.questions.list(context.directory)).toEqual([]);
    expect(context.sent).toHaveLength(1);
    expect((await context.registry.getSession(context.id)).planExecution.phase).toBe('settled');
  });

  it('fails closed on an unreadable execution journal while retaining its native session', async () => {
    const context = await setup();
    await context.registry.updateSession(context.id, { planExecution: { phase: 'dispatching', missing: true } });
    expect((await context.registry.getSession(context.id)).planExecution).toEqual({ phase: 'unavailable' });
    await expect(context.questions.reply(context.request.id, [['build']], choice('codex'))).rejects.toMatchObject({ code: 'NATIVE_PLAN_EXECUTION_UNAVAILABLE' });
    expect(context.sent).toEqual([]);
    expect(context.registry.hasPendingPlanExecution(context.id)).toBe(true);
  });
});
