import { randomUUID } from 'node:crypto';

import { NativeAgentError } from './errors.js';
import type { JsonObject } from '../shared/json-values.js';
import type {
  PlanExecutionActions,
  PlanExecutionChoice,
  PlanExecutionContext,
  PlanExecutionResult,
  PlanExitKind,
} from './plan-execution.js';

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean | undefined;
  planApproval?: boolean | undefined;
};

export type QuestionToolLink = {
  messageID: string;
  callID: string;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  kind?: PlanExitKind;
  tool?: QuestionToolLink;
  canSelectExecutionModel?: boolean;
  executionPending?: PlanExecutionChoice;
};

export type QuestionRepliedOutcome = {
  status: 'replied' | 'transferred';
  answers: string[][];
  execution?: PlanExecutionChoice;
};

export type QuestionRejectedOutcome = {
  status: 'rejected';
  reason?: 'interrupted';
};

export type QuestionOutcome = QuestionRepliedOutcome | QuestionRejectedOutcome;

export interface QuestionAskInput {
  id?: string | undefined;
  directory: string;
  sessionID: string;
  questions: QuestionInfo[];
  kind?: PlanExitKind | undefined;
  tool?: QuestionToolLink | undefined;
  signal?: AbortSignal | undefined;
  onReply?: ((outcome: QuestionOutcome) => Promise<void> | void) | undefined;
  transferred?: boolean | undefined;
  executionPending?: PlanExecutionChoice | undefined;
}

export interface QuestionRegistryOptions {
  publish: (directory: string, payload: { type: string; properties: JsonObject }) => void;
  onSettled?: ((request: QuestionRequest, outcome: QuestionOutcome, directory: string) => Promise<void> | void) | undefined;
  executePlan?: ((
    context: PlanExecutionContext,
    outcome: QuestionRepliedOutcome,
    actions: PlanExecutionActions,
  ) => Promise<PlanExecutionResult>) | undefined;
  canExecutePlan?: ((request: QuestionRequest) => boolean) | undefined;
}

export interface QuestionRegistry {
  ask: (input: QuestionAskInput) => Promise<QuestionOutcome>;
  list: (directory: string) => QuestionRequest[];
  sessionOf: (requestId: string) => string | null;
  get: (requestId: string) => QuestionRequest | null;
  reply: (requestId: string, answers: string[][], execution?: PlanExecutionChoice) => Promise<PlanExecutionResult | void> | void;
  reject: (requestId: string) => Promise<PlanExecutionResult | void> | void;
  withdraw: (requestId: string, outcome?: QuestionOutcome) => boolean;
  rejectSession: (sessionID: string) => void;
}

interface PendingQuestionEntry {
  request: QuestionRequest;
  directory: string;
  phase: 'open' | 'replying' | 'transferring';
  transferred: boolean;
  signal?: AbortSignal | undefined;
  onReply?: ((outcome: QuestionOutcome) => Promise<void> | void) | undefined;
  settle: (outcome: QuestionOutcome) => void;
}

const questionNotFoundError = (requestId: string): NativeAgentError => new NativeAgentError(
  `No pending native question ${requestId}`,
  { code: 'NATIVE_QUESTION_NOT_FOUND', status: 404 },
);

