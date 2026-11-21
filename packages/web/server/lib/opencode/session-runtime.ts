import { createMessageId } from '../dispatch-results/runtime.js';
import { isString } from '../shared/object-guards.js';
import type { JsonValue } from '../shared/json-values.js';
import type {
  EventFields, SessionStateMetadata, SessionState, SessionStateSnapshot,
  StatusBroadcast, SessionAttentionState, SessionAttentionSnapshot,
  SessionRuntimeEvent, SessionRuntimeDependencies, ActivityPhase,
  Resume, ResumeCheck, PendingRequests, SessionContextReading, WaitingPageChange,
} from './session-events.js';
import {
  isEventObject, eventFields, isNumber, isFiniteNumber, resumeErrorFields,
  SESSION_COOLDOWN_DURATION_MS, SESSION_STATE_MAX_AGE_MS,
  SESSION_ATTENTION_MAX_AGE_MS, SESSION_ACTIVITY_MAX_AGE_MS, SESSION_STATE_CLEANUP_INTERVAL_MS,
  RESTART_RESUME_GRACE_MS, RESTART_RESUME_RETRY_MS, RESTART_RESUME_ATTEMPTS,
  RESTART_RESUME_TIMEOUT_MS, RESTART_RESUME_TEXT,
  extractSessionStatusUpdate,
} from './session-events.js';

const readRequestId = <Value>(value: Value) => (isString(value) && value.trim() ? value.trim() : '');

const CONTEXT_READINGS_MAX = 2000;

const finiteCount = <Value>(value: Value) => (isNumber(value) && Number.isFinite(value) && value > 0 ? value : 0);

const contextTokensOf = <Value>(tokens: Value) => {
  if (!isEventObject(tokens)) return 0;
  const total = finiteCount(tokens.total);
  if (total > 0) return total;
  const cache = isEventObject(tokens.cache) ? tokens.cache : {};
  return finiteCount(tokens.input) + finiteCount(tokens.output) + finiteCount(tokens.reasoning)
    + finiteCount(cache.read) + finiteCount(cache.write);
};

