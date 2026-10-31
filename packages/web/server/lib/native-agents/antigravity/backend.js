import path from 'node:path';

import {
  decodeNativeSessionId,
  encodeAntigravitySessionId,
  NATIVE_PROVIDER_ANTIGRAVITY,
} from '../ids.js';
import {
  cliMissingError,
  invalidRequestError,
  NativeAgentError,
  sessionBusyError,
  sessionNotFoundError,
} from '../errors.js';
import {
  antigravityPromptFingerprint,
  antigravityPromptText,
  withInstructions,
} from '../prompt-parts.js';
import { signalCliProcess, spawnCliProcess } from '../process.js';
import { unconfirmedSessionRecord, unknownError } from '../records.js';
import { agyDiagnostic, agyProcessArgs, startAgyProcess } from './process.js';
import { createAntigravityLiveProjection } from './projector.js';
import { createAntigravityStore } from './store.js';
import { createAntigravitySubagents } from './subagents.js';
import { createAntigravityQuota } from './quota.js';
import { parseAntigravityModels } from './catalog.js';
import { agyPermissionError } from './protocol.js';
import { AGY_PLAN_QUESTION_PREFIX } from './interaction-signals.js';

const MINIMUM_VERSION = [1, 1, 15];
const IDLE_CLOSE_MS = 5 * 60_000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const HEADLESS_INSTRUCTIONS = [
  'OpenChamber collects decisions after this headless turn ends. Use ask_question for user questions, then end your response even if the native tool reports User Skipped. The user answer arrives as a later message in this conversation. A skipped question is unanswered and never approval.',
  `When a Plan is ready for approval, call ask_question with exactly one single-select question: question is ${JSON.stringify(AGY_PLAN_QUESTION_PREFIX)} followed by the complete final plan, options are exactly ["build", "plan"], and is_multi_select is false. Then end the response. OpenChamber displays the plan for approval. Do not implement it until a later user message approves it in Build mode. Do not write an implementation_plan.md artifact to request approval.`,
  'Background command completions arrive from the CLI; do not wait by repeatedly calling manage_task or running echo commands.',
].join('\n');

const backendError = (message, code = 'NATIVE_ANTIGRAVITY_ERROR') => new NativeAgentError(message, { code, status: 502 });

const versionSupported = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > MINIMUM_VERSION[index]) return true;
    if (actual[index] < MINIMUM_VERSION[index]) return false;
  }
  return true;
};

const sameDirectory = (left, right) => path.resolve(left) === path.resolve(right);

