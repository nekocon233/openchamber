// Headless agy has no question-reply channel. These decisions continue its
// conversation through the ordinary prompt owner after a completed turn.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError } from '../errors.js';
import { NATIVE_PROVIDER_ANTIGRAVITY, newNativeClientUserMessageId } from '../ids.js';

/** @typedef {{ sessionId: string, directory: string, userStep: number, callID: string, revision: string, tool: { messageID: string, callID: string }, kind?: 'antigravity-plan-exit', questions: import('../questions.js').QuestionInfo[], plan?: string, send: { modelID: string, variant?: string, agent: 'build' | 'plan' } }} AntigravityProposal */
/** @typedef {{ callID: string, userStep: number, revision: string, requestId: string, phase: 'open' | 'dispatching' | 'settled', replyMessageId?: string }} DecisionState */
/** @typedef {{ sessionId: string, directory: string }} DecisionContext */
/** @typedef {{ context: DecisionContext, proposal?: AntigravityProposal, state: DecisionState, controller: AbortController, dispatchingMessageId?: string }} Decision */

const answersSchema = z.array(z.array(z.string().refine((answer) => answer.trim().length > 0)));
const errorCode = z.object({ code: z.string() });
const sameSource = (left, right) => left.callID === right.callID && left.userStep === right.userStep && left.revision === right.revision;
const staleQuestion = () => new NativeAgentError('The Antigravity decision has been superseded', { code: 'NATIVE_QUESTION_NOT_FOUND', status: 404 });
const unknownDispatch = () => new NativeAgentError(
  'The Antigravity reply may have been accepted. Check the conversation before sending another message.',
  { code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN', status: 409 },
);

const validateAnswers = (proposal, answers) => {
  const parsed = answersSchema.safeParse(answers);
  if (!parsed.success || parsed.data.length !== proposal.questions.length || parsed.data.some((selected, index) => (
    selected.length === 0 || new Set(selected).size !== selected.length || !proposal.questions[index].multiple && selected.length !== 1
  ))) {
    throw new NativeAgentError('Answer every Antigravity question with a nonempty selection', { code: 'NATIVE_INVALID_REQUEST', status: 400 });
  }
  return parsed.data;
};

const continuation = (proposal, answers, messageID) => {
  const plan = proposal.kind === 'antigravity-plan-exit';
  const selected = plan && answers.length === 1 && answers[0].length === 1 ? answers[0][0] : null;
  if (plan && selected === 'plan') return null;
  const approved = plan && selected === 'build';
  const request = {
    directory: proposal.directory,
    messageID,
    parts: [{ type: 'text', text: approved ? 'Implement the plan.' : plan ? answers[0][0] : [
      'My answers to your questions, in order:',
      ...proposal.questions.map((question, index) => `${index + 1}. ${question.question}\n${answers[index].map((answer) => `- ${answer}`).join('\n')}`),
    ].join('\n\n') }],
    model: { providerID: NATIVE_PROVIDER_ANTIGRAVITY, modelID: proposal.send.modelID },
    variant: proposal.send.variant,
    agent: plan ? approved ? 'build' : 'plan' : proposal.send.agent,
  };
  if (approved) request.instructions = `The user approved this exact plan. Implement it in this conversation:\n\n${proposal.plan ?? proposal.questions[0].question}`;
  return request;
};

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../registry.js').createNativeRegistry>} options.registry
 * @param {ReturnType<typeof import('../questions.js').createQuestionRegistry>} options.questions
 * @param {ReturnType<typeof import('../interactions.js').createNativeInteractions>} options.interactions
 * @param {(sessionId: string, directory: string) => Promise<AntigravityProposal | null>} options.loadProposal
 * @param {(sessionId: string, request: import('../runtime.js').PromptRequest & { instructions?: string }, signal: AbortSignal) => Promise<void>} options.prompt
 * @param {(context: DecisionContext, error: Error) => void} options.failed
 */
export const createAntigravityDecisions = ({ registry, questions, interactions, loadProposal, prompt, failed }) => {
  /** @type {Map<string, Decision>} */
  const pending = new Map();
  /** @type {Map<string, Promise<void>>} */
  const lanes = new Map();
  const generations = new Map();
  const suppressed = new Map();
  let closed = false;

  const serial = (sessionId, work) => {
    const run = (lanes.get(sessionId) ?? Promise.resolve()).then(work);
    const settled = run.then(() => undefined, () => undefined);
    lanes.set(sessionId, settled);
    void settled.then(() => { if (lanes.get(sessionId) === settled) lanes.delete(sessionId); });
    return run;
  };

  const save = async (decision, phase, replyMessageId = decision.state.replyMessageId) => {
    const state = { ...decision.state, phase };
    if (replyMessageId) state.replyMessageId = replyMessageId;
    const updated = await registry.updateSession(decision.context.sessionId, { antigravityInteraction: state });
    if (!updated) throw staleQuestion();
    decision.state = state;
  };

  const forget = (decision) => {
    const sessionId = decision.context.sessionId;
    if (pending.get(sessionId) === decision) pending.delete(sessionId);
  };

  const deliver = (decision, request, outcome) => serial(decision.context.sessionId, async () => {
    const { proposal, controller } = decision;
    if (!proposal || controller.signal.aborted || closed || pending.get(proposal.sessionId) !== decision) throw staleQuestion();
    const current = await loadProposal(proposal.sessionId, proposal.directory);
    controller.signal.throwIfAborted();
    if (!current || !sameSource(current, proposal)) {
      controller.abort();
      await save(decision, 'settled');
      forget(decision);
      throw staleQuestion();
    }
    if (decision.state.phase !== 'open') throw unknownDispatch();
    const answers = outcome.status === 'replied' ? validateAnswers(proposal, outcome.answers) : null;
    const reply = answers ? continuation(proposal, answers, decision.state.replyMessageId ?? newNativeClientUserMessageId(proposal.sessionId)) : null;
    let accepted = false;
    try {
      // Persist the human choice before changing delivery state or sending.
      await interactions.record(request, outcome);
      controller.signal.throwIfAborted();
      if (!reply) {
        await save(decision, 'settled');
        forget(decision);
        return;
      }
      await save(decision, 'dispatching', reply.messageID);
      controller.signal.throwIfAborted();
      decision.dispatchingMessageId = reply.messageID;
      await prompt(proposal.sessionId, reply, controller.signal);
      accepted = true;
      await save(decision, 'settled');
      forget(decision);
    } catch (error) {
      if (accepted || errorCode.safeParse(error).data?.code === 'NATIVE_PROMPT_OUTCOME_UNKNOWN') {
        // The durable dispatching marker forbids replay after an uncertain send.
        questions.withdraw(request.id, outcome);
        const uncertain = unknownDispatch();
        failed(proposal, uncertain);
        throw uncertain;
      }
      if (decision.state.phase === 'dispatching') {
        try { await save(decision, 'open'); }
        catch {
          questions.withdraw(request.id, outcome);
          const uncertain = unknownDispatch();
          failed(proposal, uncertain);
          throw uncertain;
        }
      }
      if (!controller.signal.aborted) failed(proposal, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      delete decision.dispatchingMessageId;
    }
  });

  const offer = (decision) => {
    const proposal = decision.proposal;
    if (!proposal) return;
    const request = {
      id: decision.state.requestId, sessionID: proposal.sessionId,
      questions: proposal.questions, tool: proposal.tool,
    };
    if (proposal.kind) request.kind = proposal.kind;
    void questions.ask({
      ...request, directory: proposal.directory, signal: decision.controller.signal,
      onReply: (outcome) => deliver(decision, request, outcome),
    }).catch((error) => {
      if (!decision.controller.signal.aborted && !closed) failed(proposal, error instanceof Error ? error : new Error(String(error)));
    });
  };

  const reconcile = async (proposal) => {
    const existing = pending.get(proposal.sessionId);
    if (existing && sameSource(existing.state, proposal) && !existing.controller.signal.aborted) return;
    if (suppressed.get(proposal.sessionId) === proposal.userStep) return;
    const session = await registry.getSession(proposal.sessionId);
    if (!session || session.directory !== proposal.directory || session.backend !== 'antigravity') throw staleQuestion();
    const saved = session.antigravityInteraction;
    if (saved && saved.userStep > proposal.userStep) return;
    if (saved?.phase === 'settled' && sameSource(saved, proposal)) return;
    if (saved?.phase === 'dispatching') {
      const decision = {
        context: { sessionId: proposal.sessionId, directory: proposal.directory },
        proposal, state: saved, controller: new AbortController(),
      };
      pending.set(proposal.sessionId, decision);
      failed(proposal, unknownDispatch());
      return;
    }
    if (existing) existing.controller.abort();
    const decision = {
      context: { sessionId: proposal.sessionId, directory: proposal.directory },
      proposal,
      state: saved?.phase === 'open' && sameSource(saved, proposal) ? saved : {
        callID: proposal.callID, userStep: proposal.userStep, revision: proposal.revision,
        requestId: `ncq_${randomUUID()}`, phase: 'open',
      },
      controller: new AbortController(),
    };
    await save(decision, 'open');
    if (closed) return;
    pending.set(proposal.sessionId, decision);
    offer(decision);
  };

  const cancel = (sessionId) => {
    generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
    const decision = pending.get(sessionId);
    // Invalidate a callback before awaiting the session lane it may own.
    if (decision) {
      suppressed.set(sessionId, decision.state.userStep);
      decision.controller.abort();
    }
    return serial(sessionId, async () => {
      const active = pending.get(sessionId);
      active?.controller.abort();
      const session = await registry.getSession(sessionId);
      const state = session?.antigravityInteraction;
      if (!state || state.phase === 'settled') {
        if (active) forget(active);
        return false;
      }
      suppressed.set(sessionId, state.userStep);
      const owner = active ?? decision ?? { context: { sessionId, directory: session.directory }, state, controller: new AbortController() };
      await save(owner, 'settled');
      forget(owner);
      return true;
    });
  };

  return {
    /** @param {AntigravityProposal} proposal */
    propose(proposal) {
      if (closed) return Promise.resolve();
      const generation = generations.get(proposal.sessionId) ?? 0;
      const old = pending.get(proposal.sessionId);
      if (old?.state.phase === 'dispatching' && !old.dispatchingMessageId && !old.controller.signal.aborted) return Promise.resolve();
      if (old && old.state.userStep > proposal.userStep) return Promise.resolve();
      if (old && !old.dispatchingMessageId && !sameSource(old.state, proposal)) old.controller.abort();
      return serial(proposal.sessionId, async () => {
        if (closed || generation !== (generations.get(proposal.sessionId) ?? 0)) return;
        const current = old && !sameSource(old.state, proposal) ? await loadProposal(proposal.sessionId, proposal.directory) : proposal;
        if (closed || generation !== (generations.get(proposal.sessionId) ?? 0)) return;
        if (current) await reconcile(current);
      });
    },

    async restore(directory) {
      if (closed) return;
      const sessions = await registry.listSessions({ backend: 'antigravity', directory });
      await Promise.all(sessions.map((session) => serial(session.sessionId, async () => {
        if (closed) return;
        const current = await registry.getSession(session.sessionId);
        const state = current?.antigravityInteraction;
        if (!state || state.phase === 'settled') return;
        const existing = pending.get(session.sessionId);
        if (existing && !existing.controller.signal.aborted && existing.state.phase === state.phase && sameSource(existing.state, state)) return;
        if (state.phase === 'dispatching') {
          if (pending.has(session.sessionId)) return;
          const context = { sessionId: session.sessionId, directory };
          pending.set(session.sessionId, { context, state, controller: new AbortController() });
          failed(context, unknownDispatch());
          return;
        }
        const proposal = await loadProposal(session.sessionId, directory);
        if (proposal) await reconcile(proposal);
        else {
          const owner = pending.get(session.sessionId) ?? { context: { sessionId: session.sessionId, directory }, state, controller: new AbortController() };
          owner.controller.abort();
          await save(owner, 'settled');
          forget(owner);
        }
      })));
    },

    has(sessionId) { return pending.has(sessionId); },
    cancel,

    beforePrompt(sessionId, messageId) {
      const decision = pending.get(sessionId);
      if (decision?.dispatchingMessageId === messageId && !decision.controller.signal.aborted) return Promise.resolve();
      return cancel(sessionId).then(() => undefined);
    },

    async shutdown() {
      closed = true;
      for (const decision of pending.values()) {
        // A server shutdown is not a user's rejection and must remain restorable.
        questions.withdraw(decision.state.requestId);
        decision.controller.abort();
      }
      pending.clear();
      await Promise.all(lanes.values());
    },
  };
};