export const createSessionRuntime = <Client>({
  writeSseEvent,
  getNotificationClients,
  broadcastEvent,
  readTurnStart = null,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  isNativeSessionId = () => false,
}: SessionRuntimeDependencies<Client>) => {
  const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
  const sessionActivityCooldowns = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionStates = new Map<string, SessionState>();
  const sessionAttentionStates = new Map<string, SessionAttentionState>();
  const nativeUserStarts = new Map<string, number>();
  const turnStarts = new Map<string, { startedAt: number; running: boolean }>();
  const turnStartReads = new Map<string, object>();
  const restartResumeTimers = new Map<string, ResumeCheck>();
  const restartResumes = new Map<string, Resume>();
  const latestUserMessages = new Map<string, string>();
  const contextReadings = new Map<string, SessionContextReading>();
  const recordContext = (sessionId: string, reading: SessionContextReading) => {
    contextReadings.delete(sessionId);
    contextReadings.set(sessionId, reading);
    if (contextReadings.size > CONTEXT_READINGS_MAX) {
      const oldest = contextReadings.keys().next().value;
      if (oldest !== undefined) contextReadings.delete(oldest);
    }
  };
  const isolatedSessionIds = new Set<string>();
  const pendingRequestsBySession = new Map<string, {
    permissions: Map<string, EventFields>;
    forms: Map<string, EventFields>;
    pages: Map<string, { id: string; sessionID: string; title: string }>;
    questions: Map<string, EventFields>;
  }>();
  let activeSessionCount = 0;
  let disposed = false;

  const getOrCreatePendingRequests = (sessionId: string) => {
    let entry = pendingRequestsBySession.get(sessionId);
    if (!entry) {
      entry = { permissions: new Map(), forms: new Map(), pages: new Map(), questions: new Map() };
      pendingRequestsBySession.set(sessionId, entry);
    }
    return entry;
  };

  const settlePendingRequest = (kind: 'permissions' | 'forms' | 'pages' | 'questions', sessionId: string, requestId: string) => {
    const entry = pendingRequestsBySession.get(sessionId);
    if (!entry) return;
    if (requestId) entry[kind].delete(requestId);
    else entry[kind].clear();
    if (entry.permissions.size === 0 && entry.forms.size === 0 && entry.pages.size === 0 && entry.questions.size === 0) pendingRequestsBySession.delete(sessionId);
  };

  const trackWaitingPage = (change: WaitingPageChange) => {
    const sessionId = readRequestId(change?.sessionId);
    const callId = readRequestId(change?.callId);
    if (!sessionId || !callId) return;
    if (change.type === 'waiting') {
      const title = isString(change.title) ? change.title : '';
      getOrCreatePendingRequests(sessionId).pages.set(callId, { id: callId, sessionID: sessionId, title });
      return;
    }
    if (change.type === 'settled') settlePendingRequest('pages', sessionId, callId);
  };

  const processBlockingRequestPayload = (input: JsonValue | undefined) => {
    const payload = eventFields(input);
    if (!payload || !isString(payload.type)) return;
    const properties = isEventObject(payload.properties) ? payload.properties : {};
    const nativeSessionId = readRequestId(properties.sessionID);
    if (isNativeSessionId(nativeSessionId)) {
      if (payload.type === 'question.asked') {
        const requestId = readRequestId(properties.id);
        if (requestId) getOrCreatePendingRequests(nativeSessionId).questions.set(requestId, properties);
        return;
      }
      if (payload.type === 'question.replied' || payload.type === 'question.rejected') {
        settlePendingRequest('questions', nativeSessionId, readRequestId(properties.requestID));
        return;
      }
    }
    if (payload.type === 'permission.asked') {
      const sessionId = readRequestId(properties.sessionID);
      const requestId = readRequestId(properties.id);
      if (!sessionId || !requestId) return;
      getOrCreatePendingRequests(sessionId).permissions.set(requestId, properties);
      return;
    }
    if (payload.type === 'form.created') {
      const form = isEventObject(properties.form) ? properties.form : null;
      if (!form) return;
      const sessionId = readRequestId(form.sessionID) || readRequestId(properties.sessionID);
      const requestId = readRequestId(form.id);
      if (!sessionId || !requestId) return;
      getOrCreatePendingRequests(sessionId).forms.set(requestId, form);
      return;
    }
    if (payload.type === 'permission.replied') {
      settlePendingRequest('permissions', readRequestId(properties.sessionID), readRequestId(properties.requestID));
      return;
    }
    if (payload.type === 'form.settled') {
      settlePendingRequest('forms', readRequestId(properties.sessionID), readRequestId(properties.formID));
      return;
    }
    if (payload.type === 'session.deleted') {
      const info = isEventObject(properties.info) ? properties.info : {};
      const sessionId = readRequestId(properties.sessionID) || readRequestId(info.id);
      if (sessionId) {
        const activity = sessionActivityPhases.get(sessionId);
        if (activity?.phase === 'busy' && !isNativeSessionId(sessionId) && !isolatedSessionIds.has(sessionId)) {
          activeSessionCount = Math.max(0, activeSessionCount - 1);
        }
        const cooldown = sessionActivityCooldowns.get(sessionId);
        if (cooldown) clearTimeout(cooldown);
        sessionActivityCooldowns.delete(sessionId);
        sessionActivityPhases.delete(sessionId);
        sessionStates.delete(sessionId);
        cancelRestartResume(sessionId);
        restartResumes.delete(sessionId);
        latestUserMessages.delete(sessionId);
        isolatedSessionIds.delete(sessionId);
        pendingRequestsBySession.delete(sessionId);
        sessionAttentionStates.delete(sessionId);
        nativeUserStarts.delete(sessionId);
        turnStarts.delete(sessionId);
        turnStartReads.delete(sessionId);
      }
    }
  };

  const getPendingBlockingRequestsSnapshot = () => {
    const result: Record<string, PendingRequests> = {};
    for (const [sessionId, entry] of pendingRequestsBySession) {
      const snapshot: PendingRequests = {
        permissions: [...entry.permissions.values()],
        forms: [...entry.forms.values(), ...[...entry.questions.values()].flatMap((question): EventFields[] => {
          const questionList = Array.isArray(question.questions) ? question.questions : [];
          const firstQuestion = isEventObject(questionList[0]) ? questionList[0] : undefined;
          const title = isString(firstQuestion?.header) ? firstQuestion.header : null;
          return title !== null ? [{ id: question.id, sessionID: sessionId, title }] : [];
        })],
        pages: [...entry.pages.values()],
      };
      if (isNativeSessionId(sessionId)) snapshot.questions = [...entry.questions.values()];
      result[sessionId] = snapshot;
    }
    return result;
  };

  const getOrCreateAttentionState = (sessionId: string) => {
    if (!sessionId) return null;

    let state = sessionAttentionStates.get(sessionId);
    if (!state) {
      state = {
        needsAttention: false,
        lastUserMessageAt: null,
        lastStatusChangeAt: Date.now(),
        viewedByClients: new Set(),
        status: 'idle',
      };
      sessionAttentionStates.set(sessionId, state);
    }
    return state;
  };

  const setSessionActivityPhase = (sessionId: string, phase: ActivityPhase) => {
    if (!sessionId) return false;

    const current = sessionActivityPhases.get(sessionId);
    if (current?.phase === phase) return false;
    if (phase === 'cooldown' && current?.phase !== 'busy') {
      return false;
    }

    const existingTimer = sessionActivityCooldowns.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      sessionActivityCooldowns.delete(sessionId);
    }

    const wasActive = current?.phase === 'busy';
    const isActive = phase === 'busy';
    if (wasActive !== isActive && !isNativeSessionId(sessionId) && !isolatedSessionIds.has(sessionId)) {
      activeSessionCount = Math.max(0, activeSessionCount + (isActive ? 1 : -1));
    }
    sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

    if (phase === 'cooldown') {
      const timer = setTimeout(() => {
        const now = sessionActivityPhases.get(sessionId);
        if (now?.phase === 'cooldown') {
          setSessionActivityPhase(sessionId, 'idle');
          return;
        }
        sessionActivityCooldowns.delete(sessionId);
      }, SESSION_COOLDOWN_DURATION_MS);
      sessionActivityCooldowns.set(sessionId, timer);
    }

    if (broadcastEvent) {
      broadcastEvent({
        type: 'openchamber:session-activity',
        properties: {
          sessionId,
          phase,
        },
      });
    }

    return true;
  };

  const getRunningTurnStart = (sessionId: string) => {
    const entry = turnStarts.get(sessionId);
    return entry?.running ? entry.startedAt : null;
  };

  const reportedTurnStart = (sessionId: string, status: string) => {
    if (status === 'busy' || status === 'retry') return getRunningTurnStart(sessionId) ?? undefined;
    return turnStarts.get(sessionId)?.startedAt;
  };

  const endTurn = (sessionId: string) => {
    const entry = turnStarts.get(sessionId);
    if (entry?.running) turnStarts.set(sessionId, { startedAt: entry.startedAt, running: false });
    turnStartReads.delete(sessionId);
  };

  const broadcastSessionStatus = (properties: StatusBroadcast) => {
    const payload: SessionRuntimeEvent = { type: 'openchamber:session-status', properties };
    if (broadcastEvent) {
      broadcastEvent(payload);
      return;
    }
    for (const res of getNotificationClients()) {
      try {
        writeSseEvent(res, payload);
      } catch {
        continue;
      }
    }
  };

  const readBackTurnStart = (sessionId: string) => {
    if (!readTurnStart || isNativeSessionId(sessionId) || isolatedSessionIds.has(sessionId) || turnStartReads.has(sessionId)) return;
    const token = {};
    turnStartReads.set(sessionId, token);
    void Promise.resolve()
      .then(() => readTurnStart(sessionId))
      .catch(() => null)
      .then((startedAt) => {
        if (turnStartReads.get(sessionId) !== token || !isFiniteNumber(startedAt)) return;
        if (turnStarts.get(sessionId)?.running) return;
        const state = sessionStates.get(sessionId);
        if (state?.status !== 'busy' && state?.status !== 'retry') return;
        turnStarts.set(sessionId, { startedAt, running: true });
        broadcastSessionStatus({
          sessionID: sessionId,
          status: state.status,
          timestamp: Date.now(),
          metadata: state.metadata,
          turnStartedAt: startedAt,
        });
      });
  };

  const updateSessionAttentionStatus = (sessionId: string, status: string) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;

    const prevStatus = state.status;
    state.status = status;
    state.lastStatusChangeAt = Date.now();

    if ((prevStatus === 'busy' || prevStatus === 'retry') && status === 'idle') {
      if (state.lastUserMessageAt && state.viewedByClients.size === 0) {
        state.needsAttention = true;
      }
    }
  };

  const updateSessionState = (sessionId: string, status: string, eventId: string, metadata: SessionStateMetadata = {}) => {
    if (!sessionId) return;

    const now = Date.now();
    const existing = sessionStates.get(sessionId);
    const previousAttention = sessionAttentionStates.get(sessionId)?.needsAttention;
    const isRestartInterruption = metadata.reason === 'opencode-restart';
    if (existing && existing.lastUpdateAt > now - 5000 && status === existing.status && !isRestartInterruption) {
      existing.lastEventAt = now;
      return;
    }

    sessionStates.set(sessionId, {
      status,
      lastUpdateAt: now,
      lastEventAt: now,
      lastEventId: eventId || `server-${now}`,
      metadata: { ...existing?.metadata, ...metadata },
    });

    updateSessionAttentionStatus(sessionId, status);
    const attentionState = sessionAttentionStates.get(sessionId);
    const attentionChanged = attentionState?.needsAttention !== previousAttention;

    if (status === 'busy' || status === 'retry') cancelRestartResume(sessionId);
    if (!existing || existing.status !== status || attentionChanged || isRestartInterruption) {
      const state = sessionStates.get(sessionId);
      if (!state) throw new Error('Missing session state after update');
      broadcastSessionStatus({
        sessionID: sessionId,
        status: state.status,
        timestamp: state.lastUpdateAt,
        metadata: state.metadata,
        needsAttention: attentionState?.needsAttention ?? false,
        turnStartedAt: status === 'busy' || status === 'retry' ? getRunningTurnStart(sessionId) ?? undefined : undefined,
      });
    }

    const phase = status === 'busy' || status === 'retry' ? 'busy' : 'idle';
    if (phase !== 'idle' || sessionActivityPhases.get(sessionId)?.phase !== 'cooldown') {
      setSessionActivityPhase(sessionId, phase);
    }
  };

  const getSessionStateSnapshot = () => {
    const result: Record<string, SessionStateSnapshot> = {};
    const now = Date.now();
    for (const [sessionId, data] of sessionStates) {
      if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) continue;
      result[sessionId] = {
        status: data.status,
        lastUpdateAt: data.lastUpdateAt,
        metadata: data.metadata,
        turnStartedAt: reportedTurnStart(sessionId, data.status),
      };
    }
    return result;
  };

  const getSessionState = (sessionId: string) => {
    if (!sessionId) return null;
    return sessionStates.get(sessionId) || null;
  };

  const markSessionViewed = (sessionId: string, clientId: string) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;

    const wasNeedsAttention = state.needsAttention;
    state.viewedByClients.add(clientId);

    if (wasNeedsAttention) {
      state.needsAttention = false;

      const syntheticPayload: SessionRuntimeEvent = {
        type: 'openchamber:session-status',
        properties: {
          sessionID: sessionId,
          status: state.status,
          timestamp: Date.now(),
          metadata: {},
          needsAttention: false,
        },
      };

      if (broadcastEvent) {
        broadcastEvent(syntheticPayload);
      } else {
        const clients = getNotificationClients();
        for (const res of clients) {
          try {
            writeSseEvent(res, syntheticPayload);
          } catch {
            void 0;
          }
        }
      }
    }
  };

  const markSessionUnviewed = (sessionId: string, clientId: string) => {
    const state = sessionAttentionStates.get(sessionId);
    if (!state) return;
    state.viewedByClients.delete(clientId);
  };

  const markUserMessageSent = (sessionId: string) => {
    const state = getOrCreateAttentionState(sessionId);
    if (!state) return;
    state.lastUserMessageAt = Date.now();
  };

  const getSessionAttentionSnapshot = () => {
    const result: Record<string, SessionAttentionSnapshot> = {};
    const now = Date.now();
    for (const [sessionId, state] of sessionAttentionStates) {
      if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) continue;
      result[sessionId] = {
        needsAttention: state.needsAttention,
        lastUserMessageAt: state.lastUserMessageAt,
        lastStatusChangeAt: state.lastStatusChangeAt,
        status: state.status,
        isViewed: state.viewedByClients.size > 0,
      };
    }
    return result;
  };

  const getSessionAttentionState = (sessionId: string): SessionAttentionSnapshot | null => {
    if (!sessionId) return null;
    const state = sessionAttentionStates.get(sessionId);
    if (!state) return null;
    return {
      needsAttention: state.needsAttention,
      lastUserMessageAt: state.lastUserMessageAt,
      lastStatusChangeAt: state.lastStatusChangeAt,
      status: state.status,
      isViewed: state.viewedByClients.size > 0,
    };
  };

  const getSessionActivitySnapshot = () => {
    const result: Record<string, { type: ActivityPhase }> = {};
    for (const [sessionId, data] of sessionActivityPhases) {
      result[sessionId] = { type: data.phase };
    }
    return result;
  };

  const getActiveSessionCount = () => activeSessionCount;

  const resetAllSessionActivityToIdle = () => {
    const now = Date.now();
    for (const [sessionId] of sessionActivityPhases) {
      if (isNativeSessionId(sessionId) || isolatedSessionIds.has(sessionId)) continue;
      const timer = sessionActivityCooldowns.get(sessionId);
      if (timer) clearTimeout(timer);
      sessionActivityCooldowns.delete(sessionId);
      sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now });
    }
    activeSessionCount = 0;
  };

  const cancelRestartResume = (sessionId: string) => {
    const check = restartResumeTimers.get(sessionId);
    if (!check) return;
    clearTimeout(check.timer ?? undefined);
    restartResumeTimers.delete(sessionId);
  };

  const postRestartContinuation = async (sessionId: string, id: string) => {
    if (!buildOpenCodeUrl || !getOpenCodeAuthHeaders) throw new Error('Missing restart continuation connection');
    const fetchPath = `/api/session/${encodeURIComponent(sessionId)}/synthetic`;
    const response = await fetchImpl(buildOpenCodeUrl(fetchPath, ''), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify({
        id,
        text: RESTART_RESUME_TEXT,
        resume: true,
        delivery: 'steer',
        metadata: { notice: 'opencode-restart' },
      }),
      signal: AbortSignal.timeout(RESTART_RESUME_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      const error: Error & { status?: number } = new Error(`OpenCode restart continuation failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
  };

  const checkRestartResume = (sessionId: string, check: ResumeCheck) => {
    if (restartResumeTimers.get(sessionId) !== check) return;
    const state = sessionStates.get(sessionId);
    if (!state || state.status === 'busy' || state.status === 'retry') {
      restartResumeTimers.delete(sessionId);
      return;
    }
    void (async () => {
      check.resume.attempted = true;
      try {
        await postRestartContinuation(sessionId, check.resume.id);
        if (restartResumeTimers.get(sessionId) !== check) return;
        restartResumeTimers.delete(sessionId);
      } catch (error) {
        if (restartResumeTimers.get(sessionId) !== check) return;
        if (resumeErrorFields(error)?.status === 404 || resumeErrorFields(error)?.status === 409) {
          restartResumeTimers.delete(sessionId);
          return;
        }
        check.attempt += 1;
        if (check.attempt >= RESTART_RESUME_ATTEMPTS) {
          restartResumeTimers.delete(sessionId);
          console.warn(`[session-runtime] could not resume interrupted session ${sessionId}:`, resumeErrorFields(error)?.message ?? error);
          return;
        }
        check.timer = setTimeout(() => checkRestartResume(sessionId, check), RESTART_RESUME_RETRY_MS);
      }
    })();
  };

  const scheduleRestartResume = (sessionId: string) => {
    cancelRestartResume(sessionId);
    if (isolatedSessionIds.has(sessionId)) return false;
    if (!buildOpenCodeUrl || !getOpenCodeAuthHeaders) return false;
    let resume = restartResumes.get(sessionId);
    if (resume?.attempted) return false;
    if (!resume) {
      resume = { id: createMessageId(Date.now()), attempted: false };
      restartResumes.set(sessionId, resume);
    }
    const check: ResumeCheck = { timer: null, attempt: 0, resume };
    restartResumeTimers.set(sessionId, check);
    check.timer = setTimeout(() => checkRestartResume(sessionId, check), RESTART_RESUME_GRACE_MS);
    return true;
  };

  const interruptBusySessionsAfterRestart = () => {
    const interruptedSessionIds = new Set<string>();
    for (const [sessionId, state] of sessionStates) {
      if (isNativeSessionId(sessionId) || isolatedSessionIds.has(sessionId)) continue;
      if (state.status === 'busy' || state.status === 'retry') {
        interruptedSessionIds.add(sessionId);
      }
    }
    for (const [sessionId, activity] of sessionActivityPhases) {
      if (isNativeSessionId(sessionId) || isolatedSessionIds.has(sessionId)) continue;
      if (activity.phase === 'busy') {
        interruptedSessionIds.add(sessionId);
      }
    }

    for (const sessionId of pendingRequestsBySession.keys()) {
      if (!isNativeSessionId(sessionId) && !isolatedSessionIds.has(sessionId)) pendingRequestsBySession.delete(sessionId);
    }
    for (const sessionId of turnStarts.keys()) {
      if (!isNativeSessionId(sessionId) && !isolatedSessionIds.has(sessionId)) turnStarts.delete(sessionId);
    }
    for (const sessionId of turnStartReads.keys()) {
      if (!isNativeSessionId(sessionId) && !isolatedSessionIds.has(sessionId)) turnStartReads.delete(sessionId);
    }
    const eventId = `opencode-restart-${Date.now()}`;
    const autoResumeSessionIds: string[] = [];
    for (const sessionId of interruptedSessionIds) {
      updateSessionState(sessionId, 'idle', eventId, {
        message: 'Interrupted by OpenCode restart',
        reason: 'opencode-restart',
      });
      broadcastEvent?.({
        type: 'session.error',
        properties: {
          sessionID: sessionId,
          error: {
            name: 'MessageAbortedError',
            message: 'The running turn was interrupted when OpenCode restarted.',
          },
        },
      });
      if (scheduleRestartResume(sessionId)) autoResumeSessionIds.push(sessionId);
    }

    resetAllSessionActivityToIdle();
    return { sessionIds: [...interruptedSessionIds], autoResumeSessionIds };
  };

  const cleanupOldSessionStates = () => {
    const now = Date.now();
    for (const [sessionId, data] of sessionStates) {
      if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) {
        sessionStates.delete(sessionId);
        cancelRestartResume(sessionId);
        if (!restartResumes.has(sessionId)) latestUserMessages.delete(sessionId);
      }
    }
    for (const [sessionId, state] of sessionAttentionStates) {
      if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) sessionAttentionStates.delete(sessionId);
    }
    for (const sessionId of turnStarts.keys()) {
      if (!sessionStates.has(sessionId)) turnStarts.delete(sessionId);
    }
    for (const sessionId of nativeUserStarts.keys()) {
      if (!sessionStates.has(sessionId)) nativeUserStarts.delete(sessionId);
    }
    for (const [sessionId, data] of sessionActivityPhases) {
      if (now - data.updatedAt <= SESSION_ACTIVITY_MAX_AGE_MS) continue;
      const timer = sessionActivityCooldowns.get(sessionId);
      if (timer) clearTimeout(timer);
      sessionActivityCooldowns.delete(sessionId);
      sessionActivityPhases.delete(sessionId);
      if (data.phase === 'busy' && !isNativeSessionId(sessionId) && !isolatedSessionIds.has(sessionId)) activeSessionCount = Math.max(0, activeSessionCount - 1);
    }
  };

  const cleanupInterval = setInterval(cleanupOldSessionStates, SESSION_STATE_CLEANUP_INTERVAL_MS);

  const processOpenCodeSsePayload = (input: JsonValue | undefined, { spaceId = null }: { spaceId?: string | null } = {}) => {
    if (disposed) return;
    const payload = eventFields(input);
    const properties = eventFields(payload?.properties);
    processBlockingRequestPayload(input);
    if (payload?.type === 'session.compacted') {
      const sessionId = readRequestId(properties?.sessionID);
      if (sessionId) recordContext(sessionId, { state: 'compacted' });
    } else if (payload?.type === 'session.deleted') {
      const sessionId = readRequestId(properties?.sessionID);
      if (sessionId) contextReadings.delete(sessionId);
    }
    if (payload?.type === 'message.updated') {
      const info = eventFields(properties?.info);
      const sessionId = readRequestId(info?.sessionID);
      const tokens = info?.role === 'assistant' ? contextTokensOf(info.tokens) : 0;
      if (sessionId && tokens > 0) recordContext(sessionId, { state: 'measured', tokens });
      const messageId = readRequestId(info?.id);
      const infoTime = isEventObject(info?.time) ? info.time : undefined;
      const infoCreated = isFiniteNumber(infoTime?.created) ? infoTime.created : null;
      if (isNativeSessionId(sessionId) && info?.role === 'user' && infoCreated !== null) {
        const startedAt = infoCreated;
        if (startedAt > (nativeUserStarts.get(sessionId) ?? -Infinity)) nativeUserStarts.set(sessionId, startedAt);
        const state = sessionStates.get(sessionId);
        const current = getRunningTurnStart(sessionId);
        if ((state?.status === 'busy' || state?.status === 'retry') && (current === null || startedAt > current)) {
          turnStarts.set(sessionId, { startedAt, running: true });
          broadcastSessionStatus({ sessionID: sessionId, status: state.status, timestamp: Date.now(), metadata: state.metadata, turnStartedAt: startedAt });
        }
      }
      if (info?.role === 'user' && sessionId && messageId && latestUserMessages.get(sessionId) !== messageId) {
        latestUserMessages.set(sessionId, messageId);
        cancelRestartResume(sessionId);
        restartResumes.delete(sessionId);
      }
    }
    const update = extractSessionStatusUpdate(input);
    if (!update) return;
    if (spaceId) isolatedSessionIds.add(update.sessionId);

    if (update.type === 'busy' || update.type === 'retry') {
      const nativeStart = nativeUserStarts.get(update.sessionId);
      if (update.turnStartedAt !== null) {
        turnStarts.set(update.sessionId, { startedAt: update.turnStartedAt, running: true });
        turnStartReads.delete(update.sessionId);
      } else if (isNativeSessionId(update.sessionId) && !turnStarts.get(update.sessionId)?.running && nativeStart !== undefined) {
        turnStarts.set(update.sessionId, { startedAt: nativeStart, running: true });
      }
      setSessionActivityPhase(update.sessionId, 'busy');
    } else if (update.type === 'idle') {
      endTurn(update.sessionId);
      nativeUserStarts.delete(update.sessionId);
      settlePendingRequest('permissions', update.sessionId, '');
      setSessionActivityPhase(update.sessionId, 'cooldown');
    }

    updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
      attempt: update.attempt,
      message: update.message,
      next: update.next,
    });

    if ((update.type === 'busy' || update.type === 'retry') && !turnStarts.get(update.sessionId)?.running) {
      readBackTurnStart(update.sessionId);
    }
  };

  const adoptRunningSessions = (sessionIds: string[], readAt: number) => {
    if (disposed) return;
    const running = new Set<string>();
    for (const candidate of sessionIds) {
      const sessionId = readRequestId(candidate);
      if (!sessionId) continue;
      running.add(sessionId);
      if ((sessionStates.get(sessionId)?.lastEventAt ?? 0) >= readAt) continue;
      const status = sessionStates.get(sessionId)?.status;
      if (status !== 'busy' && status !== 'retry') updateSessionState(sessionId, 'busy', `server-adopted-${Date.now()}`);
      if (!turnStarts.get(sessionId)?.running) readBackTurnStart(sessionId);
    }
    for (const [sessionId, state] of [...sessionStates]) {
      if (state.status !== 'busy' && state.status !== 'retry') continue;
      if (isNativeSessionId(sessionId) || isolatedSessionIds.has(sessionId) || running.has(sessionId) || state.lastEventAt >= readAt) continue;
      endTurn(sessionId);
      settlePendingRequest('permissions', sessionId, '');
      setSessionActivityPhase(sessionId, 'cooldown');
      updateSessionState(sessionId, 'idle', `server-settled-${Date.now()}`);
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(cleanupInterval);
    for (const timer of sessionActivityCooldowns.values()) {
      clearTimeout(timer);
    }
    for (const check of restartResumeTimers.values()) {
      clearTimeout(check.timer ?? undefined);
    }
    restartResumeTimers.clear();
    restartResumes.clear();
    latestUserMessages.clear();
    isolatedSessionIds.clear();
    sessionActivityCooldowns.clear();
    sessionActivityPhases.clear();
    sessionStates.clear();
    sessionAttentionStates.clear();
    nativeUserStarts.clear();
    pendingRequestsBySession.clear();
    turnStarts.clear();
    turnStartReads.clear();
    activeSessionCount = 0;
  };

  return {
    processOpenCodeSsePayload,
    adoptRunningSessions,
    getRunningTurnStart,
    getSessionActivitySnapshot,
    getActiveSessionCount,
    getSessionStateSnapshot,
    getPendingBlockingRequestsSnapshot,
    getSessionContextSnapshot: () => Object.fromEntries(contextReadings),
    trackWaitingPage,
    getSessionState,
    getSessionAttentionSnapshot,
    getSessionAttentionState,
    markSessionViewed,
    markSessionUnviewed,
    markUserMessageSent,
    resetAllSessionActivityToIdle,
    interruptBusySessionsAfterRestart,
    dispose,
  };
};

export type {
  SessionStateMetadata,
  SessionState,
  SessionStateSnapshot,
  SessionAttentionSnapshot,
  SessionRuntimeEvent,
  SessionRuntimeDependencies,
  PendingRequests,
  SessionContextReading,
  WaitingPageChange,
} from './session-events.js';
export { RESTART_RESUME_GRACE_MS } from './session-events.js';
