import { z } from 'zod';

import type { JsonObject } from '../../shared/json-values.js';
import { CODEX_STANDARD_SERVICE_TIER } from '../catalog.js';
import { invalidRequestError, sessionBusyError } from '../errors.js';
import { codexPartId, decodeNativeSessionId, encodeCodexSessionId, isNativeClientUserMessageId } from '../ids.js';
import { buildSessionRecord, stoppedError, unknownError } from '../records.js';
import { codexPlanItemSchema, codexQuestionItem, codexSkillId, partsForCodexItem } from './items.js';
import { createCodexPlanTodos, type CodexPlanTodosSnapshot } from './plan-todos.js';
import { isCodexAssistantRecord, projectCodexTurns, type CodexProjectedRecord } from './projector.js';
import { JsonRpcError, type JsonRpcResult } from './rpc.js';
import { createCodexTurnDetails, type CodexTurnDetails } from './history-details.js';
import { codexUsageNotification, observeCodexUsage } from './usage.js';
import type { CodexPlan } from './plan-decisions.js';
import type {
  CodexLiveConfig,
  CodexLiveQuestionAskInput,
  CodexLiveThreadsOptions,
  CodexLivePromptInput,
  CodexLiveReviewInput,
  LiveItem,
  TurnError,
  LiveTurn,
  LiveThread,
  ThreadResumeParams,
  TurnStartParams,
} from './live-contracts.js';
import {
  APPROVAL_POLICY,
  FULL_ACCESS_SANDBOX,
  turnParams,
  itemParams,
  textDeltaParams,
  indexedDeltaParams,
  threadStatusParams,
  childThreadStartedParams,
  threadClosedParams,
  planParams,
  startedTurn,
  resumedThread,
  userInputRequest,
  skillInput,
} from './live-contracts.js';

const DEFAULT_CODEX_PROVIDER = 'openai';
const TURN_NOT_FOUND = /^turn not found/;