export const createAntigravityBackend = ({
  resolveExecutable,
  buildEnv,
  registry,
  publisher,
  readGlobalInstructions,
  decorateSession,
  onInteraction = async () => undefined,
  now = Date.now,
  home = null,
  startupTimeoutMs = 30_000,
}) => {
  const store = createAntigravityStore({ registry, home, now });
  const sessions = new Map();
  const admissions = new Map();
  const subagents = createAntigravitySubagents({ publisher, now });
  // Updated only by successful discovery. The CLI still validates availability
  // at launch; this map translates legacy selections without probing each turn.
  let modelAliases = null;

  const requireExecutable = async () => {
    const executable = await resolveExecutable();
    if (!executable) throw cliMissingError('agy');
    return executable;
  };

  const probe = async (args) => {
    const executable = await requireExecutable();
    return new Promise((resolve, reject) => {
      const child = spawnCliProcess(executable, args, { cwd: process.cwd(), env: buildEnv() });
      let stdout = '';
      let stderr = '';
      let outputExceeded = false;
      const deadline = setTimeout(() => {
        signalCliProcess(child, 'SIGKILL');
        reject(backendError(`Antigravity discovery timed out: ${args.join(' ')}`, 'NATIVE_ANTIGRAVITY_PROBE_TIMEOUT'));
      }, 10_000);
      deadline.unref?.();
      child.stdout.on('data', (chunk) => {
        if (outputExceeded) return;
        stdout += chunk.toString();
        if (stdout.length > 1024 * 1024) {
          outputExceeded = true;
          signalCliProcess(child, 'SIGKILL');
          reject(backendError('Antigravity discovery output exceeded its limit', 'NATIVE_ANTIGRAVITY_PROBE_OUTPUT'));
        }
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
      child.on('error', (error) => {
        clearTimeout(deadline);
        reject(backendError(error.message));
      });
      child.on('close', (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve(stdout);
        else {
          const diagnostic = stderr.trim() || `agy exited with code ${code}`;
          const unauthenticated = /auth|sign[ -]?in|log[ -]?in/i.test(diagnostic);
          reject(backendError(agyDiagnostic(diagnostic), unauthenticated ? 'NATIVE_ANTIGRAVITY_UNAUTHENTICATED' : 'NATIVE_ANTIGRAVITY_ERROR'));
        }
      });
    });
  };

  const quota = createAntigravityQuota({
    resolveExecutable,
    readUsage: () => probe(['--disable-slash-commands=false', '--print', '/usage', '--print-timeout', '10s']),
  });

  const readCatalog = async () => {
    const version = (await probe(['--version'])).trim();
    if (!versionSupported(version)) {
      throw backendError(`Antigravity ${version || 'version'} is unsupported. Update agy to 1.1.15 or later.`, 'NATIVE_ANTIGRAVITY_VERSION');
    }
    const models = parseAntigravityModels(await probe(['models']));
    modelAliases = new Map(models.flatMap((model) => model.aliases.map((alias) => [alias.id, model.id])));
    return models;
  };

  const eventFailure = (error) => console.warn('[native-agents] Antigravity event handling failed:', error instanceof Error ? error.message : String(error));
  const enqueue = (session, process, work) => {
    const invoke = async () => {
      const turn = session.turn?.process === process ? session.turn : null;
      try {
        await work();
      } catch (error) {
        if (!turn || session.turn !== turn) { eventFailure(error); return; }
        void process.stop('interrupt');
        try {
          await finishTurn(session, {
            outcome: session.abortRequested ? 'aborted' : 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (failure) { eventFailure(failure); }
      }
    };
    const run = session.queue.then(invoke, invoke);
    session.queue = run;
    return run;
  };

  const settleIdle = (session) => {
    if (session.turn) return;
    for (const resolve of session.idleWaiters) resolve();
    session.idleWaiters.clear();
  };

  const scheduleIdleClose = (session) => {
    clearTimeout(session.idleTimer);
    if (!session.process || session.turn) return;
    session.idleTimer = setTimeout(() => {
      const process = session.process;
      if (!process || session.turn) return;
      void process.stop('close');
    }, IDLE_CLOSE_MS);
    session.idleTimer.unref?.();
  };

  const publishTurnSession = async (session) => {
    if (store.hasTranscript(session.nativeId)) await registry.confirmSession(session.id);
    const fresh = await store.getSession(session.id, session.nativeId, session.directory).catch(() => null);
    const record = fresh ?? {
      ...session.record,
      time: { ...session.record.time, updated: now() },
    };
    session.record = record;
    publisher.session(session.directory, await decorateSession(record), { created: false });
  };

  const finishTurn = async (session, { outcome, response = '', error = '', responseStep = null }) => {
    const turn = session.turn;
    if (!turn) return;
    if (turn.completion) return turn.completion;
    turn.completion = (async () => {
      turn.projection.finish({ outcome, response, error, responseStep, time: now() });
      let completionSaved = false;
      try {
        await registry.recordSend(session.id, {
          ...turn.send, antigravity: { ...turn.send.antigravity, completion: { outcome, time: now() } },
        });
        completionSaved = true;
      } catch (failure) { eventFailure(failure); }
      let history = null;
      try {
        history = await store.loadHistory(session.id, session.nativeId, session.directory);
        if (history) turn.projection.restoreMissingHistory(history.records);
        const tasks = await store.taskSnapshot(session.id, session.nativeId, session.directory);
        if (tasks) publisher.tasks(session.directory, session.id, tasks);
      } catch { /* Optional recovery must not discard the live result; history reads report failures. */ }
      session.turn = null;
      session.abortRequested = false;
      subagents.release(session.id, turn.process);
      session.lastProjection = turn.projection;
      try {
        if (outcome === 'success' && completionSaved && history?.interactionProposal) {
          try { await onInteraction(history.interactionProposal); }
          catch (failure) { publisher.error(session.directory, session.id, unknownError(failure instanceof Error ? failure.message : String(failure))); }
        }
        if (!session.turn) publisher.status(session.directory, session.id, 'idle');
        if (outcome === 'error') publisher.error(session.directory, session.id, unknownError(error));
        await publishTurnSession(session);
      } finally {
        settleIdle(session);
        scheduleIdleClose(session);
      }
    })();
    return turn.completion;
  };

  const handleResult = async (session, process, result) => {
    const turn = session.turn;
    if (!turn || turn.process !== process || result.conversation_id !== session.nativeId) return;
    const interrupted = result.status === 'CANCELED'
      || result.status === 'INTERRUPTED'
      || result.error === 'interrupted'
      || session.abortRequested;
    let outcome = result.status === 'SUCCESS' ? 'success' : interrupted ? 'aborted' : 'error';
    // The final result has no step index. The native transcript identifies it
    // even if its last streamed frame was lost. A failed optional read cannot
    // replace an otherwise valid live result with a history error.
    let responseStep = null;
    try { responseStep = store.finalResponse(session.nativeId, turn.projection.userStepIndex()); } catch { /* The history route reports read failures. */ }
    if (outcome === 'error' && result.status === 'ERROR' && /stream was interrupted/i.test(result.error ?? '') && responseStep) outcome = 'success';
    let error = result.error || (outcome === 'aborted' ? 'aborted' : 'Antigravity turn failed');
    // Headless agy can soft-deny an Ask action and report empty SUCCESS. It
    // never asked the user, and this is not a completed assistant response.
    if (outcome === 'success' && !responseStep && result.response.trim() === '' && result.denied_actions.length > 0) {
      const denial = { actions: [...new Set(result.denied_actions.map((action) => action.action.slice(0, 256)))].slice(0, 32), time: now() };
      outcome = 'error';
      error = agyPermissionError(denial.actions);
      try {
        await registry.recordSend(session.id, { ...turn.send, antigravity: { ...turn.send.antigravity, denial } });
      } catch (failure) {
        eventFailure(failure);
        error += ' Permission-denial details could not be saved.';
      }
    }
    if (session.turn !== turn) return;
    if (result.status !== 'SUCCESS' && session.process) void session.process.stop('close');
    await finishTurn(session, {
      outcome,
      response: responseStep && !responseStep.truncated_fields.includes('content')
        ? responseStep.content : result.response,
      responseStep,
      error,
    });
  };

  const handleExit = async (session, process, error) => {
    subagents.release(session.id, process);
    subagents.forget(session.id, process);
    if (session.process === process) {
      clearTimeout(session.idleTimer);
      session.process = null;
      session.firstPrompt = true;
    }
    if (session.turn?.process === process) {
      await finishTurn(session, {
        outcome: session.abortRequested ? 'aborted' : 'error',
        error: session.abortRequested ? 'aborted' : error?.message ?? 'Antigravity process exited',
      });
    }
  };

  const handleFrame = async (session, process, frame) => {
    if (frame.event === 'init') return;
    if (session.process !== process) return;
    if (await subagents.handle(session, process, frame)) return;
    if (frame.event === 'result') {
      await handleResult(session, process, frame.result);
      return;
    }
    const turn = session.turn;
    const step = frame.step_update;
    if (!turn || turn.process !== process || step.conversation_id !== session.nativeId) return;
    await turn.projection.applyStep(step, now(), async (stepIndex) => {
      await registry.bindAntigravityMessage(session.id, turn.send.messageId, stepIndex, turn.send);
    });
  };

  const ensureSession = async (sessionId, directory, model, agent, effort) => {
    let session = sessions.get(sessionId);
    if (!session) {
      const decoded = decodeNativeSessionId(sessionId);
      if (!decoded || decoded.backend !== 'antigravity') throw sessionNotFoundError(sessionId);
      const record = await store.getSession(sessionId, decoded.conversationId, directory);
      if (!record) throw sessionNotFoundError(sessionId);
      if (record.parentID) throw invalidRequestError('Antigravity subagent sessions are read-only');
      session = {
        id: sessionId,
        nativeId: decoded.conversationId,
        directory: record.directory,
        record,
        model: null,
        agent: null,
        effort: null,
        process: null,
        firstPrompt: true,
        turn: null,
        lastProjection: null,
        abortRequested: false,
        idleWaiters: new Set(),
        idleTimer: null,
        queue: Promise.resolve(),
      };
      sessions.set(sessionId, session);
    }
    if (!sameDirectory(session.directory, directory)) throw invalidRequestError('Antigravity session directory does not match the request');
    if (session.turn) throw sessionBusyError();
    if (session.process && !session.process.acceptsInput()) {
      const previous = session.process;
      await previous.exited;
      if (session.process === previous) session.process = null;
      session.firstPrompt = true;
    }
    if (session.process && (session.model !== model || session.agent !== agent || session.effort !== effort)) {
      const previous = session.process;
      await previous.stop('close');
      if (session.process === previous) session.process = null;
      session.firstPrompt = true;
    }
    if (!session.process) {
      const executable = await requireExecutable();
      const globalInstructions = [await readGlobalInstructions(), HEADLESS_INSTRUCTIONS].filter(Boolean).join('\n\n');
      const process = startAgyProcess({
        executable,
        args: agyProcessArgs({ cwd: session.directory, model, conversationId: session.nativeId, agent, effort }),
        cwd: session.directory,
        env: buildEnv(),
        startupTimeoutMs,
        onFrame: (frame) => enqueue(session, process, () => handleFrame(session, process, frame)),
        onExit: (error) => enqueue(session, process, () => handleExit(session, process, error)),
      });
      session.process = process;
      session.globalInstructions = globalInstructions;
      try {
        const init = await process.ready;
        if (init.conversation_id !== session.nativeId) {
          throw backendError('Antigravity restored a different conversation', 'NATIVE_ANTIGRAVITY_INVALID_RESUME');
        }
        session.model = model;
        session.agent = agent;
        session.effort = effort;
        session.firstPrompt = true;
      } catch (error) {
        if (session.process === process) session.process = null;
        await process.stop('interrupt');
        throw error;
      }
    }
    clearTimeout(session.idleTimer);
    return session;
  };

  return {
    store,
    quota,

    catalog: readCatalog,

    listRootSessions(directory) {
      return store.listRootSessions(directory);
    },

    getSession(sessionId, directory) {
      const decoded = decodeNativeSessionId(sessionId);
      if (!decoded || decoded.backend !== 'antigravity') return null;
      return store.getSession(sessionId, decoded.conversationId, directory);
    },

    sessionExists(sessionId, directory) {
      const decoded = decodeNativeSessionId(sessionId);
      if (!decoded || decoded.backend !== 'antigravity') return false;
      return store.sessionExists(sessionId, decoded.conversationId, directory);
    },

    async sessionTasks(sessionId, directory) {
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== 'antigravity') throw sessionNotFoundError(sessionId);
      const snapshot = await store.taskSnapshot(sessionId, decoded.conversationId, directory);
      if (!snapshot) throw sessionNotFoundError(sessionId);
      return snapshot;
    },

    taskOutput(sessionId, directory, taskId, generation) {
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== 'antigravity') throw sessionNotFoundError(sessionId);
      return store.taskOutput(sessionId, decoded.conversationId, directory, taskId, generation);
    },

    async loadHistory(sessionId, directory) {
      const decoded = decodeNativeSessionId(sessionId);
      if (!decoded || decoded.backend !== 'antigravity') return null;
      const history = await store.loadHistory(sessionId, decoded.conversationId, directory);
      const session = sessions.get(sessionId);
      if (history && !session?.turn) {
        session?.lastProjection?.restoreMissingHistory(history.records);
        if (history.interactionProposal) await onInteraction(history.interactionProposal);
      }
      const children = new Map((history?.childSessions ?? []).map((child) => [child.id, child]));
      for (const child of subagents.childrenOf(sessionId)) children.set(child.id, child);
      return history ? { ...history, childSessions: [...children.values()] }
        : subagents.session(sessionId) ? { records: [], childSessions: [...children.values()] } : null;
    },

    async createSession({ directory, title }) {
      const executable = await requireExecutable();
      const globalInstructions = [await readGlobalInstructions(), HEADLESS_INSTRUCTIONS].filter(Boolean).join('\n\n');
      const holder = { session: null };
      const process = startAgyProcess({
        executable,
        args: agyProcessArgs({ cwd: directory, agent: null }),
        cwd: directory,
        env: buildEnv(),
        startupTimeoutMs,
        onFrame: (frame) => holder.session ? enqueue(holder.session, process, () => handleFrame(holder.session, process, frame)) : undefined,
        onExit: (error) => holder.session ? enqueue(holder.session, process, () => handleExit(holder.session, process, error)) : undefined,
      });
      try {
        const init = await process.ready;
        const nativeId = init.conversation_id;
        const sessionId = encodeAntigravitySessionId(nativeId);
        const entry = {
          backend: 'antigravity', nativeId, directory, origin: 'openchamber', createdAt: now(),
          ...(title !== undefined ? { title } : {}),
        };
        await registry.registerSession(sessionId, entry);
        const record = unconfirmedSessionRecord({ sessionId, ...entry });
        holder.session = {
          id: sessionId, nativeId, directory, record, model: null, agent: null, effort: null, process,
          firstPrompt: true, globalInstructions, turn: null, lastProjection: null,
          abortRequested: false, idleWaiters: new Set(), idleTimer: null, queue: Promise.resolve(),
        };
        sessions.set(sessionId, holder.session);
        scheduleIdleClose(holder.session);
        return record;
      } catch (error) {
        await process.stop('interrupt');
        throw error;
      }
    },

    async prompt(sessionId, request, signal = null) {
      if (subagents.session(sessionId)) throw invalidRequestError('Antigravity subagent sessions are read-only');
      const previous = admissions.get(sessionId) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(async () => {
        signal?.throwIfAborted();
        if (request.agent !== 'build' && request.agent !== 'plan') throw invalidRequestError('Antigravity supports build and plan agents only');
        const effort = request.variant ?? null;
        if (effort !== null && !EFFORTS.has(effort)) throw invalidRequestError('Unsupported Antigravity reasoning effort');
        const userText = antigravityPromptText(request.parts);
        let launchModel = request.model.modelID;
        if (effort && /-(low|medium|high|xhigh|max)$/.test(launchModel)) {
          // agy rejects a concrete low slug combined with --effort high. Resolve
          // only aliases the catalog confirmed, including after a cold restore.
          if (!modelAliases) await readCatalog();
          launchModel = modelAliases.get(launchModel) ?? launchModel;
          signal?.throwIfAborted();
        }
        const session = await ensureSession(sessionId, request.directory, launchModel, request.agent, effort);
        signal?.throwIfAborted();
        const nativeText = session.firstPrompt && session.globalInstructions
          ? antigravityPromptText(withInstructions([{ type: 'text', text: userText }], session.globalInstructions))
          : userText;
        const send = {
          messageId: request.messageID,
          providerID: NATIVE_PROVIDER_ANTIGRAVITY,
          modelID: request.model.modelID,
          agent: request.agent,
          ...(request.variant !== undefined ? { variant: request.variant } : {}),
          sentAt: now(),
          antigravity: { fingerprint: antigravityPromptFingerprint(nativeText) },
        };
        const projection = createAntigravityLiveProjection({
          sessionId, nativeId: session.nativeId, directory: session.directory, publisher,
          request: { ...request, sentAt: send.sentAt },
        });
        session.turn = { projection, send, process: session.process, completion: null };
        session.abortRequested = false;
        publisher.records(session.directory, sessionId, projection.records());
        publisher.status(session.directory, sessionId, 'busy');
        let attempted = false;
        try {
          const process = session.process;
          if (!process?.acceptsInput()) throw backendError('Antigravity exited before accepting the prompt');
          await registry.recordSend(sessionId, send);
          signal?.throwIfAborted();
          attempted = true;
          await process.write(nativeText);
          session.firstPrompt = false;
        } catch (error) {
          await finishTurn(session, { outcome: 'error', error: error instanceof Error ? error.message : String(error) });
          if (attempted) throw new NativeAgentError('Antigravity prompt delivery could not be confirmed. Check this conversation before sending again.', { code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN', status: 502 });
          throw error;
        }
      }).finally(() => {
        const session = sessions.get(sessionId);
        if (session && !session.turn) scheduleIdleClose(session);
      });
      admissions.set(sessionId, run);
      try {
        await run;
      } finally {
        if (admissions.get(sessionId) === run) admissions.delete(sessionId);
      }
    },

    async abort(sessionId) {
      if (subagents.session(sessionId)) throw invalidRequestError('Antigravity subagents cannot be stopped independently');
      const session = sessions.get(sessionId);
      const turn = session?.turn;
      if (!turn) return false;
      session.abortRequested = true;
      const process = session.process;
      if (process) await process.stop('interrupt');
      await session.queue;
      if (session.turn === turn) await finishTurn(session, { outcome: 'aborted', error: 'aborted' });
      return true;
    },

    async whenIdle(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.turn) return;
      await new Promise((resolve) => session.idleWaiters.add(resolve));
    },

    liveRecords(sessionId) {
      const session = sessions.get(sessionId);
      return session?.turn?.projection.records() ?? session?.lastProjection?.records() ?? subagents.records(sessionId);
    },

    childSession(sessionId) {
      return subagents.session(sessionId);
    },

    busySessionIds(directory) {
      return [...sessions.values()]
        .filter((session) => session.turn && sameDirectory(session.directory, directory))
        .map((session) => session.id).concat(subagents.busyIds(directory));
    },

    async shutdown() {
      const running = [...sessions.values()];
      await Promise.all(running.map(async (session) => {
        if (session.turn) session.abortRequested = true;
        if (session.process) await session.process.stop(session.turn ? 'interrupt' : 'close');
        await session.queue;
        if (session.turn) await finishTurn(session, { outcome: 'aborted', error: 'aborted' });
      }));
      sessions.clear();
      subagents.clear();
    },
  };
};
