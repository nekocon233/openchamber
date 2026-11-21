import fs from 'fs';
import os from 'os';
import path from 'path';

import { assertPromptResponse } from '../opencode/prompt-response.js';
import { readObjective } from './objectives.js';
import {
  buildJevAuditRequest,
  buildSmallModelAuditPrompt,
  decideProgress,
  readJevAnswers,
  readSmallModelAnswers,
} from './audit.js';
import { readMergedSettingsSync } from '../settings/settings-files.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { isOperatorChildSession, sessionParentId } from '../session-lineage.js';
import { isRecord, isString } from '../shared/object-guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SessionActivityOptions } from '../opencode/session-activity.js';
import type { ClassifierEndpoint } from '../routing/classifier.js';
import type { createJevClient } from '../routing/jev.js';
import type { generateSmallModelText } from '../small-model/index.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { NativeMessageRecord } from '../native-agents/records.js';
import type { NativeAgentsRuntime } from '../native-agents/runtime.js';
import type { AuditInput } from './audit.js';
import type {
  SessionGoal,
  GoalSessionData,
  SessionMetadataInput,
  AssistantInfo,
  UserInfo,
  LoopMessage,
} from './goal-projection.js';
import {
  jsonFields,
  isJsonArray,
  isFiniteNumber,
  isCallable,
  REASON_CHAR_LIMIT,
  buildContinuationPrompt,
  extractSessionStatus,
  extractAbortedAssistant,
  extractSessionUpdate,
  parseGoalMetadata,
  nativeLoopMessages,
  toLoopMessage,
  lastUserMessageCreatedAt,
  messagePartsToText,
  messageTokenTotal,
  getErrorName,
  isLengthTruncated,
  hasRepeatedLengthTail,
} from './goal-projection.js';

type GoalChecker = 'classifier' | 'small-model';
type SettledGoalStatus = 'blocked' | 'budgetLimited' | 'complete';

interface GoalSettings {
  enabled: boolean;
  checker: GoalChecker;
  maxAutoTurns: number;
}

interface GoalSession {
  sessionId: string;
  directory: string;
  goal: SessionGoal;
}

interface GoalSettlement extends GoalSession, Partial<Pick<SessionGoal, 'tokensUsed' | 'tokensBaseline' | 'tokensCommitted' | 'lastAccountedMessageID' | 'evaluationProviderID' | 'evaluationModelID'>> {
  status: SettledGoalStatus;
  statusReason: unknown;
  isCurrent?: (() => boolean) | null;
}

export interface NativeGoalPromptRequest {
  directory: string;
  parts: { type: 'text'; text: string }[];
  model: { providerID: string; modelID: string };
  variant?: string | undefined;
  agent: 'plan' | 'build';
}

export interface NativeGoalSessions {
  isNativeSessionId: (sessionId: string) => boolean;
  getSession: (sessionId: string, directory: string) => Promise<{ metadata?: JsonObject; parentID?: unknown; location?: unknown } | null>;
  statuses: (directory: string) => Promise<Record<string, { type?: string }>>;
  hasPendingPlanDecision: (sessionId: string) => boolean;
  loadMessages: (sessionId: string, directory: string, options: { limit: number }) => Promise<{ records?: NativeMessageRecord[]; childSessions?: { id: string }[] } | null>;
  updateSession: (sessionId: string, directory: string, patch: { metadata: JsonObject }) => ReturnType<NativeAgentsRuntime['updateSession']>;
  prompt: (sessionId: string, input: NativeGoalPromptRequest) => ReturnType<NativeAgentsRuntime['prompt']>;
}

type GoalStatusLookup = NonNullable<Awaited<ReturnType<ReturnType<typeof createSessionActivityProbe>['fetchActiveSessionStatuses']>>>;

interface GoalRuntimeOptions extends Pick<SessionActivityOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> {
  getSmallModelService: () => Promise<{ generateSmallModelText: typeof generateSmallModelText }>;
  classifierEndpoint?: () => Promise<ClassifierEndpoint | null>;
  jev?: Pick<ReturnType<typeof createJevClient>, 'ask'> | null;
  getChecker?: () => GoalChecker;
  emitGoalNotification?: (notification: GoalSession & { status: SettledGoalStatus }) => void;
  nativeSessions?: NativeGoalSessions | null;
  isEnabled?: () => boolean;
  idleQuietMs?: number;
  kickoffQuietMs?: number;
  recheckMs?: number;
  getMaxAutoTurns?: () => number;
  persistSessionGoal?: ((sessionId: string, directory: string, goal: SessionGoal, canWrite: ((metadata: SessionMetadataInput) => boolean) | null) => Promise<SessionMetadata | boolean | void>) | null;
  readSessionMetadata?: ((sessionId: string) => Promise<SessionMetadataInput>) | null;
}

