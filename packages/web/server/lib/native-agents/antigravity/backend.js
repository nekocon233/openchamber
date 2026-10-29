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

const MINIMUM_VERSION = [1, 1, 15];
const IDLE_CLOSE_MS = 5 * 60_000;

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

const modelDescriptor = (id, name) => ({
  id,
  name,
  contextWindow: null,
  outputLimit: null,
  efforts: [],
  defaultEffort: null,
  fast: false,
  input: { image: false, pdf: false },
});

const sameDirectory = (left, right) => path.resolve(left) === path.resolve(right);

export const createAntigravityBackend = ({
  resolveExecutable,
  buildEnv,
  registry,
  publisher,
  readGlobalInstructions,
  decorateSession,
  now = Date.now,
  home = null,
  startupTimeoutMs = 30_000,
}) => {
  const store = createAntigravityStore({ registry, home, now });
  const sessions = new Map();

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
      const deadline = setTimeout(() => {
        signalCliProcess(child, 'SIGKILL');
        reject(backendError(`Antigravity discovery timed out: ${args.join(' ')}`, 'NATIVE_ANTIGRAVITY_PROBE_TIMEOUT'));
      }, 10_000);
      deadline.unref?.();
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
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

  const enqueue = (session, work) => {
    const run = session.queue.then(work, work).catch(async (error) => {
      if (session.turn) {
        await finishTurn(session, {
          outcome: session.abortRequested ? 'aborted' : 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      console.warn('[native-agents] Antigravity event handling failed:', error instanceof Error ? error.message : error);
    });
    session.queue = run;
    return run;
  };

  const settleIdle = (session) => {
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

  const finishTurn = async (session, { outcome, response = '', error = '' }) => {
    const turn = session.turn;
    if (!turn) return;
    session.turn = null;
    turn.projection.finish({ outcome, response, error, time: now() });
    session.lastProjection = turn.projection;
    publisher.status(session.directory, session.id, 'idle');
    if (outcome === 'error') publisher.error(session.directory, session.id, unknownError(error));
    try {
      await publishTurnSession(session);
    } finally {
      settleIdle(session);
      scheduleIdleClose(session);
    }
  };

  const handleResult = async (session, process, result) => {
    const turn = session.turn;
    if (!turn || turn.process !== process || result.conversation_id !== session.nativeId) return;
    const interrupted = result.status === 'CANCELED'
      || result.status === 'INTERRUPTED'
      || result.error === 'interrupted'
      || session.abortRequested;
    let outcome = result.status === 'SUCCESS' ? 'success' : interrupted ? 'aborted' : 'error';
    if (outcome === 'error' && turn.projection.userStepIndex() !== null) {
      const complete = await store.hasCompleteTurn(session.nativeId, turn.projection.userStepIndex());
      if (complete) outcome = 'success';
    }
    if (result.status !== 'SUCCESS' && session.process) void session.process.stop('close');
    await finishTurn(session, {
      outcome,
      response: result.response,
      error: result.error || (outcome === 'aborted' ? 'aborted' : 'Antigravity turn failed'),
    });
    session.abortRequested = false;
  };

  const handleExit = async (session, process, error) => {
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
      session.abortRequested = false;
    }
  };

  const handleFrame = async (session, process, frame) => {
    if (frame.event === 'init') return;
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

  const ensureSession = async (sessionId, directory, model) => {
    let session = sessions.get(sessionId);
    if (!session) {
      const decoded = decodeNativeSessionId(sessionId);
      if (!decoded || decoded.backend !== 'antigravity') throw sessionNotFoundError(sessionId);
      const record = await store.getSession(sessionId, decoded.conversationId, directory);
      if (!record) throw sessionNotFoundError(sessionId);
      session = {
        id: sessionId,
        nativeId: decoded.conversationId,
        directory: record.directory,
        record,
        model: null,
        process: null,
        firstPrompt: true,
        turn: null,
        lastProjection: null,
        abortRequested: false,
        idleWaiters: new Set(),
        idleTimer: null,
        queue: Promise.resolve(), admission: Promise.resolve(),
      };
      sessions.set(sessionId, session);
    }
    if (session.turn) throw sessionBusyError();
    if (session.process && !session.process.acceptsInput()) {
      const previous = session.process;
      await previous.exited;
      if (session.process === previous) session.process = null;
      session.firstPrompt = true;
    }
    if (session.process && session.model !== model) {
      const previous = session.process;
      await previous.stop('close');
      if (session.process === previous) session.process = null;
      session.firstPrompt = true;
    }
    if (!session.process) {
      const executable = await requireExecutable();
      const globalInstructions = await readGlobalInstructions();
      const process = startAgyProcess({
        executable,
        args: agyProcessArgs({ cwd: session.directory, model, conversationId: session.nativeId }),
        cwd: session.directory,
        env: buildEnv(),
        startupTimeoutMs,
        onFrame: (frame) => enqueue(session, () => handleFrame(session, process, frame)),
        onExit: (error) => enqueue(session, () => handleExit(session, process, error)),
      });
      session.process = process;
      session.globalInstructions = globalInstructions;
      try {
        const init = await process.ready;
        if (init.conversation_id !== session.nativeId) {
          throw backendError('Antigravity restored a different conversation', 'NATIVE_ANTIGRAVITY_INVALID_RESUME');
        }
        session.model = model;
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

    async catalog() {
      const version = (await probe(['--version'])).trim();
      if (!versionSupported(version)) {
        throw backendError(`Antigravity ${version || 'version'} is unsupported. Update agy to 1.1.15 or later.`, 'NATIVE_ANTIGRAVITY_VERSION');
      }
      const output = await probe(['models']);
      const models = [];
      const seen = new Set();
      for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
        const [id, name, ...extra] = line.split('\t');
        if (!id || !name || extra.length > 0 || seen.has(id)) {
          throw backendError('Invalid `agy models` output', 'NATIVE_ANTIGRAVITY_CATALOG');
        }
        seen.add(id);
        models.push(modelDescriptor(id, name));
      }
      return models;
    },

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

    loadHistory(sessionId, directory) {
      const decoded = decodeNativeSessionId(sessionId);
      if (!decoded || decoded.backend !== 'antigravity') return null;
      return store.loadHistory(sessionId, decoded.conversationId, directory);
    },

    async createSession({ directory, title }) {
      const executable = await requireExecutable();
      const globalInstructions = await readGlobalInstructions();
      const holder = { session: null };
      const process = startAgyProcess({
        executable,
        args: agyProcessArgs({ cwd: directory }),
        cwd: directory,
        env: buildEnv(),
        startupTimeoutMs,
        onFrame: (frame) => holder.session ? enqueue(holder.session, () => handleFrame(holder.session, process, frame)) : undefined,
        onExit: (error) => holder.session ? enqueue(holder.session, () => handleExit(holder.session, process, error)) : undefined,
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
          id: sessionId, nativeId, directory, record, model: null, process,
          firstPrompt: true, globalInstructions, turn: null, lastProjection: null,
          abortRequested: false, idleWaiters: new Set(), idleTimer: null, queue: Promise.resolve(), admission: Promise.resolve(),
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
      const existing = sessions.get(sessionId);
      const previous = existing?.admission ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(async () => {
        signal?.throwIfAborted();
        if (request.agent !== 'build') throw invalidRequestError('Antigravity supports the build agent only');
        const session = await ensureSession(sessionId, request.directory, request.model.modelID);
        signal?.throwIfAborted();
        const globalParts = session.firstPrompt && session.globalInstructions
          ? withInstructions(request.parts, session.globalInstructions)
          : request.parts;
        const nativeText = antigravityPromptText(globalParts);
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
        session.turn = { projection, send, process: session.process };
        session.abortRequested = false;
        publisher.records(session.directory, sessionId, projection.records());
        publisher.status(session.directory, sessionId, 'busy');
        try {
          const process = session.process;
          if (!process) throw backendError('Antigravity exited before accepting the prompt');
          signal?.throwIfAborted();
          await process.write(nativeText);
          session.firstPrompt = false;
        } catch (error) {
          await finishTurn(session, { outcome: 'error', error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
      if (existing) existing.admission = run.catch(() => undefined);
      return run;
    },

    async abort(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.turn) return false;
      session.abortRequested = true;
      const process = session.process;
      if (process) await process.stop('interrupt');
      await session.queue;
      if (session.turn) await finishTurn(session, { outcome: 'aborted', error: 'aborted' });
      return true;
    },

    async whenIdle(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.turn) return;
      await new Promise((resolve) => session.idleWaiters.add(resolve));
    },

    liveRecords(sessionId) {
      const session = sessions.get(sessionId);
      return session?.turn?.projection.records() ?? session?.lastProjection?.records() ?? [];
    },

    childSession() {
      return null;
    },

    busySessionIds(directory) {
      return [...sessions.values()]
        .filter((session) => session.turn && sameDirectory(session.directory, directory))
        .map((session) => session.id);
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
    },
  };
};
