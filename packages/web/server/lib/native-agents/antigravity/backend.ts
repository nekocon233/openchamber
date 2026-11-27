import { backendError, createAntigravityCommandRuntime } from './command-runtime.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prepareAgyDelegation } from './mcp-setup.js';

import {
  decodeNativeSessionId,
  encodeAntigravitySessionId,
  newNativeClientUserMessageId,
  NATIVE_PROVIDER_ANTIGRAVITY,
} from '../ids.js';
import {
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
import { unconfirmedSessionRecord, unknownError } from '../records.js';
import type { NativeSessionRecord, NativeTextPart } from '../records.js';
import type { RegistrySendRecordInput, RegistrySessionInput } from '../registry.js';
import { agyProcessArgs, startAgyProcess } from './process.js';
import type { AgyProcessHandle } from './process.js';
import { resolveAgyCommand } from './command.js';
import { canReuseAntigravitySend, planAntigravityPrompt } from './prompt.js';
import { literalChangeRequestHeaders } from './change-request-context.js';
import { createAntigravityLiveProjection } from './projector.js';
import type { AgyLiveProjection } from './projector.js';
import { createAntigravityStore } from './store.js';
import type { AgyHistoryResult } from './store.js';
import { createAntigravitySubagents } from './subagents.js';
import { agyPermissionError } from './protocol.js';
import type { AgyResult, AgyStreamFrame, AgyTranscriptStep } from './protocol.js';
import { agyMissingFileDetails } from './tools.js';
import { AGY_PLAN_QUESTION_PREFIX } from './interaction-signals.js';
import { captureAntigravityMeasurements } from './measurements.js';
import { antigravityChecklistSnapshot } from './checklist.js';
import type { AgyChecklistSnapshot } from './checklist.js';
import { prepareAgyContextSettings } from './context-settings.js';
import type {
  AgyTurnFinishedSummary,
  CreateAntigravityBackendOptions,
  AntigravityBackend,
  AgySessionState,
} from './backend-contract.js';

interface AgySessionHolder {
  session: AgySessionState | null;
}

const IDLE_CLOSE_MS = 5 * 60_000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const HEADLESS_INSTRUCTIONS = [
  'OpenChamber collects decisions after this headless turn ends. Use ask_question for user questions, then end your response even if the native tool reports User Skipped. The user answer arrives as a later message in this conversation. A skipped question is unanswered and never approval.',
  `When a Plan is ready for approval, call ask_question with exactly one single-select question: question is ${JSON.stringify(AGY_PLAN_QUESTION_PREFIX)} followed by the complete final plan, options are exactly ["build", "plan"], and is_multi_select is false. Then end the response. OpenChamber displays the plan for approval. Do not implement it until a later user message approves it in Build mode. Do not write an implementation_plan.md artifact to request approval.`,
  'Background command completions arrive from the CLI; do not wait by repeatedly calling manage_task or running echo commands.',
].join('\n');

const sameDirectory = (left: string, right: string): boolean => path.resolve(left) === path.resolve(right);

export const createAntigravityBackend = ({
  toolConfiguration = () => null,
  resolveExecutable,
  resolveNodeExecutable = async () => null,
  resolveCommand = resolveAgyCommand,
  buildEnv,
  registry,
  publisher,
  readGlobalInstructions,
  decorateSession,
  onInteraction = async () => undefined,
  onTurnFinished = () => undefined,
  now = Date.now,
  home = null,
  startupTimeoutMs = 30_000,
  prepareContextSettings = prepareAgyContextSettings,
}: CreateAntigravityBackendOptions): AntigravityBackend => {
  const store = createAntigravityStore({ registry, home, now });
  const sessions = new Map<string, AgySessionState>();
  const admissions = new Map<string, Promise<void>>();
  const subagents = createAntigravitySubagents({
    publisher,
    now,
    loadHistory: store.loadHistory,
    readReasoning: store.completedGenerations,
  readActivity: store.readChildActivity,
  });

  const refreshReasoning = (session: AgySessionState, projection: AgyLiveProjection): void => {
    try {
      projection.restoreGenerations(store.completedGenerations(session.nativeId));
    } catch {
      return;
    }
  };

  let modelAliases: Map<string, string> | null = null;

  const { checklistLaunch, requireCommand, commands, quota, readCatalog } = createAntigravityCommandRuntime({
    buildEnv, resolveExecutable, resolveNodeExecutable, resolveCommand, now,
    setModelAliases: (aliases) => { modelAliases = aliases; },
  });

  const eventFailure = (cause: unknown): void => console.warn(
    '[native-agents] Antigravity event handling failed:',
    cause instanceof Error ? cause.message : String(cause),
  );

  const enqueue = (session: AgySessionState, process: AgyProcessHandle, work: () => Promise<void>): Promise<void> => {
    const invoke = async (): Promise<void> => {
      const turn = session.turn?.process === process ? session.turn : null;
      try {
        await work();
      } catch (error) {
        if (!turn || session.turn !== turn) {
          eventFailure(error);
          return;
        }
        void process.stop('interrupt');
        try {
          await finishTurn(session, {
            outcome: session.abortRequested ? 'aborted' : 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (failure) {
          eventFailure(failure);
        }
      }
    };
    const run = session.queue.then(invoke, invoke);
    session.queue = run;
    return run;
  };

  const settleIdle = (session: AgySessionState): void => {
    if (session.turn) return;
    for (const resolve of session.idleWaiters) resolve();
    session.idleWaiters.clear();
  };

  const clearIdleTimer = (session: AgySessionState): void => {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  };

  const scheduleIdleClose = (session: AgySessionState): void => {
    clearIdleTimer(session);
    if (!session.process || session.turn) return;
    session.idleTimer = setTimeout(() => {
      const activeProcess = session.process;
      if (!activeProcess || session.turn) return;
      void activeProcess.stop('close');
    }, IDLE_CLOSE_MS);
    session.idleTimer.unref?.();
  };

  const publishTurnSession = async (session: AgySessionState): Promise<void> => {
    if (store.hasTranscript(session.nativeId)) await registry.confirmSession(session.id);
    const fresh = await store.getSession(session.id, session.nativeId, session.directory).catch(() => null);
    const record: NativeSessionRecord = fresh ?? {
      ...session.record,
      time: { ...session.record.time, updated: now() },
    };
    session.record = record;
    publisher.session(session.directory, await decorateSession(record), { created: false });
  };

  const finishTurn = async (
    session: AgySessionState,
    {
      outcome,
      response = '',
      error = '',
      responseStep = null,
    }: {
      outcome: 'success' | 'error' | 'aborted';
      response?: string | undefined;
      error?: string | undefined;
      responseStep?: AgyTranscriptStep | null | undefined;
    },
  ): Promise<void> => {
    const turn = session.turn;
    if (!turn) return;
    if (turn.completion) return turn.completion;
    if (turn.send.antigravity?.manualCompaction) void turn.process?.stop('close');
    turn.completion = (async () => {
      turn.projection.finish({ outcome, response, error, responseStep, time: now() });
      let completionSaved = false;
      try {
        await registry.recordSend(session.id, {
          ...turn.send,
          antigravity: {
            ...turn.send.antigravity,
            completion: { outcome, time: now() },
            measurements: captureAntigravityMeasurements(turn.projection.records(), turn.send.messageId),
          },
        });
        completionSaved = true;
      } catch (failure) {
        eventFailure(failure);
      }
      let history: AgyHistoryResult | null = null;
      try {
        history = await store.loadHistory(session.id, session.nativeId, session.directory);
        if (history) turn.projection.restoreMissingHistory(history.records);
        if (history) {
          let checklist: AgyChecklistSnapshot | null = null;
          try {
            checklist = antigravityChecklistSnapshot({
              sessionId: session.id,
              records: history.records,
              complete: history.metadataComplete !== false,
              observedAt: now(),
            });
          } catch {
            checklist = null;
          }
          if (checklist?.state === 'ready') publisher.checklist(session.directory, session.id, checklist);
        }
        const tasks = await store.taskSnapshot(session.id, session.nativeId, session.directory);
        if (tasks) publisher.tasks(session.directory, session.id, tasks);
      } catch {
        history = null;
      }
      const reply = turn.projection.finalReply();
      try {
        const summaryPart = reply?.parts.findLast((part): part is NativeTextPart => (
          part.type === 'text' && !part.synthetic && !part.metadata?.nativeSubagentMessage
        ));
        const summary: AgyTurnFinishedSummary = {
          summary: summaryPart?.text ?? '',
          status: outcome === 'success' ? 'completed' : 'interrupted',
        };
        if (reply?.info.id !== undefined) summary.id = reply.info.id;
        await onTurnFinished(session.id, session.directory, summary);
      } catch (failure) {
        eventFailure(failure);
      }
      session.turn = null;
      session.abortRequested = false;
      if (turn.process) subagents.release(session.id, turn.process);
      session.lastProjection = turn.projection;
      try {
        if (outcome === 'success' && completionSaved && history?.interactionProposal) {
          try {
            await onInteraction(history.interactionProposal);
          } catch (failure) {
            publisher.error(session.directory, session.id, unknownError(failure instanceof Error ? failure.message : String(failure)));
          }
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

  const handleResult = async (session: AgySessionState, process: AgyProcessHandle, result: AgyResult): Promise<void> => {
    const turn = session.turn;
    if (!turn || turn.process !== process || result.conversation_id !== session.nativeId) return;
    const interrupted = result.status === 'CANCELED'
      || result.status === 'INTERRUPTED'
      || result.error === 'interrupted'
      || session.abortRequested;
    let outcome: 'success' | 'aborted' | 'error' = result.status === 'SUCCESS' ? 'success' : interrupted ? 'aborted' : 'error';
    let responseStep: AgyTranscriptStep | null = null;
    try {
      responseStep = store.finalResponse(session.nativeId, turn.projection.userStepIndex(), {
        allowTruncatedContent: result.status === 'SUCCESS',
      });
    } catch {
      responseStep = null;
    }
    const recoverableError = /stream was interrupted/i.test(result.error ?? '')
      || /^Your previous response was cut off because it exceeded the output token limit\r?\nPlease continue from where you left off, keeping your response shorter(?:\r?\nRetries remaining: \d+)?$/.test(result.error ?? '');
    if (outcome === 'error' && result.status === 'ERROR' && recoverableError && responseStep) outcome = 'success';
    let error = result.error || (outcome === 'aborted' ? 'aborted' : 'Antigravity turn failed');
    if (outcome === 'success' && !responseStep && result.response.trim() === '' && result.denied_actions.length > 0) {
      const denial = {
        actions: [...new Set(result.denied_actions.map((action) => action.action.slice(0, 256)))].slice(0, 32),
        time: now(),
      };
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
        ? (responseStep.content ?? '')
        : result.response,
      responseStep,
      error,
    });
  };

  const handleExit = async (session: AgySessionState, process: AgyProcessHandle, error: Error | null): Promise<void> => {
    subagents.release(session.id, process);
    subagents.forget(session.id, process);
    if (session.process === process) {
      clearIdleTimer(session);
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

  const handleFrame = async (session: AgySessionState, process: AgyProcessHandle, frame: AgyStreamFrame): Promise<void> => {
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
    const tool = await turn.projection.applyStep(step, now(), async (stepIndex) => {
      await registry.bindAntigravityMessage(session.id, turn.send.messageId, stepIndex, turn.send);
    });
    const settledTool = tool && (step.state === 'DONE' || step.state === 'ERROR' || step.state === 'INVALID');
    if (step.step_type === 'agent_response' && step.state === 'DONE') {
      refreshReasoning(session, turn.projection);
      turn.reasoningAfterTool = true;
    } else if (settledTool && agyMissingFileDetails(tool)) {
      refreshReasoning(session, turn.projection);
      turn.reasoningAfterTool = agyMissingFileDetails(turn.projection.toolPart(tool.id));
    } else if (settledTool && turn.reasoningAfterTool) {
      turn.reasoningAfterTool = false;
      refreshReasoning(session, turn.projection);
    }
  };

  const ensureSession = async (
    sessionId: string,
    directory: string,
    model: string,
    agent: 'build' | 'plan',
    effort: string | null,
    manualCompaction: boolean,
  ): Promise<AgySessionState> => {
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
    const activeSession = session;
    if (!sameDirectory(activeSession.directory, directory)) {
      throw invalidRequestError('Antigravity session directory does not match the request');
    }
    if (activeSession.turn) throw sessionBusyError();
    if (activeSession.process && !activeSession.process.acceptsInput()) {
      const previous = activeSession.process;
      await previous.exited;
      if (activeSession.process === previous) activeSession.process = null;
      activeSession.firstPrompt = true;
    }
    const tools = toolConfiguration(sessionId);
    const toolKey = tools?.key ?? '';
    const context = await prepareContextSettings({ home, modelId: model });
    let adopted = false;
    try {
      if (activeSession.process && (manualCompaction || activeSession.manualCompactionProcess || activeSession.model !== model || activeSession.agent !== agent || activeSession.effort !== effort
        || (activeSession.toolKey ?? '') !== toolKey
        || !isDeepStrictEqual(activeSession.contextSettings ?? null, context?.data ?? null))) {
        const previous = activeSession.process;
        await previous.stop('close');
        if (activeSession.process === previous) activeSession.process = null;
        activeSession.firstPrompt = true;
      }
      if (!activeSession.process) {
        const command = await requireCommand();
        const checklist = await checklistLaunch(activeSession.directory);
        if (tools) await prepareAgyDelegation(tools, buildEnv());
        const globalInstructions = [
          await readGlobalInstructions(),
          HEADLESS_INSTRUCTIONS,
          checklist.instructions,
          tools?.child ? 'This is a delegated subagent task. Report your findings or plan to the parent. Do not request approval to execute a plan and do not create subagents.' : null,
        ].filter(Boolean).join('\n\n');
        const agyProcess = startAgyProcess({
          executable: command.executable,
          args: [
            ...command.argsPrefix,
            ...agyProcessArgs({
              cwd: activeSession.directory,
              model,
              conversationId: activeSession.nativeId,
              agent,
              effort,
              settingsFile: context?.file ?? null,
              allowSlashCommands: manualCompaction,
            }),
          ],
          cwd: activeSession.directory,
          env: { ...checklist.env, ...tools?.env, OPENCHAMBER_DELEGATION_CHILD: tools?.child ? '1' : '0' },
          startupTimeoutMs,
          onFrame: (frame) => {
            void enqueue(activeSession, agyProcess, () => handleFrame(activeSession, agyProcess, frame));
          },
          onExit: (error) => {
            void enqueue(activeSession, agyProcess, async () => {
              if (context) await context.cleanup().catch(eventFailure);
              await handleExit(activeSession, agyProcess, error);
            });
          },
        });
        adopted = true;
        activeSession.process = agyProcess;
        activeSession.manualCompactionProcess = manualCompaction;
        activeSession.toolKey = toolKey;
        activeSession.contextSettings = context?.data ?? null;
        activeSession.globalInstructions = globalInstructions;
        try {
          const init = await agyProcess.ready;
          if (init.conversation_id !== activeSession.nativeId) {
            throw backendError('Antigravity restored a different conversation', 'NATIVE_ANTIGRAVITY_INVALID_RESUME');
          }
          activeSession.model = model;
          activeSession.agent = agent;
          activeSession.effort = effort;
          activeSession.firstPrompt = true;
        } catch (error) {
          if (activeSession.process === agyProcess) activeSession.process = null;
          await agyProcess.stop('interrupt');
          throw error;
        }
      }
      clearIdleTimer(activeSession);
      return activeSession;
    } finally {
      if (context && !adopted) await context.cleanup().catch(eventFailure);
    }
  };

  return {
    store,
    commands: commands.list,
    commandParts: commands.promptParts,
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

    async checklist(sessionId, directory) {
      const decoded = decodeNativeSessionId(sessionId);
      if (decoded?.backend !== 'antigravity') throw sessionNotFoundError(sessionId);
      const history = await store.loadHistory(sessionId, decoded.conversationId, directory);
      if (!history) throw sessionNotFoundError(sessionId);
      const session = sessions.get(sessionId);
      const live = session?.turn?.projection ?? session?.lastProjection;
      return antigravityChecklistSnapshot({
        sessionId,
        records: [...history.records, ...(live?.records() ?? [])],
        complete: history.metadataComplete !== false,
        observedAt: now(),
      });
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
      if (history) {
        if (session?.turn) refreshReasoning(session, session.turn.projection);
        else subagents.refreshReasoning(sessionId);
      }
      if (history && !session?.turn) {
        session?.lastProjection?.restoreMissingHistory(history.records);
        if (history.interactionProposal) await onInteraction(history.interactionProposal);
      }
      const children = new Map((history?.childSessions ?? []).map((child) => [child.id, child]));
      for (const child of subagents.childrenOf(sessionId)) children.set(child.id, child);
      return history
        ? { ...history, childSessions: [...children.values()] }
        : subagents.session(sessionId)
          ? { records: [], childSessions: [...children.values()] }
          : null;
    },

    async createSession({ directory, title }) {
      const command = await requireCommand();
      const checklist = await checklistLaunch(directory);
      const globalInstructions = [await readGlobalInstructions(), HEADLESS_INSTRUCTIONS, checklist.instructions].filter(Boolean).join('\n\n');
      const holder: AgySessionHolder = { session: null };
      const agyProcess = startAgyProcess({
        executable: command.executable,
        args: [...command.argsPrefix, ...agyProcessArgs({ cwd: directory, agent: null })],
        cwd: directory,
        env: checklist.env,
        startupTimeoutMs,
        onFrame: (frame) => {
          const active = holder.session;
          if (active) void enqueue(active, agyProcess, () => handleFrame(active, agyProcess, frame));
        },
        onExit: (error) => {
          const active = holder.session;
          if (active) void enqueue(active, agyProcess, () => handleExit(active, agyProcess, error));
        },
      });
      try {
        const init = await agyProcess.ready;
        const nativeId = init.conversation_id;
        const sessionId = encodeAntigravitySessionId(nativeId);
        const entry: RegistrySessionInput = {
          backend: 'antigravity',
          nativeId,
          directory,
          origin: 'openchamber',
          createdAt: now(),
        };
        if (title !== undefined) entry.title = title;
        await registry.registerSession(sessionId, entry);
        const record = unconfirmedSessionRecord({ sessionId, ...entry });
        const createdSession: AgySessionState = {
          id: sessionId,
          nativeId,
          directory,
          record,
          model: null,
          agent: null,
          effort: null,
          process: agyProcess,
          firstPrompt: true,
          globalInstructions,
          turn: null,
          lastProjection: null,
          abortRequested: false,
          idleWaiters: new Set(),
          idleTimer: null,
          queue: Promise.resolve(),
        };
        holder.session = createdSession;
        sessions.set(sessionId, createdSession);
        scheduleIdleClose(createdSession);
        return record;
      } catch (error) {
        await agyProcess.stop('interrupt');
        throw error;
      }
    },

    async prompt(sessionId, request, signal = null) {
      if (subagents.session(sessionId)) throw invalidRequestError('Antigravity subagent sessions are read-only');
      const previous = admissions.get(sessionId) ?? Promise.resolve();
      let cleanupImages: (() => Promise<void>) | undefined;
      let attempted = false;
      const run = previous.catch(() => undefined).then(async () => {
        signal?.throwIfAborted();
        if (request.agent !== 'build' && request.agent !== 'plan') {
          throw invalidRequestError('Antigravity supports build and plan agents only');
        }
        const effort = request.variant ?? null;
        if (effort !== null && !EFFORTS.has(effort)) throw invalidRequestError('Unsupported Antigravity reasoning effort');
        const prompt = planAntigravityPrompt(request.parts);
        const requestFingerprint = createHash('sha256').update(JSON.stringify([
          request.model.providerID, request.model.modelID, request.agent, effort, prompt.fingerprintText,
        ])).digest('hex');
        const previousSend = (await registry.sendRecords(sessionId)).get(request.messageID);
        if (previousSend) {
          const decoded = decodeNativeSessionId(sessionId);
          const owner = sessions.get(sessionId)?.directory ?? (await registry.getSession(sessionId))?.directory
            ?? (decoded?.backend === 'antigravity' ? (await store.getSession(sessionId, decoded.conversationId, request.directory))?.directory : undefined);
          if (!owner || !sameDirectory(owner, request.directory)) throw sessionNotFoundError(sessionId);
          if (canReuseAntigravitySend(previousSend.antigravity, requestFingerprint)) return;
        }
        let launchModel = request.model.modelID;
        if (effort && /-(low|medium|high|xhigh|max)$/.test(launchModel)) {
          if (!modelAliases) await readCatalog();
          launchModel = modelAliases?.get(launchModel) ?? launchModel;
          signal?.throwIfAborted();
        }
        let session: AgySessionState;
        try {
          session = await ensureSession(sessionId, request.directory, launchModel, request.agent, effort, request.manualCompaction === true);
        } catch (error) {
          if (error instanceof NativeAgentError) throw error;
          throw backendError(error instanceof Error ? error.message : String(error));
        }
        signal?.throwIfAborted();
        const prepared = await prompt.materialize();
        cleanupImages = prepared.cleanup;
        const nativeText = !request.manualCompaction && session.firstPrompt && session.globalInstructions
          ? `${prepared.text}\n\n${antigravityPromptText(withInstructions([], session.globalInstructions))}`
          : prepared.text;
        const send: RegistrySendRecordInput = {
          messageId: request.messageID,
          providerID: NATIVE_PROVIDER_ANTIGRAVITY,
          modelID: request.model.modelID,
          agent: request.agent,
          sentAt: now(),
          antigravity: { fingerprint: antigravityPromptFingerprint(nativeText), requestFingerprint, inputDelivery: 'reserved' },
        };
        if (request.manualCompaction && send.antigravity) send.antigravity.manualCompaction = true;
        const literalHeaders = literalChangeRequestHeaders(request.parts);
        if (literalHeaders !== undefined && send.antigravity) send.antigravity.literalChangeRequestHeaders = literalHeaders;
        if (request.variant !== undefined) send.variant = request.variant;
        const projection = createAntigravityLiveProjection({
          sessionId,
          nativeId: session.nativeId,
          directory: session.directory,
          publisher,
          request: { ...request, sentAt: send.sentAt },
        });
        session.turn = { projection, send, process: session.process, completion: null };
        subagents.beginTurn(session.id, session.process, send.sentAt);
        session.abortRequested = false;
        publisher.records(session.directory, sessionId, projection.records());
        publisher.status(session.directory, sessionId, 'busy');
        try {
          const currentProcess = session.process;
          if (!currentProcess?.acceptsInput()) throw backendError('Antigravity exited before accepting the prompt');
          await registry.recordSend(sessionId, send);
          signal?.throwIfAborted();
          attempted = true;
          await currentProcess.write(nativeText);
          session.firstPrompt = false;
        } catch (error) {
          if (!attempted && send.antigravity) send.antigravity.inputDelivery = 'not-written';
          await finishTurn(session, { outcome: 'error', error: error instanceof Error ? error.message : String(error) });
          if (attempted) {
            throw new NativeAgentError(
              'Antigravity prompt delivery could not be confirmed. Check this conversation before sending again.',
              { code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN', status: 502 },
            );
          }
          throw error;
        }
        try {
          if (send.antigravity) send.antigravity.inputDelivery = 'written';
          await registry.recordSend(sessionId, send);
        } catch {
          throw new NativeAgentError('Antigravity accepted the prompt but its receipt could not be saved.', {
            code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN', status: 502,
          });
        }
      }).finally(async () => {
        if (!attempted) await cleanupImages?.().catch(eventFailure);
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

    async compact(sessionId, request) {
      if (request.instructions !== undefined) throw invalidRequestError('Antigravity compacts without instructions');
      return this.prompt(sessionId, {
        ...request, messageID: newNativeClientUserMessageId(sessionId), manualCompaction: true,
        parts: [{ type: 'text', text: '/compact' }],
      });
    },

    async abort(sessionId) {
      if (subagents.session(sessionId)) throw invalidRequestError('Antigravity subagents cannot be stopped independently');
      const session = sessions.get(sessionId);
      const turn = session?.turn;
      if (!session || !turn) return false;
      session.abortRequested = true;
      const activeProcess = session.process;
      if (activeProcess) await activeProcess.stop('interrupt');
      await session.queue;
      if (session.turn === turn) await finishTurn(session, { outcome: 'aborted', error: 'aborted' });
      return true;
    },

    async whenIdle(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.turn) return;
      await new Promise<void>((resolve) => session.idleWaiters.add(resolve));
    },

    async closeSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.turn || admissions.has(sessionId)) throw sessionBusyError();
      clearIdleTimer(session);
      const activeProcess = session.process;
      if (activeProcess) await activeProcess.stop('close');
      await session.queue;
      if (session.process === activeProcess) session.process = null;
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
        .map((session) => session.id)
        .concat(subagents.busyIds(directory));
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

export type {
  AgyToolConfiguration,
  AgyBackendRegistry,
  AgyBackendPublisher,
  AgyTurnFinishedSummary,
  AgyBackendPromptRequest,
  CreateAntigravityBackendOptions,
  AntigravityBackend,
} from './backend-contract.js';