export interface SessionGoalRuntime {
  processPayload: (payload: JsonValue | undefined, directoryHint?: string) => void;
  notifyGoalChanged: (sessionId: string, directory: string, metadata: SessionMetadataInput) => Promise<void>;
  recoverActiveGoals: () => Promise<void>;
  stop: () => void;
}

interface GoalFetchOptions {
  directory?: string;
  method?: 'GET' | 'POST';
  body?: { text: string };
  query?: Record<string, string>;
}

interface GoalRequestHeaders {
  Accept: string;
  'Content-Type'?: string;
}

type TimerEntry = { timer: ReturnType<typeof setTimeout>; armedAt: number }
  | { timer: null; directory: string; quietMs: number };

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const hasErrorFields = (value: unknown): value is { message?: unknown; statusCode?: unknown } => value != null;
const errorDetail = (cause: unknown) => (hasErrorFields(cause) ? cause.message : undefined) || cause;

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

const readGoalSettings = (): GoalSettings => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return {
    enabled: settings.sessionGoalEnabled !== false,
    checker: settings.sessionGoalChecker === 'classifier' ? 'classifier' : 'small-model',
    maxAutoTurns: normalizeMaxAutoTurns(isFiniteNumber(settings.sessionGoalMaxAutoTurns) ? settings.sessionGoalMaxAutoTurns : undefined),
  };
};

const isSessionGoalEnabled = () => readGoalSettings().enabled;

const IDLE_QUIET_MS = 3_000;
const ACTIVITY_RECHECK_MS = 15_000;
const BACKGROUND_SHELL_WAIT_MS = 30 * 60 * 1000;
const RECOVERY_SESSION_LIMIT = 50;
const KICKOFF_QUIET_MS = 3_000;
const RESUME_KICKOFF_MS = 250;
const FETCH_TIMEOUT_MS = 10_000;
const SESSION_READ_RETRIES = 3;
const MESSAGE_FETCH_LIMIT = 40;
const DEFAULT_MAX_AUTO_TURNS = 20;
const MAX_AUTO_TURNS_LIMIT = 200;

export const normalizeMaxAutoTurns = (value: JsonValue | undefined) => (
  isInteger(value) && value >= 1 && value <= MAX_AUTO_TURNS_LIMIT ? value : DEFAULT_MAX_AUTO_TURNS
);
const AUDIT_FAIL_LIMIT = 2;

