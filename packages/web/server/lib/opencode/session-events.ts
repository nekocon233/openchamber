import { isString } from '../shared/object-guards.js';
import type { JsonValue } from '../shared/json-values.js';

export interface EventFields {
  type?: JsonValue | undefined;
  id?: JsonValue | undefined;
  properties?: JsonValue | undefined;
  status?: JsonValue | undefined;
  info?: JsonValue | undefined;
  sessionID?: JsonValue | undefined;
  turnStartedAt?: JsonValue | undefined;
  attempt?: JsonValue | undefined;
  message?: JsonValue | undefined;
  next?: JsonValue | undefined;
  form?: JsonValue | undefined;
  requestID?: JsonValue | undefined;
  formID?: JsonValue | undefined;
  role?: JsonValue | undefined;
  tokens?: JsonValue | undefined;
  total?: JsonValue | undefined;
  cache?: JsonValue | undefined;
  input?: JsonValue | undefined;
  output?: JsonValue | undefined;
  reasoning?: JsonValue | undefined;
  read?: JsonValue | undefined;
  write?: JsonValue | undefined;
  questions?: JsonValue | undefined;
  header?: JsonValue | undefined;
  title?: JsonValue | undefined;
  time?: JsonValue | undefined;
  created?: JsonValue | undefined;
}

export const isEventObject = (value: unknown): value is EventFields => Boolean(value && typeof value === 'object');

const hasEventFields = (value: unknown): value is EventFields => value != null;

export const eventFields = <Value>(value: Value) => hasEventFields(value) ? value : undefined;

export const isNumber = (value: unknown): value is number => typeof value === 'number';

export const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

const hasResumeErrorFields = (value: unknown): value is { status?: unknown; message?: unknown } => value != null;

export const resumeErrorFields = <Value>(value: Value) => hasResumeErrorFields(value) ? value : undefined;

export interface SessionStateMetadata {
  attempt?: number | undefined;
  message?: string | undefined;
  next?: number | undefined;
  reason?: string;
}

export interface SessionState {
  status: string;
  lastUpdateAt: number;
  lastEventAt: number;
  lastEventId: string;
  metadata: SessionStateMetadata;
}

export interface SessionStateSnapshot {
  status: string;
  lastUpdateAt: number;
  metadata: SessionStateMetadata;
  turnStartedAt: number | undefined;
}

export interface StatusBroadcast {
  sessionID: string;
  status: string;
  timestamp: number;
  metadata: SessionStateMetadata;
  needsAttention?: boolean;
  turnStartedAt?: number | undefined;
}

export interface SessionAttentionState {
  needsAttention: boolean;
  lastUserMessageAt: number | null;
  lastStatusChangeAt: number;
  viewedByClients: Set<string>;
  status: string;
}

export interface SessionAttentionSnapshot {
  needsAttention: boolean;
  lastUserMessageAt: number | null;
  lastStatusChangeAt: number;
  status: string;
  isViewed: boolean;
}

export type SessionRuntimeEvent =
  | { type: 'openchamber:session-status'; properties: StatusBroadcast }
  | { type: 'openchamber:session-activity'; properties: { sessionId: string; phase: ActivityPhase } }
  | { type: 'session.error'; properties: { sessionID: string; error: { name: string; message: string } } };

export interface SessionRuntimeDependencies<Client> {
  writeSseEvent: (client: Client, payload: SessionRuntimeEvent) => void;
  getNotificationClients: () => Iterable<Client>;
  broadcastEvent?: (payload: SessionRuntimeEvent) => void;
  readTurnStart?: ((sessionId: string) => Promise<number | null>) | null;
  buildOpenCodeUrl?: (route: string, prefix: string) => string;
  getOpenCodeAuthHeaders?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  isNativeSessionId?: (sessionId: string) => boolean;
}

export type ActivityPhase = 'busy' | 'idle' | 'cooldown';

export interface Resume {
  id: string;
  attempted: boolean;
}

export interface ResumeCheck {
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  resume: Resume;
}

export interface PendingRequests {
  permissions: EventFields[];
  forms: EventFields[];
  pages: { id: string; sessionID: string; title: string }[];
  questions?: EventFields[];
}

export type SessionContextReading = { state: 'compacted' } | { state: 'measured'; tokens: number };

export interface WaitingPageChange {
  type: string;
  sessionId?: unknown;
  callId?: unknown;
  title?: unknown;
}

export const SESSION_COOLDOWN_DURATION_MS = 2000;

export const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const SESSION_ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export const RESTART_RESUME_GRACE_MS = 60 * 1000;

export const RESTART_RESUME_RETRY_MS = 15 * 1000;

export const RESTART_RESUME_ATTEMPTS = 3;

export const RESTART_RESUME_TIMEOUT_MS = 15 * 1000;

export const RESTART_RESUME_TEXT =
  'OpenChamber restarted OpenCode while a response was still running. Continue from where you left off without repeating completed work.';

export const extractSessionStatusUpdate = (input: JsonValue | undefined) => {
  const payload = eventFields(input);
  if (!payload || payload.type !== 'session.status') {
    return null;
  }

  const properties = isEventObject(payload.properties) ? payload.properties : {};
  const status = isEventObject(properties.status) ? properties.status : {};
  const info = isEventObject(properties.info) ? properties.info : {};
  const sessionId = isString(properties.sessionID) ? properties.sessionID.trim() : '';
  const type = isString(status.type)
    ? status.type.trim()
    : (isString(info.type) ? info.type.trim() : '');

  if (!sessionId || !type) {
    return null;
  }

  return {
    sessionId,
    type,
    turnStartedAt: isFiniteNumber(properties.turnStartedAt) ? properties.turnStartedAt : null,
    eventId: isString(payload.id) ? payload.id : '',
    attempt: isNumber(status.attempt)
      ? status.attempt
      : (isNumber(info.attempt) ? info.attempt : undefined),
    message: isString(status.message)
      ? status.message
      : (isString(info.message) ? info.message : undefined),
    next: isNumber(status.next)
      ? status.next
      : (isNumber(info.next) ? info.next : undefined),
  };
};
