import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { readMergedSettingsSync } from '../settings/settings-files.js';
import { isString } from '../shared/guards.js';
import { sessionParentId } from '../session-lineage.js';
import { loadAssistContext, newestContentId } from './context.js';
import type { NativeAssistRecord } from './context.js';
import { buildAssistPrompt, buildAssistSystemPrompt } from './prompt.js';
import type { AssistTargets } from './contracts.js';
import type { createSessionLineage } from '../session-lineage.js';
import type { TurnEndInput } from '../session-work/runtime.js';
import type { describeSmallModel, generateSmallModelText } from '../small-model/index.js';

export interface SessionAssist {
  recap: string;
  suggestion: string;
  forMessageID: string;
  generatedAt: number;
}

export interface NativeAssistSession {
  id: string;
  directory?: string | undefined;
  parentID?: string | null | undefined;
  revert?: { messageID?: string | undefined } | null | undefined;
  time?: { archived?: number | null | undefined } | undefined;
}

function assistSessionDirectory(session: NativeAssistSession | { location: { directory?: string | undefined } }) {
  return 'location' in session ? session.location.directory : session.directory;
}

export interface NativeSessionsAssistRuntime {
  isNativeSessionId: (sessionId: string) => boolean;
  getSession: (sessionId: string, directory: string) => Promise<NativeAssistSession | null | undefined>;
  loadMessages: (
    sessionId: string,
    directory: string,
    options: { limit: number; before?: string | undefined },
  ) => Promise<{ records: readonly NativeAssistRecord[]; cursor?: string | null | undefined }>;
  setSessionAssist: (
    sessionId: string,
    directory: string,
    assist: SessionAssist | null,
  ) => Promise<NativeAssistSession | null | void> | void;
}

export interface SessionAssistOptions {
  buildOpenCodeUrl: (route: string, query: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  getSmallModelService: () => Promise<{
    describeSmallModel: typeof describeSmallModel;
    generateSmallModelText: typeof generateSmallModelText;
  }>;
  nativeSessions?: NativeSessionsAssistRuntime | null | undefined;
  getTargets?: () => AssistTargets;
  quietMs?: number;
  persistSessionAssist?: ((sessionId: string, directory: string | undefined, assist: SessionAssist | null) => Promise<void> | void) | null;
  isSessionArchived?: (sessionId: string) => Promise<boolean>;
  evaluateTurn?: ((input: TurnEndInput) => Promise<AssistTargets | null>) | null;
  lineage?: Pick<ReturnType<typeof createSessionLineage>, 'remember' | 'isChild'> | null;
  onPendingChange?: (change: { sessionId: string; directory: string | undefined; pending: boolean }) => void;
}

export interface AssistEvent {
  type?: unknown;
  properties?: {
    status?: unknown;
    info?: unknown;
    sessionID?: unknown;
    directory?: unknown;
  } | null;
}

interface EventInfo {
  type?: unknown;
  directory?: unknown;
  role?: unknown;
  sessionID?: unknown;
  time?: unknown;
}

const isEventInfo = (value: unknown): value is EventInfo => Boolean(value && typeof value === 'object');
const isEventProperties = (value: unknown): value is NonNullable<AssistEvent['properties']> => Boolean(value && typeof value === 'object');
const isNumber = (value: unknown): value is number => typeof value === 'number';
const hasCreated = (value: unknown): value is { created?: unknown } => value != null;
interface FailureFields {
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  _tag?: unknown;
}
const hasFailureFields = (value: unknown): value is FailureFields => value != null;
const isJsonObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

interface PendingRun {
  directory: string;
  armedAt: number;
  allowed: AssistTargets;
}

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

const getSessionAssistTargets = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return {
    recap: settings.sessionRecapEnabled !== false,
    suggestion: settings.sessionSuggestionEnabled !== false,
  };
};