export const createSessionGoalRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  classifierEndpoint = async () => null,
  jev = null,
  getChecker = () => readGoalSettings().checker,
  emitGoalNotification,
  nativeSessions = null,
  isEnabled = isSessionGoalEnabled,
  idleQuietMs = IDLE_QUIET_MS,
  kickoffQuietMs = KICKOFF_QUIET_MS,
  recheckMs = ACTIVITY_RECHECK_MS,
  getMaxAutoTurns = () => readGoalSettings().maxAutoTurns,
  persistSessionGoal = null,
  readSessionMetadata = null,
}: GoalRuntimeOptions): SessionGoalRuntime => {
  const timers = new Map<string, TimerEntry>();
  const inflight = new Set<string>();
  const readAttempts = new Map<string, { failures: number; activityFailures: number }>();
  let stopped = false;

  const clearTimer = (sessionId: string) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer ?? undefined);
      timers.delete(sessionId);
    }
  };

  const openCodeFetch = async (fetchPath: string, { directory, method = 'GET', body, query }: GoalFetchOptions = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const url = search ? `${base}?${search}` : base;
    const acceptHeaders: GoalRequestHeaders = { Accept: 'application/json' };
    if (body) acceptHeaders['Content-Type'] = 'application/json';
    const headers = { ...acceptHeaders, ...getOpenCodeAuthHeaders() };
    const requestBody: Pick<RequestInit, 'body'> = {};
    if (body) requestBody.body = JSON.stringify(body);
    const response = await fetch(url, {
      method,
      headers,
      ...requestBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (method === 'POST' && fetchPath.endsWith('/prompt')) {
      await assertPromptResponse(response, 'session.prompt');
    } else if (!response.ok) {
      throw new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
    }
    const payload: JsonValue = await response.json().catch(() => null);
    return unwrapOpenCodeResponse(payload);
  };

  const fetchRecentMessages = async (sessionId: string, directory: string) => {
    const page = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_FETCH_LIMIT) },
    }).catch(() => null);
    const messages = jsonFields(page)?.data;
    if (!isJsonArray(messages)) return null;
    return messages.map(toLoopMessage).filter((message) => message !== null).reverse();
  };

  const activityProbe = createSessionActivityProbe({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  const fetchOwnRunningShells = async (session: GoalSessionData, sessionId: string, directory: string) => {
    const location = isRecord(session) && isRecord(session.location) ? session.location : undefined;
    const shellDirectory = isString(location?.directory) && location.directory
      ? location.directory
      : directory;
    const shells = shellDirectory ? await activityProbe.fetchRunningShells(shellDirectory) : null;
    return shells && shells.filter((shell) => shell.sessionID === sessionId);
  };

  const isNativeSession = (sessionId: unknown): sessionId is string => (
    isString(sessionId) && sessionId.length > 0 && Boolean(nativeSessions?.isNativeSessionId(sessionId))
  );

  const isWorkingStatus = (status: JsonValue | undefined, native = false) => {
    if (native) {
      const type = isRecord(status) ? status.type : undefined;
      return type === 'busy' || type === 'retry';
    }
    return Boolean(status);
  };

  interface GoalContinuationInput {
    goal: SessionGoal;
    messages: LoopMessage[];
    lastAssistantInfo: AssistantInfo;
  }

  const openCodeSource = (sessionId: string, directory: string) => ({
    native: false as const,
    readSession: () => openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`, { directory }),
    readStatuses: () => activityProbe.fetchActiveSessionStatuses(),
    hasWorkingChildren: (statuses: GoalStatusLookup) => activityProbe.hasWorkingChildren(sessionId, statuses),
    readMessages: () => fetchRecentMessages(sessionId, directory),
    writeMetadata: null,
    sendContinuation: ({ goal }: GoalContinuationInput) => sendContinuation({ sessionId, directory, goal }),
  });

  const nativeSource = (sessionId: string, directory: string) => {
    const native = nativeSessions;
    if (!native) {
      return openCodeSource(sessionId, directory);
    }
    return {
      native: true as const,
      readSession: () => native.getSession(sessionId, directory),
      readStatuses: () => native.statuses(directory).catch(() => null),
      hasWorkingChildren: async (statuses: GoalStatusLookup): Promise<boolean | null> => {
        const page = await native.loadMessages(sessionId, directory, { limit: 1 }).catch(() => null);
        return (page?.childSessions ?? []).some((child) => isWorkingStatus(statuses?.[child.id], true));
      },
      readMessages: () => native.loadMessages(sessionId, directory, { limit: MESSAGE_FETCH_LIMIT })
        .then((page) => (Array.isArray(page?.records) ? nativeLoopMessages(page.records) : null))
        .catch(() => null),
      writeMetadata: (metadata: JsonObject) => native.updateSession(sessionId, directory, { metadata }),
      sendContinuation: async ({ goal, messages, lastAssistantInfo }: GoalContinuationInput) => {
        if (native.hasPendingPlanDecision(sessionId)) return;
        let lastPrompt: UserInfo | null = null;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const info = messages[i]?.info;
          if (info?.role === 'user' && info.model?.modelID) {
            lastPrompt = info;
            break;
          }
        }
        const providerID = lastPrompt?.model?.providerID
          ?? (isString(lastAssistantInfo?.providerID) ? lastAssistantInfo.providerID : '');
        const modelID = lastPrompt?.model?.modelID
          ?? (isString(lastAssistantInfo?.modelID) ? lastAssistantInfo.modelID : '');
        if (!providerID || !modelID) {
          throw new Error('cannot continue goal: no prompt or reply names a model');
        }
        const variant = lastPrompt?.model?.variant;
        const request: NativeGoalPromptRequest = {
          directory,
          parts: [{ type: 'text', text: buildContinuationPrompt(goal) }],
          model: { providerID, modelID },
          agent: lastPrompt?.agent === 'plan' ? 'plan' : 'build',
        };
        if (variant !== undefined) request.variant = variant;
        await native.prompt(sessionId, request);
      },
    };
  };

  const sourceFor = (sessionId: string, directory: string) => (
    isNativeSession(sessionId) ? nativeSource(sessionId, directory) : openCodeSource(sessionId, directory)
  );

  const readGoal = async (sessionId: string, directory = '') => {
    if (isNativeSession(sessionId) && nativeSessions) {
      const session = await nativeSessions.getSession(sessionId, directory);
      return parseGoalMetadata(session ?? undefined);
    }
    return parseGoalMetadata({ metadata: await readSessionMetadata?.(sessionId) });
  };

  const writeGoal = async (sessionId: string, directory: string, expectedGoalId: string,
    mutate: (current: SessionGoal) => Partial<SessionGoal> | null, isCurrent: (() => boolean) | null = null) => {
    const source = sourceFor(sessionId, directory);
    if (source.native) {
      const session = await source.readSession();
      const currentGoal = parseGoalMetadata(session ?? undefined);
      if (!currentGoal || currentGoal.id !== expectedGoalId) return null;
      const patch = mutate(currentGoal);
      if (!patch) return null;
      if (isCurrent && !isCurrent()) return null;
      const nextGoal = { ...currentGoal, ...patch, updatedAt: Date.now() };
      const currentMetadata = session?.metadata ?? {};
      const currentNamespace = jsonFields(currentMetadata.openchamber) ?? {};
      await source.writeMetadata({
        ...currentMetadata,
        openchamber: { ...currentNamespace, goal: nextGoal },
      });
      return nextGoal;
    }
    const currentGoal = await readGoal(sessionId, directory);
    if (!currentGoal || currentGoal.id !== expectedGoalId) return null;
    const patch = mutate(currentGoal);
    if (!patch) return null;
    const nextGoal = { ...currentGoal, ...patch, updatedAt: Date.now() };
    const canWrite = isCurrent ? (metadata: SessionMetadataInput) => {
      const latest = parseGoalMetadata({ metadata });
      return latest?.id === expectedGoalId && latest.status === 'active' && isCurrent();
    } : null;
    const persisted = await persistSessionGoal?.(sessionId, directory, nextGoal, canWrite);
    if (persisted === false) return null;
    return nextGoal;
  };

  const settleGoal = async ({ sessionId, directory, goal, status, statusReason, tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID, evaluationProviderID, evaluationModelID, isCurrent = null }: GoalSettlement) => {
    const written = await writeGoal(sessionId, directory, goal.id, (current) => {
      if (current.status !== 'active' || (isCurrent && !isCurrent())) return null;
      const patch: Partial<SessionGoal> = {
        status,
        statusReason: String(statusReason ?? '').trim().slice(0, REASON_CHAR_LIMIT),
        auditFailStreak: 0,
      };
      if (tokensUsed !== undefined) patch.tokensUsed = tokensUsed;
      if (tokensBaseline !== undefined) patch.tokensBaseline = tokensBaseline;
      if (tokensCommitted !== undefined) patch.tokensCommitted = tokensCommitted;
      if (lastAccountedMessageID) patch.lastAccountedMessageID = lastAccountedMessageID;
      if (evaluationModelID !== undefined) {
        patch.evaluationProviderID = evaluationProviderID ?? '';
        patch.evaluationModelID = evaluationModelID;
      }
      return patch;
    }, isCurrent);
    if (!written) return;
    console.log(`[session-goal] ${sessionId} settled as ${status}${statusReason ? ` (${statusReason})` : ''}`);
    if (isCallable(emitGoalNotification)) {
      try {
        emitGoalNotification({ sessionId, directory, status, goal: written });
      } catch (error) {
        console.warn('[session-goal] notification failed:', errorDetail(error));
      }
    }
  };

  const checkWithJev = async ({ objective, answer, sessionId }: AuditInput & { sessionId: JsonValue }) => {
    const endpoint = await classifierEndpoint();
    if (!endpoint || !jev) return null;
    try {
      const { answers } = await jev.ask(buildJevAuditRequest({ objective, answer }), endpoint);
      const scores = readJevAnswers(answers);
      if (!scores) {
        console.warn('[session-goal] progress check: Jev left a question unanswered', { sessionId });
        return null;
      }
      return { scores, evaluationProviderID: '', evaluationModelID: endpoint.model };
    } catch (error) {
      console.warn('[session-goal] progress check: Jev failed:', errorDetail(error));
      return null;
    }
  };

  const checkWithSmallModel = async ({ objective, answer, directory, lastAssistantInfo }: AuditInput & { directory: string; lastAssistantInfo: AssistantInfo }) => {
    let service;
    try {
      service = await getSmallModelService();
    } catch {
      return null;
    }
    try {
      const generated = await service.generateSmallModelText({
        prompt: buildSmallModelAuditPrompt({ objective, answer }),
        directory,
        sessionID: isString(lastAssistantInfo.sessionID) ? lastAssistantInfo.sessionID : undefined,
        preferredProviderID: isString(lastAssistantInfo.providerID) ? lastAssistantInfo.providerID : undefined,
        preferredModelID: isString(lastAssistantInfo.modelID) ? lastAssistantInfo.modelID : undefined,
      });
      const scores = readSmallModelAnswers(generated?.text);
      if (!scores) {
        console.warn('[session-goal] progress check: small model reply is not the asked-for JSON', {
          sessionId: lastAssistantInfo?.sessionID ?? null,
          provider: generated?.providerID ?? null,
          model: generated?.modelID ?? null,
          outputChars: String(generated?.text ?? '').length,
        });
        return null;
      }
      return {
        scores,
        evaluationProviderID: isString(generated.providerID) ? generated.providerID : '',
        evaluationModelID: isString(generated.modelID) ? generated.modelID : '',
      };
    } catch (error) {
      if (Number(hasErrorFields(error) ? error.statusCode : undefined) !== 404) {
        console.warn('[session-goal] progress check: small model failed:', errorDetail(error));
      }
      return null;
    }
  };

  const runAudit = async ({ goal, assistantText, directory, lastAssistantInfo }: { goal: SessionGoal; assistantText: string; directory: string; lastAssistantInfo: AssistantInfo }) => {
    const input = { objective: goal.objective, answer: assistantText };
    const sessionId = lastAssistantInfo?.sessionID ?? null;
    const checked = (getChecker() === 'classifier' ? await checkWithJev({ ...input, sessionId }) : null)
      ?? await checkWithSmallModel({ ...input, directory, lastAssistantInfo });
    if (!checked) return null;
    const verdict = decideProgress(checked.scores);
    console.log('[session-goal:diagnostic] progress check', {
      sessionId,
      model: checked.evaluationModelID || null,
      scores: checked.scores,
      verdict,
    });
    return { verdict, evaluationProviderID: checked.evaluationProviderID, evaluationModelID: checked.evaluationModelID };
  };

  const sendContinuation = async ({ sessionId, directory, goal }: GoalSession) => {
    await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      directory,
      method: 'POST',
      body: { text: buildContinuationPrompt(goal) },
    });
  };

  const tick = async (sessionId: string, directory: string) => {
    if (!isEnabled()) return;
    const maxAutoTurns = getMaxAutoTurns();
    const source = sourceFor(sessionId, directory);

    const attempt = readAttempts.get(sessionId) ?? { failures: 0, activityFailures: 0 };
    readAttempts.set(sessionId, attempt);
    const isCurrent = () => !stopped && readAttempts.get(sessionId) === attempt;
    const session = await source.readSession()
      .catch((cause: unknown) => {
        console.warn(`[session-goal] session fetch failed: ${errorDetail(cause)}`);
        return null;
      });
    if (!isCurrent()) return;
    if (!isObject(session)) {
      attempt.failures += 1;
      if (attempt.failures <= SESSION_READ_RETRIES) {
        armTimer(sessionId, directory, recheckMs * (2 ** (attempt.failures - 1)));
      } else {
        const goal = await readGoal(sessionId, directory);
        if (goal?.status === 'active' && isCurrent()) {
          await settleGoal({
            sessionId, directory, goal, status: 'blocked',
            statusReason: 'Session could not be read after repeated attempts. Resume to try again.',
            isCurrent,
          });
        }
        if (isCurrent()) readAttempts.delete(sessionId);
      }
      return;
    }
    attempt.failures = 0;
    if (sessionParentId(session) && !isOperatorChildSession(session)) return;

    const goal = source.native ? parseGoalMetadata(session) : await readGoal(sessionId, directory);
    if (!goal || goal.status !== 'active') return;

    const retryActivity = async () => {
      if (!isCurrent()) return;
      attempt.activityFailures += 1;
      if (attempt.activityFailures <= SESSION_READ_RETRIES) {
        armTimer(sessionId, directory, recheckMs * (2 ** (attempt.activityFailures - 1)));
        return;
      }
      await settleGoal({
        sessionId, directory, goal, status: 'blocked',
        statusReason: 'Session activity could not be read after repeated attempts. Resume to try again.',
        isCurrent,
      });
    };

    let effectiveObjective = goal.objective;
    if (goal.objectiveFile) {
      const fileObjective = await readObjective(sessionId);
      if (fileObjective) {
        effectiveObjective = fileObjective;
      } else if (!effectiveObjective) {
        console.warn(`[session-goal] ${sessionId} objective file unreadable and no inline fallback`);
        return;
      } else {
        console.warn(`[session-goal] ${sessionId} objective file unreadable, using inline fallback`);
      }
    }

    const statuses = await source.readStatuses();
    if (!isCurrent()) return;
    if (!statuses) {
      await retryActivity();
      return;
    }
    if (isWorkingStatus(statuses[sessionId], source.native)) {
      attempt.activityFailures = 0;
      return;
    }
    if (source.native && nativeSessions?.hasPendingPlanDecision(sessionId)) return;

    const backgroundJobs = source.native ? undefined : await activityProbe.fetchRunningBackgroundJobs(sessionId);
    if (!isCurrent()) return;
    if (!source.native && backgroundJobs === null) {
      await retryActivity();
      return;
    }
    const childrenWorking = backgroundJobs?.some((job) => job.kind !== 'shell')
      || await source.hasWorkingChildren(statuses);
    if (!isCurrent()) return;
    if (childrenWorking === null) {
      await retryActivity();
      return;
    }
    if (childrenWorking) {
      attempt.activityFailures = 0;
      armTimer(sessionId, directory, recheckMs);
      return;
    }

    const messages = await source.readMessages();
    if (!messages) return;

    let lastAssistant: LoopMessage | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.info?.role === 'assistant') {
        lastAssistant = message;
        break;
      }
    }
    const lastAssistantInfo = lastAssistant?.info.role === 'assistant' ? lastAssistant.info : undefined;
    const lastMessageInfo = messages.length > 0 ? messages[messages.length - 1]?.info : null;

    let executionInfo = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i]?.info;
      if (info?.role === 'assistant' && info.summary !== true) {
        executionInfo = info;
        break;
      }
    }

    if (lastMessageInfo?.role === 'user') return;
    if (lastAssistantInfo && !(Number(lastAssistantInfo.time.completed) > 0) && !lastAssistantInfo.error) return;

    if (!lastAssistantInfo?.id) return;

    let tokensBaseline = goal.tokensBaseline;
    if (!goal.lastAccountedMessageID && !(tokensBaseline > 0)) {
      tokensBaseline = 0;
      for (const message of messages) {
        const info = message?.info;
        if (info?.role !== 'assistant') continue;
        if (!(Number(info.time.completed) > 0) || Number(info.time.completed) > goal.createdAt) continue;
        tokensBaseline = Math.max(tokensBaseline, messageTokenTotal(info));
      }
    }
    let tokensCommitted = goal.tokensCommitted;
    let tokensUsed = goal.tokensUsed;
    let lastAccountedMessageID = goal.lastAccountedMessageID;
    let segmentSnapshot = null;
    let sawNewMessages = false;
    const cursorIndex = source.native && lastAccountedMessageID
      ? messages.findIndex((message) => message?.info?.id === lastAccountedMessageID)
      : -1;
    for (const [index, message] of messages.entries()) {
      const info = message?.info;
      if (info?.role !== 'assistant' || !isString(info.id)) continue;
      if (lastAccountedMessageID && (source.native ? index <= cursorIndex : info.id <= lastAccountedMessageID)) continue;
      if (!(Number(info.time.completed) > 0)) continue;
      sawNewMessages = true;
      const total = messageTokenTotal(info);
      if (info.summary === true) {
        tokensCommitted = Math.max(
          goal.tokensUsed,
          tokensCommitted + Math.max(0, (segmentSnapshot ?? 0) - tokensBaseline),
        );
        tokensBaseline = 0;
        segmentSnapshot = null;
      } else {
        segmentSnapshot = total;
      }
      if (source.native || !lastAccountedMessageID || info.id > lastAccountedMessageID) {
        lastAccountedMessageID = info.id;
      }
    }
    if (sawNewMessages) {
      const segmentCurrent = segmentSnapshot !== null ? Math.max(0, segmentSnapshot - tokensBaseline) : 0;
      tokensUsed = Math.max(goal.tokensUsed, tokensCommitted + segmentCurrent);
    }

    const assistantText = messagePartsToText(lastAssistant);

    if (!source.native && goal.statusReason !== 'resumed' && !lastAssistantInfo.error) {
      const jobs = backgroundJobs && await activityProbe.fetchRunningBackgroundJobs(sessionId);
      const shells = backgroundJobs
        ? jobs && jobs.filter((job) => job.kind === 'shell')
        : await fetchOwnRunningShells(session, sessionId, directory);
      if (!isCurrent()) return;
      if (!shells) {
        await retryActivity();
        return;
      }
      attempt.activityFailures = 0;
      if (jobs?.some((job) => job.kind !== 'shell')) {
        armTimer(sessionId, directory, recheckMs);
        return;
      }
      const roundStartedAt = lastUserMessageCreatedAt(messages, goal.createdAt);
      const waitingOn = shells.filter((shell) => shell.startedAt >= roundStartedAt);
      const stillWaiting = waitingOn.some((shell) => Date.now() - shell.startedAt < BACKGROUND_SHELL_WAIT_MS);
      if (stillWaiting) {
        armTimer(sessionId, directory, recheckMs);
        return;
      }
    }

    const error = lastAssistantInfo.error;
    const errorName = getErrorName(error);
    const hasError = error !== null && error !== undefined;
    const abortedTail = errorName === 'MessageAbortedError';
    const lengthTail = isLengthTruncated(lastAssistantInfo, { errorName });
    if (abortedTail && goal.statusReason !== 'resumed') {
      await writeGoal(sessionId, directory, goal.id, () => ({
        status: 'paused',
        statusReason: 'paused after abort',
        tokensUsed,
        tokensBaseline,
        tokensCommitted,
        lastAccountedMessageID,
      }));
      console.log(`[session-goal] ${sessionId} paused after user abort`);
      return;
    }

    if (!abortedTail && !lengthTail && hasError) {
      await settleGoal({
        sessionId, directory, goal, status: 'blocked', statusReason: errorName || 'assistant turn failed', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
      });
      return;
    }

    if (goal.tokenBudget !== null && tokensUsed >= goal.tokenBudget) {
      await settleGoal({
        sessionId, directory, goal, status: 'budgetLimited', statusReason: 'token budget reached', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
      });
      return;
    }

    if (goal.turnsUsed >= maxAutoTurns) {
      await settleGoal({
        sessionId, directory, goal, status: 'blocked', statusReason: 'auto-continuation limit reached', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
      });
      return;
    }

    if (lengthTail && goal.statusReason !== 'resumed' && hasRepeatedLengthTail(messages, lastAssistant, goal.createdAt)) {
      await settleGoal({
        sessionId, directory, goal, status: 'blocked', statusReason: 'repeated output truncation', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
      });
      return;
    }

    let audit = null;
    let auditFailStreak = goal.auditFailStreak;
    if (!(lastAssistantInfo.summary === true || abortedTail || lengthTail)) {
      audit = await runAudit({ goal: { ...goal, objective: effectiveObjective }, assistantText, directory, lastAssistantInfo: executionInfo ?? lastAssistantInfo });
      if (source.native && nativeSessions?.hasPendingPlanDecision(sessionId)) return;

      if (!audit) {
        auditFailStreak += 1;
        if (auditFailStreak >= AUDIT_FAIL_LIMIT) {
          await settleGoal({
            sessionId, directory, goal, status: 'blocked', statusReason: 'progress audit unavailable', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
          });
          return;
        }
        console.warn(`[session-goal] ${sessionId} progress check unavailable, continuing unchecked (${auditFailStreak}/${AUDIT_FAIL_LIMIT})`);
      } else {
        auditFailStreak = 0;
      }

      if (audit?.verdict === 'complete') {
        await settleGoal({
          sessionId, directory, goal, status: 'complete', statusReason: 'verified by audit', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
          evaluationProviderID: audit.evaluationProviderID, evaluationModelID: audit.evaluationModelID,
        });
        return;
      }

      if (audit?.verdict === 'blocked') {
        await settleGoal({
          sessionId, directory, goal, status: 'blocked', statusReason: 'waiting for user input', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
          evaluationProviderID: audit.evaluationProviderID, evaluationModelID: audit.evaluationModelID,
        });
        return;
      }
    }

    const written = await writeGoal(sessionId, directory, goal.id, (current) => {
      const patch: Partial<SessionGoal> = {
        tokensUsed,
        tokensBaseline,
        tokensCommitted,
        lastAccountedMessageID,
        turnsUsed: current.turnsUsed + 1,
        auditFailStreak,
        statusReason: '',
      };
      if (audit) {
        patch.evaluationProviderID = audit.evaluationProviderID ?? '';
        patch.evaluationModelID = audit.evaluationModelID ?? '';
      }
      return patch;
    });
    if (!written) {
      console.log('[session-goal] goal changed during tick, dropping continuation');
      return;
    }

    const latest = await source.readMessages();
    const latestLastInfo = latest && latest.length > 0 ? latest[latest.length - 1]?.info : null;
    if (!latestLastInfo || latestLastInfo.id !== lastMessageInfo?.id) {
      console.log('[session-goal] tail moved on, dropping continuation');
      return;
    }

    console.log(`[session-goal] continuing ${sessionId} (turn ${written.turnsUsed}/${maxAutoTurns}, tokens ${written.tokensUsed}${written.tokenBudget ? `/${written.tokenBudget}` : ''})`);
    await source.sendContinuation({
      goal: { ...written, objective: effectiveObjective },
      messages,
      lastAssistantInfo: executionInfo ?? lastAssistantInfo,
    });
  };

  const finishInflight = (sessionId: string) => {
    inflight.delete(sessionId);
    const pending = timers.get(sessionId);
    if (pending?.timer === null) armTimer(sessionId, pending.directory, pending.quietMs);
    if (!pending) readAttempts.delete(sessionId);
  };

  const armTimer = (sessionId: string, directory: string, quietMs: number) => {
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      if (stopped) return;
      if (inflight.has(sessionId)) {
        timers.set(sessionId, { timer: null, directory, quietMs });
        return;
      }
      timers.delete(sessionId);
      inflight.add(sessionId);
      tick(sessionId, directory)
        .catch((cause: unknown) => {
          console.warn('[session-goal] tick failed:', errorDetail(cause));
        })
        .finally(() => {
          finishInflight(sessionId);
        });
    }, quietMs);
    if (isCallable(timer?.unref)) timer.unref();
    timers.set(sessionId, { timer, armedAt: Date.now() });
  };

  const pauseAfterAbort = async (sessionId: string, directory: string) => {
    const goal = await readGoal(sessionId, directory);
    if (!goal || goal.status !== 'active') return;
    await writeGoal(sessionId, directory, goal.id, () => ({
      status: 'paused',
      statusReason: 'paused after abort',
    }));
    console.log(`[session-goal] ${sessionId} paused after user abort`);
  };

  const isWired = (sessionId?: JsonValue) => (
    isNativeSession(sessionId) || (isCallable(persistSessionGoal) && isCallable(readSessionMetadata))
  );

  const notifyGoalChanged: SessionGoalRuntime['notifyGoalChanged'] = async (sessionId, directory, metadata) => {
    if (stopped || !isWired(sessionId)) return;
    const goal = parseGoalMetadata({ metadata });
    if (!goal || goal.status !== 'active') {
      readAttempts.delete(sessionId);
      clearTimer(sessionId);
      return;
    }
    if (goal.turnsUsed !== 0 && goal.statusReason !== 'resumed') return;
    readAttempts.delete(sessionId);
    clearTimer(sessionId);

    let resolved = directory;
    if (!resolved && !isNativeSession(sessionId)) {
      const session = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`).catch(() => null);
      const location = jsonFields(jsonFields(session)?.location);
      resolved = isString(location?.directory) ? location.directory : '';
    }
    if (stopped || timers.has(sessionId)) return;
    armTimer(sessionId, resolved, goal.statusReason === 'resumed' ? RESUME_KICKOFF_MS : kickoffQuietMs);
  };

  const recoverActiveGoals = async () => {
    if (stopped || !isWired() || !isEnabled()) return;
    const page = await openCodeFetch('/api/session', {
      query: { parentID: 'null', archived: 'false', order: 'desc', limit: String(RECOVERY_SESSION_LIMIT) },
    }).catch((cause: unknown) => {
      console.warn('[session-goal] recovery: session list failed:', errorDetail(cause));
      return null;
    });
    const data = jsonFields(page)?.data;
    const sessions = isJsonArray(data) ? data : [];
    for (const record of sessions) {
      if (stopped) return;
      const session = jsonFields(record);
      const sessionId = isString(session?.id) ? session.id : '';
      if (!sessionId || timers.has(sessionId) || inflight.has(sessionId)) continue;
      if (parseGoalMetadata(session)?.status !== 'active') continue;
      const location = jsonFields(session?.location);
      const directory = isString(location?.directory) ? location.directory : '';
      armTimer(sessionId, directory, kickoffQuietMs);
    }
  };

  let parkedNoticeLogged = false;
  const processPayload: SessionGoalRuntime['processPayload'] = (rawPayload, directoryHint = '') => {
    if (stopped) return;
    const payload = jsonFields(rawPayload);
    const props = jsonFields(payload?.properties);
    const propsInfo = jsonFields(props?.info);
    const eventSessionId = props?.sessionID ?? propsInfo?.sessionID ?? propsInfo?.id;
    if (!isWired(eventSessionId)) {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[session-goal] parked: no session metadata store is wired, so goal progress cannot be saved');
      }
      return;
    }

    const nativeInfo = payload?.type === 'message.updated' ? propsInfo : undefined;
    const nativeSessionId = isString(nativeInfo?.sessionID) ? nativeInfo.sessionID : '';
    const nativeErrorName = jsonFields(nativeInfo?.error)?.name;
    const aborted = nativeInfo && isNativeSession(nativeSessionId) && nativeErrorName === 'MessageAbortedError'
      ? { sessionId: nativeSessionId }
      : extractAbortedAssistant(payload);
    if (aborted) {
      if (!inflight.has(aborted.sessionId)) readAttempts.delete(aborted.sessionId);
      clearTimer(aborted.sessionId);
      if (!inflight.has(aborted.sessionId)) {
        inflight.add(aborted.sessionId);
        pauseAfterAbort(aborted.sessionId, directoryHint)
          .catch((cause: unknown) => {
            console.warn('[session-goal] pause after abort failed:', errorDetail(cause));
          })
          .finally(() => {
            finishInflight(aborted.sessionId);
          });
      }
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      readAttempts.delete(status.sessionId);
      if (status.type === 'idle') {
        armTimer(status.sessionId, status.directory || directoryHint, idleQuietMs);
      } else {
        clearTimer(status.sessionId);
      }
      return;
    }

    const update = extractSessionUpdate(payload);
    if (update && !update.parentID && !timers.has(update.sessionId) && !inflight.has(update.sessionId)) {
      void readGoal(update.sessionId, update.directory || directoryHint)
        .then((goal) => {
          if (stopped || !goal || goal.status !== 'active') return;
          if (goal.turnsUsed !== 0 && goal.statusReason !== 'resumed') return;
          if (timers.has(update.sessionId) || inflight.has(update.sessionId)) return;
          armTimer(
            update.sessionId,
            update.directory || directoryHint,
            goal.statusReason === 'resumed' ? RESUME_KICKOFF_MS : kickoffQuietMs,
          );
        })
        .catch(() => undefined);
    }
  };

  const stop = () => {
    stopped = true;
    for (const { timer } of timers.values()) {
      clearTimeout(timer ?? undefined);
    }
    timers.clear();
    readAttempts.clear();
  };

  return { processPayload, notifyGoalChanged, recoverActiveGoals, stop };
};