export const createQuestionRegistry = ({
  publish,
  onSettled = () => undefined,
  executePlan,
  canExecutePlan = () => true,
}: QuestionRegistryOptions): QuestionRegistry => {
  const pending = new Map<string, PendingQuestionEntry>();

  const updateExecutionPending = (requestId: string, executionPending?: PlanExecutionChoice): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    if (executionPending) entry.request.executionPending = executionPending;
    else delete entry.request.executionPending;
    publish(entry.directory, { type: 'question.asked', properties: entry.request });
    return true;
  };

  const settle = (requestId: string, outcome: QuestionOutcome): Promise<PlanExecutionResult | void> | void => {
    const entry = pending.get(requestId);
    if (!entry) throw questionNotFoundError(requestId);
    const commit = () => {
      if (pending.get(requestId) !== entry) throw questionNotFoundError(requestId);
      pending.delete(requestId);
      publish(entry.directory, {
        type: outcome.status === 'replied' ? 'question.replied' : 'question.rejected',
        properties: outcome.status === 'replied'
          ? { sessionID: entry.request.sessionID, requestID: requestId, answers: outcome.answers }
          : { sessionID: entry.request.sessionID, requestID: requestId },
      });
      entry.settle(outcome);
      return onSettled(entry.request, outcome, entry.directory);
    };
    const transfer = async (replied: QuestionRepliedOutcome): Promise<void> => {
      if (entry.transferred) return;
      await entry.onReply?.({ ...replied, status: 'transferred' });
      if (pending.get(requestId) !== entry) throw questionNotFoundError(requestId);
      entry.transferred = true;
      entry.phase = 'transferring';
      entry.settle({ ...replied, status: 'transferred' });
      entry.onReply = undefined;
    };
    const deliver: (() => Promise<PlanExecutionResult | void> | void) | undefined =
      executePlan && outcome.status === 'replied' && (outcome.execution || entry.transferred)
        ? () => executePlan(
          { request: entry.request, directory: entry.directory, transferred: entry.transferred === true },
          outcome,
          {
            transfer: () => transfer(outcome),
            deliver: () => entry.onReply?.(outcome),
            link: (tool) => { entry.request.tool = tool; },
            isCurrent: () => pending.get(requestId) === entry,
            pending: (executionPending) => {
              if (pending.get(requestId) !== entry) return;
              updateExecutionPending(requestId, executionPending);
            },
          },
        )
        : entry.onReply
          ? () => entry.onReply?.(outcome)
          : undefined;
    if (!deliver || entry.signal?.aborted || (outcome.status === 'rejected' && outcome.reason === 'interrupted')) return commit();
    if (entry.phase !== 'open') throw new NativeAgentError('This native question answer is being delivered', { status: 409, code: 'NATIVE_QUESTION_REPLY_PENDING' });
    entry.phase = 'replying';
    return Promise.resolve().then(deliver).then(async (result) => {
      await commit();
      return result;
    }, (error) => {
      if (pending.get(requestId) === entry) entry.phase = 'open';
      throw error;
    });
  };

  return {
    ask({ id, directory, sessionID, questions, kind, tool, signal, onReply, transferred = false, executionPending }) {
      const request: QuestionRequest = {
        id: id ?? `ncq_${randomUUID()}`,
        sessionID,
        questions,
      };
      if (pending.has(request.id)) throw new NativeAgentError('This native question is already pending', { status: 409, code: 'NATIVE_QUESTION_REPLY_PENDING' });
      if (kind !== undefined) request.kind = kind;
      if (tool !== undefined) request.tool = tool;
      if (executePlan && kind?.endsWith('-plan-exit') && canExecutePlan(request)) request.canSelectExecutionModel = true;
      if (executionPending) request.executionPending = executionPending;
      return new Promise((resolve) => {
        const onAbort = () => {
          const entry = pending.get(request.id);
          if (entry && !entry.transferred) void Promise.resolve(settle(request.id, { status: 'rejected', reason: 'interrupted' })).catch(() => {});
        };
        pending.set(request.id, {
          request,
          directory,
          phase: 'open',
          signal,
          onReply,
          transferred,
          settle: (outcome) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(outcome);
          },
        });
        publish(directory, { type: 'question.asked', properties: request });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    },

    list(directory) {
      return Array.from(pending.values())
        .filter((entry) => entry.directory === directory)
        .map((entry) => entry.request);
    },

    sessionOf(requestId) {
      return pending.get(requestId)?.request.sessionID ?? null;
    },

    get(requestId) {
      return pending.get(requestId)?.request ?? null;
    },

    reply(requestId, answers, execution) {
      if (execution) {
        const request = pending.get(requestId)?.request;
        if (!request) throw questionNotFoundError(requestId);
        const first = answers[0];
        if (!request.canSelectExecutionModel || answers.length !== 1 || !first || first.length !== 1 || first[0] !== 'build') {
          throw new NativeAgentError('An execution model can only accompany a native plan approval', { status: 400, code: 'NATIVE_INVALID_REQUEST' });
        }
      }
      const outcome: QuestionRepliedOutcome = { status: 'replied', answers };
      if (execution) outcome.execution = execution;
      return settle(requestId, outcome);
    },

    reject(requestId) {
      return settle(requestId, { status: 'rejected' });
    },

    withdraw(requestId, outcome) {
      const entry = pending.get(requestId);
      if (!entry) return false;
      pending.delete(requestId);
      entry.settle({ status: 'rejected', reason: 'interrupted' });
      if (outcome) {
        publish(entry.directory, {
          type: outcome.status === 'replied' ? 'question.replied' : 'question.rejected',
          properties: outcome.status === 'replied'
            ? { sessionID: entry.request.sessionID, requestID: requestId, answers: outcome.answers }
            : { sessionID: entry.request.sessionID, requestID: requestId },
        });
      }
      return true;
    },

    rejectSession(sessionID) {
      for (const [requestId, entry] of pending) {
        if (entry.request.sessionID === sessionID && !(entry.transferred && entry.phase !== 'open')) {
          void Promise.resolve(settle(requestId, { status: 'rejected', reason: 'interrupted' })).catch(() => {});
        }
      }
    },
  };
};