const IDLE_QUIET_MS = 0;
const RECAP_CHAR_LIMIT = 320;
const SUGGESTION_CHAR_LIMIT = 100;
const FETCH_TIMEOUT_MS = 5_000;
const GENERATION_TIMEOUT_MS = 120_000;
const TAIL_RECHECK_LIMIT = 8;
const QUIET_FAILURE_CODES = new Set(['context-too-small', 'output-exhausted']);
const assistOutputSchema = z.object({
  recap: z.string().catch(''),
  suggestion: z.string().catch(''),
});

const normalizeSuggestion = (value: string) => {
  const text = value.trim().replace(/^(["'])\s*([\s\S]*?)\s*\1$/, '$2').trim();
  if (!text || text.length >= SUGGESTION_CHAR_LIMIT) return '';
  if (/[\r\n*?？]/u.test(text) || /[.!。！]\s+\p{L}|[。！]\s*\p{L}/u.test(text)) return '';
  const words = text.split(/\s+/u);
  if (words.length > 12) return '';
  if (words.length === 1 && !text.startsWith('/') && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}].*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
    && !/^(yes|yeah|yep|yup|sure|ok|okay|push|commit|deploy|stop|continue|check|exit|quit|no)$/i.test(text)) return '';
  if (/^(no suggestion|nothing to suggest|nothing found|silence\b|done\b|无建议|没有建议|無建議|沒有建議|完成了?$)/iu.test(text)) return '';
  if (/^(thanks?\b|thank you\b|looks good\b|sounds good\b|nice\b|great\b|perfect\b|谢谢|謝謝|看起来不错|看起來不錯|太好了)/iu.test(text)) return '';
  if (/^(let me\b|i(?:['’]ll|['’]ve|['’]m| will\b| can\b| would\b| think\b)|here(?:['’]s| is\b| are\b)|you (?:can|should|could)\b|让我(?!们)|我来|我会|我将)/iu.test(text)) return '';
  return text;
};

const describeGenerationFailure = (failure: FailureFields | undefined) => {
  const parts = [];
  const status = Number(failure?.statusCode);
  if (Number.isFinite(status)) parts.push(`status ${status}`);
  const code = isString(failure?.code) ? failure.code.trim() : '';
  if (code) parts.push(`code ${code}`);
  const message = isString(failure?.message) ? failure.message.trim() : '';
  if (message) parts.push(message.replace(/\s+/g, ' ').slice(0, 300));
  const tag = isString(failure?._tag) ? failure._tag.trim() : '';
  if (tag) parts.push(`tag ${tag}`);
  return parts.join(' | ');
};

const extractJsonObject = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  for (let end = candidate.length; end > start; end -= 1) {
    if (candidate[end - 1] !== '}') continue;
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end));
      if (isJsonObject(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
};

const extractSessionStatus = (payload: AssistEvent | null | undefined) => {
  if (!payload || payload.type !== 'session.status') return null;
  const properties = isEventProperties(payload.properties) ? payload.properties : {};
  const status = isEventInfo(properties.status) ? properties.status : {};
  const info = isEventInfo(properties.info) ? properties.info : {};
  const sessionId = isString(properties.sessionID) ? properties.sessionID.trim() : '';
  const type = isString(status.type)
    ? status.type.trim()
    : (isString(info.type) ? info.type.trim() : '');
  if (!sessionId || !type) return null;
  const directory = isString(properties.directory) && properties.directory
    ? properties.directory
    : (isString(info.directory) ? info.directory : '');
  return { sessionId, type, directory };
};

const extractUserMessage = (payload: AssistEvent | null | undefined) => {
  if (!payload || payload.type !== 'message.updated') return null;
  const info = payload.properties?.info;
  if (!isEventInfo(info) || info.role !== 'user') return null;
  if (!isString(info.sessionID) || !info.sessionID) return null;
  return {
    sessionId: info.sessionID,
    createdAt: hasCreated(info.time) && isNumber(info.time.created) ? info.time.created : 0,
  };
};

export const createSessionAssistRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  nativeSessions = null,
  getTargets = getSessionAssistTargets,
  quietMs = IDLE_QUIET_MS,
  persistSessionAssist = null,
  isSessionArchived = async () => false,
  evaluateTurn = null,
  lineage = null,
  onPendingChange = () => {},
}: SessionAssistOptions) => {
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; armedAt: number }>();
  const gates = new Map<string, { armedAt: number }>();
  const inflight = new Map<string, { controller: AbortController; armedAt: number }>();
  const ready = new Map<string, PendingRun>();
  const persisted = new Map<string, string>();
  const announced = new Map<string, string>();
  let stopped = false;

  const announce = (sessionId: string, directory = '') => {
    const pending = !stopped && (gates.has(sessionId) || timers.has(sessionId)
      || inflight.has(sessionId) || ready.has(sessionId));
    if (pending === announced.has(sessionId)) return;
    const announcedDirectory = pending ? directory : announced.get(sessionId);
    if (pending) announced.set(sessionId, directory);
    else announced.delete(sessionId);
    onPendingChange({ sessionId, directory: announcedDirectory, pending });
  };

  const clearTimer = (sessionId: string) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(sessionId);
    }
  };

  const invalidate = (sessionId: string) => {
    clearTimer(sessionId);
    gates.delete(sessionId);
    ready.delete(sessionId);
    inflight.get(sessionId)?.controller.abort();
    announce(sessionId);
  };

  const retireStored = (sessionId: string, directory: string) => {
    const storedDirectory = persisted.get(sessionId);
    if (storedDirectory === undefined) return;
    persisted.delete(sessionId);
    Promise.resolve(nativeSessions?.isNativeSessionId(sessionId)
      ? nativeSessions.setSessionAssist(sessionId, directory || storedDirectory, null)
      : persistSessionAssist?.(sessionId, directory || storedDirectory, null))
      .catch(() => console.warn('[session-assist] failed to retire a stale assist'));
  };

  const localSkipNotices = new Set<string>();
  const reportLocalSkip = (providerID: string | undefined, modelID: string | undefined) => {
    const key = `${providerID}/${modelID}`;
    if (localSkipNotices.has(key)) return;
    localSkipNotices.add(key);
    console.log(`[session-assist] skipped: ${key} is served from a local endpoint and is the session's own model, so a side request would evict its prompt cache. Set a different Small Model to get a recap or a suggestion`);
  };

  const openCodeSource = (sessionId: string, directory: string, signal: AbortSignal) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    const client = OpenCode.make({
      baseUrl,
      headers,
    });
    const requestOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    const native: false = false;
    return {
      native,
      parentId: (session: Parameters<typeof sessionParentId>[0]) => sessionParentId(session),
      isArchived: () => isSessionArchived(sessionId),
      checkCurrent: () => {
        signal.throwIfAborted();
        if (buildOpenCodeUrl('/', '').replace(/\/$/, '') !== baseUrl) throw new Error('Session assist runtime changed');
      },
      readSession: () => client.session.get({ sessionID: sessionId }, requestOptions()),
      readPage: ({ limit, cursor }: { limit: number; cursor: string | undefined }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        requestOptions(),
      ),
      latestMessageId: async () => newestContentId((await client.message.list({ sessionID: sessionId, limit: TAIL_RECHECK_LIMIT, order: 'desc' }, requestOptions())).data),
      writeAssist: (assist: SessionAssist) => persistSessionAssist?.(sessionId, directory, assist),
    };
  };

  const nativeSource = (
    runtime: NativeSessionsAssistRuntime,
    sessionId: string,
    directory: string,
    signal: AbortSignal,
  ) => {
    const native: true = true;
    return {
      native,
      parentId: (session: NativeAssistSession) => session.parentID ?? null,
      isArchived: async (session: NativeAssistSession) => Boolean(session.time?.archived),
      checkCurrent: () => signal.throwIfAborted(),
      readSession: () => runtime.getSession(sessionId, directory),
      readPage: async ({ limit, cursor }: { limit: number; cursor: string | undefined }) => {
        const result = await runtime.loadMessages(sessionId, directory, { limit, before: cursor });
        return { records: result.records, cursor: result.cursor };
      },
      latestMessageId: async () => (await runtime.loadMessages(sessionId, directory, { limit: 1 })).records.at(-1)?.info.id ?? null,
      writeAssist: (assist: SessionAssist) => runtime.setSessionAssist(sessionId, directory, assist),
    };
  };

  const generateAssist = async (sessionId: string, directory: string, signal: AbortSignal, allowed: AssistTargets) => {
    const enabledTargets = getTargets();
    const targets = {
      recap: enabledTargets.recap && allowed.recap,
      suggestion: enabledTargets.suggestion && allowed.suggestion,
    };
    if (!targets.recap && !targets.suggestion) return;
    const isNative = Boolean(nativeSessions?.isNativeSessionId(sessionId));
    const source = isNative && nativeSessions
      ? nativeSource(nativeSessions, sessionId, directory, signal)
      : openCodeSource(sessionId, directory, signal);
    const session = await source.readSession();
    source.checkCurrent();
    if (!session || session.id !== sessionId) return;
    const parentId = source.native
      ? source.parentId(session)
      : source.parentId(session);
    lineage?.remember(sessionId, parentId);
    if (parentId || session.revert?.messageID) return;
    if (source.native ? await source.isArchived(session) : await source.isArchived()) return;
    const initialDirectory = assistSessionDirectory(session);
    const context = source.native
      ? await loadAssistContext({ signal, readPage: source.readPage, native: true })
      : await loadAssistContext({ signal, readPage: source.readPage });
    source.checkCurrent();
    if (!context) return;
    const { last, turns } = context;
    const { describeSmallModel, generateSmallModelText } = await getSmallModelService();
    const preferredProviderID = last.providerID;
    const preferredModelID = last.modelID;
    const described = await describeSmallModel({ directory, preferredProviderID, preferredModelID });
    source.checkCurrent();
    if (!described) return;
    if (described.localEndpoint
      && described.providerID === preferredProviderID
      && described.modelID === preferredModelID) {
      reportLocalSkip(preferredProviderID, preferredModelID);
      return;
    }
    const system = buildAssistSystemPrompt(targets);
    const prompt = buildAssistPrompt(turns, targets, described.inputCharBudget - system.length - 512);
    if (!prompt) return;
    let generated;
    try {
      generated = await generateSmallModelText({
        prompt: prompt.text, system, directory,
        preferredProviderID, preferredModelID,
        onOverflow: 'error', timeoutMs: GENERATION_TIMEOUT_MS, signal,
      });
    } catch (error) {
      const failure = hasFailureFields(error) ? error : undefined;
      if (!signal.aborted && Number(failure?.statusCode) !== 404 && !(isString(failure?.code) && QUIET_FAILURE_CODES.has(failure.code))) {
        console.warn('[session-assist] generation failed', describeGenerationFailure(failure));
      }
      return;
    }
    source.checkCurrent();
    const structured = assistOutputSchema.safeParse(extractJsonObject(generated?.text));
    if (!structured.success) return;
    let recap = targets.recap ? structured.data.recap.trim().slice(0, RECAP_CHAR_LIMIT) : '';
    let suggestion = targets.suggestion ? normalizeSuggestion(structured.data.suggestion) : '';
    const hasCyrillic = (text: string) => /[\u0400-\u04FF]/.test(text);
    const hasCjk = (text: string) => /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
    const scriptMismatch = (text: string) => prompt.language && ((hasCyrillic(text) && !hasCyrillic(prompt.language))
      || (hasCjk(text) && !hasCjk(prompt.language)));
    if (recap && scriptMismatch(recap)) recap = '';
    if (suggestion && scriptMismatch(suggestion)) suggestion = '';
    if (!recap && !suggestion) return;
    const latestId = await source.latestMessageId();
    source.checkCurrent();
    if (latestId !== last.id) return;
    const freshSession = await source.readSession();
    source.checkCurrent();
    if (!freshSession || freshSession.id !== sessionId || freshSession.revert?.messageID) return;
    const freshDirectory = assistSessionDirectory(freshSession);
    if (freshDirectory !== initialDirectory) return;
    if (source.native ? await source.isArchived(freshSession) : await source.isArchived()) return;
    source.checkCurrent();
    const enabled = getTargets();
    if (!enabled.recap || !allowed.recap) recap = '';
    if (!enabled.suggestion || !allowed.suggestion) suggestion = '';
    if (!recap && !suggestion) return;
    await source.writeAssist({ recap, suggestion, forMessageID: last.id, generatedAt: Date.now() });
    persisted.set(sessionId, directory);
  };

  const startGeneration = (sessionId: string, directory: string, armedAt: number, allowed: AssistTargets) => {
    if (stopped) return;
    if (inflight.has(sessionId)) {
      ready.set(sessionId, { directory, armedAt, allowed });
      return;
    }
    const controller = new AbortController();
    inflight.set(sessionId, { controller, armedAt });
    generateAssist(sessionId, directory, controller.signal, allowed)
      .catch(() => {
        if (!controller.signal.aborted) console.warn('[session-assist] failed to read or save assistance');
      })
      .finally(() => {
        inflight.delete(sessionId);
        const next = ready.get(sessionId);
        if (next) {
          ready.delete(sessionId);
          startGeneration(sessionId, next.directory, next.armedAt, next.allowed);
        }
        announce(sessionId);
      });
  };

  const armTimer = (sessionId: string, directory: string, armedAt: number, allowed: AssistTargets) => {
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      startGeneration(sessionId, directory, armedAt, allowed);
      announce(sessionId);
    }, quietMs);
    timer.unref?.();
    timers.set(sessionId, { timer, armedAt });
    announce(sessionId, directory);
  };

  const ALL_FIELDS = { recap: true, suggestion: true };

  const onTurnEnd = (sessionId: string, directory: string) => {
    clearTimer(sessionId);
    const armedAt = Date.now();
    const enabled = getTargets();
    if (!enabled.recap && !enabled.suggestion) {
      gates.delete(sessionId);
      announce(sessionId);
      return;
    }
    if (!evaluateTurn) {
      armTimer(sessionId, directory, armedAt, ALL_FIELDS);
      return;
    }
    const gate = { armedAt };
    gates.set(sessionId, gate);
    announce(sessionId, directory);
    Promise.resolve()
      .then(() => evaluateTurn({ sessionId, directory, assist: enabled }))
      .catch(() => null)
      .then((allowed) => {
        if (stopped || gates.get(sessionId) !== gate) return;
        gates.delete(sessionId);
        const fields = allowed ?? ALL_FIELDS;
        if (fields.recap || fields.suggestion) armTimer(sessionId, directory, armedAt, fields);
        announce(sessionId);
      });
  };

  let parkedNoticeLogged = false;
  const processPayload = (payload: AssistEvent | null | undefined, directoryHint = '') => {
    if (stopped) return;
    const status = extractSessionStatus(payload);
    const userMessage = extractUserMessage(payload);
    const sessionId = status?.sessionId ?? userMessage?.sessionId;
    const native = Boolean(sessionId && nativeSessions?.isNativeSessionId(sessionId));
    if (!native && !persistSessionAssist) {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[session-assist] parked: no session metadata store is wired, so a recap could not be saved');
      }
      return;
    }
    if (status) {
      if (status.type === 'idle') {
        if (lineage?.isChild(status.sessionId) !== true) onTurnEnd(status.sessionId, status.directory || directoryHint);
      }
      else {
        invalidate(status.sessionId);
        retireStored(status.sessionId, status.directory || directoryHint);
      }
      return;
    }
    if (userMessage) {
      const since = timers.get(userMessage.sessionId)?.armedAt
        ?? gates.get(userMessage.sessionId)?.armedAt
        ?? inflight.get(userMessage.sessionId)?.armedAt;
      if (since !== undefined && userMessage.createdAt >= since) invalidate(userMessage.sessionId);
    }
  };

  const stop = () => {
    stopped = true;
    for (const sessionId of timers.keys()) clearTimer(sessionId);
    gates.clear();
    ready.clear();
    for (const { controller } of inflight.values()) controller.abort();
  };
  return { processPayload, stop };
};
