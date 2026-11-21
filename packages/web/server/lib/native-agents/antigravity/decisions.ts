import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { NativeAgentError } from '../errors.js';
import { NATIVE_PROVIDER_ANTIGRAVITY, newNativeClientUserMessageId } from '../ids.js';
import type { NativeInteractions } from '../interactions.js';
import type { PromptPart } from '../prompt-parts.js';
import type { QuestionInfo, QuestionOutcome, QuestionRegistry, QuestionRequest } from '../questions.js';
import type { NativeRegistry, RegistryAntigravityInteraction } from '../registry.js';

export interface AntigravityProposalSelection {
  modelID: string;
  variant?: string;
  agent: 'build' | 'plan';
}

export interface AntigravityProposal {
  sessionId: string;
  directory: string;
  userStep: number;
  callID: string;
  revision: string;
  tool: { messageID: string; callID: string };
  kind?: 'antigravity-plan-exit';
  questions: QuestionInfo[];
  plan?: string;
  send: AntigravityProposalSelection;
}

export type DecisionState = RegistryAntigravityInteraction;

export interface DecisionContext {
  sessionId: string;
  directory: string;
}

export interface AgyDecisionPromptRequest {
  directory: string;
  messageID: string;
  parts: PromptPart[];
  instructions: string;
  model: { providerID: typeof NATIVE_PROVIDER_ANTIGRAVITY; modelID: string };
  variant?: string;
  agent: 'build' | 'plan';
}

export type AgyDecisionsRegistry = Pick<NativeRegistry, 'getSession' | 'listSessions' | 'updateSession'>;
export type AgyDecisionsQuestionRegistry = Pick<QuestionRegistry, 'ask' | 'withdraw'>;
export type AgyDecisionsInteractionsStore = Pick<NativeInteractions, 'record'>;

export interface CreateAntigravityDecisionsOptions {
  registry: AgyDecisionsRegistry;
  questions: AgyDecisionsQuestionRegistry;
  interactions: AgyDecisionsInteractionsStore;
  loadProposal: (sessionId: string, directory: string) => Promise<AntigravityProposal | null>;
  prompt: (sessionId: string, request: AgyDecisionPromptRequest, signal: AbortSignal) => Promise<void>;
  failed: (context: DecisionContext, error: Error) => void;
}

export interface AntigravityDecisionsController {
  propose: (proposal: AntigravityProposal) => Promise<void>;
  restore: (directory: string) => Promise<void>;
  has: (sessionId: string) => boolean;
  cancel: (sessionId: string) => Promise<boolean>;
  beforePrompt: (sessionId: string, messageId: string) => Promise<void>;
  shutdown: () => Promise<void>;
}

interface Decision {
  context: DecisionContext;
  proposal?: AntigravityProposal;
  state: DecisionState;
  controller: AbortController;
  dispatchingMessageId?: string;
}

interface DecisionSourceIdentity {
  callID: string;
  userStep: number;
  revision: string;
}

