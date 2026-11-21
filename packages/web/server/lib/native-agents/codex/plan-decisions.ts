import { randomUUID } from 'node:crypto';

import { NATIVE_PROVIDER_CODEX, newCodexPlanApprovalMessageId } from '../ids.js';

export interface CodexPlanToolRef {
  messageID: string;
  callID: string;
}

export interface CodexPlanSend {
  modelID: string;
  variant?: string | undefined;
  agent: string;
}

export interface CodexPlan {
  sessionId: string;
  directory: string;
  turnId: string;
  text: string;
  tool?: CodexPlanToolRef | undefined;
  send: CodexPlanSend;
}

export interface CodexPlanPromptRequest {
  directory: string;
  messageID: string;
  parts: Array<{ type: 'text'; text: string }>;
  model: { providerID: typeof NATIVE_PROVIDER_CODEX; modelID: string };
  variant?: string;
  agent: 'build' | 'plan';
}

export interface CodexPlanQuestionOption {
  label: string;
  description: string;
}

export interface CodexPlanQuestionItem {
  header: string;
  question: string;
  options: CodexPlanQuestionOption[];
  multiple: boolean;
}

export type CodexPlanQuestionOutcome =
  | { status: 'replied' | 'transferred'; answers: string[][] }
  | { status: 'rejected'; reason?: string | undefined };

export interface CodexPlanQuestionAskInput {
  directory: string;
  sessionID: string;
  kind: 'codex-plan-exit';
  tool?: CodexPlanToolRef;
  questions: CodexPlanQuestionItem[];
  signal: AbortSignal;
  onReply: (outcome: CodexPlanQuestionOutcome) => Promise<void>;
}

export interface CodexPlanQuestionRegistry {
  ask(input: CodexPlanQuestionAskInput): Promise<CodexPlanQuestionOutcome>;
}

export interface CodexPlanDecisionsOptions {
  questions: CodexPlanQuestionRegistry;
  prompt: (sessionId: string, request: CodexPlanPromptRequest, signal: AbortSignal) => Promise<void>;
  failed: (plan: CodexPlan, error: Error) => void;
}

interface PendingDecision {
  turnId: string;
  controller: AbortController;
}

export const createCodexPlanDecisions = ({ questions, prompt, failed }: CodexPlanDecisionsOptions) => {
  const pending = new Map<string, PendingDecision>();

  const cancel = (sessionId: string): boolean => {
    const decision = pending.get(sessionId);
    if (!decision) return false;
    pending.delete(sessionId);
    decision.controller.abort();
    return true;
  };

  const decide = async (plan: CodexPlan, signal: AbortSignal): Promise<void> => {
    const deliver = async (outcome: CodexPlanQuestionOutcome): Promise<void> => {
      signal.throwIfAborted();
      if (outcome.status !== 'replied' || outcome.answers.length !== 1) return;
      const firstAnswers = outcome.answers[0];
      if (!firstAnswers || firstAnswers.length !== 1) return;
      const answer = firstAnswers[0];
      if (!answer || answer === 'plan' || !answer.trim()) return;
      try {
        const request: CodexPlanPromptRequest = {
          directory: plan.directory,
          messageID: answer === 'build' ? newCodexPlanApprovalMessageId() : `ncx_u_${randomUUID()}`,
          parts: [{ type: 'text', text: answer === 'build' ? 'Implement the plan.' : answer }],
          model: { providerID: NATIVE_PROVIDER_CODEX, modelID: plan.send.modelID },
          agent: answer === 'build' ? 'build' : 'plan',
        };
        if (plan.send.variant !== undefined) request.variant = plan.send.variant;
        await prompt(plan.sessionId, request, signal);
      } catch (error) {
        if (!signal.aborted) failed(plan, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    };
    const askInput: CodexPlanQuestionAskInput = {
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
      onReply: deliver,
    };
    if (plan.tool !== undefined) askInput.tool = plan.tool;
    await questions.ask(askInput);
  };

  return {
    propose(plan: CodexPlan) {
      if (pending.get(plan.sessionId)?.turnId === plan.turnId) return;
      cancel(plan.sessionId);
      const decision: PendingDecision = { turnId: plan.turnId, controller: new AbortController() };
      pending.set(plan.sessionId, decision);
      void decide(plan, decision.controller.signal).catch((error) => {
        if (!decision.controller.signal.aborted) failed(plan, error instanceof Error ? error : new Error(String(error)));
      }).finally(() => {
        if (pending.get(plan.sessionId) === decision) pending.delete(plan.sessionId);
      });
    },

    has(sessionId: string): boolean {
      return pending.has(sessionId);
    },

    cancel,

    clear() {
      for (const sessionId of pending.keys()) cancel(sessionId);
    },
  };
};
