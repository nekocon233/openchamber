// A proposed plan outlives the Codex turn that produced it. Keep its decision
// in the native question registry until the user answers or supersedes it.
// The normal prompt path owns execution, snapshots and the CLI transcript.

import { randomUUID } from 'node:crypto';

import { NATIVE_PROVIDER_CODEX } from '../ids.js';

/**
 * @typedef {{ sessionId: string, directory: string, turnId: string, text: string, send: { modelID: string, variant?: string, agent: string } }} CodexPlan
 */

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../questions.js').createQuestionRegistry>} options.questions
 * @param {(sessionId: string, request: import('../runtime.js').PromptRequest, signal: AbortSignal) => Promise<void>} options.prompt
 * @param {(plan: CodexPlan, error: Error) => void} options.failed
 */
export const createCodexPlanDecisions = ({ questions, prompt, failed }) => {
  /** @type {Map<string, { turnId: string, controller: AbortController }>} */
  const pending = new Map();

  const cancel = (sessionId) => {
    const decision = pending.get(sessionId);
    if (!decision) return false;
    pending.delete(sessionId);
    decision.controller.abort();
    return true;
  };

  const decide = async (plan, signal) => {
    const outcome = await questions.ask({
      directory: plan.directory,
      sessionID: plan.sessionId,
      kind: 'codex-plan-exit',
      questions: [{
        header: 'Plan',
        question: plan.text,
        options: [{ label: 'build', description: '' }, { label: 'plan', description: '' }],
        multiple: false,
      }],
      signal,
    });
    signal.throwIfAborted();
    if (outcome.status !== 'replied' || outcome.answers.length !== 1 || outcome.answers[0].length !== 1) return;
    const answer = outcome.answers[0][0];
    if (answer === 'plan' || !answer.trim()) return;
    await prompt(plan.sessionId, {
      directory: plan.directory,
      messageID: `ncx_u_${randomUUID()}`,
      parts: [{ type: 'text', text: answer === 'build' ? 'Implement the plan.' : answer }],
      model: { providerID: NATIVE_PROVIDER_CODEX, modelID: plan.send.modelID },
      variant: plan.send.variant,
      agent: answer === 'build' ? 'build' : 'plan',
    }, signal);
  };

  return {
    /** @param {CodexPlan} plan */
    propose(plan) {
      if (pending.get(plan.sessionId)?.turnId === plan.turnId) return;
      cancel(plan.sessionId);
      const decision = { turnId: plan.turnId, controller: new AbortController() };
      pending.set(plan.sessionId, decision);
      void decide(plan, decision.controller.signal).catch((error) => {
        if (!decision.controller.signal.aborted) failed(plan, error instanceof Error ? error : new Error(String(error)));
      }).finally(() => {
        if (pending.get(plan.sessionId) === decision) pending.delete(plan.sessionId);
      });
    },

    has(sessionId) {
      return pending.has(sessionId);
    },

    cancel,

    clear() {
      for (const sessionId of pending.keys()) cancel(sessionId);
    },
  };
};
