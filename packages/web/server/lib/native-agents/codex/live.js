// Live Codex turns through the shared app-server. A prompt resumes the
// thread (the app-server unloads a thread once its turn ends), then starts a
// turn, or steers into the turn that is running. Notifications are routed by
// thread id; each item start or completion re-projects the running turn with
// the same projector history reads use, so live records and a later history
// read name the same messages and parts. Agent text streams as deltas.
//
// Every run is fully auto-approved (approval policy `never`, full access), so
// approval requests are accepted if one arrives anyway. Questions the model
// asks through requestUserInput reach the question UI.
//
// A revert rewinds the thread with `thread/revert` before the prompt that
// commits it; Codex keeps only the turns before the reverted one.

import { z } from 'zod';

import { CODEX_FAST_SERVICE_TIER, CODEX_STANDARD_SERVICE_TIER } from '../catalog.js';
import { invalidRequestError, sessionBusyError } from '../errors.js';
import { codexPartId, decodeNativeSessionId, isNativeClientUserMessageId } from '../ids.js';
import { stoppedError, unknownError } from '../records.js';
import { projectCodexTurns } from './projector.js';
import { JsonRpcError } from './rpc.js';

const APPROVAL_POLICY = 'never';
const FULL_ACCESS_SANDBOX = 'danger-full-access';
const TODO_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };
const TURN_NOT_FOUND = /^turn not found/;

const turnParams = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ message: z.string() }).passthrough().nullish(),
    startedAt: z.number().nullish(),
    completedAt: z.number().nullish(),
  }).passthrough(),
}).passthrough();
const itemParams = z.object({
  threadId: z.string(),
  turnId: z.string(),
  startedAtMs: z.number().nullish(),
  completedAtMs: z.number().nullish(),
  item: z.object({ id: z.string(), type: z.string() }).passthrough(),
}).passthrough();
const textDeltaParams = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
}).passthrough();
const indexedDeltaParams = textDeltaParams.extend({
  summaryIndex: z.number().optional(),
  contentIndex: z.number().optional(),
});
const threadStatusParams = z.object({ threadId: z.string(), status: z.object({ type: z.string() }).passthrough() }).passthrough();
const planParams = z.object({
  threadId: z.string(),
  plan: z.array(z.object({ step: z.string(), status: z.string() }).passthrough()),
}).passthrough();
const startedTurn = z.object({ turn: z.object({ id: z.string() }).passthrough() }).passthrough();
// The tier a thread runs on, as a resume reports it; absent for the standard tier.
const resumedThread = z.object({ serviceTier: z.string().nullish() }).passthrough();
const userInputRequest = z.object({
  threadId: z.string(),
  itemId: z.string(),
  questions: z.array(z.object({
    id: z.string(),
    header: z.string(),
    question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() }).passthrough()).nullish(),
  }).passthrough()),
}).passthrough();

// Streamed fields of items the app-server sent earlier, before deltas extend them.
const textField = z.string().catch('');
const textListField = z.array(z.string()).catch([]);

const appendAt = (list, index, delta) => {
  const next = [...list];
  while (next.length <= index) next.push('');
  next[index] += delta;
  return next;
};

/**
 * @typedef {{ model: string | null, effort: string | null, fast: boolean, mode: 'default' | 'plan' }} LiveConfig
 */

/**
 * @param {object} options
 * @param {(method: string, params: object) => Promise<unknown>} options.request app-server JSON-RPC request
 * @param {ReturnType<typeof import('../publisher.js').createNativeEventPublisher>} options.publisher
 * @param {ReturnType<typeof import('../questions.js').createQuestionRegistry>} options.questions
 * @param {(sessionId: string, directory: string, turn: { id: string, status: string }) => void} [options.onTurnFinished] Codex finished a turn and recorded it
 * @param {(sessionId: string, directory: string) => void} [options.onIdle] the thread stopped running a turn
 * @param {() => number} [options.now]
 */