export interface CodexThreadTools {
  child: boolean;
  key: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type CodexThreadToolConfig = {
  'features.multi_agent': false;
  'mcp_servers.openchamber_subagents'?: {
    command: string;
    args: string[];
    env: Record<string, string>;
    tool_timeout_sec: number;
  };
};

export const codexThreadToolConfig = (tools: CodexThreadTools | null | undefined): CodexThreadToolConfig | undefined => {
  if (!tools) return undefined;
  const config: CodexThreadToolConfig = { 'features.multi_agent': false };
  if (!tools.child) config['mcp_servers.openchamber_subagents'] = {
    command: tools.command,
    args: tools.args,
    env: tools.env,
    tool_timeout_sec: 3600,
  };
  return config;
};

const textField = z.string().catch('');
const textListField = z.array(z.string()).catch([]);

const appendAt = (list: readonly string[], index: number, delta: string): string[] => {
  const next = [...list];
  while (next.length <= index) next.push('');
  next[index] = `${next[index] ?? ''}${delta}`;
  return next;
};

export const createCodexLiveThreads = ({
  toolConfiguration = () => null,
  request,
  readGlobalInstructions = async () => null,
  readTurnDetails = async () => null,
  publisher,
  questions,
  onTurnFinished = () => {},
  onIdle = () => {},
  onPlanReady = () => {},
  onSessionClosed = () => {},
  now = Date.now,
}: CodexLiveThreadsOptions) => {
  const threads = new Map<string, LiveThread>();
  let todoRevision = 0;

  const project = (live: LiveThread, turn: LiveTurn | null = live.turn, detail: CodexTurnDetails | undefined = turn?.detail): CodexProjectedRecord[] => {
    if (!turn) return [];
    const resolvedDetail = detail ?? turn.detail;
    const records = projectCodexTurns({
      sessionId: live.sessionId,
      threadId: live.threadId,
      cwd: live.directory,
      turns: [{
        id: turn.id,
        items: turn.order.map((id) => turn.items.get(id)).filter((item): item is LiveItem => item !== undefined),
        status: turn.status,
        error: turn.error,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
      }],
      threadModel: live.config?.model ?? '',
      sendRecordFor: (messageId) => live.sends.get(messageId) ?? null,
      itemTimes: turn.itemTimes,
      details: new Map([[turn.id, resolvedDetail]]),
    });
    if (turn === live.turn) live.messageOfPart = new Map(records.flatMap((record) => record.parts.map((part) => [part.id, record.info.id])));
    return records;
  };

  const publishTurn = (live: LiveThread) => publisher.records(live.directory, live.sessionId, project(live));

  const setBusy = (live: LiveThread, busy: boolean, error: { name: string; data: { message: string } } | null = null) => {
    if (live.busy === busy) return;
    live.busy = busy;
    if (!busy) questions.rejectSession(live.sessionId);
    publisher.status(live.directory, live.sessionId, busy ? 'busy' : 'idle');
    if (error !== null && error.name !== 'MessageAbortedError') publisher.error(live.directory, live.sessionId, error);
    if (busy) return;
    onIdle(live.sessionId, live.directory);
    for (const resolve of live.idleWaiters.splice(0)) resolve();
  };

  const upsertItem = (live: LiveThread, item: LiveItem) => {
    const activeTurn = live.turn;
    if (!activeTurn) return;
    if (!activeTurn.items.has(item.id)) activeTurn.order.push(item.id);
    activeTurn.items.set(item.id, item);
  };

  const threadFor = (sessionId: string): string => {
    const decoded = decodeNativeSessionId(sessionId);
    if (!decoded || decoded.backend !== 'codex') throw invalidRequestError(`Not a Codex session: ${sessionId}`);
    return decoded.threadId;
  };

  const ensureLoaded = async (live: LiveThread): Promise<void> => {
    if (live.loaded) return;
    const tools = toolConfiguration(live.sessionId);
    const resume: ThreadResumeParams = {
      threadId: live.threadId,
      excludeTurns: true,
      approvalPolicy: APPROVAL_POLICY,
      sandbox: FULL_ACCESS_SANDBOX,
    };
    const instructions = await readGlobalInstructions();
    if (instructions) resume.developerInstructions = instructions;
    const toolConfig = codexThreadToolConfig(tools);
    if (toolConfig) resume.config = toolConfig;
    const resumed = resumedThread.safeParse(await request('thread/resume', resume));
    live.serviceTier = resumed.success ? resumed.data.serviceTier ?? null : null;
    live.modelProvider = resumed.success ? resumed.data.modelProvider ?? null : null;
    live.loaded = true;
    live.toolKey = tools?.key ?? '';
  };

  const applyProvider = async (live: LiveThread, config: CodexLiveConfig): Promise<void> => {
    const target = config.providerId ?? DEFAULT_CODEX_PROVIDER;
    if (live.modelProvider === null || live.modelProvider === target) return;
    await request('thread/settings/update', {
      threadId: live.threadId,
      cwd: live.directory,
      model: config.model,
      modelProvider: target,
      approvalPolicy: APPROVAL_POLICY,
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    live.modelProvider = target;
  };

  const liveThread = (sessionId: string, directory: string): LiveThread => {
    const threadId = threadFor(sessionId);
    let live = threads.get(threadId);
    if (!live) {
      const todos = createCodexPlanTodos({
        nextRevision: () => (todoRevision += 1),
        publish: (snapshot) => publisher.todos(directory, sessionId, snapshot),
      });
      live = {
        threadId,
        sessionId,
        directory,
        loaded: false,
        serviceTier: null,
        modelProvider: null,
        toolKey: '',
        busy: false,
        turn: null,
        config: null,
        pendingPlanningSend: null,
        childSession: null,
        sends: new Map(),
        messageOfPart: new Map(),
        idleWaiters: [],
        todos,
        pendingSkills: [],
        telemetryRevision: 0,
      };
      threads.set(threadId, live);
    }
    return live;
  };

  const settleTurn = (live: LiveThread, turn: { status: string; error?: TurnError | null | undefined; completedAt?: number | null | undefined }, withTelemetry = false) => {
    const activeTurn = live.turn;
    if (!activeTurn) return;
    for (const entry of activeTurn.detail.extraItems) {
      if (entry.item.type === 'openchamberQuestion' && entry.item.resolution === 'pending') entry.item.resolution = 'interrupted';
    }
    activeTurn.status = turn.status;
    activeTurn.error = turn.error ?? null;
    activeTurn.completedAt = turn.completedAt ?? Math.floor(now() / 1000);
    const completedTurn = activeTurn;
    const completedRecords = project(live);
    publisher.records(live.directory, live.sessionId, completedRecords);
    const revision = live.telemetryRevision;
    if (withTelemetry && completedRecords.some(isCodexAssistantRecord)) void readTurnDetails(live.sessionId, completedTurn.id).then((detail) => {
      if (!detail || threads.get(live.threadId) !== live || live.telemetryRevision !== revision) return;
      const completedIds = new Set(completedRecords.map((record) => record.info.id));
      for (const record of project(live, completedTurn, detail)) {
        if (!isCodexAssistantRecord(record) || !completedIds.has(record.info.id)) continue;
        const telemetry = record.info.metadata.openchamber.telemetry;
        if (telemetry.toolWaitDurationMs === null) continue;
        publisher.emit(live.directory, 'message.patched', {
          sessionID: live.sessionId,
          messageID: record.info.id,
          patch: { telemetry },
        });
      }
    }).catch(() => undefined);
    const error = turn.status === 'failed'
      ? unknownError(turn.error?.message ?? 'Codex turn failed')
      : turn.status === 'interrupted' ? stoppedError() : null;
    live.turn = null;
    setBusy(live, false, error);
  };

  const startTurn = (live: LiveThread, turn: { id: string; startedAt?: number | null | undefined }) => {
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
      planningSend: live.pendingPlanningSend,
      detail: createCodexTurnDetails(),
    };
    live.pendingPlanningSend = null;
    live.turn.detail.segment = turn.id;
    setBusy(live, true);
  };

  const onItem = (params: JsonObject, completed: boolean) => {
    const parsed = itemParams.safeParse(params);
    if (!parsed.success) return;
    const live = threads.get(parsed.data.threadId);
    if (!live?.turn || live.turn.id !== parsed.data.turnId) return;
    const previous = live.turn.itemTimes.get(parsed.data.item.id);
    if (previous && (previous.end !== null || !completed)) return;
    const receivedAt = now();
    live.turn.itemTimes.set(parsed.data.item.id, {
      start: previous?.start ?? parsed.data.startedAtMs ?? parsed.data.completedAtMs ?? receivedAt,
      end: completed ? (parsed.data.completedAtMs ?? receivedAt) : null,
    });
    upsertItem(live, parsed.data.item);
    if (!previous) {
      const detail = live.turn.detail;
      if (parsed.data.item.type === 'userMessage') {
        if (detail.hasAssistant) detail.segment = parsed.data.item.id;
        detail.hasAssistant = false;
        for (const skill of live.pendingSkills.splice(0)) detail.extraItems.push({
          after: parsed.data.item.id,
          item: {
            type: 'openchamberSkill',
            id: codexSkillId(live.turn.id, parsed.data.item.id, skill.name),
            name: skill.name,
            path: skill.path,
            source: 'attached',
          },
        });
      } else if (parsed.data.item.type === 'contextCompaction') {
        detail.segment = parsed.data.item.id;
        detail.hasAssistant = false;
        detail.usage.lastTotal = null;
      } else {
        detail.hasAssistant = true;
      }
    }
    publishTurn(live);
  };

  const deltaTarget = <Params extends { threadId: string; turnId: string; itemId: string }>(
    schema: z.ZodType<Params>,
    params: JsonObject,
  ): { live: LiveThread; turn: LiveTurn; item: LiveItem; params: Params } | null => {
    const parsed = schema.safeParse(params);
    if (!parsed.success) return null;
    const live = threads.get(parsed.data.threadId);
    if (!live?.turn || live.turn.id !== parsed.data.turnId) return null;
    if (live.turn.itemTimes.get(parsed.data.itemId)?.end != null) return null;
    const item = live.turn.items.get(parsed.data.itemId);
    return item ? { live, turn: live.turn, item, params: parsed.data } : null;
  };

  const onReasoningDelta = (params: JsonObject, field: 'summary' | 'content', indexField: 'summaryIndex' | 'contentIndex') => {
    const target = deltaTarget(indexedDeltaParams, params);
    if (!target) return;
    target.item[field] = appendAt(textListField.parse(target.item[field]), target.params[indexField] ?? 0, target.params.delta);
    publishTurn(target.live);
  };

  const closeChild = (live: LiveThread) => {
    if (!live.childSession) return;
    if (live.turn) settleTurn(live, { status: 'interrupted' });
    else setBusy(live, false);
    live.todos.close();
    threads.delete(live.threadId);
    publisher.forget(live.sessionId);
  };

  const handlers = new Map<string, (params: JsonObject) => void>(Object.entries({
    'thread/started': (params) => {
      const parsed = childThreadStartedParams.safeParse(params);
      if (!parsed.success) return;
      const thread = parsed.data.thread;
      if (!threads.has(thread.parentThreadId)) return;
      const live = liveThread(encodeCodexSessionId(thread.id), thread.cwd);
      if (live.childSession) return;
      live.childSession = buildSessionRecord({
        id: live.sessionId,
        backend: 'codex',
        directory: thread.cwd,
        parentID: encodeCodexSessionId(thread.parentThreadId),
        title: thread.name || thread.agentNickname || thread.preview?.split('\n')[0] || 'Subagent',
        created: thread.createdAt * 1000,
        updated: thread.updatedAt * 1000,
      });
      live.config ??= { model: thread.model ?? null, effort: null, serviceTier: CODEX_STANDARD_SERVICE_TIER, mode: 'default' };
      live.loaded = thread.status.type !== 'notLoaded';
      publisher.session(live.directory, live.childSession, { created: true });
      if (thread.status.type === 'active') setBusy(live, true);
    },
    'turn/started': (params) => {
      const parsed = turnParams.safeParse(params);
      if (!parsed.success) return;
      const live = threads.get(parsed.data.threadId);
      if (live) startTurn(live, parsed.data.turn);
    },
    'item/started': (params) => onItem(params, false),
    'item/completed': (params) => onItem(params, true),
    'thread/tokenUsage/updated': (params) => {
      const parsed = codexUsageNotification.safeParse(params);
      if (!parsed.success) return;
      const live = threads.get(parsed.data.threadId);
      if (!live?.turn || live.turn.id !== parsed.data.turnId) return;
      const detail = live.turn.detail;
      if (detail.segment !== null && observeCodexUsage(detail.usage, detail.segment, parsed.data.tokenUsage)) publishTurn(live);
    },
    'item/plan/delta': (params) => {
      const target = deltaTarget(textDeltaParams, params);
      if (!target || target.item.type !== 'plan') return;
      target.item.text = textField.parse(target.item.text) + target.params.delta;
      const partID = codexPartId(target.live.threadId, target.item.id);
      const messageId = target.live.messageOfPart.get(partID);
      if (!messageId) return;
      const [part] = partsForCodexItem(target.item, {
        sessionId: target.live.sessionId,
        threadId: target.live.threadId,
        messageId,
        start: target.turn.itemTimes.get(target.item.id)?.start ?? now(),
        end: null,
      });
      if (part) publisher.part(target.live.directory, target.live.sessionId, part);
    },
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
      if (!parsed.success) return;
      const live = threads.get(parsed.data.threadId);
      if (!live?.loaded || !live.turn) return;
      if (parsed.data.turnId !== undefined && live.turn.id !== parsed.data.turnId) return;
      live.todos.observe(parsed.data.plan);
    },
    'turn/completed': (params) => {
      const parsed = turnParams.safeParse(params);
      if (!parsed.success) return;
      const live = threads.get(parsed.data.threadId);
      if (!live?.turn || live.turn.id !== parsed.data.turn.id) return;
      const activeTurn = live.turn;
      const lastText = activeTurn.order
        .map((id) => activeTurn.items.get(id))
        .findLast((item): item is LiveItem => item !== undefined && (item.type === 'agentMessage' || item.type === 'plan'));
      const summary = lastText ? textField.parse(lastText.text) : '';
      let proposal: CodexPlan | null = null;
      if (parsed.data.turn.status === 'completed' && activeTurn.planningSend && !live.childSession) {
        for (let index = activeTurn.order.length - 1; index >= 0; index -= 1) {
          const itemId = activeTurn.order[index];
          if (itemId === undefined) continue;
          if (activeTurn.itemTimes.get(itemId)?.end == null) continue;
          const plan = codexPlanItemSchema.safeParse(activeTurn.items.get(itemId));
          if (!plan.success || !plan.data.text.trim()) continue;
          proposal = {
            sessionId: live.sessionId,
            directory: live.directory,
            turnId: activeTurn.id,
            text: plan.data.text,
            send: activeTurn.planningSend,
          };
          const messageID = live.messageOfPart.get(codexPartId(live.threadId, itemId));
          if (messageID) proposal.tool = { messageID, callID: itemId };
          break;
        }
      }
      settleTurn(live, parsed.data.turn, true);
      if (proposal) onPlanReady(proposal);
      onTurnFinished(live.sessionId, live.directory, { id: parsed.data.turn.id, status: parsed.data.turn.status, summary });
    },
    'thread/status/changed': (params) => {
      const parsed = threadStatusParams.safeParse(params);
      if (!parsed.success) return;
      const live = threads.get(parsed.data.threadId);
      if (!live) return;
      const status = parsed.data.status.type;
      if (status === 'notLoaded') {
        live.loaded = false;
        live.todos.close();
      }
      if (!live.childSession) return;
      if (status === 'active') setBusy(live, true);
      else if (status === 'idle') setBusy(live, false);
      else if (status === 'notLoaded') closeChild(live);
      else if (status === 'systemError') {
        const error = { message: 'Codex subagent encountered a system error' };
        if (live.turn) settleTurn(live, { status: 'failed', error });
        else setBusy(live, false, unknownError(error.message));
      }
    },
    'thread/closed': (params) => {
      const parsed = threadClosedParams.safeParse(params);
      if (!parsed.success) return;
      const live = threads.get(parsed.data.threadId);
      if (live) {
        live.loaded = false;
        onSessionClosed(live.sessionId);
        closeChild(live);
      }
    },
  }));

  const answerQuestions = async (params: JsonObject): Promise<JsonObject> => {
    const parsed = userInputRequest.safeParse(params);
    if (!parsed.success) return { answers: {} };
    const live = threads.get(parsed.data.threadId);
    if (!live?.turn) return { answers: {} };
    const turn = live.turn;
    const questionItem = codexQuestionItem.parse({
      type: 'openchamberQuestion',
      id: parsed.data.itemId,
      questions: parsed.data.questions,
    });
    turn.detail.extraItems.push({ item: questionItem, after: turn.order.at(-1) ?? null });
    turn.itemTimes.set(questionItem.id, { start: now(), end: null });
    publishTurn(live);
    const partID = codexPartId(live.threadId, parsed.data.itemId);
    const messageID = live.messageOfPart.get(partID);
    const askInput: CodexLiveQuestionAskInput = {
      directory: live.directory,
      sessionID: live.sessionId,
      questions: parsed.data.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description })),
        multiple: false,
      })),
    };
    if (messageID) askInput.tool = { messageID, callID: parsed.data.itemId };
    const outcome = await questions.ask(askInput);
    const chosen = outcome.status === 'replied' ? outcome.answers : [];
    questionItem.answers = chosen;
    questionItem.resolution = outcome.status === 'replied'
      ? 'answered'
      : outcome.status === 'rejected' && outcome.reason === 'interrupted' ? 'interrupted' : 'dismissed';
    if (live.turn === turn) {
      const questionTime = turn.itemTimes.get(questionItem.id);
      if (questionTime) questionTime.end = now();
      publishTurn(live);
    }
    return {
      answers: Object.fromEntries(parsed.data.questions.map((question, index) => [question.id, { answers: chosen[index] ?? [] }])),
    };
  };

  const serverRequests = new Map<string, (params: JsonObject) => Promise<JsonRpcResult>>(Object.entries({
    'item/commandExecution/requestApproval': async () => ({ decision: 'accept' }),
    'item/fileChange/requestApproval': async () => ({ decision: 'accept' }),
    execCommandApproval: async () => ({ decision: 'approved' }),
    applyPatchApproval: async () => ({ decision: 'approved' }),
    'item/tool/requestUserInput': answerQuestions,
    'mcpServer/elicitation/request': async () => ({ action: 'decline' }),
  }));

  return {
    async loadSession(sessionId: string, directory: string): Promise<void> {
      await ensureLoaded(liveThread(sessionId, directory));
    },

    async prompt({ sessionId, directory, messageId, input, config, send, signal }: CodexLivePromptInput): Promise<void> {
      if (!messageId.startsWith('ncx_u_') || !isNativeClientUserMessageId(messageId)) {
        throw invalidRequestError(`Not a Codex user message id: ${messageId}`);
      }
      const live = liveThread(sessionId, directory);
      const toolKey = toolConfiguration(sessionId)?.key ?? '';
      if (live.toolKey !== toolKey) {
        if (live.turn) throw invalidRequestError('Wait for the current turn before applying subagent settings');
        if (live.loaded) await request('thread/unsubscribe', { threadId: live.threadId });
        live.loaded = false;
        live.toolKey = toolKey;
      }
      await ensureLoaded(live);
      await applyProvider(live, config);
      signal?.throwIfAborted();
      live.sends.set(messageId, send);
      live.config = config;
      live.pendingSkills = input.flatMap((item) => {
        const parsed = skillInput.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
      if (live.busy && live.turn) {
        await request('turn/steer', { threadId: live.threadId, expectedTurnId: live.turn.id, input: [...input], clientUserMessageId: messageId });
        return;
      }
      const params: TurnStartParams = {
        threadId: live.threadId,
        input: [...input],
        clientUserMessageId: messageId,
        cwd: live.directory,
        approvalPolicy: APPROVAL_POLICY,
        sandboxPolicy: { type: 'dangerFullAccess' },
        summary: 'auto',
      };
      if (config.effort !== null) params.effort = config.effort;
      if (config.model !== null) {
        params.model = config.model;
        params.collaborationMode = {
          mode: config.mode,
          settings: { model: config.model, reasoning_effort: config.effort, developer_instructions: null },
        };
      }
      const changesTier = config.serviceTier !== (live.serviceTier ?? CODEX_STANDARD_SERVICE_TIER);
      if (changesTier) params.serviceTier = config.serviceTier;
      live.pendingPlanningSend = config.mode === 'plan' ? { ...send } : null;
      try {
        const started = startedTurn.safeParse(await request('turn/start', params));
        if (changesTier) live.serviceTier = config.serviceTier;
        if (started.success) {
          startTurn(live, { id: started.data.turn.id });
          if (signal?.aborted && live.turn?.id === started.data.turn.id) {
            await request('turn/interrupt', { threadId: live.threadId, turnId: started.data.turn.id });
          }
        }
      } finally {
        live.pendingPlanningSend = null;
      }
    },

    async compact(sessionId: string, directory: string): Promise<void> {
      const live = liveThread(sessionId, directory);
      await ensureLoaded(live);
      await request('thread/compact/start', { threadId: live.threadId });
    },

    async review({ sessionId, directory, target, config }: CodexLiveReviewInput): Promise<void> {
      const live = liveThread(sessionId, directory);
      if (live.busy) throw sessionBusyError();
      await ensureLoaded(live);
      if (live.busy) throw sessionBusyError();
      live.config = config;
      await request('thread/settings/update', {
        threadId: live.threadId,
        model: config.model,
        effort: config.effort,
        summary: 'auto',
        serviceTier: config.serviceTier,
        approvalPolicy: APPROVAL_POLICY,
        sandboxPolicy: { type: 'dangerFullAccess' },
      });
      live.serviceTier = config.serviceTier;
      const response = startedTurn.parse(await request('review/start', {
        threadId: live.threadId,
        delivery: 'inline',
        target,
      }));
      startTurn(live, { id: response.turn.id });
    },

    threadStarted(sessionId: string, directory: string, serviceTier: string | null = null, toolKey = '') {
      const live = liveThread(sessionId, directory);
      live.loaded = true;
      live.serviceTier = serviceTier;
      live.toolKey = toolKey;
    },

    async abort(sessionId: string): Promise<boolean> {
      const live = threads.get(threadFor(sessionId));
      if (!live?.busy || !live.turn) return false;
      questions.rejectSession(sessionId);
      await request('turn/interrupt', { threadId: live.threadId, turnId: live.turn.id });
      return true;
    },

    forget(sessionId: string) {
      const live = threads.get(threadFor(sessionId));
      live?.todos.close();
      threads.delete(threadFor(sessionId));
    },

    whenIdle(sessionId: string): Promise<void> {
      const live = threads.get(threadFor(sessionId));
      if (!live?.busy) return Promise.resolve();
      return new Promise<void>((resolve) => {
        live.idleWaiters.push(resolve);
      });
    },

    isIdle(): boolean {
      for (const live of threads.values()) if (live.busy) return false;
      return true;
    },

    async revertThread(sessionId: string, beforeTurnId: string): Promise<void> {
      const live = threads.get(threadFor(sessionId));
      if (live) live.telemetryRevision += 1;
      try {
        await request('thread/revert', { threadId: threadFor(sessionId), beforeTurnId });
      } catch (error) {
        if (error instanceof JsonRpcError && error.code === -32600 && TURN_NOT_FOUND.test(error.message)) return;
        throw error;
      }
    },

    handleNotification(method: string, params: JsonObject) {
      handlers.get(method)?.(params);
    },

    async handleServerRequest(method: string, params: JsonObject): Promise<JsonRpcResult> {
      const handle = serverRequests.get(method);
      if (!handle) throw new Error(`Unsupported app-server request: ${method}`);
      return handle(params);
    },

    handleExit(reason: string) {
      for (const live of threads.values()) {
        live.loaded = false;
        live.todos.close();
        const error = { message: `Codex app-server stopped: ${reason}` };
        if (live.turn) settleTurn(live, { status: 'failed', error });
        else setBusy(live, false, unknownError(error.message));
        if (live.childSession) closeChild(live);
      }
    },

    todos(sessionId: string): CodexPlanTodosSnapshot {
      const live = threads.get(threadFor(sessionId));
      return live ? live.todos.snapshot() : { state: 'unknown', generation: null, revision: 0, todos: [] };
    },

    childSession(sessionId: string): ReturnType<typeof buildSessionRecord> | null {
      const decoded = decodeNativeSessionId(sessionId);
      return decoded?.backend === 'codex' ? threads.get(decoded.threadId)?.childSession ?? null : null;
    },

    liveRecords(sessionId: string): CodexProjectedRecord[] | null {
      const live = threads.get(threadFor(sessionId));
      return live?.turn ? project(live) : null;
    },

    busySessionIds(directory: string): string[] {
      return Array.from(threads.values())
        .filter((live) => live.busy && live.directory === directory)
        .map((live) => live.sessionId);
    },
  };
};

export type {
  CodexLiveConfig,
  CodexUserInputItem,
  CodexReviewTarget,
  CodexLiveTurnSummary,
  CodexLivePublisher,
  CodexLiveQuestionOutcome,
  CodexLiveQuestionAskInput,
  CodexLiveQuestionRegistry,
  CodexLiveThreadsOptions,
  CodexLivePromptInput,
  CodexLiveReviewInput,
} from './live-contracts.js';
