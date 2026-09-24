// Questions native sessions wait on: Claude's AskUserQuestion and Codex's
// requestUserInput. The CLI blocks until the question is answered, so a
// question lives only as long as the live turn that asked it; nothing is
// persisted. Replies and rejections resolve the CLI's pending callback and
// publish the same `question.*` events OpenCode questions produce.

import { randomUUID } from 'node:crypto';

import { NativeAgentError } from './errors.js';

/** @typedef {{ question: string, header: string, options: Array<{ label: string, description: string }>, multiple?: boolean }} QuestionInfo */
/** @typedef {{ id: string, sessionID: string, questions: QuestionInfo[], tool?: { messageID: string, callID: string } }} QuestionRequest */
/** @typedef {{ status: 'replied', answers: string[][] } | { status: 'rejected' }} QuestionOutcome */

const questionNotFoundError = (requestId) => new NativeAgentError(
  `No pending native question ${requestId}`,
  { code: 'NATIVE_QUESTION_NOT_FOUND', status: 404 },
);

/**
 * @param {object} options
 * @param {(directory: string, payload: { type: string, properties: object }) => void} options.publish
 */
export const createQuestionRegistry = ({ publish }) => {
  /** @type {Map<string, { request: QuestionRequest, directory: string, settle: (outcome: QuestionOutcome) => void }>} */
  const pending = new Map();

  const settle = (requestId, outcome) => {
    const entry = pending.get(requestId);
    if (!entry) throw questionNotFoundError(requestId);
    pending.delete(requestId);
    publish(entry.directory, {
      type: outcome.status === 'replied' ? 'question.replied' : 'question.rejected',
      properties: outcome.status === 'replied'
        ? { sessionID: entry.request.sessionID, requestID: requestId, answers: outcome.answers }
        : { sessionID: entry.request.sessionID, requestID: requestId },
    });
    entry.settle(outcome);
  };

  return {
    /**
     * Publishes a question and resolves once it is answered or rejected. An
     * abort signal rejects it, as does ending the session's turn.
     * @param {{ directory: string, sessionID: string, questions: QuestionInfo[], tool?: { messageID: string, callID: string }, signal?: AbortSignal }} input
     * @returns {Promise<QuestionOutcome>}
     */
    ask({ directory, sessionID, questions, tool, signal }) {
      const request = tool === undefined
        ? { id: `ncq_${randomUUID()}`, sessionID, questions }
        : { id: `ncq_${randomUUID()}`, sessionID, questions, tool };
      return new Promise((resolve) => {
        const onAbort = () => {
          if (pending.has(request.id)) settle(request.id, { status: 'rejected' });
        };
        pending.set(request.id, {
          request,
          directory,
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

    /** @param {string} directory */
    list(directory) {
      return Array.from(pending.values())
        .filter((entry) => entry.directory === directory)
        .map((entry) => entry.request);
    },

    /** @param {string} requestId */
    sessionOf(requestId) {
      return pending.get(requestId)?.request.sessionID ?? null;
    },

    /**
     * @param {string} requestId
     * @param {string[][]} answers one list of chosen labels per question
     */
    reply(requestId, answers) {
      settle(requestId, { status: 'replied', answers });
    },

    /** @param {string} requestId */
    reject(requestId) {
      settle(requestId, { status: 'rejected' });
    },

    /** Rejects every question a session is waiting on, when its turn ends. */
    rejectSession(sessionID) {
      for (const [requestId, entry] of pending) {
        if (entry.request.sessionID === sessionID) settle(requestId, { status: 'rejected' });
      }
    },
  };
};