const answersSchema = z.array(z.array(z.string().refine((answer) => answer.trim().length > 0)));
const errorCode = z.object({ code: z.string() });
const sameSource = (left: DecisionSourceIdentity, right: DecisionSourceIdentity): boolean => (
  left.callID === right.callID && left.userStep === right.userStep && left.revision === right.revision
);
const staleQuestion = () => new NativeAgentError('The Antigravity decision has been superseded', { code: 'NATIVE_QUESTION_NOT_FOUND', status: 404 });
const unknownDispatch = () => new NativeAgentError(
  'The Antigravity reply may have been accepted. Check the conversation before sending another message.',
  { code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN', status: 409 },
);

const validateAnswers = (proposal: AntigravityProposal, answers: string[][]): string[][] => {
  const parsed = answersSchema.safeParse(answers);
  if (!parsed.success || parsed.data.length !== proposal.questions.length || parsed.data.some((selected, index) => {
    const question = proposal.questions[index];
    return !question || selected.length === 0 || new Set(selected).size !== selected.length || (!question.multiple && selected.length !== 1);
  })) {
    throw new NativeAgentError('Answer every Antigravity question with a nonempty selection', { code: 'NATIVE_INVALID_REQUEST', status: 400 });
  }
  return parsed.data;
};

const continuation = (
  proposal: AntigravityProposal,
  answers: string[][],
  messageID: string,
): AgyDecisionPromptRequest | null => {
  const plan = proposal.kind === 'antigravity-plan-exit';
  const firstGroup = answers[0];
  const firstAnswer = firstGroup?.[0];
  const selected = plan && answers.length === 1 && firstGroup?.length === 1 ? (firstAnswer ?? null) : null;
  if (plan && selected === 'plan') return null;
  const approved = plan && selected === 'build';
  const instructions = approved
    ? `The user approved this exact plan. Implement it in this conversation:\n\n${proposal.plan ?? proposal.questions[0]?.question ?? ''}`
    : plan
      ? (firstAnswer ?? '')
      : [
          'My answers to your questions, in order:',
          ...proposal.questions.map((question, index) => `${index + 1}. ${question.question}\n${(answers[index] ?? []).map((answer) => `- ${answer}`).join('\n')}`),
        ].join('\n\n');
  const request: AgyDecisionPromptRequest = {
    directory: proposal.directory,
    messageID,
    parts: [],
    instructions,
    model: { providerID: NATIVE_PROVIDER_ANTIGRAVITY, modelID: proposal.send.modelID },
    agent: plan ? (approved ? 'build' : 'plan') : proposal.send.agent,
  };
  if (proposal.send.variant !== undefined) request.variant = proposal.send.variant;
  return request;
};

export const createAntigravityDecisions = ({
  registry,
  questions,
  interactions,
  loadProposal,
  prompt,
  failed,
}: CreateAntigravityDecisionsOptions): AntigravityDecisionsController => {
  const pending = new Map<string, Decision>();
  const lanes = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  const suppressed = new Map<string, number>();
  let closed = false;

  const serial = <Result>(sessionId: string, work: () => Promise<Result>): Promise<Result> => {
    const run = (lanes.get(sessionId) ?? Promise.resolve()).then(work);
    const settled = run.then(() => undefined, () => undefined);
    lanes.set(sessionId, settled);
    void settled.then(() => { if (lanes.get(sessionId) === settled) lanes.delete(sessionId); });
    return run;
  };

  const save = async (
    decision: Decision,
    phase: DecisionState['phase'],
    replyMessageId = decision.state.replyMessageId,
  ): Promise<void> => {
    const state: DecisionState = { ...decision.state, phase };
    if (replyMessageId) state.replyMessageId = replyMessageId;
    const updated = await registry.updateSession(decision.context.sessionId, { antigravityInteraction: state });
    if (!updated) throw staleQuestion();
    decision.state = state;
  };

  const isDispatching = (decision: Decision): boolean => decision.state.phase === 'dispatching';

  const forget = (decision: Decision): void => {
    const sessionId = decision.context.sessionId;
    if (pending.get(sessionId) === decision) pending.delete(sessionId);
  };

  const deliver = (
    decision: Decision,
    request: QuestionRequest,
    outcome: QuestionOutcome,
  ): Promise<void> => serial(decision.context.sessionId, async () => {
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
    if (outcome.status === 'transferred') {
      await save(decision, 'settled');
      forget(decision);
      return;
    }
    const answers = outcome.status === 'replied' ? validateAnswers(proposal, outcome.answers) : null;
    const reply = answers
      ? continuation(proposal, answers, decision.state.replyMessageId ?? newNativeClientUserMessageId(proposal.sessionId))
      : null;
    let accepted = false;
    try {
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
        questions.withdraw(request.id, outcome);
        const uncertain = unknownDispatch();
        failed(proposal, uncertain);
        throw uncertain;
      }
      if (isDispatching(decision)) {
        try {
          await save(decision, 'open');
        } catch {
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

  const offer = (decision: Decision): void => {
    const proposal = decision.proposal;
    if (!proposal) return;
    const request: QuestionRequest = {
      id: decision.state.requestId,
      sessionID: proposal.sessionId,
      questions: proposal.questions,
      tool: proposal.tool,
    };
    if (proposal.kind) request.kind = proposal.kind;
    void questions.ask({
      ...request,
      directory: proposal.directory,
      signal: decision.controller.signal,
      onReply: (outcome) => deliver(decision, request, outcome),
    }).catch((error) => {
      if (!decision.controller.signal.aborted && !closed) failed(proposal, error instanceof Error ? error : new Error(String(error)));
    });
  };

  const reconcile = async (proposal: AntigravityProposal): Promise<void> => {
    const existing = pending.get(proposal.sessionId);
    if (existing && sameSource(existing.state, proposal) && !existing.controller.signal.aborted) return;
    if (suppressed.get(proposal.sessionId) === proposal.userStep) return;
    const session = await registry.getSession(proposal.sessionId);
    if (!session || session.directory !== proposal.directory || session.backend !== 'antigravity') throw staleQuestion();
    const saved = session.antigravityInteraction;
    if (saved && saved.userStep > proposal.userStep) return;
    if (saved?.phase === 'settled' && sameSource(saved, proposal)) return;
    if (saved?.phase === 'dispatching') {
      const decision: Decision = {
        context: { sessionId: proposal.sessionId, directory: proposal.directory },
        proposal,
        state: saved,
        controller: new AbortController(),
      };
      pending.set(proposal.sessionId, decision);
      failed(proposal, unknownDispatch());
      return;
    }
    if (existing) existing.controller.abort();
    const decision: Decision = {
      context: { sessionId: proposal.sessionId, directory: proposal.directory },
      proposal,
      state: saved?.phase === 'open' && sameSource(saved, proposal)
        ? saved
        : {
            callID: proposal.callID,
            userStep: proposal.userStep,
            revision: proposal.revision,
            requestId: `ncq_${randomUUID()}`,
            phase: 'open',
          },
      controller: new AbortController(),
    };
    await save(decision, 'open');
    if (closed) return;
    pending.set(proposal.sessionId, decision);
    offer(decision);
  };

  const cancel = (sessionId: string): Promise<boolean> => {
    generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
    const decision = pending.get(sessionId);
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
      const owner: Decision = active ?? decision ?? {
        context: { sessionId, directory: session.directory },
        state,
        controller: new AbortController(),
      };
      await save(owner, 'settled');
      forget(owner);
      return true;
    });
  };

  return {
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
          const context: DecisionContext = { sessionId: session.sessionId, directory };
          pending.set(session.sessionId, { context, state, controller: new AbortController() });
          failed(context, unknownDispatch());
          return;
        }
        const proposal = await loadProposal(session.sessionId, directory);
        if (proposal) await reconcile(proposal);
        else {
          const owner: Decision = pending.get(session.sessionId) ?? {
            context: { sessionId: session.sessionId, directory },
            state,
            controller: new AbortController(),
          };
          owner.controller.abort();
          await save(owner, 'settled');
          forget(owner);
        }
      })));
    },

    has(sessionId) {
      return pending.has(sessionId);
    },

    cancel,

    beforePrompt(sessionId, messageId) {
      const decision = pending.get(sessionId);
      if (decision?.dispatchingMessageId === messageId && !decision.controller.signal.aborted) return Promise.resolve();
      return cancel(sessionId).then(() => undefined);
    },

    async shutdown() {
      closed = true;
      for (const decision of pending.values()) {
        questions.withdraw(decision.state.requestId);
        decision.controller.abort();
      }
      pending.clear();
      await Promise.all(lanes.values());
    },
  };
};
