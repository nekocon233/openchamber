import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError, invalidRequestError } from './errors.js';
import { newNativeClientUserMessageId } from './ids.js';
import { AGY_PLAN_QUESTION_PREFIX } from './antigravity/interaction-signals.js';

export const planExecutionChoiceSchema = z.object({
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
  variant: z.string().min(1).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();
/** @typedef {z.infer<typeof planExecutionChoiceSchema>} PlanExecutionChoice */

const requestIdentity = z.object({
  id: z.string().min(1), sessionID: z.string().min(1),
  kind: z.enum(['claude-plan-exit', 'codex-plan-exit', 'deepseek-plan-exit', 'antigravity-plan-exit']),
  tool: z.object({ messageID: z.string().min(1), callID: z.string().min(1) }),
});
export const planExecutionStateSchema = z.object({
  request: requestIdentity,
  source: planExecutionChoiceSchema,
  execution: planExecutionChoiceSchema,
  phase: z.enum(['open', 'preparing', 'dispatching', 'settled']),
  messageID: z.string().min(1),
  logicalMessageID: z.string().min(1),
}).or(z.object({ phase: z.literal('unavailable') }));
const planInput = z.object({ plan: z.string().optional() });
const questionInput = z.object({ questions: z.array(z.object({ question: z.string() })) });
const errorCode = z.object({ code: z.string() });
const sameModel = (left, right) => left.model.providerID === right.model.providerID
  && left.model.modelID === right.model.modelID && left.variant === right.variant;
const unavailable = () => new NativeAgentError('The original plan is unavailable. Reload the conversation before retrying.', {
  status: 409, code: 'NATIVE_PLAN_EXECUTION_UNAVAILABLE',
});
const unknown = () => new NativeAgentError('The plan execution may have been accepted. Check its history before retrying.', {
  status: 409, code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN',
});

/** Plan bodies stay in native histories; only their call identity is retained. */
export const readNativePlanReference = (request, records) => {
  const explicit = records.flatMap((record) => record.parts.filter((part) => part.type === 'tool' && (
    part.tool === 'plan_exit' || request.tool && part.callID === request.tool.callID && part.tool === 'question'
  ))
    .map((part) => ({ record, part })));
  const reference = request.tool
    ? explicit.find(({ part }) => part.callID === request.tool.callID)
    : explicit.findLast(({ record }) => {
      const lastUser = records.findLast((entry) => entry.info.role === 'user');
      return !lastUser || record.info.time.created >= lastUser.info.time.created;
    });
  if (!reference) throw unavailable();
  let plan = planInput.safeParse(reference.part.state.input).data?.plan
    ?? questionInput.safeParse(reference.part.state.input).data?.questions[0]?.question ?? '';
  if (request.kind === 'antigravity-plan-exit' && plan.startsWith(AGY_PLAN_QUESTION_PREFIX)) plan = plan.slice(AGY_PLAN_QUESTION_PREFIX.length);
  return {
    tool: { messageID: reference.record.info.id, callID: reference.part.callID },
    plan,
  };
};

/** Owns model-changing approvals after the original CLI has yielded its turn. */
export const createNativePlanExecution = ({
  registry, questions, interactions, sourceSelection, validate, readHistory,
  yieldSource, prompt, confirm, failed,
}) => {
  const active = new Map();
  let closed = false;
  const save = async (sessionId, state) => {
    if (!await registry.updateSession(sessionId, { planExecution: state })) throw unavailable();
    return state;
  };

  const execute = async (context, outcome, actions) => {
    const { request, directory } = context;
    if (outcome.answers.length !== 1 || outcome.answers[0].length !== 1 || !outcome.answers[0][0].trim()) throw invalidRequestError('Choose a plan action or provide feedback');
    let state = (await registry.getSession(request.sessionID))?.planExecution;
    if (state?.phase === 'unavailable') throw unavailable();
    if (state?.request.id !== request.id) state = null;
    if (closed) throw new NativeAgentError('Native plan execution is shutting down', { status: 503, code: 'NATIVE_UNAVAILABLE' });
    const approves = outcome.answers.length === 1 && outcome.answers[0].length === 1 && outcome.answers[0][0] === 'build';
    if (state?.phase === 'dispatching') {
      if (!outcome.execution || !sameModel(state.execution, outcome.execution) || !await confirm(request.sessionID, directory, state)) throw unknown();
      await save(request.sessionID, { ...state, phase: 'settled' });
      return { execution: state.execution };
    }
    if (!approves && outcome.answers.length === 1 && outcome.answers[0].length === 1 && outcome.answers[0][0] === 'plan') {
      if (state) await save(request.sessionID, { ...state, phase: 'settled' });
      return;
    }
    if (!approves && !context.transferred) throw invalidRequestError('An execution model requires approval');
    const source = state?.source ?? planExecutionChoiceSchema.parse(await sourceSelection(request.sessionID, directory));
    const execution = approves ? planExecutionChoiceSchema.parse(outcome.execution) : source;
    const handoff = context.transferred || Boolean(state) || !sameModel(source, execution);
    await validate(request.sessionID, directory, request.id, execution, handoff, approves);
    if (actions.isCurrent && !actions.isCurrent()) throw new NativeAgentError('The plan approval is no longer pending', { status: 404, code: 'NATIVE_QUESTION_NOT_FOUND' });
    if (!handoff) {
      await interactions.record(request, outcome);
      await actions.deliver();
      return { execution };
    }
    const history = await readHistory(request.sessionID, directory, request);
    const reference = readNativePlanReference(request, history);
    actions.link?.(reference.tool);
    const identity = requestIdentity.parse({ ...request, tool: reference.tool });
    const fresh = !state || !sameModel(state.execution, execution);
    const controller = new AbortController();
    active.set(request.sessionID, controller);
    try {
      if (actions.isCurrent && !actions.isCurrent()) throw new NativeAgentError('The plan approval is no longer pending', { status: 404, code: 'NATIVE_QUESTION_NOT_FOUND' });
      state = await save(request.sessionID, {
        request: identity, source, execution, phase: 'preparing',
        messageID: fresh ? newNativeClientUserMessageId(request.sessionID) : state.messageID,
        logicalMessageID: fresh ? `ncv_u_${randomUUID()}` : state.logicalMessageID,
      });
    } catch (error) { active.delete(request.sessionID); throw error; }
    let dispatched = false;
    try {
      controller.signal.throwIfAborted();
      if (actions.isCurrent && !actions.isCurrent()) throw new NativeAgentError('The plan approval is no longer pending', { status: 404, code: 'NATIVE_QUESTION_NOT_FOUND' });
      await interactions.record(request, outcome);
      await actions.transfer();
      await yieldSource(request.sessionID, directory, controller.signal);
      controller.signal.throwIfAborted();
      const continuation = {
        directory, messageID: state.messageID,
        parts: approves ? [] : [{ type: 'text', text: outcome.answers[0][0] }],
        model: execution.model, variant: execution.variant, agent: approves ? 'build' : 'plan',
        preserveSelection: true,
      };
      if (approves) continuation.instructions = [
        'The user approved the plan in this conversation. Implement that approved plan using the selected model.',
        request.questions[0]?.question || reference.plan,
      ].filter(Boolean).join('\n\n');
      await prompt(request.sessionID, continuation, controller.signal, {
        requestId: request.id, logicalMessageId: state.logicalMessageID,
        expectedRevision: approves ? execution.expectedRevision : undefined,
        onDispatched: async () => {
          if (dispatched) return;
          controller.signal.throwIfAborted();
          state = await save(request.sessionID, { ...state, phase: 'dispatching' });
          dispatched = true;
        },
      });
      await save(request.sessionID, { ...state, phase: 'settled' });
      return approves ? { execution } : undefined;
    } catch (error) {
      const code = errorCode.safeParse(error).data?.code;
      const uncertain = dispatched && (!code || code.endsWith('_UNKNOWN'));
      const cancelled = !closed && controller.signal.aborted || actions.isCurrent && !actions.isCurrent();
      try { await save(request.sessionID, { ...state, phase: uncertain ? 'dispatching' : cancelled ? 'settled' : 'open' }); }
      catch { actions.pending(execution); throw unknown(); }
      if (uncertain) { actions.pending(execution); throw unknown(); }
      throw error;
    } finally {
      if (active.get(request.sessionID) === controller) active.delete(request.sessionID);
    }
  };

  return {
    execute,
    async restore(directory) {
      for (const entry of await registry.listSessions({ directory })) {
        const state = entry.planExecution;
        if (state?.phase === 'unavailable') { failed(directory, entry.sessionId, unavailable()); continue; }
        if (!state || state.phase === 'settled' || active.has(entry.sessionId)) continue;
        try {
          if (state.phase === 'preparing') await save(entry.sessionId, { ...state, phase: 'open' });
          if (questions.get(state.request.id)) continue;
          const records = await readHistory(entry.sessionId, directory, state.request);
          const reference = readNativePlanReference(state.request, records);
          const input = {
            ...state.request, directory, transferred: true,
            questions: [{ question: reference.plan, header: 'Plan', options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }], multiple: false }],
          };
          if (state.phase === 'dispatching') input.executionPending = state.execution;
          void questions.ask(input).catch((error) => failed(directory, entry.sessionId, error));
        } catch (error) { failed(directory, entry.sessionId, error); }
      }
    },
    async beforePrompt(sessionId, messageId) {
      const state = (await registry.getSession(sessionId))?.planExecution;
      if (state?.phase === 'unavailable') throw unavailable();
      if (!state || state.phase === 'settled' || state.messageID === messageId) return;
      if (state.phase === 'dispatching') throw unknown();
      if (state.phase === 'preparing') throw new NativeAgentError('The approved plan is preparing execution', { status: 409, code: 'NATIVE_SESSION_BUSY' });
      await save(sessionId, { ...state, phase: 'settled' });
      questions.withdraw(state.request.id, { status: 'rejected' });
    },
    async settled(request, outcome) {
      if (outcome.status !== 'rejected') return;
      active.get(request.sessionID)?.abort(new Error('Plan execution cancelled'));
      if (active.has(request.sessionID)) return;
      const state = (await registry.getSession(request.sessionID))?.planExecution;
      if (state?.phase === 'unavailable') return;
      if (state?.request.id === request.id && state.phase !== 'dispatching') await save(request.sessionID, { ...state, phase: 'settled' });
    },
    async cancel(sessionId) {
      const controller = active.get(sessionId);
      controller?.abort(new Error('Plan execution cancelled'));
      const state = (await registry.getSession(sessionId))?.planExecution;
      if (state?.phase === 'unavailable') return false;
      if (!state || state.phase === 'settled') return Boolean(controller);
      if (!controller && state.phase !== 'dispatching') await save(sessionId, { ...state, phase: 'settled' });
      if (questions.get(state.request.id)) await questions.reject(state.request.id);
      return true;
    },
    async shutdown() {
      closed = true;
      for (const controller of active.values()) controller.abort(new Error('Native plan execution is shutting down'));
    },
  };
};