export const createCodexLiveThreads = ({
  request,
  // Given to Codex as developer instructions each time a thread loads.
  readGlobalInstructions = async () => null,
  publisher,
  questions,
  onTurnFinished = () => {},
  onIdle = () => {},
  now = Date.now,
}) => {
  /** @type {Map<string, object>} thread id → live thread */
  const threads = new Map();

  const project = (live) => {
    if (!live.turn) return [];
    const records = projectCodexTurns({
      sessionId: live.sessionId,
      threadId: live.threadId,
      cwd: live.directory,
      turns: [{
        id: live.turn.id,
        items: live.turn.order.map((id) => live.turn.items.get(id)),
        status: live.turn.status,
        error: live.turn.error,
        startedAt: live.turn.startedAt,
        completedAt: live.turn.completedAt,
      }],
      threadModel: live.config?.model ?? '',
      sendRecordFor: (messageId) => live.sends.get(messageId) ?? null,
      itemTimes: live.turn.itemTimes,
    });
    live.messageOfPart = new Map(records.flatMap((record) => record.parts.map((part) => [part.id, record.info.id])));
    return records;
  };

  const publishTurn = (live) => publisher.records(live.directory, live.sessionId, project(live));

  const setBusy = (live, busy, error = null) => {
    if (live.busy === busy) return;
    live.busy = busy;
    if (!busy) questions.rejectSession(live.sessionId);
    publisher.status(live.directory, live.sessionId, busy ? 'busy' : 'idle');
    if (error !== null && error.name !== 'MessageAbortedError') publisher.error(live.directory, live.sessionId, error);
    if (busy) return;
    onIdle(live.sessionId, live.directory);
    for (const resolve of live.idleWaiters.splice(0)) resolve();
  };

  const upsertItem = (live, item) => {
    if (!live.turn.items.has(item.id)) live.turn.order.push(item.id);
    live.turn.items.set(item.id, item);
  };

  const threadFor = (sessionId) => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') throw invalidRequestError(`Not a Codex session: ${sessionId}`);
    return decoded.threadId;
  };

  // The app-server unloads a thread once its turn ends; a request that starts
  // a turn resumes it first.
  const ensureLoaded = async (live) => {
    if (live.loaded) return;
    const resumed = resumedThread.safeParse(await request('thread/resume', {
      threadId: live.threadId,
      excludeTurns: true,
      approvalPolicy: APPROVAL_POLICY,
      sandbox: FULL_ACCESS_SANDBOX,
      developerInstructions: (await readGlobalInstructions()) ?? undefined,
    }));
    live.serviceTier = resumed.success ? resumed.data.serviceTier ?? null : null;
    live.loaded = true;
  };

  const liveThread = (sessionId, directory) => {
    const threadId = threadFor(sessionId);
    let live = threads.get(threadId);
    if (!live) {
      live = {
        threadId,
        sessionId,
        directory,
        loaded: false,
        // The tier the loaded thread runs on as Codex last reported or a turn
        // set it; null for the standard tier.
        serviceTier: null,
        busy: false,
        turn: null,
        config: null,
        sends: new Map(),
        messageOfPart: new Map(),
        idleWaiters: [],
      };
      threads.set(threadId, live);
    }
    return live;
  };

  const settleTurn = (live, turn) => {
    live.turn.status = turn.status;
    live.turn.error = turn.error ?? null;
    live.turn.completedAt = turn.completedAt ?? Math.floor(now() / 1000);
    publishTurn(live);
    const error = turn.status === 'failed'
      ? unknownError(turn.error?.message ?? 'Codex turn failed')
      : turn.status === 'interrupted' ? stoppedError() : null;
    live.turn = null;
    setBusy(live, false, error);
  };

  const startTurn = (live, turn) => {
    // The turn/start response and the turn/started notification both open
    // the turn, in either order.
    if (live.turn?.id === turn.id) return;
    live.turn = {
      id: turn.id,
      items: new Map(),
      itemTimes: new Map(),
      order: [],
      status: 'inProgress',
      error: null,
      startedAt: turn.startedAt ?? Math.floor(now() / 1000),
      completedAt: null,
    };
    setBusy(live, true);
  };

  const onItem = (params, completed) => {
    const parsed = itemParams.safeParse(params);
    const live = parsed.success ? threads.get(parsed.data.threadId) : null;
    if (!live?.turn || live.turn.id !== parsed.data.turnId) return;
    const previous = live.turn.itemTimes.get(parsed.data.item.id);
    // A completed item is immutable; duplicate starts must not erase deltas.
    if (previous && (previous.end !== null || !completed)) return;
    const receivedAt = now();
    live.turn.itemTimes.set(parsed.data.item.id, {
      start: previous?.start ?? parsed.data.startedAtMs ?? parsed.data.completedAtMs ?? receivedAt,
      end: completed ? (parsed.data.completedAtMs ?? receivedAt) : null,
    });
    upsertItem(live, parsed.data.item);
    publishTurn(live);
  };

  // The running item a delta extends, or null.
  const deltaTarget = (schema, params) => {
    const parsed = schema.safeParse(params);
    const live = parsed.success ? threads.get(parsed.data.threadId) : null;
    if (!live?.turn || live.turn.id !== parsed.data.turnId) return null;
    if (live.turn.itemTimes.get(parsed.data.itemId)?.end != null) return null;
    const item = live.turn.items.get(parsed.data.itemId);
    return item ? { live, item, params: parsed.data } : null;
  };

  const onReasoningDelta = (params, field, indexField) => {
    const target = deltaTarget(indexedDeltaParams, params);
    if (!target) return;
    target.item[field] = appendAt(textListField.parse(target.item[field]), target.params[indexField] ?? 0, target.params.delta);
    publishTurn(target.live);
  };

  const handlers = new Map(Object.entries({
    'turn/started': (params) => {
      const parsed = turnParams.safeParse(params);
      const live = parsed.success ? threads.get(parsed.data.threadId) : null;
      if (live) startTurn(live, parsed.data.turn);
    },
    'item/started': (params) => onItem(params, false),
    'item/completed': (params) => onItem(params, true),
    'item/agentMessage/delta': (params) => {
      const target = deltaTarget(textDeltaParams, params);
      if (!target) return;
      const { live, item } = target;
      item.text = textField.parse(item.text) + target.params.delta;
      const partID = codexPartId(live.threadId, item.id);
      const messageID = live.messageOfPart.get(partID);
      if (messageID) publisher.delta(live.directory, { sessionID: live.sessionId, messageID, partID, field: 'text', delta: target.params.delta });
    },
    'item/reasoning/summaryTextDelta': (params) => onReasoningDelta(params, 'summary', 'summaryIndex'),
    'item/reasoning/textDelta': (params) => onReasoningDelta(params, 'content', 'contentIndex'),
    'item/commandExecution/outputDelta': (params) => {
      const target = deltaTarget(textDeltaParams, params);
      if (!target) return;
      target.item.aggregatedOutput = textField.parse(target.item.aggregatedOutput) + target.params.delta;
      publishTurn(target.live);
    },
    'turn/plan/updated': (params) => {
      const parsed = planParams.safeParse(params);
      const live = parsed.success ? threads.get(parsed.data.threadId) : null;
      if (!live) return;
      publisher.todos(live.directory, live.sessionId, parsed.data.plan.map((entry, index) => ({
        id: `${live.threadId}_plan_${index}`,
        content: entry.step,
        status: TODO_STATUS[entry.status] ?? 'pending',
        priority: 'medium',
      })));
    },
    'turn/completed': (params) => {
      const parsed = turnParams.safeParse(params);
      const live = parsed.success ? threads.get(parsed.data.threadId) : null;
      if (!live?.turn || live.turn.id !== parsed.data.turn.id) return;
      settleTurn(live, parsed.data.turn);
      onTurnFinished(live.sessionId, live.directory, { id: parsed.data.turn.id, status: parsed.data.turn.status });
    },
    'thread/status/changed': (params) => {
      const parsed = threadStatusParams.safeParse(params);
      const live = parsed.success ? threads.get(parsed.data.threadId) : null;
      if (live && parsed.data.status.type === 'notLoaded') live.loaded = false;
    },
  }));

  const answerQuestions = async (params) => {
    const parsed = userInputRequest.safeParse(params);
    const live = parsed.success ? threads.get(parsed.data.threadId) : null;
    if (!live) return { answers: {} };
    const partID = codexPartId(live.threadId, parsed.data.itemId);
    const messageID = live.messageOfPart.get(partID);
    const outcome = await questions.ask({
      directory: live.directory,
      sessionID: live.sessionId,
      questions: parsed.data.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description })),
        multiple: false,
      })),
      tool: messageID ? { messageID, callID: parsed.data.itemId } : undefined,
    });
    const chosen = outcome.status === 'replied' ? outcome.answers : [];
    return {
      answers: Object.fromEntries(parsed.data.questions.map((question, index) => [question.id, { answers: chosen[index] ?? [] }])),
    };
  };

  const serverRequests = new Map(Object.entries({
    'item/commandExecution/requestApproval': async () => ({ decision: 'accept' }),
    'item/fileChange/requestApproval': async () => ({ decision: 'accept' }),
    execCommandApproval: async () => ({ decision: 'approved' }),
    applyPatchApproval: async () => ({ decision: 'approved' }),
    'item/tool/requestUserInput': answerQuestions,
    'mcpServer/elicitation/request': async () => ({ action: 'decline' }),
  }));

  return {
    /** Commands that inspect a thread's tools or terminals need it loaded. */
    async loadSession(sessionId, directory) {
      await ensureLoaded(liveThread(sessionId, directory));
    },

    /**
     * @param {object} input
     * @param {string} input.sessionId
     * @param {string} input.directory
     * @param {string} input.messageId `ncx_u_<uuid>`, echoed back as the user item's clientId
     * @param {object[]} input.input Codex user input items
     * @param {LiveConfig} input.config
     * @param {{ modelID: string, variant?: string, agent: string }} input.send what the user message shows
     */
    async prompt({ sessionId, directory, messageId, input, config, send }) {
      if (!messageId.startsWith('ncx_u_') || !isNativeClientUserMessageId(messageId)) {
        throw invalidRequestError(`Not a Codex user message id: ${messageId}`);
      }
      const live = liveThread(sessionId, directory);
      await ensureLoaded(live);
      live.sends.set(messageId, send);
      live.config = config;
      if (live.busy && live.turn) {
        await request('turn/steer', { threadId: live.threadId, expectedTurnId: live.turn.id, input, clientUserMessageId: messageId });
        return;
      }
      const params = {
        threadId: live.threadId,
        input,
        clientUserMessageId: messageId,
        cwd: live.directory,
        approvalPolicy: APPROVAL_POLICY,
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
      if (config.effort !== null) params.effort = config.effort;
      if (config.model !== null) {
        params.model = config.model;
        // Null developer instructions select Codex's own instructions for the mode.
        params.collaborationMode = {
          mode: config.mode,
          settings: { model: config.model, reasoning_effort: config.effort, developer_instructions: null },
        };
      }
      // A turn's tier stays with the thread for the turns after it, and Codex's
      // own settings may load a thread on another tier, so the tier is named
      // whenever the variant asks for a different one than the thread runs on.
      const tier = config.fast ? CODEX_FAST_SERVICE_TIER : null;
      const threadTier = live.serviceTier === CODEX_STANDARD_SERVICE_TIER ? null : live.serviceTier;
      const changesTier = tier !== threadTier;
      if (changesTier) params.serviceTier = tier ?? CODEX_STANDARD_SERVICE_TIER;
      const started = startedTurn.safeParse(await request('turn/start', params));
      if (changesTier) live.serviceTier = tier;
      if (started.success) startTurn(live, { id: started.data.turn.id });
    },

    /**
     * Compacts the thread's context. Codex runs the compaction as a turn of
     * its own, which streams in like any other.
     */
    async compact(sessionId, directory) {
      const live = liveThread(sessionId, directory);
      await ensureLoaded(live);
      await request('thread/compact/start', { threadId: live.threadId });
    },

    /** Runs Codex's review workflow, with the same live events as an ordinary turn. */
    async review({ sessionId, directory, target, config }) {
      const live = liveThread(sessionId, directory);
      if (live.busy) throw sessionBusyError();
      await ensureLoaded(live);
      if (live.busy) throw sessionBusyError();
      live.config = config;
      await request('thread/settings/update', {
        threadId: live.threadId,
        model: config.model,
        effort: config.effort,
        serviceTier: config.fast ? CODEX_FAST_SERVICE_TIER : CODEX_STANDARD_SERVICE_TIER,
        approvalPolicy: APPROVAL_POLICY,
        sandboxPolicy: { type: 'dangerFullAccess' },
      });
      // Settings are already authoritative even if starting the review fails.
      live.serviceTier = config.fast ? CODEX_FAST_SERVICE_TIER : null;
      const response = startedTurn.parse(await request('review/start', {
        threadId: live.threadId, delivery: 'inline', target,
      }));
      startTurn(live, { id: response.turn.id });
    },

    /**
     * A thread this app-server just started is loaded and has no rollout yet,
     * so its first prompt must not try to resume it.
     * @param {string} sessionId
     * @param {string} directory
     * @param {string | null} [serviceTier] the tier the start reported
     */
    threadStarted(sessionId, directory, serviceTier = null) {
      const live = liveThread(sessionId, directory);
      live.loaded = true;
      live.serviceTier = serviceTier;
    },

    async abort(sessionId) {
      const live = threads.get(threadFor(sessionId));
      if (!live?.busy || !live.turn) return false;
      questions.rejectSession(sessionId);
      await request('turn/interrupt', { threadId: live.threadId, turnId: live.turn.id });
      return true;
    },

    /** Drops what the live threads know of a deleted thread. */
    forget(sessionId) {
      threads.delete(threadFor(sessionId));
    },

    /** Resolves once the thread runs no turn. */
    whenIdle(sessionId) {
      const live = threads.get(threadFor(sessionId));
      if (!live?.busy) return Promise.resolve();
      return new Promise((resolve) => {
        live.idleWaiters.push(resolve);
      });
    },

    /**
     * Drops a turn and every later one from the thread's history. A turn that
     * is gone already, for example reverted from another client, needs no
     * rewind.
     */
    async revertThread(sessionId, beforeTurnId) {
      try {
        await request('thread/revert', { threadId: threadFor(sessionId), beforeTurnId });
      } catch (error) {
        if (error instanceof JsonRpcError && error.code === -32600 && TURN_NOT_FOUND.test(error.message)) return;
        throw error;
      }
    },

    /** Routes one app-server notification to the live thread it names. */
    handleNotification(method, params) {
      handlers.get(method)?.(params);
    },

    /** Answers an app-server request; unknown requests are refused. */
    async handleServerRequest(method, params) {
      const handle = serverRequests.get(method);
      if (!handle) throw new Error(`Unsupported app-server request: ${method}`);
      return handle(params);
    },

    /** The app-server went away: running turns cannot finish. */
    handleExit(reason) {
      for (const live of threads.values()) {
        live.loaded = false;
        if (!live.turn) continue;
        settleTurn(live, { status: 'failed', error: { message: `Codex app-server stopped: ${reason}` } });
      }
    },

    /** Records of the running turn, for history reads to overlay. */
    liveRecords(sessionId) {
      const live = threads.get(threadFor(sessionId));
      return live?.turn ? project(live) : null;
    },

    /** @param {string} directory */
    busySessionIds(directory) {
      return Array.from(threads.values())
        .filter((live) => live.busy && live.directory === directory)
        .map((live) => live.sessionId);
    },

  };
};
